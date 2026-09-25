package llmgateway

// R17C-02（审计 2026-09-25，P1）：`PUT /api/server/admin/gateway` 改**峰谷计费窗口**
// 与审计不在同一个事务里，且审计是事务外的 fire-and-forget。
//
// 缺陷形态（修前实测，真 HTTP + 真 PG）：
//
//	A 段（对照）：PUT peak_windows=09-12 ⇒ 200，settings 已改，audit gateway_config = 1 行
//	B 段（表级 CHECK 阻断 gateway_config 审计）：
//	              PUT peak_windows=08-20 ⇒ **200，settings 已改成 08-20，audit = 0 行，零回滚**
//
// 为什么这算"钱"而不是"配置"：`usage.peak_windows` 与模型的 `offpeak_discount`
// 一起决定每一次调用的费用（高峰 1×、低谷折扣）—— 把窗口从 09:00-12:00 改成
// 08:00-20:00 等于把一天里 6 小时从低谷价挪进高峰价，**每一次后续调用的钱都随它变**。
// 与 R16C-01 收口的 `updateModel`（改价）同类。
//
// 判据（本文件）：阻断 `gateway_config` 的审计写入 ⇒ PUT 必须 5xx、设置逐字不变、
// 审计 0 行；不阻断时照旧 200 + 审计 1 行（防"把审计路径整个关掉"的过度修复）。

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"testing"
)

// r17c02PeakWindow 是本次提交的窗口值（与 A 段不同，便于断言"改没改"）。
const r17c02PeakWindow = `[{"start":"08:00","end":"20:00"}]`

// gatewayPutBody 造一个合法的 PUT /gateway 请求体（peak_windows 是 JSON **字符串**
// 字段，内层引号必须转义 —— 手拼会得到 400「请求体错误」，判据就咬错地方了）。
func gatewayPutBody(t *testing.T, peakWindows string) string {
	t.Helper()
	raw, err := json.Marshal(map[string]string{"peak_windows": peakWindows})
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// blockGatewayConfigAudit 用表级 CHECK 精确阻断 gateway_config 的审计写入。
//
// 先删存量行 —— ADD CONSTRAINT 会校验既有行，"表里已有同 action 的审计"时约束
// 根本加不上，而不加约束的注入会让"审计 0 行"的断言假绿（R16 的探针踩过同一点）。
// 加完立刻自检约束真的生效（否则判据咬不到）。
func blockGatewayConfigAudit(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`DELETE FROM audit_logs WHERE action = 'gateway_config'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`ALTER TABLE audit_logs ADD CONSTRAINT r17c02_block_gc CHECK (action <> 'gateway_config')`); err != nil {
		t.Fatalf("加阻断约束失败（判据根本咬不到）: %v", err)
	}
	// 自检：直接插一行必须被拒 —— 证明这条约束真的在挡，而不是名字撞了/没加上。
	if _, err := db.Exec(`INSERT INTO audit_logs (username, action, detail) VALUES ('probe','gateway_config','probe')`); err == nil {
		t.Fatal("阻断约束没有生效（直插 gateway_config 成功了）⇒ 下面的断言会假绿")
	}
}

func unblockGatewayConfigAudit(t *testing.T, db *sql.DB) {
	t.Helper()
	// IF EXISTS：C 段会主动撤一次，defer 再撤一次（幂等，不因"已经撤了"报错）。
	if _, err := db.Exec(`ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS r17c02_block_gc`); err != nil {
		t.Fatalf("去掉阻断约束失败: %v", err)
	}
}

func countAuditAction(t *testing.T, db *sql.DB, action string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action = ?`, action).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// TestGatewayConfigAuditIsSameTransactionAsBillingWindow 是 R17C-02 的核心判据。
func TestGatewayConfigAuditIsSameTransactionAsBillingWindow(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// A 段（对照）：正常写入 ⇒ 200 + 设置生效 + 审计 1 行。
	const firstWindow = `[{"start":"09:00","end":"12:00"}]`
	w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", gatewayPutBody(t, firstWindow), hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("A 段 PUT = %d %s, want 200", w.Code, w.Body.String())
	}
	if got, _ := gwcSetting(t, db, "usage.peak_windows"); got != firstWindow {
		t.Fatalf("A 段设置 = %q, want 09:00-12:00", got)
	}
	if n := countAuditAction(t, db, "gateway_config"); n != 1 {
		t.Fatalf("A 段审计行 = %d, want 1（对照段不成立，后面的判据就没有意义）", n)
	}

	// B 段（注入）：阻断 gateway_config 审计 ⇒ 计费窗口**不得**被改。
	blockGatewayConfigAudit(t, db)
	defer unblockGatewayConfigAudit(t, db)

	w, _ = adminReq(t, r, "PUT", "/api/server/admin/gateway", gatewayPutBody(t, r17c02PeakWindow), hdr)
	if w.Code == http.StatusOK {
		t.Fatalf("审计被阻断时 PUT 仍返回 200（修前形态：配置照改、审计 0 行、零回滚）body=%s", w.Body.String())
	}
	if w.Code < 500 {
		t.Fatalf("审计写失败应按服务端错误回报，得到 %d %s", w.Code, w.Body.String())
	}
	if got, _ := gwcSetting(t, db, "usage.peak_windows"); got != firstWindow {
		t.Fatalf("审计写失败但峰谷窗口被改了: %q —— 计费口径动了却没留痕", got)
	}
	if n := countAuditAction(t, db, "gateway_config"); n != 0 {
		t.Fatalf("被阻断的审计居然落了 %d 行（注入失效）", n)
	}

	// C 段（恢复）：撤掉约束后同一个请求必须成功 —— 证明 B 段的失败来自"审计写不进去"，
	// 而不是这个端点从此坏了（防过度修复 / 防假红）。
	unblockGatewayConfigAudit(t, db)
	w, _ = adminReq(t, r, "PUT", "/api/server/admin/gateway", gatewayPutBody(t, r17c02PeakWindow), hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("C 段（撤掉阻断后）PUT = %d %s, want 200", w.Code, w.Body.String())
	}
	if got, _ := gwcSetting(t, db, "usage.peak_windows"); got != r17c02PeakWindow {
		t.Fatalf("C 段设置 = %q, want %s", got, r17c02PeakWindow)
	}
	if n := countAuditAction(t, db, "gateway_config"); n != 1 {
		t.Fatalf("C 段审计行 = %d, want 1", n)
	}
}
