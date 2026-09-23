package api

import (
	"bytes"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// ===========================================================================
// 发布审核开关（R17）的**三态**：读到真 / 读到假 / 读失败（R3-A A-3）
// ===========================================================================
//
// 缺陷形态（审计第三轮 A-3，fail-open）：`reviewRequired()` 把
// `err != nil`（读失败）与 `!ok`（键不存在）**并成一条路径**都返回 false，
// 于是"组织的审核开关被一次数据库读故障静默绕过" —— 开关在库里是 true、
// 新版本却直接落 `approved` 对外生效。
//
// 本文件钉住的不变量（三态必须各走各的路）：
//   - **键不存在** ⇒ 默认关（R17 的缺省语义，是承诺，不随读故障改变）；
//   - **键存在且可读** ⇒ 取解析值（true / false 各自生效）；
//   - **读失败** ⇒ fail-closed（按"需要审核"处理）+ fail-loud（平台日志），
//     且**发布闸门**必须把这次读失败如实报出去（503、不落行、不产生 approved
//     版本）—— "读不到"与"明确为 false"是两条路径，这正是旧实现的合并点。

// hideSettingsTable 制造"审核开关读失败"：表在、行在、值在，只是**读不到**。
//
// 为什么用改名：这是测试里唯一确定性、可逆、且**只影响 settings 读路径**的注入
// 方式。生产里同一个 `err != nil` 分支由连接池耗尽 / 主库抖动 / 行锁命中
// （settings 读路径就是一条普通 SELECT），所以它不是"只有夹具能造出的形态"。
//
// 返回还原闭包（调用方必须 defer；还原失败直接 Fatal —— 否则同进程的后续用例会
// 集体假红，那比本用例自身失败更难查）。
func hideSettingsTable(t *testing.T, e *testEnv) func() {
	t.Helper()
	if _, err := e.db.Exec(`ALTER TABLE settings RENAME TO settings_hidden`); err != nil {
		t.Fatalf("改名 settings 表失败: %v", err)
	}
	return func() {
		if _, err := e.db.Exec(`ALTER TABLE settings_hidden RENAME TO settings`); err != nil {
			t.Fatalf("还原 settings 表失败: %v", err)
		}
	}
}

// captureLog 捕获标准 logger 的输出（fail-loud 的判据）。
//
// 本包的 `log.Printf` 是**进程级**出口，而 api 包的用例全部串行（无 t.Parallel），
// 所以这段替换是安全的；defer 一定还原，避免污染后续用例。
func captureLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	prev := log.Writer()
	flags := log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(prev)
		log.SetFlags(flags)
	}()
	fn()
	return buf.String()
}

// TestReviewSwitchReadFailurePublishIsFailClosed 是本条缺陷的**主判据**。
//
// 红/绿对照（修复前 ⇒ 下面每条断言都红）：
//   - 修复前 HTTP 201（版本落库并直接 approved）；
//   - 修复前 countReleases = 1（还占掉了 1.0.0 这个**永久占位**的版本号）；
//   - 修复前日志里没有 fail-loud 记录（读失败被静默当成"审核关"）。
func TestReviewSwitchReadFailurePublishIsFailClosed(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)

	// 前提：开关在库里**明确是 true**。fail-closed 的证据就是"它没有被当成 false"。
	if err := serverstore.SetSetting(e.db, SettingReviewRequired, "true"); err != nil {
		t.Fatalf("写审核开关失败: %v", err)
	}

	restore := hideSettingsTable(t, e)
	defer restore()

	var w *httptest.ResponseRecorder
	logs := captureLog(t, func() {
		w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/reviewfail-tool/releases",
			e.tokens["alice"], e.payload("reviewfail-tool", "1.0.0", guest, goodConfig()))
	})

	// ① 发布必须**如实失败**（503），而不是"成功但进了待审队列"：
	//    审核队列本身也依赖 settings 读路径，读不到开关时谁也不能假装"已进入审核"。
	eb := e.decodeErr(w, http.StatusServiceUnavailable)
	if eb.Error.Code != string(apperr.CodeInternal) {
		t.Fatalf("code = %q, want %q（读失败是平台侧故障，不是作者写错了参数）",
			eb.Error.Code, string(apperr.CodeInternal))
	}
	if !strings.Contains(eb.Error.Message, "审核开关") {
		t.Fatalf("message 必须点名「审核开关」（否则运维只看到一句笼统的 503）: %q", eb.Error.Message)
	}
	if len(eb.Error.Hints) == 0 {
		t.Fatal("读失败必须给可行动 hints（第一消费者是 AI 与运维）")
	}

	// ② 绝不产出 approved 版本 —— 这是缺陷的原始判据。
	if n := e.countReleases("reviewfail-tool"); n != 0 {
		t.Fatalf("读失败时不得落任何版本行（版本号是永久占位），实际 %d 行", n)
	}
	if _, err := serverstore.GetWasmApp(t.Context(), e.db, "reviewfail-tool"); !errors.Is(err, serverstore.ErrNotFound) {
		t.Fatalf("读失败时不得建立 apps 行（不落行 = publish 完全没进写入段），err = %v", err)
	}

	// ③ fail-loud：平台日志必须留下可检索的一条（"静默 fail-open"的对照反面）。
	for _, want := range []string{SettingReviewRequired, "读取失败"} {
		if !strings.Contains(logs, want) {
			t.Fatalf("日志里没有 fail-loud 记录（缺 %q）: %q", want, logs)
		}
	}
}

