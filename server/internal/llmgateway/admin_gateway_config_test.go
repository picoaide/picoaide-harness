package llmgateway

// 网关配置（GET/PUT /api/server/admin/gateway）判据 —— 2026-09-22 新增的三个字段
// （max_file_refs / body_parse_budget_mb / file_expiry_days）与管理面的既有契约。
//
// 覆盖面：
//  1. GET 缺省回显：空库必须回显生效缺省（600 / 128 / 7），而不是空串 ——
//     "空 = 缺省"不该让管理员看见空白；
//  2. PUT 的 null 契约："缺省(null/未传)= 不覆盖"（函数自己的注释）；
//  3. PUT 的部分失败回滚：新字段写失败时排在前面的字段也必须回滚；
//  4. 非法值一律 400 且**任何字段都不落库**（拒绝不留半套配置）；
//  5. InvalidateGatewayLimits 接线：保存后运行期立即读到新值（不等 10s TTL）；
//  6. 审计旧值捕获：字段级 detail 必须是"旧→新"（含从"不存在"变成有值）。

import (
	"database/sql"
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// gwcSetting 直读 settings（绕开缓存），ok=false 表示键不存在。
func gwcSetting(t *testing.T, db *sql.DB, key string) (string, bool) {
	t.Helper()
	var v string
	switch err := db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v); {
	case err == nil:
		return v, true
	case err == sql.ErrNoRows:
		return "", false
	default:
		t.Fatalf("read setting %s: %v", key, err)
		return "", false
	}
}

// TestAdminGatewayConfigDefaultsEchoed：空库上 GET /gateway 必须回显生效缺省。
func TestAdminGatewayConfigDefaultsEchoed(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	w, out := adminReq(t, r, "GET", "/api/server/admin/gateway", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("GET gateway = %d %s", w.Code, w.Body.String())
	}
	for _, tc := range []struct {
		field string
		want  string
	}{
		{"max_file_refs", "600"},        // DefaultMaxFileRefsPerRequest（官方 vision 口径）
		{"body_parse_budget_mb", "128"}, // DefaultBodyParseBudgetMB
		{"file_expiry_days", "7"},       // DefaultFileExpiryDays
	} {
		if got, _ := out[tc.field].(string); got != tc.want {
			t.Fatalf("空库 GET %s = %v, want %q（缺省必须回显具体数字，不能是空串）", tc.field, out[tc.field], tc.want)
		}
	}
	// 缺省值与运行期生效值同源：GET 回显的 600 必须就是闸门用的那个数。
	if got := gatewayLimitsFor(db); got.maxFileRefs != DefaultMaxFileRefsPerRequest ||
		got.budgetBytes != int64(DefaultBodyParseBudgetMB)<<20 ||
		got.fileExpiry != DefaultFileExpiryDays*24*60*60*1e9 {
		t.Fatalf("空库运行期取值与回显缺省不同源: %+v", got)
	}
	// 显式存空串（"回落缺省"的写法）同样回显缺省，而不是空白。
	if err := serverstore.SetSetting(db, SettingMaxFileRefs, ""); err != nil {
		t.Fatal(err)
	}
	InvalidateGatewayLimits()
	_, out = adminReq(t, r, "GET", "/api/server/admin/gateway", "", hdr)
	if got, _ := out["max_file_refs"].(string); got != "600" {
		t.Fatalf("空串回显 = %q, want 600", got)
	}
	// 存了合法值就回显该值。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"max_file_refs":300,"body_parse_budget_mb":256,"file_expiry_days":14}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("PUT = %d %s", w.Code, w.Body.String())
	}
	_, out = adminReq(t, r, "GET", "/api/server/admin/gateway", "", hdr)
	for field, want := range map[string]string{"max_file_refs": "300", "body_parse_budget_mb": "256", "file_expiry_days": "14"} {
		if got, _ := out[field].(string); got != want {
			t.Fatalf("GET %s = %v, want %s", field, out[field], want)
		}
	}
}

