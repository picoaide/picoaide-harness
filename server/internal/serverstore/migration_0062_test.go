package serverstore

import (
	"database/sql"
	"math"
	"testing"
	"time"
)

// 0062 回填回归(2026-09-11):迁移最容易出事的是**存量数据** —— 账本必须自洽
// (I1: balance_money == SUM(ledger.amount)),当月已发放的批次必须补成逐人锚,
// 否则升级后调度器会把当月额度再发一次(真实加钱事故)。
//
// 本用例模拟真实升级路径:先只应用到 0061(旧库),构造存量余额 + 当月发放批次,
// 再应用 0062,逐条断言。
func TestMigration0062BackfillKeepsLedgerInvariant(t *testing.T) {
	// 注意顺序:必须**先**设置迁移集合再建库 —— 否则会克隆"已迁移到最新"的
	// 模板库,0062 根本不会重放(本用例第一版就踩了这个坑)。
	all := migrationsFor()
	var pre, post []migration
	for _, m := range all {
		if m.version <= 61 {
			pre = append(pre, m)
		}
		if m.version >= 62 {
			post = append(post, m)
		}
	}
	if len(post) == 0 {
		t.Fatal("0062 迁移未找到")
	}
	testMigrationHook = func() []migration { return pre }
	// --- 1) 造一个"升级前"的库:只应用 <= 0061 ---
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if v := latestMigration(); v != 61 {
		t.Fatalf("前置条件:应为 0061 旧库,实际 %d", v)
	}

	// --- 2) 存量数据 ---
	// a) 管理员充值过、余额非零、从未发放
	topped := mustUser(t, db, "legacy-topped")
	if _, err := db.Exec(`UPDATE users SET balance_money = 123.456 WHERE id = ?`, topped); err != nil {
		t.Fatal(err)
	}
	// b) 本月已发放 100,之后消费掉 30 → 余额 70(回填必须同时解释"发放"与"期初")
	granted := mustUser(t, db, "legacy-granted")
	if _, err := db.Exec(`UPDATE users SET balance_money = 70 WHERE id = ?`, granted); err != nil {
		t.Fatal(err)
	}
	// c) 本月已发放 100 且花光 → 余额 0(必须仍被认定为"已发放 + 已开通")
	spent := mustUser(t, db, "legacy-spent")
	if _, err := db.Exec(`UPDATE users SET balance_money = 0 WHERE id = ?`, spent); err != nil {
		t.Fatal(err)
	}
	// --- d) 当月发放批次(时间点 := 现在;此前的用户视为"当时在场") ---
	month := monthKey(BeijingMonth(time.Now()))
	if _, err := db.Exec(`INSERT INTO balance_grants (month, mode, amount, affected, actor)
		VALUES (?, 'add', 100, 3, 'tester')`, month); err != nil {
		t.Fatal(err)
	}
	// e) 批次之后入职的新员工:不应被补锚 → 会被下一轮正常补发
	untouched := mustUser(t, db, "legacy-newbie")
	// f) 被禁用的员工:发放范围外,不应被补锚(但存量余额仍须入账)
	disabled := mustUser(t, db, "legacy-disabled")
	if _, err := db.Exec(`UPDATE users SET status = 0, balance_money = 5 WHERE id = ?`, disabled); err != nil {
		t.Fatal(err)
	}

	// --- 3) 应用 0062 ---
	testMigrationHook = func() []migration { return post }
	defer func() { testMigrationHook = nil }()
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("apply 0062: %v", err)
	}

	// --- 4) I1:每个用户 余额 == Σ流水 ---
	for _, uid := range []int64{topped, granted, spent, untouched, disabled} {
		u, err := GetUserByID(db, uid)
		if err != nil {
			t.Fatal(err)
		}
		sum, err := BalanceLedgerSum(db, uid)
		if err != nil {
			t.Fatal(err)
		}
		if math.Abs(u.BalanceMoney-roundMicro(sum)) > 1e-9 {
			t.Fatalf("用户 %s I1 违反: balance=%v ledger_sum=%v", u.Username, u.BalanceMoney, sum)
		}
	}

	// --- 5) 发放语义:本月已发放的三人口径 ---
	// granted:期初 -30 + 发放 100 = 70,账本必须能解释这 100 的发放
	items, total, err := BalanceLedgerPage(db, granted, "", 1, 10)
	if err != nil {
		t.Fatal(err)
	}
	var sawGrant bool
	for _, e := range items {
		if e.Kind == LedgerKindGrant && e.Amount == 100 {
			sawGrant = true
		}
	}
	if !sawGrant || total < 2 {
		t.Fatalf("已发放用户缺少发放流水: total=%d items=%+v", total, items)
	}
	// spent:余额 0 但本月已发放过 → 仍须有发放流水且被开通
	if sum, _ := BalanceLedgerSum(db, spent); math.Abs(sum) > 1e-9 {
		t.Fatalf("花光用户 I1 = %v, want 0", sum)
	}
	uSpent, _ := GetUserByID(db, spent)
	if uSpent.BalanceActivatedAt.IsZero() {
		t.Fatal("本月已发放(即使花光)的用户必须被开通")
	}

	// --- 6) 开通态 ---
	uTopped, _ := GetUserByID(db, topped)
	if uTopped.BalanceActivatedAt.IsZero() {
		t.Fatal("有存量余额的用户必须被开通")
	}
	uUntouched, _ := GetUserByID(db, untouched)
	if !uUntouched.BalanceActivatedAt.IsZero() {
		t.Fatal("批次之后入职且从未入账的用户必须保持未开通")
	}
	if uDisabled, _ := GetUserByID(db, disabled); uDisabled.BalanceActivatedAt.IsZero() {
		t.Fatal("有存量余额的禁用用户仍须入账并开通(账本完整性不受状态影响)")
	}

	// --- 7) 关键:升级后调度器不得把当月额度再发一次 ---
	run, err := GrantMonthlyBalance(db, BalanceModeAdd, 100, "system", time.Now(), 0)
	if err != nil {
		t.Fatal(err)
	}
	// 只有"批次之后入职的新员工"应被补发;当月已发放的老员工不得重复发放。
	if run.Granted != 1 {
		t.Fatalf("升级后发放人数 = %d, want 1(仅新员工;老员工不得重复发放)", run.Granted)
	}
	for _, uid := range []int64{topped, granted, spent} {
		u, _ := GetUserByID(db, uid)
		want := map[int64]float64{topped: 123.456, granted: 70, spent: 0}[uid]
		if math.Abs(u.BalanceMoney-want) > 1e-9 {
			t.Fatalf("用户 %d 余额被重复发放改动: %v want %v", uid, u.BalanceMoney, want)
		}
	}

	// --- 8) 新员工拿到的正是当月额度,并因此开通 ---
	if u, _ := GetUserByID(db, untouched); u.BalanceMoney != 100 {
		t.Fatalf("新员工补发后余额 = %v, want 100", u.BalanceMoney)
	}
	if u, _ := GetUserByID(db, untouched); u.BalanceActivatedAt.IsZero() {
		t.Fatal("发放即开通")
	}
}