// TestReviewSwitchReadFailureDisplayIsFailClosed 钉住**展示面**的 fail-closed：
// 读失败时管理面列表必须报"需要审核"（true），而不是回落到"审核关"。
//
// 为什么展示面也要单独钉：它与发布闸门是两个消费方（一个是渲染，一个是拒绝），
// 只修一个会让"页面说开关关着、发布却被拦"或反之 —— 正是本条缺陷的分叉形态。
func TestReviewSwitchReadFailureDisplayIsFailClosed(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "display-tool", "1.0.0", testGuestModule(t), goodConfig())
	if err := serverstore.SetSetting(e.db, SettingReviewRequired, "true"); err != nil {
		t.Fatalf("写审核开关失败: %v", err)
	}

	restore := hideSettingsTable(t, e)
	defer restore()

	var out struct {
		ReviewRequired bool   `json:"review_required"`
		SettingKey     string `json:"setting_key"`
	}
	logs := captureLog(t, func() {
		e.decodeJSON(e.req(http.MethodGet, "/api/server/admin/wasm-apps", "", nil), http.StatusOK, &out)
	})
	if !out.ReviewRequired {
		t.Fatal("读失败时管理面必须按「需要审核」展示（fail-closed），不得回落成「审核关」")
	}
	if out.SettingKey != SettingReviewRequired {
		t.Fatalf("setting_key = %q, want %q", out.SettingKey, SettingReviewRequired)
	}
	if !strings.Contains(logs, "读取失败") {
		t.Fatalf("展示面读失败同样要 fail-loud: %q", logs)
	}
}

// TestReviewSwitchThreeStates 是**反向用例**（防过度修复）：三态里除"读失败"之外
// 的两态必须保持原语义 —— 键不存在 ⇒ 默认关且发布直接生效；明确 false ⇒ 同样直接
// 生效；明确 true ⇒ 进待审队列。
//
// 没有这条，"把一切都变成 503"或"把一切都变成待审"也能让主判据变绿 —— 那是过度
// 修复（全组织再也发不出新版本），比原缺陷更难发现。
func TestReviewSwitchThreeStates(t *testing.T) {
	cases := []struct {
		name         string
		value        string
		writeSetting bool
		wantStatus   string
	}{
		{name: "键不存在 = 默认关（R17 缺省）", writeSetting: false, wantStatus: "approved"},
		{name: "明确 false = 关", value: "false", writeSetting: true, wantStatus: "approved"},
		{name: "明确 true = 开（进待审队列）", value: "true", writeSetting: true, wantStatus: "pending"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newTestEnv(t)
			if tc.writeSetting {
				if err := serverstore.SetSetting(e.db, SettingReviewRequired, tc.value); err != nil {
					t.Fatalf("写审核开关失败: %v", err)
				}
			}
			rel := e.publishOK(e.tokens["alice"], "three-state-tool", "1.0.0", testGuestModule(t), goodConfig())
			if got := rel["status"]; got != tc.wantStatus {
				t.Fatalf("status = %v, want %q（release=%v）", got, tc.wantStatus, rel)
			}
		})
	}
}