// TestAdminGatewayConfigNullMeansSkip：契约明写"缺省(null/未传)= 不覆盖"。
//
// FlexibleString 实现了 json.Unmarshaler，encoding/json 会把 JSON **null** 也交给它
// （不是把指针置 nil）—— 所以它必须自己认 null，否则 `{"rate_limit":null}` 会被
// 当成"非法类型"直接 400（第三方客户端按契约回提交 null 即踩），或被当成空串把
// 已配好的值清掉。
func TestAdminGatewayConfigNullMeansSkip(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"rate_limit":"120","max_file_refs":300,"body_parse_budget_mb":256,"file_expiry_days":14,"peak_windows":"[]"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("baseline PUT = %d", w.Code)
	}
	before := map[string]string{}
	for _, k := range []string{"gateway.rate_limit", SettingMaxFileRefs, SettingBodyParseBudgetMB, SettingFileExpiryDays, serverstore.PeakWindowsSetting} {
		v, ok := gwcSetting(t, db, k)
		if !ok {
			t.Fatalf("baseline 缺少 %s", k)
		}
		before[k] = v
	}

	// 全部可空字段显式 null + 一个真正要改的字段：null 必须被当作"未提供"。
	body := `{"rate_limit":null,"max_file_refs":null,"body_parse_budget_mb":null,"file_expiry_days":null,
	          "peak_windows":null,"default_model":null,"error_reporting_enabled":null,
	          "error_reporting_level":null,"default_thinking_level":null,"server_base_url":null,
	          "retention_months":null,"error_reporting_dsn":null,"glitchtip_base_url":null,
	          "glitchtip_organization":null,"error_reporting_heartbeat":null,"default_thinking_level":null}`
	w, out := adminReq(t, r, "PUT", "/api/server/admin/gateway", body, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("全 null 的 PUT = %d %s（契约:null = 不覆盖）", w.Code, w.Body.String())
	}
	if _, hasWarn := out["warnings"]; !hasWarn {
		t.Fatalf("响应缺少 warnings 字段: %v", out)
	}
	for k, want := range before {
		if got, _ := gwcSetting(t, db, k); got != want {
			t.Fatalf("%s 被 null 改写: %q → %q（null 必须与未传同义）", k, want, got)
		}
	}
	// null 不是"空串写入"：不得留下审计噪音。
	if n := audit0919AuditRows(t, db, "gateway_config"); n != 1 {
		t.Fatalf("全 null 的 PUT 写了审计行（%d，want 1 = 只有 baseline）—— null 被当成了变更", n)
	}
	// 反向对照：同一个字段用空串是**真的要清空**（写空串 + 留审计），语义未被削弱。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"max_file_refs":""}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("空串 PUT = %d", w.Code)
	}
	if v, _ := gwcSetting(t, db, SettingMaxFileRefs); v != "" {
		t.Fatalf("显式空串应写空（回落缺省），实得 %q", v)
	}
}