// 迁移幂等:重复执行 0062 不改变任何数据(可重跑是运维前提)。
func TestMigration0062Idempotent(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	uid := mustUser(t, db, "idem-user")
	if _, err := SetUserBalance(db, uid, 42, "t", "tester"); err != nil {
		t.Fatal(err)
	}
	before, _, err := BalanceLedgerPage(db, uid, "", 1, 50)
	if err != nil {
		t.Fatal(err)
	}
	// 强制重放 0062(清掉 schema_migrations 里的版本号)
	if _, err := db.Exec(`DELETE FROM schema_migrations WHERE version = 62`); err != nil {
		t.Fatal(err)
	}
	var only62 []migration
	for _, m := range migrationsFor() {
		if m.version == 62 {
			only62 = append(only62, m)
		}
	}
	testMigrationHook = func() []migration { return only62 }
	defer func() { testMigrationHook = nil }()
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("replay 0062: %v", err)
	}
	after, _, err := BalanceLedgerPage(db, uid, "", 1, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != len(after) {
		t.Fatalf("重放 0062 产生了新流水: %d → %d", len(before), len(after))
	}
	if u, _ := GetUserByID(db, uid); u.BalanceMoney != 42 {
		t.Fatalf("重放 0062 改动了余额: %v", u.BalanceMoney)
	}
}

// mustUser 建一个启用的普通员工(名字唯一化,避免与同库其它用例撞唯一索引)。
func mustUser(t *testing.T, db *sql.DB, name string) int64 {
	t.Helper()
	id, err := CreateUser(db, &User{Username: name, Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	return id
}
