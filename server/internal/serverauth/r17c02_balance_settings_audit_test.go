package serverauth

// R17C-02 同族（审计 2026-09-25 的全仓扫描）：**改钱/改计费口径的路径，审计必须与
// 业务写在同一个事务里**。
//
// 本条钉 `PUT /api/server/admin/balance`：它写 `balance.enabled`（余额闸门开关）与
// `balance.monthly_amount` / `balance.monthly_mode`（每人每月自动到账多少、add 还是
// cover）—— 三个键**都是钱**。修前形态：`SaveBalanceSettings`（独立事务）→
// `_ = serverstore.AuditLog(...)`（fire-and-forget）⇒ 拦截这条审计时实测
// **HTTP 200 + 额度照改 + 审计 0 行 + 零回滚**。
//
// 修后：三键与审计在同一个事务（`serverstore.SaveBalanceSettingsTx` +
// `serverstore.AuditLogTx`），审计写不进去整体回滚 + 500。
//
// 判据：表级 CHECK 阻断 `balance_settings` 审计 ⇒ 5xx + 三个键逐字不变 + 审计 0 行；
// 撤掉阻断 ⇒ 200 + 审计 1 行（防"把审计整个关掉"的过度修复）。

import (
	"database/sql"
	"fmt"
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func blockBalanceSettingsAudit(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`DELETE FROM audit_logs WHERE action = 'balance_settings'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`ALTER TABLE audit_logs ADD CONSTRAINT r17c02_block_bs CHECK (action <> 'balance_settings')`); err != nil {
		t.Fatalf("加阻断约束失败（判据根本咬不到）: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO audit_logs (username, action, detail) VALUES ('probe','balance_settings','probe')`); err == nil {
		t.Fatal("阻断约束没有生效（直插 balance_settings 成功了）⇒ 下面的断言会假绿")
	}
}

func unblockBalanceSettingsAudit(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS r17c02_block_bs`); err != nil {
		t.Fatalf("去掉阻断约束失败: %v", err)
	}
}

// countAuditAction 统计某 action 的审计行数（跨包同名 helper，这里自带一份，
// 避免测试之间互相依赖实现细节）。
func countAuditAction(t *testing.T, db *sql.DB, action string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action = ?`, action).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// balanceSettingsSnapshot 是"必须逐字不变"的观测面：三个设置键 + 生效值。
func balanceSettingsSnapshot(t *testing.T, db *sql.DB) string {
	t.Helper()
	s, err := serverstore.GetBalanceSettings(db)
	if err != nil {
		t.Fatalf("读余额设置: %v", err)
	}
	return fmt.Sprintf("enabled=%v amount=%.2f mode=%s", s.Enabled, s.MonthlyAmount, s.MonthlyMode)
}

func TestBalanceSettingsAuditIsSameTransactionAsMoneyKnobs(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	hdr := adminSession(t, r)

	// A 段（对照）：正常保存 ⇒ 200 + 设置生效 + 审计 1 行。
	w, _ := doJSON(t, r, "PUT", "/api/server/admin/balance",
		`{"enabled":true,"monthly_amount":100,"monthly_mode":"add"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("A 段 PUT = %d %s, want 200", w.Code, w.Body.String())
	}
	if got := balanceSettingsSnapshot(t, db); got != "enabled=true amount=100.00 mode=add" {
		t.Fatalf("A 段设置 = %q", got)
	}
	if n := countAuditAction(t, db, "balance_settings"); n != 1 {
		t.Fatalf("A 段审计行 = %d, want 1（对照段不成立，后面的判据就没有意义）", n)
	}
	before := balanceSettingsSnapshot(t, db)

	// B 段（注入）：阻断 balance_settings 审计 ⇒ 额度不得被改。
	blockBalanceSettingsAudit(t, db)
	defer unblockBalanceSettingsAudit(t, db)

	w, _ = doJSON(t, r, "PUT", "/api/server/admin/balance",
		`{"enabled":false,"monthly_amount":200,"monthly_mode":"cover"}`, hdr)
	if w.Code == http.StatusOK {
		t.Fatalf("审计被阻断时 PUT 仍 200（修前形态：额度照改、审计 0 行、零回滚）body=%s", w.Body.String())
	}
	if w.Code < 500 {
		t.Fatalf("审计写失败应按服务端错误回报，得到 %d %s", w.Code, w.Body.String())
	}
	if got := balanceSettingsSnapshot(t, db); got != before {
		t.Fatalf("审计写失败但余额设置被改了: %q → %q —— 钱的口径动了却没留痕", before, got)
	}
	if n := countAuditAction(t, db, "balance_settings"); n != 0 {
		t.Fatalf("被阻断的审计居然落了 %d 行（注入失效）", n)
	}

	// C 段（恢复）：撤掉阻断后同一个请求必须成功。
	unblockBalanceSettingsAudit(t, db)
	w, _ = doJSON(t, r, "PUT", "/api/server/admin/balance",
		`{"enabled":false,"monthly_amount":200,"monthly_mode":"cover"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("C 段（撤掉阻断后）PUT = %d %s, want 200", w.Code, w.Body.String())
	}
	if got := balanceSettingsSnapshot(t, db); got != "enabled=false amount=200.00 mode=cover" {
		t.Fatalf("C 段设置 = %q", got)
	}
	if n := countAuditAction(t, db, "balance_settings"); n != 1 {
		t.Fatalf("C 段审计行 = %d, want 1", n)
	}
}
