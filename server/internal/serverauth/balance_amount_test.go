package serverauth

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// FIX-08(审计 2026-09-12,CC-P1-2):余额「设为」在 amount 缺失/null 时被当成清零。
//
// 缺陷形态:balanceReq.Amount 是 float64,「没给」与「给了 0」在 Go 侧不可
// 区分。`{"mode":"set","amount":null}` 解出 0 → set 分支执行清零:HTTP 200 +
// {"ok":true},余额 12345.67 → 0,**不可逆**。省略 amount 同样清零。
//
// 触发链路(真实用户可达):webadmin usage/Balance.tsx 的输入框只判
// `Number.isFinite(n)`,不判 `n*100`;用户输入 1e307 这类大数时 `n*100`
// 溢出成 Infinity,`JSON.stringify(Infinity)` 产出 **null** → 服务端清零。
//
// 修法:Amount 改 *float64(区分"缺失"与"显式 0"),set 模式缺字段即 400。
// clear 是唯一不需要金额的模式(set 的显式 0 仍然合法,不能被误伤)。

const balanceStart = 12345.67

func seedBalanceUser(t *testing.T) (http.Handler, *sql.DB, int64, map[string]string) {
	t.Helper()
	r, db := adminRouter(t)
	uid, err := createUserDB(db, "target", "pw12345678", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.SetUserBalance(db, uid, balanceStart, "seed", "tester"); err != nil {
		t.Fatal(err)
	}
	boss, err := serverstore.GetUserByUsername(db, "boss")
	if err != nil {
		t.Fatal(err)
	}
	sess, csrf, err := CreateAdminSession(db, boss.ID)
	if err != nil {
		t.Fatal(err)
	}
	return r, db, uid, map[string]string{
		"Cookie": sessionCookieName + "=" + sess.ID, "X-CSRF-Token": csrf,
	}
}

func currentBalance(t *testing.T, db *sql.DB, uid int64) float64 {
	t.Helper()
	u, err := serverstore.GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	return u.BalanceMoney
}

// TestBalanceSetRejectsMissingAmount 锁住核心回归:set + 缺字段/null ⇒ 400,
// 余额**分毫不动**。修复前这两种写法都是 200 + 清零。
func TestBalanceSetRejectsMissingAmount(t *testing.T) {
	r, db, uid, hdr := seedBalanceUser(t)
	path := "/api/server/admin/users/" + strconv.FormatInt(uid, 10) + "/balance"

	for _, body := range []string{
		`{"mode":"set","amount":null}`, // JSON.stringify(Infinity) 的真实产物
		`{"mode":"set"}`,               // 字段整个省略
	} {
		w, out := doAdmin(t, r, "POST", path, body, hdr)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body=%s → status %d, want 400 (body=%s)", body, w.Code, w.Body.String())
		}
		if out["ok"] == true {
			t.Fatalf("body=%s → ok:true,拒绝必须是明确失败", body)
		}
		if got := currentBalance(t, db, uid); got != balanceStart {
			t.Fatalf("body=%s → balance = %v, want %v(缺字段不得清零)", body, got, balanceStart)
		}
	}
}

// TestBalanceSetExplicitZeroStillWorks 是防误伤:set + 显式 0 仍然是合法的
// 清零操作(这是修复必须保留的语义 —— 不能用"0 一律拒绝"来偷懒)。
func TestBalanceSetExplicitZeroStillWorks(t *testing.T) {
	r, db, uid, hdr := seedBalanceUser(t)
	path := "/api/server/admin/users/" + strconv.FormatInt(uid, 10) + "/balance"

	w, out := doAdmin(t, r, "POST", path, `{"mode":"set","amount":0}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("set amount=0 → status %d, want 200 (body=%s)", w.Code, w.Body.String())
	}
	if out["ok"] != true {
		t.Fatalf("set amount=0 → %v, want ok:true", out)
	}
	if got := currentBalance(t, db, uid); got != 0 {
		t.Fatalf("balance = %v, want 0", got)
	}
}

// TestBalanceClearStillWorks 是防误伤:clear 是唯一不需要 amount 的模式。
func TestBalanceClearStillWorks(t *testing.T) {
	r, db, uid, hdr := seedBalanceUser(t)
	path := "/api/server/admin/users/" + strconv.FormatInt(uid, 10) + "/balance"

	w, _ := doAdmin(t, r, "POST", path, `{"mode":"clear"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("clear → status %d, want 200 (body=%s)", w.Code, w.Body.String())
	}
	if got := currentBalance(t, db, uid); got != 0 {
		t.Fatalf("balance = %v, want 0", got)
	}
}

// TestBalanceAmountBoundsUnchanged 锁住修复前就有的边界,防止这次改动把
// add/deduct 的正数校验或 1 亿元上限弄丢。
func TestBalanceAmountBoundsUnchanged(t *testing.T) {
	r, db, uid, hdr := seedBalanceUser(t)
	path := "/api/server/admin/users/" + strconv.FormatInt(uid, 10) + "/balance"

	cases := []struct {
		body string
		want int
	}{
		{`{"mode":"add","amount":0}`, http.StatusBadRequest},    // add 必须为正
		{`{"mode":"add","amount":-5}`, http.StatusBadRequest},   // 负数
		{`{"mode":"deduct","amount":0}`, http.StatusBadRequest}, // deduct 必须为正
		{`{"mode":"set","amount":-1}`, http.StatusBadRequest},   // set 不能为负
		{`{"mode":"set","amount":1e9}`, http.StatusBadRequest},  // 超 1 亿元
		{`{"mode":"add","amount":1e9}`, http.StatusBadRequest},  // 超 1 亿元
		{`{"mode":"add"}`, http.StatusBadRequest},               // 缺金额
		{`{"mode":"deduct"}`, http.StatusBadRequest},            // 缺金额
		{`{"mode":"nope","amount":1}`, http.StatusBadRequest},   // 非法 mode
		{`{"mode":"add","amount":1.5}`, http.StatusOK},          // 正常加钱
		{`{"mode":"deduct","amount":0.5}`, http.StatusOK},       // 正常扣钱
		{`{"mode":"set","amount":100}`, http.StatusOK},          // 正常设值
	}
	for _, tc := range cases {
		w, _ := doAdmin(t, r, "POST", path, tc.body, hdr)
		if w.Code != tc.want {
			t.Errorf("body=%s → status %d, want %d (body=%s)", tc.body, w.Code, tc.want, w.Body.String())
		}
	}
	// 1.5 - 0.5 = 1.0,set 100 → 100
	if got := currentBalance(t, db, uid); got != 100 {
		t.Fatalf("final balance = %v, want 100", got)
	}
}

// TestBalanceWebadminOverflowPayloadIsRejected 复刻审计的真实触发链路:
// webadmin 把 1e307 乘 100 溢出成 Infinity,JSON.stringify 产出 null。
// 服务端必须拒绝(修复前是 200 + 清零)。
func TestBalanceWebadminOverflowPayloadIsRejected(t *testing.T) {
	r, db, uid, hdr := seedBalanceUser(t)
	path := "/api/server/admin/users/" + strconv.FormatInt(uid, 10) + "/balance"

	// 与 JS 端一致的载荷构造
	payload := map[string]any{"mode": "set", "amount": nil}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	w, _ := doAdmin(t, r, "POST", path, string(raw), hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", w.Code, w.Body.String())
	}
	if got := currentBalance(t, db, uid); got != balanceStart {
		t.Fatalf("balance = %v, want %v", got, balanceStart)
	}
}
