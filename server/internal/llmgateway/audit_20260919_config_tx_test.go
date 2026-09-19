package llmgateway

// 审计 2026-09-19(P2-1):setGatewayConfig 的 12 处写库收进单一事务。
//
// 缺陷形态(既有,已实测复现):函数无事务、逐键 autocommit ⇒ 任一字段写失败
// (实测:在 settings 上加 CHECK 约束让 web.error_reporting_level 必然写失败)
// 时返回 500「保存失败」,但**排在前面的字段已经落库生效**,而 AuditLog 只在
// 函数末尾调一次 ⇒ 改配置的人查不到任何审计。`retention_months` 之后还紧跟
// **破坏性**的 CleanupUsageRetention(DROP 过期分区),半套配置的代价更大。
//
// 修法:Begin + defer Rollback + 逐键 SetSettingTx + Commit;提交后
// InvalidateSettings()(SetSettingTx 有意不失效缓存,漏了会"保存成功但运行期
// 读到旧值");CleanupUsageRetention 移出事务、放在提交之后,且仅在显式提交
// retention_months 时执行。
//
// 判据:500 路径一个键都不许落库、不留审计、不执行破坏性清理;成功路径逐字
// 不变;提交后运行期读取(限流/保留期)必须立刻看到新值。

import (
	"database/sql"
	"net/http"
	"reflect"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// audit0919ConfigKeys 是 setGatewayConfig 会写的 12 个 settings 键
// (与 temp/verify-60ceaa 的探针同一集合,便于两边结果对拍)。
var audit0919ConfigKeys = []string{
	"gateway.default_model",
	"gateway.rate_limit",
	serverstore.PeakWindowsSetting,
	serverstore.RetentionMonthsSetting,
	"web.error_reporting_dsn",
	"web.error_reporting_enabled",
	"web.error_reporting_level",
	"web.error_reporting_heartbeat",
	"web.glitchtip_base_url",
	"web.glitchtip_organization",
	"web.default_thinking_level",
	"server.base_url",
}

// audit0919Snapshot 读全部 12 个键的现值。直读 SQL(绕开 settings 缓存),
// 缺失记为 "<absent>" —— 与"存在但为空"区分,半套配置的判据正是"键被动过没有"。
func audit0919Snapshot(t *testing.T, db *sql.DB) map[string]string {
	t.Helper()
	out := make(map[string]string, len(audit0919ConfigKeys))
	for _, k := range audit0919ConfigKeys {
		var v string
		switch err := db.QueryRow(`SELECT value FROM settings WHERE key = ?`, k).Scan(&v); {
		case err == nil:
			out[k] = v
		case err == sql.ErrNoRows:
			out[k] = "<absent>"
		default:
			t.Fatalf("read setting %s: %v", k, err)
		}
	}
	return out
}

// audit0919AuditRows 数某个 action 的审计行数。
func audit0919AuditRows(t *testing.T, db *sql.DB, action string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action = ?`, action).Scan(&n); err != nil {
		t.Fatalf("count audit rows: %v", err)
	}
	return n
}

// audit0919TableExists 判断某表/分区是否存在。
func audit0919TableExists(t *testing.T, db *sql.DB, name string) bool {
	t.Helper()
	var ok bool
	if err := db.QueryRow(`SELECT to_regclass(?) IS NOT NULL`, "public."+name).Scan(&ok); err != nil {
		t.Fatalf("to_regclass %s: %v", name, err)
	}
	return ok
}

// audit0919InjectLevelWriteFailure 在 DB 层注入一次真实写库失败:凡是写
// web.error_reporting_level 且值非空就违反 CHECK 约束。它是本文件所有
// "中途失败"用例的故障源(不是桩函数,是真实 SQLSTATE 23514)。
func audit0919InjectLevelWriteFailure(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`ALTER TABLE settings ADD CONSTRAINT audit0919_level_fail CHECK (key <> 'web.error_reporting_level' OR length(value) < 1)`); err != nil {
		t.Fatalf("inject write failure: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`ALTER TABLE settings DROP CONSTRAINT IF EXISTS audit0919_level_fail`)
	})
}

// TestSetGatewayConfigWriteFailureRollsBackEverything:500 路径不得留半套配置,
// 也不得留审计(本次请求什么都没生效)。
func TestSetGatewayConfigWriteFailureRollsBackEverything(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 基线:一次成功保存(rate_limit=120),拿到"不该被失败请求改写"的现值。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"rate_limit":"120"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("baseline: %d %s", w.Code, w.Body.String())
	}
	before := audit0919Snapshot(t, db)
	if before["gateway.rate_limit"] != "120" {
		t.Fatalf("baseline rate_limit = %q, want 120", before["gateway.rate_limit"])
	}
	if n := audit0919AuditRows(t, db, "gateway_config"); n != 1 {
		t.Fatalf("baseline 审计行 = %d, want 1", n)
	}

	// 注入真实写库失败:error_reporting_level 排在 rate_limit 之后。
	audit0919InjectLevelWriteFailure(t, db)

	w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"rate_limit":"777","error_reporting_level":"warning"}`, hdr)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body=%s)", w.Code, w.Body.String())
	}
	// 500 响应体逐字不变。
	if got, want := w.Body.String(), `{"error":{"code":"INTERNAL","message":"保存失败"}}`; got != want {
		t.Fatalf("500 响应体 = %s, want %s", got, want)
	}
	// 半套配置:一个键都不许落库(此前 rate_limit 已经变成 777)。
	if after := audit0919Snapshot(t, db); !reflect.DeepEqual(after, before) {
		t.Fatalf("失败的请求留下了半套配置:\n before=%v\n after =%v", before, after)
	}
	// 已落库字段零审计是 P2-1 的另一半:失败的请求不得留审计行。
	if n := audit0919AuditRows(t, db, "gateway_config"); n != 1 {
		t.Fatalf("失败的请求留下了审计行: %d (want 1 = 只有基线)", n)
	}

	// 反向对照:故障去掉后同一请求成功 ⇒ 两个键都落库 + 恰好 1 条新审计。
	if _, err := db.Exec(`ALTER TABLE settings DROP CONSTRAINT audit0919_level_fail`); err != nil {
		t.Fatal(err)
	}
	w2, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"rate_limit":"777","error_reporting_level":"warning"}`, hdr)
	if w2.Code != http.StatusOK {
		t.Fatalf("control status = %d, want 200 (%s)", w2.Code, w2.Body.String())
	}
	after := audit0919Snapshot(t, db)
	if after["gateway.rate_limit"] != "777" || after["web.error_reporting_level"] != "warning" {
		t.Fatalf("成功路径未落库: rate_limit=%q level=%q", after["gateway.rate_limit"], after["web.error_reporting_level"])
	}
	if n := audit0919AuditRows(t, db, "gateway_config"); n != 2 {
		t.Fatalf("成功路径审计行 = %d, want 2", n)
	}
}

// TestSetGatewayConfigRetentionNotAppliedWhenLaterWriteFails:保留月数与其它键
// 同事务 —— 后续字段写失败时 retention 也必须回滚,且**破坏性清理不得执行**。
// 旧实现里 retention 已落库、CleanupUsageRetention 已经 DROP 掉过期分区。
func TestSetGatewayConfigRetentionNotAppliedWhenLaterWriteFails(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 测试库预建了 2026-01 起的分区;retention=1 时它落在保留期外,会被清理。
	if !audit0919TableExists(t, db, "usage_202601") {
		t.Fatal("前置条件不成立:测试库没有 usage_202601 分区")
	}
	before := audit0919Snapshot(t, db)

	audit0919InjectLevelWriteFailure(t, db)

	w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"retention_months":"1","error_reporting_level":"warning"}`, hdr)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body=%s)", w.Code, w.Body.String())
	}
	if got := audit0919Snapshot(t, db); !reflect.DeepEqual(got, before) {
		t.Fatalf("失败的请求写入了 retention(事务未回滚):\n before=%v\n after =%v", before, got)
	}
	if !audit0919TableExists(t, db, "usage_202601") {
		t.Fatal("失败的请求执行了破坏性清理:usage_202601 已被 DROP")
	}
}

