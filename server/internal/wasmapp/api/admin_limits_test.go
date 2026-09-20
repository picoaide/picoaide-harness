package api

// P2-1（2026-09-20 本机全功能实测）：`PUT /api/server/admin/wasm-apps/limits` 的**顶层
// 信封**曾经完全不校验 —— 扁平 body（把 11 个字段直接放顶层）在旧实现下
// `struct{ Limits *json.RawMessage }` 的 `Limits` 为 nil ⇒ `raw=""` ⇒ LimitsApply 按
// "清空设置"处理 ⇒ **静默回落到部署档位**，且响应 200 + 不写审计。管理员以为保存成功，
// 而调好的限制项已经被重置。
//
// 判据（三态，都必须走**生产路径** PUT /limits）：
//  1. 缺 `limits` 键（含扁平 body 与 `{}`）⇒ 400，`field`/`allowed`/`hint` 齐备，
//     **且 LimitsApply 一次都没被调用**（"发错形状"绝不能有副作用）；
//  2. 出现 `limits` 以外的顶层键 ⇒ 400（`field` = 排序后的第一个未知键，稳定可断言）；
//  3. 正确形态 `{"limits":{…}}` ⇒ 200 且真的生效；`{"limits":null}` ⇒ 200 且是
//     **显式**回落档位（唯一合法的"清空"动作）。
//
// 变异验证：把 `adminLimitsPut` 里 `validateLimitsEnvelope` 的调用去掉（回到
// `*json.RawMessage` 解析）⇒ 判据 1/2 的用例红（扁平 body 又变成 200 + 静默重置）。

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
)

// limitsFake 是控制台限制项读写的**驱动件**（不是被测对象，也不是"声称"）。
//
// 它只做两件事：①把 raw 到底有没有被递下来记成事实（`applied`）；②维护"当前值 +
// 来源"，并按与生产 `wasmLimitsHolder.Apply` **同形**的持久化语义迁移状态：
//
//	raw == "" ⇒ 回落部署档位：**删除 `settings.wasm.limits` 行**（幂等）+ 来源 profile
//	raw != "" ⇒ 保存：写入设置行 + 来源 setting（解析失败原样返回 400，不落库）
//
// 落库走 `serverstore.SetSetting` / `serverstore.DeleteSetting`（与生产同一份 DAO），
// 所以"行真的被删掉了"在**真库**上可断言。
//
// ⚠️ 严格划界（AUD-2 的教训）：**真实回落语义**（`profileLimits()` / `profileSource()`
// 的取值、四笔账、删行后重启读回什么）的判据**不在本文件**，而在 cmd/server 的
// `TestLimitsClearReallyRestoresProfileSource`（真 holder + 真 PG + 生产路由）。
// 替身自己把 source 置成 "default" 就说"回落成立"，正是本轮审计判定的假绿根因；
// 本文件只测**端点的职责**：信封校验、转发、审计、回显。
type limitsFake struct {
	// db 在 newLimitsEnv 里回填（构造 Options 时 env.db 还不存在）。
	db      *sql.DB
	profile memprofile.Profile

	cur     applimits.Limits
	source  string
	applied []string
}

func newLimitsFake(profile memprofile.Profile) *limitsFake {
	return &limitsFake{profile: profile, cur: applimits.FromProfile(profile), source: "profile"}
}

func (f *limitsFake) limits() applimits.Limits { return f.cur }
func (f *limitsFake) src() string              { return f.source }

