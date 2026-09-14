package serverstore

// 审计 r7 **第二轮**复核(报告 RECHECK-F1-server-billing §4 r7f1-6,P2 残留):
// 流式后付费允许余额走负(SSE 的 usage chunk 在流末尾,结算发生在**正文早已
// 交付**之后),而闸门只在请求入口看一次余额 ⇒ 同一瞬间在途的 N 个并发请求
// 可以一起透支(实测 0.02 元账户 6 路并发 → -47.98 元);cover 模式的月度发放
// 又把这个欠款直接重置成当月额度 ⇒ 账号每月重新武装,同一账号可每月重复一次
// 突发。
//
// 本轮**不做架构改动**(预授权/在途额度是独立特性),只做最小收口:让欠款在
// 管理端可见 ——
//  ① GetBalanceSummary 汇总欠款人数与欠款总额(管理端余额总览响应体);
//  ② cover 发放记录"本次抹平了多少欠款"(GrantRun 字段 + 日志),不再无声。

import (
	"database/sql"
	"testing"
	"time"
)

// r7bUserWithBalance 建一个启用中的普通员工并直接置余额(负数 = 欠款)。
func r7bUserWithBalance(t *testing.T, db *sql.DB, name string, balance float64) int64 {
	t.Helper()
	uid, err := CreateUser(db, &User{Username: name, Source: "local", Status: 1, Role: RoleUser})
	if err != nil {
		t.Fatalf("建用户 %s: %v", name, err)
	}
	if _, err := db.Exec(`UPDATE users SET balance_money = ?, balance_activated_at = `+NowExpr()+` WHERE id = ?`,
		balance, uid); err != nil {
		t.Fatalf("置余额 %s: %v", name, err)
	}
	return uid
}

// TestR7bBalanceSummaryExposesOverdraft:欠款必须出现在管理端余额总览里
// (人数 + 总额),而不是只能逐笔翻流水。
func TestR7bBalanceSummaryExposesOverdraft(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	r7bUserWithBalance(t, db, "r7b-debtor", -47.96) // 欠款
	r7bUserWithBalance(t, db, "r7b-healthy", 10)    // 正常
	notActivated, err := CreateUser(db, &User{Username: "r7b-inactive", Source: "local", Status: 1, Role: RoleUser})
	if err != nil {
		t.Fatal(err)
	}
	_ = notActivated

	sum, err := GetBalanceSummary(db, time.Now())
	if err != nil {
		t.Fatalf("GetBalanceSummary: %v", err)
	}
	t.Logf("管理端余额总览: users=%d total=%.2f overdrawn_users=%d overdrawn_debt=%.2f",
		sum.Users, sum.Total, sum.OverdrawnUsers, sum.OverdrawnDebt)
	if sum.OverdrawnUsers != 1 {
		t.Fatalf("欠款人数 = %d, want 1(0.02 元账户可被并发突发送到负几十元,管理端必须看得见)", sum.OverdrawnUsers)
	}
	if want := 47.96; sum.OverdrawnDebt != want {
		t.Fatalf("欠款总额 = %.2f, want %.2f", sum.OverdrawnDebt, want)
	}
	if want := -37.96; sum.Total != want {
		t.Fatalf("余额合计 = %.2f, want %.2f(欠款必须计入合计)", sum.Total, want)
	}

	// 全部还清后欠款归零(不残留)。
	if _, err := db.Exec(`UPDATE users SET balance_money = 0 WHERE username = 'r7b-debtor'`); err != nil {
		t.Fatal(err)
	}
	sum, err = GetBalanceSummary(db, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if sum.OverdrawnUsers != 0 || sum.OverdrawnDebt != 0 {
		t.Fatalf("还清后仍有欠款: users=%d debt=%.2f", sum.OverdrawnUsers, sum.OverdrawnDebt)
	}
}

// TestR7bCoverGrantReportsClearedDebt:cover 模式月度发放会把欠款抹平(设计
// 如此),但"抹掉了多少"必须在发放结果里可见 —— 否则账号每月重新武装这件事
// 在管理端完全无声(逐笔 reset 流水存在,但没人会去逐条翻)。
func TestR7bCoverGrantReportsClearedDebt(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	r7bUserWithBalance(t, db, "r7b-cover-debtor", -47.96)
	r7bUserWithBalance(t, db, "r7b-cover-healthy", 3)

	run, err := GrantMonthlyBalance(db, BalanceModeCover, 10, "r7btest", time.Now(), 0)
	if err != nil {
		t.Fatalf("GrantMonthlyBalance(cover): %v", err)
	}
	t.Logf("cover 发放: granted=%d cover_debt_users=%d cover_debt_amount=%.2f",
		run.Granted, run.CoverDebtUsers, run.CoverDebtAmount)
	if run.Granted != 2 {
		t.Fatalf("发放人数 = %d, want 2", run.Granted)
	}
	if run.CoverDebtUsers != 1 {
		t.Fatalf("被抹平欠款的人数 = %d, want 1(cover 发放把 -47.96 重置成 10.00 这件事必须可见)", run.CoverDebtUsers)
	}
	if want := 47.96; run.CoverDebtAmount != want {
		t.Fatalf("被抹平的欠款 = %.2f, want %.2f", run.CoverDebtAmount, want)
	}
	// 抹平之后所有候选余额都等于当月额度(既有语义不变)。
	var stillDebt int
	if err := db.QueryRow(`SELECT COUNT(*) FROM users WHERE role = ? AND balance_money < 0`, RoleUser).Scan(&stillDebt); err != nil {
		t.Fatal(err)
	}
	if stillDebt != 0 {
		t.Fatalf("cover 发放后仍有 %d 个欠款账户(既有语义被改动)", stillDebt)
	}
	// 账本里逐笔的 reset 流水仍在(欠款可追溯到具体一轮发放)。
	var resets int
	if err := db.QueryRow(`SELECT COUNT(*) FROM balance_ledger WHERE kind = ? AND month = ?`, LedgerKindReset, run.Month).Scan(&resets); err != nil {
		t.Fatal(err)
	}
	if resets == 0 {
		t.Fatalf("cover 发放没有留下 reset 流水(欠款不可追溯)")
	}

	// add 模式不抹平欠款,因此不该报"抹平欠款"。
	run2, err := GrantMonthlyBalance(db, BalanceModeAdd, 5, "r7btest", time.Now().AddDate(0, 1, 0), 0)
	if err != nil {
		t.Fatalf("GrantMonthlyBalance(add): %v", err)
	}
	if run2.CoverDebtUsers != 0 || run2.CoverDebtAmount != 0 {
		t.Fatalf("add 模式不该有抹平欠款统计: users=%d amount=%.2f", run2.CoverDebtUsers, run2.CoverDebtAmount)
	}
}