// TestAdminGatewayConfigRejectsInvalidNewLimitsBeforeAnyWrite：新字段的非法值必须
// 在**任何写库之前**被拒（拒绝不留半套配置）。
func TestAdminGatewayConfigRejectsInvalidNewLimitsBeforeAnyWrite(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"rate_limit":"120"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("baseline = %d", w.Code)
	}
	cases := []struct{ name, body string }{
		{"max_file_refs=0", `{"rate_limit":"777","max_file_refs":"0"}`},
		{"max_file_refs 超上限", `{"rate_limit":"777","max_file_refs":"4097"}`},
		{"max_file_refs 非整数", `{"rate_limit":"777","max_file_refs":"abc"}`},
		{"max_file_refs 浮点", `{"rate_limit":"777","max_file_refs":12.5}`},
		{"body_parse_budget_mb 低于下限", `{"rate_limit":"777","body_parse_budget_mb":"63"}`},
		{"body_parse_budget_mb 超上限", `{"rate_limit":"777","body_parse_budget_mb":"8193"}`},
		{"body_parse_budget_mb 非整数", `{"rate_limit":"777","body_parse_budget_mb":"x"}`},
		{"file_expiry_days=0", `{"rate_limit":"777","file_expiry_days":"0"}`},
		{"file_expiry_days=31", `{"rate_limit":"777","file_expiry_days":"31"}`},
		{"file_expiry_days 负数", `{"rate_limit":"777","file_expiry_days":"-1"}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w, out := adminReq(t, r, "PUT", "/api/server/admin/gateway", c.body, hdr)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (%s)", w.Code, w.Body.String())
			}
			if e, _ := out["error"].(map[string]any); e["code"] != "VALIDATION" {
				t.Fatalf("envelope = %v, want VALIDATION", out)
			}
			if v, _ := gwcSetting(t, db, "gateway.rate_limit"); v != "120" {
				t.Fatalf("被拒的请求改写了 rate_limit: %q (want 120) —— 验证晚于写库", v)
			}
		})
	}
	// 边界值必须放行（1/30、64/8192、1/4096）。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"max_file_refs":"1","body_parse_budget_mb":"64","file_expiry_days":"1"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("下限值应放行: %d %s", w.Code, w.Body.String())
	}
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"max_file_refs":"4096","body_parse_budget_mb":"8192","file_expiry_days":"30"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("上限值应放行: %d %s", w.Code, w.Body.String())
	}
}

// TestAdminGatewayConfigNewLimitWriteFailureRollsBack：新字段写失败时整体回滚。
//
// 注入一次真实 SQLSTATE 23514（CHECK 约束）到 `gateway.max_file_refs` 上 ——
// 它排在 `gateway.rate_limit` 之后，旧实现（逐键 autocommit）会留下 rate_limit 已改
// 而 max_file_refs 未改的半套配置。
func TestAdminGatewayConfigNewLimitWriteFailureRollsBack(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"rate_limit":"120","max_file_refs":"300"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("baseline = %d (%s)", w.Code, w.Body.String())
	}
	before := map[string]string{}
	for _, k := range append([]string{}, audit0919ConfigKeys...) {
		v, _ := gwcSetting(t, db, k)
		before[k] = v
	}
	auditsBefore := audit0919AuditRows(t, db, "gateway_config")

	if _, err := db.Exec(`ALTER TABLE settings ADD CONSTRAINT gwf_maxrefs_fail CHECK (key <> '` + SettingMaxFileRefs + `' OR value <> '4096')`); err != nil {
		t.Fatalf("inject write failure: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`ALTER TABLE settings DROP CONSTRAINT IF EXISTS gwf_maxrefs_fail`) })

	w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"rate_limit":"777","max_file_refs":"4096","file_expiry_days":"3"}`, hdr)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", w.Code, w.Body.String())
	}
	for _, k := range audit0919ConfigKeys {
		if v, _ := gwcSetting(t, db, k); v != before[k] {
			t.Fatalf("%s 留下了半套配置: %q → %q", k, before[k], v)
		}
	}
	if n := audit0919AuditRows(t, db, "gateway_config"); n != auditsBefore {
		t.Fatalf("失败的请求留下审计行: %d (want %d)", n, auditsBefore)
	}
	// 反向对照：去掉约束后同一请求成功 ⇒ 三个键都落库 + 恰好 1 条新审计。
	if _, err := db.Exec(`ALTER TABLE settings DROP CONSTRAINT gwf_maxrefs_fail`); err != nil {
		t.Fatal(err)
	}
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"rate_limit":"777","max_file_refs":"4096","file_expiry_days":"3"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("control = %d (%s)", w.Code, w.Body.String())
	}
	for k, want := range map[string]string{"gateway.rate_limit": "777", SettingMaxFileRefs: "4096", SettingFileExpiryDays: "3"} {
		if v, _ := gwcSetting(t, db, k); v != want {
			t.Fatalf("成功路径未落库 %s = %q, want %q", k, v, want)
		}
	}
	if n := audit0919AuditRows(t, db, "gateway_config"); n != auditsBefore+1 {
		t.Fatalf("成功路径审计行 = %d, want %d", n, auditsBefore+1)
	}
}