// ===========================================================================
// 审核开关的**取值无法识别**：语义仍是"关"，但必须 fail-loud（R3-A 复审 F4）
// ===========================================================================
//
// 复审实测的残留面：`reviewSwitch` 的 `default:` 分支对 `""` / `"   "` / `"tru"`
// 这类取不到的形态**按关处理且不打任何日志**。与"读失败"（503 + fail-loud）不同，
// 这条路径是安全方向上的 fail-open —— 一次人工改库/未来的格式变更就能把全组织的
// 发布审核悄悄关掉，而在平台日志里查不到任何痕迹。
//
// 本次处置（不改语义、只加可观测性）：
//   - **保留**"按关"（把无法识别的值判成"要审核"会把全组织的新版本卡进待审队列，
//     那是另一种事故，见 reviewSwitch 的判定表）；
//   - 加一行可 grep 的 fail-loud 日志：点名键 + 回显**取到的原文** + 处置指引。
//
// 变异验证（实跑对照见交付报告）：
//   - 删掉 `default:` 分支里的 `log.Printf` ⇒ 本文件红（"静默"回归）；
//   - 把 `default:` 改成 `Required: true` ⇒ 本文件红（语义被改）。

// unrecognizedValueLogMarker 是日志里必须出现的、可 grep 的判定词。
const unrecognizedValueLogMarker = "无法识别"

// TestReviewSwitchUnrecognizedValueIsOffAndLoud 是 F4 的**主判据**。
//
// 每条子用例都同时判两件事：① 行为＝按关（新版本直接 approved）；② 日志可检索
// （键名 + 原文 + 判定 + 处置指引）。
func TestReviewSwitchUnrecognizedValueIsOffAndLoud(t *testing.T) {
	cases := []string{"", "   ", "tru", "enabled", "yes-no", "2"}
	for _, value := range cases {
		t.Run("value="+strconv.Quote(value), func(t *testing.T) {
			e := newTestEnv(t)
			if err := serverstore.SetSetting(e.db, SettingReviewRequired, value); err != nil {
				t.Fatalf("写审核开关失败: %v", err)
			}
			var w *httptest.ResponseRecorder
			logs := captureLog(t, func() {
				w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/loud-tool/releases",
					e.tokens["alice"], e.payload("loud-tool", "1.0.0", testGuestModule(t), goodConfig()))
			})

			// ① 语义不变：按"关"处理 ⇒ 直接 approved（不是 pending、更不是 503）。
			var out struct {
				Release map[string]any `json:"release"`
			}
			e.decodeJSON(w, http.StatusCreated, &out)
			if got := out.Release["status"]; got != "approved" {
				t.Fatalf("无法识别的取值必须仍按「关」处理（直接 approved），实得 %v", got)
			}

			// ② fail-loud：日志必须点名键、回显原文、说明判定、给出处置。
			for _, marker := range []string{
				SettingReviewRequired,
				strconv.Quote(value), // 取到的**原文**（含空串/空白形态）
				unrecognizedValueLogMarker,
				"按「关」处理",
				"true/false",
			} {
				if !strings.Contains(logs, marker) {
					t.Fatalf("fail-loud 日志缺 %q（取值无法识别时必须留下可检索的一行）:\n%s", marker, logs)
				}
			}
		})
	}
}

// TestReviewSwitchRecognizedFormsStayQuiet 是**反向用例**（防过度修复/防误报）：
// 归一化后仍被识别的取值（TRUE / "1 " / ON / yes）走的是"读到 true"那条路 ——
// 必须照旧进待审队列，且**不得**打出"取值无法识别"的日志。
func TestReviewSwitchRecognizedFormsStayQuiet(t *testing.T) {
	for _, value := range []string{"TRUE", "1 ", " on ", "Yes", "false", "FALSE", "0", "off", "no"} {
		t.Run("value="+strconv.Quote(value), func(t *testing.T) {
			e := newTestEnv(t)
			if err := serverstore.SetSetting(e.db, SettingReviewRequired, value); err != nil {
				t.Fatalf("写审核开关失败: %v", err)
			}
			var w *httptest.ResponseRecorder
			logs := captureLog(t, func() {
				w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/quiet-tool/releases",
					e.tokens["alice"], e.payload("quiet-tool", "1.0.0", testGuestModule(t), goodConfig()))
			})
			var out struct {
				Release map[string]any `json:"release"`
			}
			e.decodeJSON(w, http.StatusCreated, &out)
			want := "approved"
			switch strings.ToLower(strings.TrimSpace(value)) {
			case "1", "true", "on", "yes":
				want = "pending"
			}
			if got := out.Release["status"]; got != want {
				t.Fatalf("归一化后被识别的取值 %q 必须走 %q 路径，实得 %v", value, want, got)
			}
			if strings.Contains(logs, unrecognizedValueLogMarker) {
				t.Fatalf("被识别的取值 %q 不得打「取值无法识别」日志（误报会淹没真信号）:\n%s", value, logs)
			}
		})
	}
}
