package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/router"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
)

// 本文件是「平台限制项」**保存路径**的装配级门禁（审计 R1-rt-8）。
//
// 现场：四笔账里没有 SQLite 页缓存这一笔，而控制台允许
// `appdb_cache_kib=65536` + `app_db_readers=16` + `max_instances=256`
// ⇒ (1+16) × 64 MiB × 256 ≈ 272 GiB 的理论常驻，保存判据却仍然通过。
//
// 变异验证（改回缺陷实现时哪条必红）：
//   - 把 applimits.BudgetFor 的 AppDBPageCachePerHandleBytes 去掉 ⇒
//     TestLimitsSaveRejectsOverBudgetAppDBCache 必红（保存被放行）；
//   - 把 wasmLimitsHolder.Plan() 里的 AppDBPageCachePerHandleBytes 去掉 ⇒
//     TestLimitsPlanCarriesEffectivePageCache 必红（启动自检与保存判据两套口径）。

// TestLimitsSaveRejectsOverBudgetAppDBCache：极大页缓存 + 大并发的组合**保存时必须被拒**。
//
// 判据不依赖注入：这条限制项组合在任何真实机器上都超水位（272 GiB 级），
// 只有在"可用内存读不到"或"机器内存 > 411 GiB"时才跳过（并如实说明原因）。
func TestLimitsSaveRejectsOverBudgetAppDBCache(t *testing.T) {
	avail := readMemoryAvailability()
	if !avail.Known() {
		t.Skipf("本机读不到可用内存（%s），保存路径按设计跳过水位判定", avail.Detail)
	}
	// 被拒的那组账约 288 GiB；水位是可用内存的 70% ⇒ 需要 > 411 GiB 才可能通过。
	if avail.Bytes > 411<<30 {
		t.Skipf("本机可用内存 %d GiB 大于被测组合的账（测试前提不成立）", avail.Bytes>>30)
	}

	h := newWasmLimitsHolder(nil, memprofile.Default())
	huge := applimits.Defaults()
	huge.MaxInstances = applimits.MaxInstances
	huge.AppDBCacheKiB = applimits.MaxAppDBCacheKiB
	huge.AppDBReaders = limits.AppDBReadersMax
	if err := huge.Validate(); err != nil {
		t.Fatalf("这组值本身必须合法（否则测的不是保存判据）：%v", err)
	}
	_, aerr := h.Apply(huge.Encode())
	if aerr == nil {
		t.Fatal("272 GiB 级页缓存组合必须被保存判据拒绝（页缓存不进账 = 控制台可把机器配爆）")
	}
	if aerr.Code != apperr.CodeValidation {
		t.Fatalf("拒绝必须是校验类错误（控制台按它渲染提示），得到 %s：%s", aerr.Code, aerr.Message)
	}
	body := aerr.JSON()
	for _, want := range []string{"appdb_cache_bytes", "total_bytes", "appdb_cache_kib"} {
		if !strings.Contains(body, want) {
			t.Fatalf("错误信封应给出可操作明细/提示（%s）：%s", want, body)
		}
	}
	// 明细里的页缓存这笔必须是**真的算过**的数（变异：BudgetFor 不算它 ⇒ 这里是 0 ⇒ 必红）。
	wantCache := int64(1+limits.AppDBReadersMax) * (int64(applimits.MaxAppDBCacheKiB) << 10) * int64(applimits.MaxInstances)
	gotCache, ok := aerr.Details["appdb_cache_bytes"].(int64)
	if !ok {
		t.Fatalf("明细里缺少页缓存这笔的数值：%#v", aerr.Details)
	}
	if gotCache != wantCache {
		t.Fatalf("页缓存这笔 = %d（%d MiB），期望 %d（%d MiB）—— 页缓存没进保存判据的账",
			gotCache, gotCache>>20, wantCache, wantCache>>20)
	}
	if total, ok := aerr.Details["total_bytes"].(int64); !ok || total < gotCache {
		t.Fatalf("总账必须含页缓存这笔：total=%v cache=%d", aerr.Details["total_bytes"], gotCache)
	}
	// 保存被拒 ⇒ 当前生效值不变（不许"拒了但已经改了一半"）。
	if got := h.Get(); got.MaxInstances != applimits.Defaults().MaxInstances {
		t.Fatalf("被拒的保存不得改动生效值：%s", got.Encode())
	}
}

