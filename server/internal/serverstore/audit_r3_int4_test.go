package serverstore

import (
	"math"
	"testing"
)

// R3(2026-09-13 审计):结算 SQL 里的 `? >= 0` 曾让 PG 把金额参数推断成 int4,
// 单笔差额超过 2^31 时 pgx 编码失败 → 大额结算整体报错(修复前是静默免费,
// 修好后是 503,两者都不该发生)。这里用真 PG 跑一笔 > 2^31 的结算。
func TestSettlementBeyondInt4Range(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	// 定价 5e9 元 / 1M token:一次 1M 输入的调用 = 50 亿元,远超 int4 上限。
	mustPricedModel(t, db, "int4-model", 5e9, 0)
	uid := mustBalanceUser(t, db, "int4-user")
	if _, err := SetUserBalance(db, uid, 1e10, "", "admin"); err != nil {
		t.Fatal(err)
	}
	pend, err := RecordUsage(db, uid, "int4-model", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := UpdateUsageTokens(db, pend, 1_000_000, 0); err != nil {
		t.Fatalf("大额结算失败(参数类型推断回归?): %v", err)
	}
	u, err := GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	// 100 亿 - 50 亿 = 50 亿(浮点比较用相对容差)。
	if math.Abs(u.BalanceMoney-5e9) > 1e-3 {
		t.Fatalf("余额 = %v, want 5e9", u.BalanceMoney)
	}
	assertLedgerInvariant(t, db, uid)
}

// 同一 SQL 的另一个方向:大额退款(差额为正)不受下限约束,也必须能落账。
func TestRefundBeyondInt4Range(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	mustPricedModel(t, db, "int4-refund-model", 5e9, 0)
	uid := mustBalanceUser(t, db, "int4-refund-user")
	if _, err := SetUserBalance(db, uid, 1e10, "", "admin"); err != nil {
		t.Fatal(err)
	}
	pend, err := RecordUsage(db, uid, "int4-refund-model", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := UpdateUsageTokens(db, pend, 1_000_000, 0); err != nil {
		t.Fatal(err)
	}
	// 费用下调(回填更小的 token) → 差额为正 → 走 refund 分支。
	if err := UpdateUsageTokens(db, pend, 0, 0); err != nil {
		t.Fatalf("大额 refund 失败: %v", err)
	}
	u, err := GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(u.BalanceMoney-1e10) > 1e-3 {
		t.Fatalf("余额 = %v, want 1e10(全额退回)", u.BalanceMoney)
	}
	assertLedgerInvariant(t, db, uid)
}