// TestSetGatewayConfigSavedValuesVisibleByRuntimeReaders:SetSettingTx 不失效
// 缓存 ⇒ 提交后必须显式 InvalidateSettings(),否则保存成功但运行期读到旧值
// (配置静默不生效)。这里用**运行期真实读取路径**验证:
//   - (*API).rateLimitPerMinute → serverstore.GetSetting("gateway.rate_limit")
//   - serverstore.EffectiveRetentionMonths → CleanupUsageRetention 的输入
//   - serverstore.GetSetting(PeakWindowsSetting) → serverstore.loadPeakWindows
func TestSetGatewayConfigSavedValuesVisibleByRuntimeReaders(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"rate_limit":"120","retention_months":"6","peak_windows":"[]"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("baseline: %d %s", w.Code, w.Body.String())
	}
	// 预热缓存:这三条就是运行期读取路径,读一次即把旧值放进 settings 缓存。
	api := &API{DB: db}
	if got := api.rateLimitPerMinute(); got != 120 {
		t.Fatalf("预热 rateLimitPerMinute = %d, want 120", got)
	}
	if n, err := serverstore.EffectiveRetentionMonths(db); err != nil || n != 6 {
		t.Fatalf("预热 EffectiveRetentionMonths = %d/%v, want 6", n, err)
	}
	if v, _, err := serverstore.GetSetting(db, serverstore.PeakWindowsSetting); err != nil || v != "[]" {
		t.Fatalf("预热 peak_windows = %q/%v, want []", v, err)
	}

	w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"rate_limit":"432","retention_months":"3","peak_windows":"[{\"start\":\"09:00\",\"end\":\"12:00\"}]"}`,
		hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	// 立刻(不 sleep、不等 TTL 过期)经运行期读取路径取值。
	if got := api.rateLimitPerMinute(); got != 432 {
		t.Fatalf("保存后运行期仍读到旧限流: %d (want 432) —— 提交后漏了 InvalidateSettings", got)
	}
	if n, err := serverstore.EffectiveRetentionMonths(db); err != nil || n != 3 {
		t.Fatalf("保存后运行期仍读到旧保留期: %d/%v (want 3)", n, err)
	}
	if v, _, err := serverstore.GetSetting(db, serverstore.PeakWindowsSetting); err != nil || v != `[{"start":"09:00","end":"12:00"}]` {
		t.Fatalf("保存后运行期仍读到旧高峰时段: %q/%v", v, err)
	}
}

// TestSetGatewayConfigRetentionCleanupRunsAfterCommit:破坏性清理仍然执行
// (只是移到了提交之后),且只在显式提交 retention_months 时执行。
func TestSetGatewayConfigRetentionCleanupRunsAfterCommit(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if !audit0919TableExists(t, db, "usage_202601") {
		t.Fatal("前置条件不成立:测试库没有 usage_202601 分区")
	}
	// 不提交 retention_months ⇒ 不清理。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"rate_limit":"121"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("save without retention: %d %s", w.Code, w.Body.String())
	}
	if !audit0919TableExists(t, db, "usage_202601") {
		t.Fatal("未提交 retention_months 却执行了清理")
	}
	// 显式提交 retention_months=1 ⇒ 提交后清理生效(2026-01 在保留期外)。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"retention_months":"1"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("save retention: %d %s", w.Code, w.Body.String())
	}
	if audit0919TableExists(t, db, "usage_202601") {
		t.Fatal("提交 retention_months 后清理没有执行(usage_202601 仍在)")
	}
	// 清库不影响本次提交的配置本身。
	if v, _, _ := serverstore.GetSetting(db, serverstore.RetentionMonthsSetting); v != "1" {
		t.Fatalf("retention = %q, want 1", v)
	}
}