// TestLimitsPlanCarriesEffectivePageCache：启动自检用的 Plan 必须带上**当前生效**的
// 页缓存单价（否则保存判据算 272 GiB、启动自检却只算四笔 —— 两条口径分叉）。
func TestLimitsPlanCarriesEffectivePageCache(t *testing.T) {
	h := newWasmLimitsHolder(nil, memprofile.Default())
	l := h.Get()
	plan := h.Plan()
	if want := l.AppDBPageCachePerHandleBytes(); plan.AppDBPageCachePerHandleBytes != want {
		t.Fatalf("Plan 的页缓存单价 = %d，生效值 = %d（装配漏接）", plan.AppDBPageCachePerHandleBytes, want)
	}
	// 改一个旋钮（appdb_cache_kib 翻倍）⇒ Plan 必须跟着变（不是编译期常量）。
	next := l
	next.AppDBCacheKiB = l.AppDBCacheKiB * 2
	if _, aerr := h.Apply(next.Encode()); aerr != nil {
		t.Fatalf("翻倍页缓存的组合应仍在合法范围内：%v", aerr)
	}
	if got, want := h.Plan().AppDBPageCachePerHandleBytes, next.AppDBPageCachePerHandleBytes(); got != want {
		t.Fatalf("改 appdb_cache_kib 后 Plan 单价 = %d，期望 %d", got, want)
	}
}

// ---------------------------------------------------------------------------
// AUD-2（2026-09-20 独立对抗审计）：`{"limits":null}` 必须**真的**回落部署档位
// ---------------------------------------------------------------------------

// limitsTestEnv 组装"限制项控制台"的**生产装配**（真 holder + 真 PG + 生产路由申报）。
//
// 与 api 包里的替身用例的区别（AUD-2 的教训）：这里有真 `wasmLimitsHolder`（生产持有者，
// 走 setupWasmPlatform 的同一条构造路径）、真 `settings.wasm.limits` 行、真
// `wasmLimitsHolder.Apply`、真 profile 解析与真审计写入 —— 替身自己把 source 置成
// "default" 就说"回落成立"正是本轮判定的假绿根因。
type limitsTestEnv struct {
	p     *wasmPlatform
	db    *sql.DB
	eng   *gin.Engine
	route string
}

// newLimitsTestEnv 真装配一次平台（档位 small：四笔账在任何 CI 机器上都过水位）。
//
// prep 在**建库之后、装配之前**执行：需要"平台启动时就已存在一条设置"的用例
// （本文件的清空判据）必须在这里写库 —— 装配后再写，持有者已经按旧状态建好了。
func newLimitsTestEnv(t *testing.T, prep func(db *sql.DB)) *limitsTestEnv {
	t.Helper()
	// 显式配置档位 ⇒ 回落之后的来源必须是 "profile"（而不是编译期默认）。
	t.Setenv(memprofile.EnvMemoryProfile, memprofile.Small().Name)
	ensureCompileChildNextToTestBinary(t)
	db := requireRealDB(t)
	if prep != nil {
		prep(db)
	}

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	p := setupWasmPlatform(ctx, db, t.TempDir())
	if p == nil {
		t.Fatal("setupWasmPlatform 返回 nil")
	}
	t.Cleanup(p.Close)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	// 管理面身份：生产由 AdminAuth 注入，这里直接放上下文（与既有装配级用例同一契约）。
	r.Use(func(c *gin.Context) {
		c.Set("admin_user", &serverstore.User{Username: "boss", Role: serverstore.RoleSuperAdmin})
		c.Next()
	})
	ag := r.Group(router.NamespaceServer + "/admin/wasm-apps")
	serverauth.AdminRoute(ag, "GET", "/limits", serverauth.PermCapabilityRead, p.API.AdminLimitsGet)
	serverauth.AdminRoute(ag, "PUT", "/limits", serverauth.PermCapabilityWrite, p.API.AdminLimitsPut)
	return &limitsTestEnv{p: p, db: db, eng: r, route: router.NamespaceServer + "/admin/wasm-apps/limits"}
}

// limitsViewForTest 是 /limits 视图里本用例关心的字段。
type limitsViewForTest struct {
	Limits struct {
		MaxInstances int `json:"max_instances"`
		AppQueue     int `json:"app_queue"`
	} `json:"limits"`
	Source      string `json:"source"`
	Profile     string `json:"profile"`
	SourceLabel string `json:"source_label"`
	Budget      struct {
		Profile string `json:"profile"`
	} `json:"budget"`
}

func (e *limitsTestEnv) getLimits(t *testing.T) limitsViewForTest {
	t.Helper()
	w := httptest.NewRecorder()
	e.eng.ServeHTTP(w, httptest.NewRequest(http.MethodGet, e.route, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("GET /limits = %d: %s", w.Code, w.Body.String())
	}
	var view limitsViewForTest
	if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil {
		t.Fatalf("解析 /limits 视图失败: %v; body=%s", err, w.Body.String())
	}
	return view
}

func (e *limitsTestEnv) putLimits(t *testing.T, body string) limitsViewForTest {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, e.route, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	e.eng.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("PUT /limits(%s) = %d: %s", body, w.Code, w.Body.String())
	}
	var view limitsViewForTest
	if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil {
		t.Fatalf("解析 PUT /limits 响应失败: %v; body=%s", err, w.Body.String())
	}
	return view
}

