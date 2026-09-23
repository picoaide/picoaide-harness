package llmgateway

// 审计 2026-09-19(N2):setGatewayConfig 的审计必须**先于**破坏性清理落库。
//
// 缺陷形态(本次改动引入,已实测复现):配置写入已收进单一事务,但 AuditLog
// 仍在 `CleanupUsageRetention` **之后**调用 ⇒ 清理失败(500「保留清理失败」)
// 时配置**已经提交生效**,却没有任何审计记录("谁改了保留期"查不到;
// 红队实测 gateway_config 审计行 delta=0)。
//
// 修法:把 `if len(changes) > 0 { AuditLog(...) }` 提到 InvalidateSettings()
// 之后、CleanupUsageRetention **之前** —— 配置已提交 ⇒ 审计必须落;清理失败
// 不影响"谁改了什么"的可追溯性。清理失败的 500 文案与语义不变。
//
// 判据:清理失败仍是 500「保留清理失败」+ 配置确实已生效 + 审计行**已落**且
// detail 与同一变更在成功路径下的 detail 逐字一致。

import (
	"database/sql"
	"net/http"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// nacAuditRows 数 gateway_config 的审计行数,并返回最新一行的 detail。
func nacAuditRows(t *testing.T, db *sql.DB) (int, string) {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action = 'gateway_config'`).Scan(&n); err != nil {
		t.Fatalf("count audit rows: %v", err)
	}
	var detail string
	if err := db.QueryRow(`SELECT detail FROM audit_logs WHERE action = 'gateway_config' ORDER BY id DESC LIMIT 1`).Scan(&detail); err != nil {
		return n, "<none>"
	}
	return n, detail
}

// nacSetting 直读 settings(绕开缓存),缺失记为 "<absent>"。
func nacSetting(t *testing.T, db *sql.DB, key string) string {
	t.Helper()
	var v string
	switch err := db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v); {
	case err == nil:
		return v
	case err == sql.ErrNoRows:
		return "<absent>"
	default:
		t.Fatalf("read setting %s: %v", key, err)
		return ""
	}
}

// nacMonthRelation 返回 CleanupUsageRetention 在给定保留月数下**第一个**访问
// 的月份关系名(loop 起点 = 当前北京月 - n - 1,逐月向前直到缺表即停)。
func nacMonthRelation(n int) string {
	return "usage_" + serverstore.BeijingMonth(time.Now()).AddDate(0, -n-1, 0).Format("200601")
}

// nacInjectCleanupFailure 造一个"必然让清理失败"的形态：一个**视图依赖**该月的
// usage 分区 ⇒ `ALTER TABLE usage DETACH PARTITION` 成功后 `DROP TABLE` 报
// 2BP01（cannot drop table … because other objects depend on it）。
//
// 为什么不沿用"同名 VIEW 占名"（旧夹具）：R6-A-1（审计 2026-09-23）之后清理按
// relkind 分流，占用月名的视图会被 `DROP VIEW` **清掉**（那正是修好的行为），
// 不再是失败 —— 判据会退化成"注入没生效"而不是"清理失败"。依赖视图是同一族
// 里**仍然**让清理失败、且运维真会做出来的形态（建报表视图）。
//
// 返回（解除注入的函数, 依赖视图名）。
func nacInjectCleanupFailure(t *testing.T, db *sql.DB, rel string) (func(), string) {
	t.Helper()
	// 依赖视图必须挂在**真分区**上：只有 DETACH+DROP 真分区这条路径才会撞依赖。
	var isPartition bool
	var kind string
	if err := db.QueryRow(`SELECT c.relispartition, c.relkind FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = ? AND n.nspname = 'public'`, rel).Scan(&isPartition, &kind); err != nil {
		t.Fatalf("探测注入目标 %s: %v", rel, err)
	}
	if !isPartition || kind != "r" {
		t.Fatalf("夹具失效：%s 不是挂在 usage 下的叶子分区(is_partition=%t kind=%q)，"+
			"依赖视图无法制造 DROP 失败（测试库预建分区窗口变了吗？）", rel, isPartition, kind)
	}
	view := rel + "_report_view"
	_, _ = db.Exec(`DROP VIEW IF EXISTS ` + view)
	if _, err := db.Exec(`CREATE VIEW ` + view + ` AS SELECT count(*) AS n FROM ` + rel); err != nil {
		t.Fatalf("建依赖视图 %s: %v", view, err)
	}
	return func() { _, _ = db.Exec(`DROP VIEW IF EXISTS ` + view) }, view
}

// TestGatewayConfigAuditLandsBeforeRetentionCleanupFails(N2):清理失败 500 时
// 审计必须已落,detail 与成功路径逐字一致,且配置确实已提交生效。
func TestGatewayConfigAuditLandsBeforeRetentionCleanupFails(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 基线:保留 6 个月(第一次成功保存 ⇒ 1 条审计)。此轮清理只访问 6 个月前的
	// 月份,不会碰到下面要注入的"当前月-3"。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"retention_months":"6"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("baseline retention: %d %s", w.Code, w.Body.String())
	}
	if n, detail := nacAuditRows(t, db); n != 1 || detail != "明细保留:(空)→6" {
		t.Fatalf("基线审计 = %d/%q, want 1/\"明细保留:(空)→6\"", n, detail)
	}

	// 注入:retention=2 时清理的第一个访问月份 = 当前月-3,让一个视图依赖它。
	rel := nacMonthRelation(2)
	dropView, view := nacInjectCleanupFailure(t, db, rel)
	defer dropView()

	w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"retention_months":"2"}`, hdr)
	// ① 500 文案与语义不变。
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("清理失败应 500,得到 %d %s", w.Code, w.Body.String())
	}
	if got, want := w.Body.String(), `{"error":{"code":"INTERNAL","message":"保留清理失败"}}`; got != want {
		t.Fatalf("500 响应体 = %s, want %s", got, want)
	}
	// ② 清理确实失败了(注入的依赖视图还在 ⇒ DROP TABLE 报 2BP01)。
	var kind string
	if err := db.QueryRow(`SELECT relkind FROM pg_class WHERE relname = ? AND relnamespace = 'public'::regnamespace`, view).Scan(&kind); err != nil || kind != "v" {
		t.Fatalf("注入的依赖视图 %s 不在了(说明失败不是来自注入): kind=%q err=%v", view, kind, err)
	}
	// ③ 配置已提交生效(库值 + 运行期读取路径)。
	if v := nacSetting(t, db, serverstore.RetentionMonthsSetting); v != "2" {
		t.Fatalf("配置未提交(保留期 = %q, want 2) —— 事务顺序被改坏", v)
	}
	if n, err := serverstore.EffectiveRetentionMonths(db); err != nil || n != 2 {
		t.Fatalf("运行期读到旧保留期: %d/%v, want 2", n, err)
	}
	// ④ 审计行**已落**,且 detail 与成功路径逐字一致(N2 的核心判据)。
	n, detail := nacAuditRows(t, db)
	if n != 2 {
		t.Fatalf("清理失败路径零审计(行数 = %d, want 2) —— AuditLog 仍在 cleanup 之后", n)
	}
	if detail != "明细保留:6→2" {
		t.Fatalf("失败路径审计 detail = %q, want %q", detail, "明细保留:6→2")
	}

	// 对照组:同一变更(6→2)在成功路径下的 detail 必须与上面逐字相同。
	dropView()
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"retention_months":"6"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("恢复保留期 6: %d %s", w.Code, w.Body.String())
	}
	w, _ = adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"retention_months":"2"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("成功路径同一变更应 200,得到 %d %s", w.Code, w.Body.String())
	}
	n2, okDetail := nacAuditRows(t, db)
	if n2 != 4 {
		t.Fatalf("成功路径审计行 = %d, want 4", n2)
	}
	if okDetail != detail {
		t.Fatalf("同一变更在成功/失败路径下的 detail 不一致: 成功=%q 失败=%q", okDetail, detail)
	}
}