// apply 复刻生产持有者的持久化语义（raw=="" ⇒ 删行 + 回落档位；否则写行 + setting）。
func (f *limitsFake) apply(raw string) ([]string, *apperr.Error) {
	f.applied = append(f.applied, raw)
	if strings.TrimSpace(raw) == "" {
		if f.db != nil {
			if _, err := serverstore.DeleteSetting(f.db, SettingWasmLimits); err != nil {
				return nil, apperr.New(apperr.CodeInternal, "清空平台限制项失败").
					WithDetail("reason", err.Error())
			}
		}
		f.cur, f.source = applimits.FromProfile(f.profile), "profile"
		return nil, nil
	}
	next, aerr := applimits.Parse(raw)
	if aerr != nil {
		return nil, aerr
	}
	if f.db != nil {
		if err := serverstore.SetSetting(f.db, SettingWasmLimits, next.Encode()); err != nil {
			return nil, apperr.New(apperr.CodeInternal, "保存平台限制项失败").
				WithDetail("reason", err.Error())
		}
	}
	f.cur, f.source = next, "setting"
	return nil, nil
}

// newLimitsEnv 造一个"限制项已接线"的测试环境（其余装配与 newTestEnv 相同）。
func newLimitsEnv(t *testing.T) (*testEnv, *limitsFake) {
	t.Helper()
	f := newLimitsFake(memprofile.Small())
	env := newTestEnv(t, func(o *Options) {
		o.Limits = f.limits
		o.LimitsSource = f.src
		o.LimitsProfile = func() string { return f.profile.Name }
		o.LimitsApply = f.apply
		o.LimitsRestart = func() []string { return nil }
		o.MemoryAvailable = func() int64 { return 8 << 30 }
	})
	f.db = env.db
	// 前置自证：驱动件与端点读的是**同一行**设置。
	if _, ok, err := serverstore.GetSetting(env.db, SettingWasmLimits); err != nil || ok {
		t.Fatalf("前置：测试库不应已有 %s 行（ok=%v err=%v）", SettingWasmLimits, ok, err)
	}
	return env, f
}

// settingRowExists 读真库里的设置行（"清空到底删没删"的唯一判据来源）。
func settingRowExists(t *testing.T, e *testEnv) (string, bool) {
	t.Helper()
	v, ok, err := serverstore.GetSetting(e.db, SettingWasmLimits)
	if err != nil {
		t.Fatalf("读 %s 设置行: %v", SettingWasmLimits, err)
	}
	return v, ok
}

// lastAuditDetail 取某个动作**最后一条**审计的明细（审计的内容也是判据的一部分）。
func lastAuditDetail(t *testing.T, e *testEnv, action string) string {
	t.Helper()
	var detail string
	if err := e.db.QueryRow(
		`SELECT detail FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1`, action).Scan(&detail); err != nil {
		t.Fatalf("读审计(%s)明细失败: %v", action, err)
	}
	return detail
}

// limitsPutBody 是 A7 实测里那份**完整合法**的限制项（12 个字段），
// 测试里既当"正确形态的 limits 值"，也当"扁平误用形态"。
func limitsPutBody() map[string]any {
	return map[string]any{
		"max_instances": 7, "app_running": 6, "app_queue": 40,
		"user_global_running": 5, "user_per_app_running": 2, "user_per_app_queued": 6,
		"instance_memory_mb": 64, "module_cache_mb": 96, "module_cache_idle_min": 12,
		"appdb_idle_min": 5, "appdb_cache_kib": 2048, "app_db_readers": 6,
	}
}

