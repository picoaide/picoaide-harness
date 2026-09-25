package serverstore

// R14-K · D-03 的行为判据：`GetBalanceSummary` 的**金额聚合读**必须与同一响应里的其余
// 读面来自**同一个库**（public）。
//
// 被审形态（lane D 的 D-03，历史已认账、第十三轮后出现新形态）：
//
//	// balance.go（旧实现）
//	db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(balance_money),0) FROM users
//	             WHERE status = 1 AND role = ?`, RoleUser)          // ← 裸池 + 未限定名
//	db.QueryRow(`SELECT COUNT(*), COALESCE(-SUM(balance_money),0) FROM users …`) // ← 同上
//
// 登记表把 `users` 归 non-family，理由写的是"遮蔽读 ⇒ 登录/余额查询**可见地**失败
// （不静默错数字）"。那条理由对**点查**成立，对**聚合读**不成立：这条 SQL 与 shadow 的
// 同名表完全同形、`err=nil`、数字是错的（真 PG 实测：public `2 人 / 100.00` vs
// 敌对池 `3 人 / 9999.00`）。
//
// 更糟的是第十三轮之后的新形态：同一函数里的 settings / 发放台账读**已经**走已钉只读
// 事务（读 public）⇒ 一个响应里两组数字来自**两个库**（半真半假比整块读错更难发现）。
//
// 判据：在**敌对 search_path** 的旁路池上调用 `GetBalanceSummary`，人数/余额合计/欠款
// 必须等于 public 的真值，且不得等于 shadow 的诱饵值。
//
// 变异验证：把两条聚合读改回 `db.QueryRow(...)`（裸池）⇒ 本用例红（读回 3 人 / 9999.00）。

import (
	"database/sql"
	"fmt"
	"testing"
	"time"
)

// r14kShadowSchema 是本判据专用的 shadow schema（与 r12n2 / r13ge 的分开，
// 避免并行用例互相 DROP）。
const r14kShadowSchema = "r14k_shadow"

// r14kShadowPool 造一份"同名 users 表 + 余额诱饵"的 shadow，并返回 search_path 前置
// 它的旁路池（复用 r13ge 的旁路池构造点，不自造第二份连接串拼装）。
func r14kShadowPool(t *testing.T, db *sql.DB) *sql.DB {
	t.Helper()
	sh := quoteRelationIdent(r14kShadowSchema)
	stmts := []string{
		"DROP SCHEMA IF EXISTS " + sh + " CASCADE",
		"CREATE SCHEMA " + sh,
		"CREATE TABLE " + sh + ".users (LIKE public.users INCLUDING ALL)",
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("造 shadow（R14-K · D-03）: %v\n%s", err, s)
		}
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP SCHEMA IF EXISTS " + sh + " CASCADE") })
	// 诱饵：3 个启用普通员工 —— 两人 +3333.00、一人 −500.00（public 侧的真值是
	// 2 人 / 合计 150.00 / 无人欠款 ⇒ 人数、合计、欠款三处都能分辨读的是哪个库）。
	for i := 1; i <= 3; i++ {
		balance := 3333.00
		if i == 3 {
			balance = -500.00
		}
		if _, err := db.Exec(fmt.Sprintf(`INSERT INTO %s.users
			(username, display_name, source, status, role, balance_money, balance_activated_at)
			VALUES ($1, $1, 'local', 1, $2, $3, now())`, sh),
			fmt.Sprintf("r14k-shadow-user-%d", i), RoleUser, balance); err != nil {
			t.Fatalf("播 shadow 诱饵用户: %v", err)
		}
	}
	side := r13geHostilePoolFor(t, db, r14kShadowSchema)
	var shown string
	if err := side.QueryRow("SHOW search_path").Scan(&shown); err != nil {
		t.Fatal(err)
	}
	t.Logf("敌对池 search_path=%q", shown)
	return side
}

// TestAuditR14KBalanceSummaryAggregatesReadPublic 是 D-03 的判据（真 PG + 真 shadow）。
func TestAuditR14KBalanceSummaryAggregatesReadPublic(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)

	// public 侧真值：两个启用普通员工，合计 150.00、无人欠款。
	// （`AdjustUserBalance` / `SetUserBalance` 都不接受负值 —— 欠款只能由消费产生，
	//  夹具不去伪造。欠款那一侧的判据靠 shadow 里的 −500 诱饵区分。）
	createR14KUser(t, db, "r14k-bal-a", 120.00)
	createR14KUser(t, db, "r14k-bal-b", 30.00)

	now := time.Now()
	want, err := GetBalanceSummary(db, now)
	if err != nil {
		t.Fatalf("GetBalanceSummary(public): %v", err)
	}
	if want.Users != 2 || want.Total != 150.00 {
		t.Fatalf("夹具前提不成立：public 侧 users=%d total=%.2f（want 2 / 150.00）", want.Users, want.Total)
	}

	side := r14kShadowPool(t, db)
	got, err := GetBalanceSummary(side, now)
	if err != nil {
		t.Fatalf("GetBalanceSummary(敌对池): %v", err)
	}
	t.Logf("public: users=%d total=%.2f overdrawn=%d debt=%.2f | 敌对池: users=%d total=%.2f overdrawn=%d debt=%.2f",
		want.Users, want.Total, want.OverdrawnUsers, want.OverdrawnDebt,
		got.Users, got.Total, got.OverdrawnUsers, got.OverdrawnDebt)

	if got.Users != want.Users || got.Total != want.Total {
		t.Errorf("人数/余额合计读自 shadow（users=%d total=%.2f，want %d / %.2f）—— "+
			"同一响应里 settings/发放台账读 public、聚合读读 shadow = 半真半假",
			got.Users, got.Total, want.Users, want.Total)
	}
	if got.OverdrawnUsers != want.OverdrawnUsers || got.OverdrawnDebt != want.OverdrawnDebt {
		t.Errorf("欠款聚合读自 shadow（overdrawn=%d debt=%.2f，want %d / %.2f）",
			got.OverdrawnUsers, got.OverdrawnDebt, want.OverdrawnUsers, want.OverdrawnDebt)
	}
	// 反向自证：诱饵值确实"长得像真的"（否则上面的断言可能因为 shadow 侧没数据而恒真）。
	if got.Total == 9999.00 {
		t.Errorf("读到的正好是 shadow 的诱饵合计 9999.00 —— 判据确实咬到了跨库混读")
	}
}

// createR14KUser 建一个启用普通员工并把它精确设置到指定余额（走账本，保持不变量）。
func createR14KUser(t *testing.T, db *sql.DB, name string, balance float64) int64 {
	t.Helper()
	id, err := CreateUser(db, &User{Username: name, Source: "local", Status: 1, Role: RoleUser})
	if err != nil {
		t.Fatalf("建用户 %s: %v", name, err)
	}
	if _, err := AdjustUserBalance(db, id, balance, "R14-K D-03 夹具", "test"); err != nil {
		t.Fatalf("设置余额 %s: %v", name, err)
	}
	return id
}
