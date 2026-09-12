package serverstore

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// 主控独立验证（2026-09-12 审计修复）：不复用 coder 的测试构造，用自己的方式
// 重建复核员报告的原始利用链，确认 P0-B / P0-C 已被堵住。
//
// 原始证据（REVIEW-CONFIRMED.md）：
//   RESULT: seeded=1.00 cost_each=1.00 attempts=8 errors=0
//           balance_money=-7.000000 ledger_sum=-7.000000

// TestLeadVerifyOverdraftExploitChain 重建「1.00 余额 + 16 笔 1.00 消耗」。
// 修复前：全部成功，余额 -15.00。修复后：只有 1 笔能成功。
func TestLeadVerifyOverdraftExploitChain(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	mustPricedModel(t, db, "lead-od", 1, 1)
	uid := mustBalanceUser(t, db, "lead-od-user")
	if _, err := SetUserBalance(db, uid, 1, "seed", "admin"); err != nil {
		t.Fatal(err)
	}

	const attempts = 16
	var wg sync.WaitGroup
	results := make([]error, attempts)
	gate := make(chan struct{})
	for i := range attempts {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-gate
			_, results[i] = RecordUsage(db, uid, "lead-od", 1_000_000, 0)
		}(i)
	}
	close(gate)
	wg.Wait()

	var okCount, rejected int
	for i, err := range results {
		switch {
		case err == nil:
			okCount++
		case errors.Is(err, ErrInsufficientBalance):
			rejected++
		default:
			t.Fatalf("第 %d 笔意外错误: %v", i, err)
		}
	}

	user, err := GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("成功=%d 余额不足=%d balance=%.6f", okCount, rejected, user.BalanceMoney)

	// 核心断言：余额不得为负（原利用链会到 -15.00）
	if user.BalanceMoney < -1e-9 {
		t.Fatalf("❌ 仍可透支：balance=%.6f（1.00 余额被扣了 %d 笔）", user.BalanceMoney, okCount)
	}
	// 只有 1 元余额 → 只能成功 1 笔 1.00
	if okCount != 1 {
		t.Fatalf("❌ 成功笔数=%d，应为 1（余额只够 1 笔）", okCount)
	}
	if rejected != attempts-1 {
		t.Fatalf("❌ 拒绝笔数=%d，应为 %d", rejected, attempts-1)
	}

	// 账本仍自洽（不变量 I1 不该被破坏）
	var ledgerSum float64
	if err := db.QueryRow(`SELECT COALESCE(SUM(amount),0) FROM balance_ledger WHERE user_id = ?`, uid).Scan(&ledgerSum); err != nil {
		t.Fatal(err)
	}
	if diff := ledgerSum - user.BalanceMoney; diff > 1e-9 || diff < -1e-9 {
		t.Fatalf("❌ I1 不变量被破坏：ledger=%.6f balance=%.6f", ledgerSum, user.BalanceMoney)
	}
}

// TestLeadVerifyNegativeTokenNoRefund 重建 P0-B：负 token 不得产生 refund。
// 修复前：cost=-1.00 → delta=+1.00 → LedgerKindRefund → 余额 1.00→2.00。
func TestLeadVerifyNegativeTokenNoRefund(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	mustPricedModel(t, db, "lead-neg", 1, 1)
	uid := mustBalanceUser(t, db, "lead-neg-user")
	if _, err := SetUserBalance(db, uid, 1, "seed", "admin"); err != nil {
		t.Fatal(err)
	}

	// 上游回报负 token（原利用链：prompt=-1000000, completion=-1000000）
	if _, err := RecordUsage(db, uid, "lead-neg", -1_000_000, -1_000_000); err != nil {
		t.Fatalf("负 token 的 usage 记录不应报错（应被钳到 0 成本）: %v", err)
	}

	user, err := GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("负 token 后 balance=%.6f", user.BalanceMoney)

	// 核心断言：余额不得增加（原利用链会 1.00→2.00）
	if user.BalanceMoney > 1+1e-9 {
		t.Fatalf("❌ 负 token 仍在充值：balance=%.6f（原 1.00）", user.BalanceMoney)
	}

	// 不得出现 refund 流水
	var refunds int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM balance_ledger WHERE user_id = ? AND kind = ?`, uid, LedgerKindRefund,
	).Scan(&refunds); err != nil {
		t.Fatal(err)
	}
	if refunds != 0 {
		t.Fatalf("❌ 出现 %d 条 refund 流水（负 token 不应产生退款）", refunds)
	}
}

// TestLeadVerifyCostOfAtClamps 直接对计费函数下探：负 token 必须算出 0 成本。
func TestLeadVerifyCostOfAtClamps(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name                      string
		prompt, completion, cache int64
	}{
		{"双负", -1_000_000, -1_000_000, 0},
		{"仅输入负", -500_000, 100, 0},
		{"仅输出负", 100, -500_000, 0},
		{"缓存负", 100, 100, -500_000},
		{"全部负", -1, -1, -1},
	}
	for _, c := range cases {
		got := costOfAt(now, c.prompt, c.completion, c.cache, 1, 1, 1, 1, nil)
		if got < 0 {
			t.Fatalf("%s: costOfAt = %v，不得为负", c.name, got)
		}
	}
}