// countAuditAction 统计某个动作的审计条数（P2-1 的"误用不得写审计/不得静默"判据）。
func countAuditAction(t *testing.T, e *testEnv, action string) int {
	t.Helper()
	var n int
	if err := e.db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action = ?`, action).Scan(&n); err != nil {
		t.Fatalf("统计审计(%s)失败: %v", action, err)
	}
	return n
}

// TestAdminLimitsPutEnvelopeMissingKeyFailsLoud 覆盖 P2-1 判据 1 与 2。
func TestAdminLimitsPutEnvelopeMissingKeyFailsLoud(t *testing.T) {
	e, f := newLimitsEnv(t)

	// 前置：先存一份**非默认**的限制项，这样"静默回落"能被观察到（与实测同形：
	// 管理员先调好，再用扁平 body PUT 一次）。
	good := e.req(http.MethodPut, "/api/server/admin/wasm-apps/limits", e.tokens["boss"],
		map[string]any{"limits": limitsPutBody()})
	if good.Code != http.StatusOK {
		t.Fatalf("前置：正确形态应 200，得到 %d %s", good.Code, good.Body.String())
	}
	if f.source != "setting" || f.cur.MaxInstances != 7 {
		t.Fatalf("前置：正确形态必须生效，得到 source=%q max_instances=%d", f.source, f.cur.MaxInstances)
	}
	appliedBefore := len(f.applied)

	cases := []struct {
		name      string
		body      any
		wantField string
	}{
		{"扁平 body（实测的误用形态）", limitsPutBody(), "app_db_readers"},
		{"空对象", map[string]any{}, "limits"},
		{"只有未知键", map[string]any{"bogus_key": 1}, "bogus_key"},
		{"limits + 未知顶层键", map[string]any{"limits": limitsPutBody(), "max_instances": 99}, "max_instances"},
		{"limits:null + 未知顶层键（未知键优先，不得静默清空）", map[string]any{"limits": nil, "extra": true}, "extra"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := e.req(http.MethodPut, "/api/server/admin/wasm-apps/limits", e.tokens["boss"], tc.body)
			eb := e.decodeErr(rec, http.StatusBadRequest)
			if eb.Error.Code != string(apperr.CodeValidation) {
				t.Fatalf("error.code = %q, want %q", eb.Error.Code, apperr.CodeValidation)
			}
			// 三件套：field 点名 + allowed 列出合法键集 + hint 给出正确形态。
			if got, _ := eb.Error.Details["field"].(string); got != tc.wantField {
				t.Fatalf("details.field = %q, want %q（map 迭代无序 ⇒ 未知键必须排序后取第一个）",
					got, tc.wantField)
			}
			allowed, _ := eb.Error.Details["allowed"].([]any)
			if len(allowed) != 1 || allowed[0] != "limits" {
				t.Fatalf("details.allowed = %v, want [limits]", eb.Error.Details["allowed"])
			}
			if len(eb.Error.Hints) == 0 {
				t.Fatal("400 必须带 hint（告诉调用方正确形态）")
			}
			if !strings.Contains(strings.Join(eb.Error.Hints, " "), "limits") {
				t.Fatalf("hint 必须出现 limits 键名: %v", eb.Error.Hints)
			}
		})
	}

	// 核心副作用判据：上面 5 次误用**一次都不许进 LimitsApply**（旧实现会把
	// raw="" 递下去 ⇒ 清空设置 ⇒ 静默回落档位）。
	if len(f.applied) != appliedBefore {
		t.Fatalf("校验失败仍调用了 LimitsApply %d 次（raw=%q）：误用形态绝不许可有副作用",
			len(f.applied)-appliedBefore, f.applied[appliedBefore:])
	}
	if f.source != "setting" || f.cur.MaxInstances != 7 {
		t.Fatalf("误用形态改变了已保存的限制项：source=%q max_instances=%d（静默回落档位）",
			f.source, f.cur.MaxInstances)
	}
	// 审计也不得增加（旧实现里"静默回落"的另一半是"无审计"；这里断言连尝试都没有）。
	if n := countAuditAction(t, e, "wasm_limits_change"); n != 1 {
		t.Fatalf("wasm_limits_change 审计 = %d 条, want 1（只有前置那次成功保存）", n)
	}
}

// TestAdminLimitsPutEnvelopeCorrectShapeApplies 覆盖 P2-1 判据 3：
// 正确形态真的生效，`{"limits":null}` 是**显式**回落（唯一合法的清空动作）。
func TestAdminLimitsPutEnvelopeCorrectShapeApplies(t *testing.T) {
	e, f := newLimitsEnv(t)

	rec := e.req(http.MethodPut, "/api/server/admin/wasm-apps/limits", e.tokens["boss"],
		map[string]any{"limits": limitsPutBody()})
	var view struct {
		Source string `json:"source"`
		Limits struct {
			MaxInstances int `json:"max_instances"`
			AppQueue     int `json:"app_queue"`
		} `json:"limits"`
		SourceLabel string `json:"source_label"`
	}
	e.decodeJSON(rec, http.StatusOK, &view)
	if view.Source != "setting" || view.Limits.MaxInstances != 7 || view.Limits.AppQueue != 40 {
		t.Fatalf("保存未生效: %+v（f.source=%q f.cur=%+v）", view, f.source, f.cur)
	}
	if view.SourceLabel == "" {
		t.Fatal("视图必须给出来源说明（source_label）")
	}
	if f.applied[len(f.applied)-1] == "" {
		t.Fatal("正确形态必须把 limits 的原始 JSON 递给 LimitsApply，而不是空串")
	}
	// 保存后库里必须真有那一行（驱动件按生产语义落库）。
	if _, ok := settingRowExists(t, e); !ok {
		t.Fatal("保存后 settings.wasm.limits 行必须存在（前端下次 GET 的依据）")
	}

	// 显式清空：`{"limits":null}` ⇒ 200 + raw="" + 真删设置行 + 来源回到档位（profile）。
	rec = e.req(http.MethodPut, "/api/server/admin/wasm-apps/limits", e.tokens["boss"],
		map[string]any{"limits": nil})
	// 显式清空后视图必须回落（不再是 setting）。
	var cleared struct {
		Source      string `json:"source"`
		SourceLabel string `json:"source_label"`
		Profile     string `json:"profile"`
	}
	e.decodeJSON(rec, http.StatusOK, &cleared)
	if f.applied[len(f.applied)-1] != "" || f.source != "profile" {
		t.Fatalf("显式清空未生效: applied=%q source=%q", f.applied[len(f.applied)-1], f.source)
	}
	if cleared.Source != "profile" {
		t.Fatalf("显式清空后视图 source = %q, want profile（回落档位；旧实现报 default 是同一条假绿）",
			cleared.Source)
	}
	// 来源文案必须**随来源变化**：清空后不得再显示「控制台保存」。
	if strings.Contains(cleared.SourceLabel, "控制台保存") {
		t.Fatalf("清空后 source_label 仍写着控制台保存：%q（文案与实现不一致）", cleared.SourceLabel)
	}
	if !strings.Contains(cleared.SourceLabel, cleared.Profile) {
		t.Fatalf("清空后 source_label = %q 必须点名回落到的档位 %q", cleared.SourceLabel, cleared.Profile)
	}
	// **核心判据（AUD-2 的本体）**：清空必须真的把设置行删掉，而不是把档位值写回成设置。
	if v, ok := settingRowExists(t, e); ok {
		t.Fatalf("清空后 settings.wasm.limits 行仍在（内容 %s）—— 这正是审计实测的缺陷形态："+
			"库里行还在 ⇒ source 仍 setting ⇒ 运维事实上无法回落档位", v)
	}
	// 两次合法调用各写一条审计（一次生效、一次回落）。
	if n := countAuditAction(t, e, "wasm_limits_change"); n != 2 {
		t.Fatalf("wasm_limits_change 审计 = %d 条, want 2", n)
	}
}

// TestAdminLimitsPutClearAuditsSourceChange 钉住 AUD-2 的另一半：**来源变化也要审计**。
//
// 场景（三步，刻意让"清空"发生在**值恰好等于档位值**的时刻）：管理员先把限制项调成
// 与档位不同的值（值变化 ⇒ 有审计），再调回与档位**逐值相同**的值（值变化 ⇒ 有审计），
// 最后清空设置 —— 生效值一个数字都没变，只有设置行被删、来源 setting → profile。
// 旧实现只比 `next != old` ⇒ 第三步**零审计**，事后没人说得清"那条钉死的设置还在不在"。
//
// 变异验证：把 `adminLimitsPut` 的条件改回只比 `next != old` ⇒ 本用例在**第三步**
// 的审计条数上红（前两步都真的改过值，不受影响）。
func TestAdminLimitsPutClearAuditsSourceChange(t *testing.T) {
	e, f := newLimitsEnv(t)
	const path = "/api/server/admin/wasm-apps/limits"
	var view struct {
		Source string `json:"source"`
	}
	put := func(body any) {
		t.Helper()
		e.decodeJSON(e.req(http.MethodPut, path, e.tokens["boss"], body), http.StatusOK, &view)
	}

	// 第一步：值与档位**不同**（AppQueue +1）⇒ 值变化，有审计。
	off := applimits.FromProfile(f.profile)
	off.AppQueue++
	put(map[string]any{"limits": off})
	if f.source != "setting" || f.cur != off {
		t.Fatalf("前置①：保存应生效，得到 source=%q value=%s", f.source, f.cur.Encode())
	}
	if n := countAuditAction(t, e, "wasm_limits_change"); n != 1 {
		t.Fatalf("前置①：值变化应写 1 条审计，得到 %d", n)
	}

	// 第二步：调回与档位**逐值相同**的值 ⇒ 仍是值变化，有审计。
	same := applimits.FromProfile(f.profile)
	put(map[string]any{"limits": same})
	if f.source != "setting" || f.cur != same || view.Source != "setting" {
		t.Fatalf("前置②：得到 source=%q view=%q value=%s", f.source, view.Source, f.cur.Encode())
	}
	if n := countAuditAction(t, e, "wasm_limits_change"); n != 2 {
		t.Fatalf("前置②：第二次值变化应累计 2 条审计，得到 %d", n)
	}

	// 第三步（被测）：清空 —— 值一个数字都没变，但来源 setting → profile、设置行消失。
	put(map[string]any{"limits": nil})
	if view.Source != "profile" {
		t.Fatalf("清空后 source = %q, want profile", view.Source)
	}
	if f.cur != same {
		t.Fatalf("本用例的前提是「值不变」：清空后 %s ≠ 清空前 %s", f.cur.Encode(), same.Encode())
	}
	if n := countAuditAction(t, e, "wasm_limits_change"); n != 3 {
		t.Fatalf("wasm_limits_change 审计 = %d 条, want 3 —— "+
			"清空设置是一次运维动作（删行 + 来源变了），值恰好没变也必须留痕（AUD-2）", n)
	}
	detail := lastAuditDetail(t, e, "wasm_limits_change")
	if !strings.Contains(detail, "setting") || !strings.Contains(detail, "profile") {
		t.Fatalf("审计明细必须点名来源变化（setting → profile），得到 %q", detail)
	}
}

// TestAdminLimitsPutDuplicateTopLevelKeyIsLastWinsAndObservable 把审计观察项
// （2026-09-20）的**接受决定**钉成判据：顶层重复键 `{"limits":<合法>,"limits":null}`
// 按 JSON 的 last-wins 语义执行清空（不拒），但这件事必须**完全可观测**：
// 设置行真的没了、响应 source 从 setting 回到 profile、并写一条点名来源变化的审计。
//
// 为什么不拒（完整理由见 `validateLimitsEnvelope` 的注释）：RFC 8259 允许重复名且
// Go 的 last-wins 语义稳定可预测；拒它要在公共解析路径之外再实现一遍 token 级扫描，
// 风险大于收益；而"清空"不是危险动作且现在可观测/可逆。真正危险的那条（扁平 body
// 被当成清空而**零副作用可观测**）已由信封校验挡住。
func TestAdminLimitsPutDuplicateTopLevelKeyIsLastWinsAndObservable(t *testing.T) {
	e, f := newLimitsEnv(t)
	const path = "/api/server/admin/wasm-apps/limits"

	// 先存一份非档位值，这样"清空"可判别。
	rec := e.req(http.MethodPut, path, e.tokens["boss"], map[string]any{"limits": limitsPutBody()})
	e.decodeJSON(rec, http.StatusOK, &struct{}{})
	if _, ok := settingRowExists(t, e); !ok {
		t.Fatal("前置：设置行必须存在")
	}

	// 重复顶层键：合法对象在前、null 在后 ⇒ last-wins ⇒ 清空。
	dup := `{"limits":` + applimits.FromProfile(f.profile).Encode() + `,"limits":null}`
	rec = e.req(http.MethodPut, path, e.tokens["boss"], dup)
	var view struct {
		Source string `json:"source"`
	}
	e.decodeJSON(rec, http.StatusOK, &view)
	if view.Source != "profile" {
		t.Fatalf("重复键 last-wins 应执行清空（source=profile），得到 %q", view.Source)
	}
	if v, ok := settingRowExists(t, e); ok {
		t.Fatalf("重复键触发的清空必须真的删掉设置行，实际仍在：%s", v)
	}
	if n := countAuditAction(t, e, "wasm_limits_change"); n != 2 {
		t.Fatalf("重复键触发的清空也必须留痕（设置 1 条 + 清空 1 条 = 2），得到 %d", n)
	}
	if detail := lastAuditDetail(t, e, "wasm_limits_change"); !strings.Contains(detail, "profile") {
		t.Fatalf("审计明细应点名来源变化，得到 %q", detail)
	}
}

// TestAdminLimitsPutEnvelopeRejectsNonObjectBodies 是信封的边界补强：
// 非对象 body / 尾随内容仍然走 bindJSONLimited 的既有纪律（400），不会被信封校验
// 放过成"500 或静默"。
func TestAdminLimitsPutEnvelopeRejectsNonObjectBodies(t *testing.T) {
	e, f := newLimitsEnv(t)
	for _, raw := range []string{`[1,2,3]`, `"limits"`, `{"limits":{}}{"limits":{}}`} {
		rec := e.req(http.MethodPut, "/api/server/admin/wasm-apps/limits", e.tokens["boss"], raw)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body=%s 应 400，得到 %d %s", raw, rec.Code, rec.Body.String())
		}
	}
	if len(f.applied) != 0 {
		t.Fatalf("非法 body 不得进 LimitsApply，实际调用 %d 次", len(f.applied))
	}
}

// TestAdminLimitsPutEnvelopeFieldIsDeterministic 钉住"未知键排序"：同一份多键误用
// 重复调用必须报**同一个** field（map 迭代无序 ⇒ 不排序会随机报不同键，用例与
// 排障日志都没法比对）。
func TestAdminLimitsPutEnvelopeFieldIsDeterministic(t *testing.T) {
	e, _ := newLimitsEnv(t)
	body := map[string]any{"zeta": 1, "alpha": 2, "mid": 3, "limits": limitsPutBody()}
	seen := map[string]struct{}{}
	for i := 0; i < 12; i++ {
		rec := e.req(http.MethodPut, "/api/server/admin/wasm-apps/limits", e.tokens["boss"], body)
		var eb errBody
		if err := json.Unmarshal(rec.Body.Bytes(), &eb); err != nil {
			t.Fatalf("解析错误信封: %v", err)
		}
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("应 400，得到 %d %s", rec.Code, rec.Body.String())
		}
		field, _ := eb.Error.Details["field"].(string)
		seen[field] = struct{}{}
	}
	if len(seen) != 1 {
		keys := make([]string, 0, len(seen))
		for k := range seen {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		t.Fatalf("同一份请求报出了多个 field %v（必须排序后取第一个，才能稳定断言与排障）", keys)
	}
	if _, ok := seen["alpha"]; !ok {
		t.Fatalf("field 应为排序后的第一个未知键 alpha，得到 %v", seen)
	}
}