// TestAdminGatewayConfigInvalidatesRuntimeLimits：保存后运行期必须**立刻**读到新值
// （gatewayLimitsFor 有 10s TTL，漏了 InvalidateGatewayLimits 会"保存成功但闸门不生效"）。
func TestAdminGatewayConfigInvalidatesRuntimeLimits(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"max_file_refs":"300","body_parse_budget_mb":"256","file_expiry_days":"14"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("baseline = %d", w.Code)
	}
	// 预热：这三条就是运行期读取路径，读一次即把旧值放进 10s TTL 缓存。
	warm := gatewayLimitsFor(db)
	if warm.maxFileRefs != 300 || warm.budgetBytes != 256<<20 || warm.fileExpiry.Hours() != 14*24 {
		t.Fatalf("预热值 = %+v, want 300/256MiB/14d", warm)
	}
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"max_file_refs":"4096","body_parse_budget_mb":"64","file_expiry_days":"1"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("save = %d %s", w.Code, w.Body.String())
	}
	got := gatewayLimitsFor(db) // 不 sleep
	if got.maxFileRefs != 4096 {
		t.Fatalf("保存后运行期仍读到旧引用上限: %d (want 4096) —— 漏了 InvalidateGatewayLimits", got.maxFileRefs)
	}
	if got.budgetBytes != int64(MinBodyParseBudgetMB)<<20 {
		t.Fatalf("保存后运行期仍读到旧内存预算: %d (want %d)", got.budgetBytes, int64(MinBodyParseBudgetMB)<<20)
	}
	if got.fileExpiry.Hours() != 24 {
		t.Fatalf("保存后运行期仍读到旧保留上限: %v (want 24h)", got.fileExpiry)
	}
}

// TestAdminGatewayConfigAuditCapturesOldValue：字段级审计必须是"旧→新"，
// 含从"键不存在"变成有值这一档（旧值捕获不能在事务里读成新值）。
func TestAdminGatewayConfigAuditCapturesOldValue(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if v, ok := gwcSetting(t, db, SettingMaxFileRefs); ok {
		t.Fatalf("前置条件不成立: %s 已经存在 (%q)", SettingMaxFileRefs, v)
	}
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"max_file_refs":"300"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("first save = %d", w.Code)
	}
	rows := gwfAudit(t, db, "gateway_config")
	if len(rows) != 1 {
		t.Fatalf("审计行 = %d, want 1 (%v)", len(rows), rows)
	}
	if !strings.Contains(rows[0], "单请求文件引用上限:(空)→300") {
		t.Fatalf("首次保存明细 = %q, want 含「单请求文件引用上限:(空)→300」", rows[0])
	}
	// 第二次改成 500：明细必须是 300→500（旧值捕获不能读成新值/空值）。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"max_file_refs":"500"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("second save = %d", w.Code)
	}
	rows = gwfAudit(t, db, "gateway_config")
	if len(rows) != 2 {
		t.Fatalf("审计行 = %d, want 2 (%v)", len(rows), rows)
	}
	if !strings.Contains(rows[1], "单请求文件引用上限:300→500") {
		t.Fatalf("第二次明细 = %q, want 含「单请求文件引用上限:300→500」", rows[1])
	}
	// 三个新字段都必须在明细里有各自的标签（字段级可追溯，不是一坨 JSON）。
	// 先显式落一遍现值，再改 —— 明细必须是"旧→新"，而不是恒"（空）→新"。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"body_parse_budget_mb":"128","file_expiry_days":"7"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("seed = %d", w.Code)
	}
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"body_parse_budget_mb":"192","file_expiry_days":"9"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("third save = %d", w.Code)
	}
	rows = gwfAudit(t, db, "gateway_config")
	last := rows[len(rows)-1]
	for _, want := range []string{"请求体加工内存预算:128→192", "文件保留上限(天):7→9"} {
		if !strings.Contains(last, want) {
			t.Fatalf("明细 = %q, want 含 %q", last, want)
		}
	}
}
