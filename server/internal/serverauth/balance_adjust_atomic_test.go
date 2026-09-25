package serverauth

// R16C-01 同族（审计 2026-09-25，P1 的全仓扫描）：**改钱**的路径不允许
// "钱动了、没人知道是谁动的"。
//
// 扫描结论：修前有两处 `_ = serverstore.AuditLog(...)` 落在"改配置即改钱"的写路径上
// —— `PUT /models/:id`（价格）与 `POST /users/:id/balance`（**直接动钱**）。两者的
// 业务写各自提交、审计在事务外 fire-and-forget ⇒ 只让那条审计写不进去时，请求 200、
// 余额真的变了、审计 0 行、日志 0 行。
//
// 本文件钉余额调整这一条：审计写不进去 ⇒ 5xx + 余额/账本**逐字不变**。

import (
	"database/sql"
	"fmt"
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// blockBalanceAudit 用表级 CHECK 精确阻断 balance_adjust 的审计写入。
// 先删存量行 —— ADD CONSTRAINT 会校验既有行，表里已有同 action 的审计时约束加不上
// （探针踩过：约束没加上 ⇒ "审计 0 行"的断言假绿）。
func blockBalanceAudit(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`DELETE FROM audit_logs WHERE action = 'balance_adjust'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`ALTER TABLE audit_logs ADD CONSTRAINT r16c_block_balance_adjust CHECK (action <> 'balance_adjust')`); err != nil {
		t.Fatalf("加阻断约束失败（判据根本咬不到）: %v", err)
	}
}

// balanceAndLedger 是"操作前后必须逐字一致"的观测面：余额 + 流水条数 + 流水金额合计。
func balanceAndLedger(t *testing.T, db *sql.DB, userID int64) string {
	t.Helper()
	u, err := serverstore.GetUserByID(db, userID)
	if err != nil {
		t.Fatalf("读用户: %v", err)
	}
	var n int
	var sum float64
	if err := db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(amount),0) FROM balance_ledger WHERE user_id = ?`, userID).
		Scan(&n, &sum); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("balance=%.9f ledger_rows=%d ledger_sum=%.9f", u.BalanceMoney, n, sum)
}

// adminLoginHdr 走真实登录路径拿会话 + CSRF（与 admin_test.go 的其它用例同款）。
func adminLoginHdr(t *testing.T, r http.Handler) map[string]string {
	t.Helper()
	w, out := doJSON(t, r, "POST", "/api/server/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("admin login: %d %s", w.Code, w.Body.String())
	}
	csrf, _ := out["csrf_token"].(string)
	sess := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == sessionCookieName {
			sess = ck.Value
		}
	}
	if csrf == "" || sess == "" {
		t.Fatal("登录未拿到 csrf/session")
	}
	return map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
}

func TestAdminBalanceAdjustAuditFailureRollsBackMoney(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	hdr := adminLoginHdr(t, r)

	// 目标员工 + 初始余额（首次入账即开通）。
	if w, _ := doJSON(t, r, "POST", "/api/server/admin/users", `{"username":"emp","password":"tenchars12"}`, hdr); w.Code != http.StatusCreated {
		t.Fatalf("建员工: %d %s", w.Code, w.Body.String())
	}
	var empID int64
	if err := db.QueryRow(`SELECT id FROM users WHERE username = 'emp'`).Scan(&empID); err != nil {
		t.Fatal(err)
	}
	if w, _ := doJSON(t, r, "POST", fmt.Sprintf("/api/server/admin/users/%d/balance", empID),
		`{"mode":"set","amount":10,"reason":"init"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("初始入账: %d %s", w.Code, w.Body.String())
	}
	before := balanceAndLedger(t, db, empID)

	blockBalanceAudit(t, db)
	w, out := doJSON(t, r, "POST", fmt.Sprintf("/api/server/admin/users/%d/balance", empID),
		`{"mode":"add","amount":100,"reason":"r16c-probe"}`, hdr)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("审计写不进去时状态 = %d %s, want 500 —— 加钱必须与审计同事务", w.Code, w.Body.String())
	}
	if errObj, ok := out["error"].(map[string]any); !ok || errObj["code"] != "INTERNAL" {
		t.Fatalf("失败响应不是 INTERNAL 信封: %s", w.Body.String())
	}
	if after := balanceAndLedger(t, db, empID); after != before {
		t.Fatalf("审计失败却动了钱:\n before=%s\n after =%s", before, after)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action='balance_adjust'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("被阻断的审计竟然落库: %d 行", n)
	}

	// 正向对照：解除阻断后必须 200 + 加钱 + 落一条审计。
	if _, err := db.Exec(`ALTER TABLE audit_logs DROP CONSTRAINT r16c_block_balance_adjust`); err != nil {
		t.Fatal(err)
	}
	if w, _ := doJSON(t, r, "POST", fmt.Sprintf("/api/server/admin/users/%d/balance", empID),
		`{"mode":"add","amount":100,"reason":"r16c-probe"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("正常加钱: %d %s", w.Code, w.Body.String())
	}
	after := balanceAndLedger(t, db, empID)
	if after == before {
		t.Fatal("正常路径没有改动余额（上面的\"零副作用\"可能是整个写路径坏了造成的假绿）")
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action='balance_adjust'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("正常路径 balance_adjust 审计 = %d 行, want 1", n)
	}
	// 账本不变量仍成立（I1）：余额 == 流水合计。
	u, err := serverstore.GetUserByID(db, empID)
	if err != nil {
		t.Fatal(err)
	}
	var sum float64
	if err := db.QueryRow(`SELECT COALESCE(SUM(amount),0) FROM balance_ledger WHERE user_id = ?`, empID).Scan(&sum); err != nil {
		t.Fatal(err)
	}
	if diff := u.BalanceMoney - sum; diff > 1e-6 || diff < -1e-6 {
		t.Fatalf("账本不变量被破坏: balance=%v ledger_sum=%v", u.BalanceMoney, sum)
	}
}