// auditRow 读某动作的审计条数与最后一条明细。
func auditRow(t *testing.T, db *sql.DB, action string) (int, string) {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action = ?`, action).Scan(&n); err != nil {
		t.Fatalf("统计审计(%s): %v", action, err)
	}
	detail := ""
	if n > 0 {
		if err := db.QueryRow(`SELECT detail FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1`,
			action).Scan(&detail); err != nil {
			t.Fatalf("读审计(%s)明细: %v", action, err)
		}
	}
	return n, detail
}

// TestLimitsClearReallyRestoresProfileSource 是 AUD-2 的**生产装配**判据（默认选 (a)：
// 实现真正的回落）。
//
// 缺陷现场（审计活体复现）：`{"limits":null}` 号称"回落部署档位"，而 `Apply("")` 把档位值
// **又写回 settings** 并 `h.set(..., "setting")` ⇒ 库行仍在、`source` 仍 `setting`、
// label 仍「控制台保存（wasm.limits）」—— 运维**事实上无法回落档位**（此后改
// PICOAI_WASM_MEMORY_PROFILE 会被这条钉死的设置覆盖，而界面上看不出异常）。
//
// 判据（全部在真装配上，逐条对应一个可观测事实）：
//  1. 清空前：设置行存在、`source=setting`，**换一个档位构造 holder 也仍读设置值**
//     （钉死的证明）；
//  2. `PUT {"limits":null}` ⇒ 200；
//  3. **库里那行真的没了**（`GetSetting` ok=false）—— 回落通道的本体；
//  4. 视图 `source=profile`、`source_label` 不再出现「控制台保存」且点名档位名、
//     四笔账来源不再是 `limits/setting`；
//  5. 生效值回到档位值（不是"设置值被重写成档位值"的那种假回落）；
//  6. 写了一条 `wasm_limits_change` 审计，明细点名来源变化（setting → profile）；
//  7. **重启视角**：清空后用**另一个档位**构造 holder ⇒ 新档位真的生效（这正是
//     "运维可以改 PICOAI_WASM_MEMORY_PROFILE 回落/换档"的可操作含义）。
//
// 变异验证（任一即红）：
//   - 把 `Apply("")` 改回 `SetSetting(..., next.Encode())` + `h.set(next, "setting", …)`
//     ⇒ 判据 3/4/5/6 红（库里行仍在、source 仍 setting、label 仍「控制台保存」）；
//   - 把 `profileSource()` 改回恒 "profile" ⇒ 判据 7 在同档位场景下仍绿，但
//     "未配置档位"的对照断言（见下）会红。
func TestLimitsClearReallyRestoresProfileSource(t *testing.T) {
	prof := memprofile.Small()
	profLimits := applimits.FromProfile(prof)
	// 另一个档位（只改并发数：四笔账在任何机器上都过水位）。
	other := memprofile.Small()
	other.Instances = prof.Instances + 1
	otherLimits := applimits.FromProfile(other)
	if otherLimits == profLimits {
		t.Fatal("夹具失效：两个档位必须给出不同的限制项")
	}
	// 前置：存一份与档位**不同**的设置（AppQueue +1），这样"回落是否真的发生"可判别。
	saved := profLimits
	saved.AppQueue = profLimits.AppQueue + 1

	env := newLimitsTestEnv(t, func(db *sql.DB) {
		if err := serverstore.SetSetting(db, SettingWasmLimits, saved.Encode()); err != nil {
			t.Fatalf("前置保存设置失败: %v", err)
		}
	})
	db := env.db

	// ---- 判据 1：设置钉住生效值（换档位也读设置） ----
	hPinned := newWasmLimitsHolder(db, other)
	if hPinned.Source() != "setting" || hPinned.Get() != saved {
		t.Fatalf("前置：设置必须赢过档位（source=%q value=%s want %s）",
			hPinned.Source(), hPinned.Get().Encode(), saved.Encode())
	}
	view := env.getLimits(t)
	if view.Source != "setting" || view.Limits.AppQueue != saved.AppQueue {
		t.Fatalf("前置：视图应为 setting + 设置值 %d，得到 source=%q %+v", saved.AppQueue, view.Source, view.Limits)
	}
	if !strings.Contains(view.SourceLabel, "控制台保存") {
		t.Fatalf("前置：来源文案应写着控制台保存，得到 %q", view.SourceLabel)
	}
	if _, ok, _ := serverstore.GetSetting(db, SettingWasmLimits); !ok {
		t.Fatal("前置：设置行必须存在")
	}
	auditBefore, _ := auditRow(t, db, "wasm_limits_change")

	// ---- 判据 2：显式清空（生产路由 + 真 holder） ----
	cleared := env.putLimits(t, `{"limits":null}`)

	// ---- 判据 3：设置行**真的被删掉**（"回落通道"的本体） ----
	if v, ok, err := serverstore.GetSetting(db, SettingWasmLimits); err != nil {
		t.Fatalf("读设置行: %v", err)
	} else if ok {
		t.Fatalf("清空后 settings.%s 行仍在（内容 %s）—— 这正是 AUD-2 的缺陷形态："+
			"库里行还在 ⇒ source 仍 setting ⇒ 运维事实上无法回落档位", SettingWasmLimits, v)
	}

	// ---- 判据 4：视图来源如实回到档位，且文案随之变化 ----
	if cleared.Source != "profile" {
		t.Fatalf("清空后视图 source = %q, want profile（显式配置了档位）", cleared.Source)
	}
	if strings.Contains(cleared.SourceLabel, "控制台保存") {
		t.Fatalf("清空后 source_label 仍写着控制台保存：%q（文案与实现不一致）", cleared.SourceLabel)
	}
	if !strings.Contains(cleared.SourceLabel, prof.Name) {
		t.Fatalf("清空后 source_label = %q 必须点名档位 %q", cleared.SourceLabel, prof.Name)
	}
	if strings.Contains(cleared.Budget.Profile, "setting") {
		t.Fatalf("清空后四笔账来源仍是 limits/setting：%q", cleared.Budget.Profile)
	}

	// ---- 判据 5：生效值 = 档位值（不是"设置值被重写成档位值"） ----
	if got := env.p.Limits.Get(); got != profLimits {
		t.Fatalf("清空后生效值 = %s, want 档位值 %s（设置值 %s 必须消失）",
			got.Encode(), profLimits.Encode(), saved.Encode())
	}
	if env.p.Limits.Source() != "profile" {
		t.Fatalf("清空后持有者 source = %q, want profile", env.p.Limits.Source())
	}
	if cleared.Limits.AppQueue != profLimits.AppQueue {
		t.Fatalf("清空后视图 app_queue = %d, want 档位值 %d", cleared.Limits.AppQueue, profLimits.AppQueue)
	}

	// ---- 判据 6：清空是运维动作，必须留痕且点名来源变化 ----
	auditAfter, detail := auditRow(t, db, "wasm_limits_change")
	if auditAfter != auditBefore+1 {
		t.Fatalf("清空后 wasm_limits_change 审计 = %d 条, want %d（清空必须审计）", auditAfter, auditBefore+1)
	}
	if !strings.Contains(detail, "setting") || !strings.Contains(detail, "profile") {
		t.Fatalf("审计明细必须点名来源变化（setting → profile），得到 %q", detail)
	}

	// ---- 判据 7：重启 + 换档位 ⇒ 新档位真的生效（回落通道可操作） ----
	hOther := newWasmLimitsHolder(db, other)
	if hOther.Source() != "profile" {
		t.Fatalf("清空后重启的来源 = %q, want profile", hOther.Source())
	}
	if hOther.Get() != otherLimits {
		t.Fatalf("清空后换档位必须生效：得到 %s, want %s（同一份设置在清空前会把它钉住）",
			hOther.Get().Encode(), otherLimits.Encode())
	}
}

// TestLimitsClearWithoutExplicitProfileReportsDefault 钉住"档位未显式配置"那一档的
// 来源文案：清空后 `source` 必须是 `default`（编译期默认）而不是 `profile` ——
// 否则界面会把"根本没配档位"说成"部署档位生效"，排查方向完全不同。
//
// 变异验证：把 `profileSource()` 改成恒返回 "profile" ⇒ 本用例红。
func TestLimitsClearWithoutExplicitProfileReportsDefault(t *testing.T) {
	// 显式把档位**清空**：memprofile.FromEnv("") ⇒ default 档，profileExplicit=false。
	prof, perr := memprofile.FromEnv(func(string) string { return "" })
	if perr != nil {
		t.Fatalf("解析默认档位失败: %v", perr)
	}
	h := newWasmLimitsHolder(nil, prof)
	if h.Source() != "default" {
		t.Fatalf("未显式配置档位时 source = %q, want default（不得谎称档位生效）", h.Source())
	}
	if h.Get() != applimits.Defaults() {
		t.Fatalf("未显式配置档位时应是编译期默认，得到 %s", h.Get().Encode())
	}
	if label := h.ProfileLabel(); !strings.Contains(label, "default") {
		t.Fatalf("ProfileLabel = %q 必须如实说明是默认档", label)
	}
}
