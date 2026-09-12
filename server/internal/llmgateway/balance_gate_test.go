package llmgateway

import (
	"database/sql"
	"encoding/json"
	"math"
	"net/http"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// 余额闸门回归(2026-09-11):此前 QUOTA_EXCEEDED 只有 token/金额配额/部门预算
// 的用例,唯一真正"硬"的余额闸门在网关这一步完全没测(审计 P4)。
// 规则只有一条:闸门开启 且 **已开通** 余额账户 且 分位余额 <= 0 → 429。

func activateBalance(t *testing.T, db *sql.DB, uid int64, amount float64) {
	t.Helper()
	if _, err := serverstore.SetUserBalance(db, uid, amount, "test", "tester"); err != nil {
		t.Fatal(err)
	}
}

func enableBalanceGate(t *testing.T, db *sql.DB, enabled bool) {
	t.Helper()
	if err := serverstore.SaveBalanceSettings(db, serverstore.BalanceSettings{
		Enabled: enabled, MonthlyAmount: 0, MonthlyMode: serverstore.BalanceModeAdd,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestBalanceGateBlocksWhenExhausted(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	activateBalance(t, db, 1, 1) // 开通
	activateBalance(t, db, 1, 0) // 花光(余额 0)

	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 (body=%s)", w.Code, w.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if code := out["error"].(map[string]any)["code"]; code != "BALANCE_EXHAUSTED" {
		t.Fatalf("code = %v, want BALANCE_EXHAUSTED", code)
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("upstream calls = %d, want 0 (拦截必须发生在转发前)", n)
	}
}

// 分位口径:P3 —— 余额 0.004 显示 ¥0.00,判定必须与展示一致地拦截。
func TestBalanceGateUsesCentQuantizedValue(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	if _, err := serverstore.SetUserBalance(db, 1, 1, "", "tester"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE users SET balance_money = 0.004 WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	if w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil); w.Code != http.StatusTooManyRequests {
		t.Fatalf("余额 0.004(展示 ¥0.00)= %d, want 429", w.Code)
	}
	// 0.006 → 展示 ¥0.01 → 放行
	if _, err := db.Exec(`UPDATE users SET balance_money = 0.006 WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	if w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil); w.Code != http.StatusOK {
		t.Fatalf("余额 0.006(展示 ¥0.01)= %d, want 200", w.Code)
	}
}

// 未开通余额账户的员工不受闸门约束(存量部署开启闸门不会误拦全员)。
func TestBalanceGateSkipsUnactivatedUsers(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	if w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil); w.Code != http.StatusOK {
		t.Fatalf("未开通用户被拦 = %d, want 200", w.Code)
	}
}

// 闸门关闭:不拦人,但消费照样扣余额(闸门只决定拦不拦,不决定记不记)。
func TestBalanceGateDisabledStillCharges(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, false)
	activateBalance(t, db, 1, 10)
	// 模型无定价 → cost 0;价格由 seedModel 决定,这里断言"未拦"即可
	if w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil); w.Code != http.StatusOK {
		t.Fatalf("闸门关闭时被拦 = %d, want 200", w.Code)
	}
	// 已开通用户消费后余额 <= 初值(有定价时严格减少;无定价时为 0 元不变)
	u, err := serverstore.GetUserByID(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	if u.BalanceMoney > 10+1e-9 {
		t.Fatalf("余额异常增长 = %v", u.BalanceMoney)
	}
	sum, err := serverstore.BalanceLedgerSum(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(u.BalanceMoney-sum) > 1e-9 {
		t.Fatalf("I1 违反: balance=%v ledger=%v", u.BalanceMoney, sum)
	}
}

func TestBalanceGateAdminExempt(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, _ := newGateway(t, f)
	enableBalanceGate(t, db, true)
	u, err := serverstore.GetUserByID(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	u.Role = serverstore.RoleSuperAdmin
	u.IsAdmin = true
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	activateBalance(t, db, 1, 1)
	activateBalance(t, db, 1, 0)
	token, err := serverauth.IssueToken(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	if w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil); w.Code != http.StatusOK {
		t.Fatalf("管理员被余额闸门拦截 = %d, want 200", w.Code)
	}
}

// 逐人发放:月中新建的员工被下一轮补齐(网关侧冒烟,细粒度见 serverstore 用例)。
func TestMonthlyGrantReachesActivatedBalance(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	run, err := serverstore.GrantMonthlyBalance(db, serverstore.BalanceModeAdd, 5, "tester", time.Now(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if run.Granted != 1 {
		t.Fatalf("grant run = %+v, want granted=1", run)
	}
	if w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil); w.Code != http.StatusOK {
		t.Fatalf("发放后仍被拦 = %d, want 200", w.Code)
	}
	u, _ := serverstore.GetUserByID(db, 1)
	if u.BalanceActivatedAt.IsZero() {
		t.Fatal("发放必须同时开通余额账户")
	}
}
