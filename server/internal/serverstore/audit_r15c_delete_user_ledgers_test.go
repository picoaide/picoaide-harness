package serverstore

// R15C-01（审计 2026-09-25，P1）：删除用户只清「用量明细」，不清「日/月汇总」与
// 「资金流水」。
//
// 三处缺一不可的成因：
//   1. DeleteUser 的级联清单是固定四条（api_tokens / usage / admin_sessions /
//      user_groups），不含 usage_daily / usage_monthly / balance_ledger /
//      balance_grant_items；
//   2. 永久账本按设计**没有任何回收路径**，而启动补算是纯 UPSERT、只从明细算
//      ⇒ 被删用户留在账本里的行**永远不会被纠正**（不可自愈）；
//   3. 读面**逐月切换读源**（该月有明细行 ⇒ 读明细；明细行归零而账本有行 ⇒ 读
//      账本）⇒ 一旦该月明细不再覆盖（删掉该月仅有的用量用户即可达成，不必等保留
//      期 DROP），被删用户的费用会**回涨**，并出现 label 是数字 user_id 的幽灵行。
//
// 本文件钉住两条不变量（修好后必须恒成立）：
//   I1  同月同用户：`明细 == 日账 == 月账`，且管理端聚合出口（逐月切读源）与之
//       一致；其他用户的金额不得因删除而变动。
//   I2  资金账本：`SUM(balance_ledger.amount) == SUM(users.balance_money)`
//       （全局与逐用户）。
//
// 语义定案（与 webadmin 二次确认文案一致）：**删除 = 抹除**。用户行被物理删除的
// 同时，其在四个账目关系（usage / usage_daily / usage_monthly / balance_ledger）
// 里的行在同一事务内一并清除；被抹除的金额由 DeleteUser 返回并写入审计链
// （0048 哈希链），所以"抹掉了多少"仍可追溯 —— 这是"删即消失"语义下唯一可对账
// 的形态（保留账本行会立刻破坏 I1/I2，见上）。

import (
	"database/sql"
	"fmt"
	"sort"
	"testing"
	"time"
)

// r15cMonth 造一个"过去的北京月"夹具（保留期内、月分区已建）。
type r15cMonth struct {
	start  time.Time // 月初（北京日值）
	day    time.Time // 夹具写入日
	next   time.Time // 下月初
	window time.Time // 闭区间末日
}

func newR15CMonth(t *testing.T, y int, m time.Month, dayOfMonth int) r15cMonth {
	t.Helper()
	start := time.Date(y, m, 1, 0, 0, 0, 0, time.UTC)
	return r15cMonth{
		start:  start,
		day:    start.AddDate(0, 0, dayOfMonth-1),
		next:   start.AddDate(0, 1, 0),
		window: start.AddDate(0, 1, -1),
	}
}

// r15cInsertUsage 直接写 usage 明细（真列集；绕过网关只为夹具可控）。
func r15cInsertUsage(t *testing.T, db *sql.DB, userID int64, cost float64, at time.Time) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO usage
		(user_id, model, prompt_tokens, completion_tokens, cache_prompt_tokens, cost, kind, created_at, estimated)
		VALUES (?, 'r15c-model', 500, 500, 0, ?, 'chat', ?, false)`, userID, cost, at); err != nil {
		t.Fatalf("insert usage: %v", err)
	}
}

// r15cCostsByUser 读某个关系在该月的逐用户金额（缺行 = 0）。
func r15cCostsByUser(t *testing.T, db *sql.DB, rel, timeCol string, m r15cMonth) map[int64]float64 {
	t.Helper()
	rows, err := db.Query(fmt.Sprintf(
		`SELECT user_id, COALESCE(SUM(cost),0) FROM %s WHERE %s >= ? AND %s < ? GROUP BY user_id`,
		rel, timeCol, timeCol), m.start, m.next)
	if err != nil {
		t.Fatalf("query %s: %v", rel, err)
	}
	defer rows.Close()
	out := map[int64]float64{}
	for rows.Next() {
		var uid int64
		var cost float64
		if err := rows.Scan(&uid, &cost); err != nil {
			t.Fatal(err)
		}
		out[uid] = cost
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// r15cAggregateByUser 是"管理端口径"：UsageAggregateWithLedger 会按该月明细是否
// 仍覆盖逐月切读源，因此它同时暴露 I1 的分叉与幽灵行。
func r15cAggregateByUser(t *testing.T, db *sql.DB, m r15cMonth) map[string]float64 {
	t.Helper()
	rows, err := UsageAggregateWithLedger(db, m.start, m.window, "user")
	if err != nil {
		t.Fatalf("UsageAggregateWithLedger: %v", err)
	}
	out := map[string]float64{}
	for _, r := range rows {
		out[r.Label] += r.Cost
	}
	return out
}

func r15cTotal(m map[string]float64) float64 {
	var total float64
	for _, v := range m {
		total += v
	}
	return total
}

func r15cLabels(m map[string]float64) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// r15cAssertUsageInvariant 钉 I1：同月同用户 detail == daily == monthly，
// 以及管理端聚合出口与三者的合计一致。
func r15cAssertUsageInvariant(t *testing.T, db *sql.DB, m r15cMonth, usernames map[int64]string) {
	t.Helper()
	detail := r15cCostsByUser(t, db, "usage", "created_at", m)
	daily := r15cCostsByUser(t, db, "usage_daily", "day", m)
	monthly := r15cCostsByUser(t, db, "usage_monthly", "month", m)

	ids := map[int64]bool{}
	for id := range detail {
		ids[id] = true
	}
	for id := range daily {
		ids[id] = true
	}
	for id := range monthly {
		ids[id] = true
	}
	for id := range ids {
		if d, dl, mo := detail[id], daily[id], monthly[id]; d != dl || dl != mo {
			t.Errorf("I1 破坏：用户 %s(%d) 该月 明细=%.4f 日账=%.4f 月账=%.4f（三口径必须一致）",
				usernames[id], id, d, dl, mo)
		}
	}
	if dt, dl, mt := r15cTotal(mapInt64ToStr(detail)), r15cTotal(mapInt64ToStr(daily)), r15cTotal(mapInt64ToStr(monthly)); dt != dl || dl != mt {
		t.Errorf("I1 破坏：该月合计 明细=%.4f 日账=%.4f 月账=%.4f", dt, dl, mt)
	}
	// 管理端出口：合计必须等于明细合计（同区间只有一个口径）。
	agg := r15cAggregateByUser(t, db, m)
	if at, dt := r15cTotal(agg), r15cTotal(mapInt64ToStr(detail)); at != dt {
		t.Errorf("I1 破坏：管理端聚合出口=%.4f ≠ 明细合计=%.4f（labels=%v）", at, dt, r15cLabels(agg))
	}
}

func mapInt64ToStr(in map[int64]float64) map[string]float64 {
	out := make(map[string]float64, len(in))
	for k, v := range in {
		out[fmt.Sprintf("%d", k)] = v
	}
	return out
}

// r15cAssertBalanceInvariant 钉 I2：全局与逐用户 `SUM(balance_ledger) == balance_money`。
func r15cAssertBalanceInvariant(t *testing.T, db *sql.DB) {
	t.Helper()
	pairs, err := db.Query(`SELECT u.id, u.balance_money,
		COALESCE((SELECT SUM(l.amount) FROM balance_ledger l WHERE l.user_id = u.id), 0)
		FROM users u ORDER BY u.id`)
	if err != nil {
		t.Fatal(err)
	}
	defer pairs.Close()
	for pairs.Next() {
		var id int64
		var balance, ledger float64
		if err := pairs.Scan(&id, &balance, &ledger); err != nil {
			t.Fatal(err)
		}
		if quantizeDiff(balance, ledger) {
			t.Errorf("I2 破坏：用户 %d 余额=%.6f ≠ 流水合计=%.6f", id, balance, ledger)
		}
	}
	if err := pairs.Err(); err != nil {
		t.Fatal(err)
	}
	// 全局：不能有指向不存在用户的孤儿流水（幽灵金额无任何界面出口）。
	var orphans int
	var orphanSum float64
	if err := db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(amount),0) FROM balance_ledger l
		WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = l.user_id)`).Scan(&orphans, &orphanSum); err != nil {
		t.Fatal(err)
	}
	if orphans != 0 {
		t.Errorf("I2 破坏：资金账本有 %d 条孤儿流水（合计 %.2f 元），且没有用户行与之对应", orphans, orphanSum)
	}
	var globalLedger, globalUsers float64
	if err := db.QueryRow(`SELECT COALESCE(SUM(amount),0) FROM balance_ledger`).Scan(&globalLedger); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COALESCE(SUM(balance_money),0) FROM users`).Scan(&globalUsers); err != nil {
		t.Fatal(err)
	}
	if globalLedger != globalUsers {
		t.Errorf("I2 破坏：全局账本合计=%.6f ≠ 现存用户余额合计=%.6f", globalLedger, globalUsers)
	}
}

// quantizeDiff 用分位口径比较（余额与流水都按 QuantizeMoney 对外展示）。
func quantizeDiff(a, b float64) bool {
	return QuantizeMoney(a) != QuantizeMoney(b)
}

// TestR15CDeleteUserErasesUsageLedgers：删除用户必须同时抹除其日/月汇总，
// 使同月三口径与"管理端出口"一致；其他用户的金额分毫不动；明细老化后金额不得回涨。
func TestR15CDeleteUserErasesUsageLedgers(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	m := newR15CMonth(t, 2026, time.June, 4)
	victim, err := CreateUserWithPassword(db, "r15c-victim", "Probe-Password-123")
	if err != nil {
		t.Fatal(err)
	}
	other, err := CreateUserWithPassword(db, "r15c-other", "Probe-Password-123")
	if err != nil {
		t.Fatal(err)
	}
	r15cInsertUsage(t, db, victim, 7.0, m.day)
	r15cInsertUsage(t, db, other, 14.0, m.day.Add(time.Hour))
	if err := RebuildUsageLedger(db, m.start, m.window); err != nil {
		t.Fatalf("rebuild ledger: %v", err)
	}
	names := map[int64]string{victim: "r15c-victim", other: "r15c-other"}

	// 前置：删除前 I1 成立，且该月合计 21.00。
	r15cAssertUsageInvariant(t, db, m, names)
	if got := r15cTotal(mapInt64ToStr(r15cCostsByUser(t, db, "usage", "created_at", m))); got != 21.0 {
		t.Fatalf("前置夹具不对：删除前明细合计=%.2f（期望 21.00）", got)
	}

	// 管理员删除 victim。
	if _, err := DeleteUser(db, victim); err != nil {
		t.Fatalf("DeleteUser: %v", err)
	}

	// 修前红点：日/月账本仍留着被删用户的 7.00 ⇒ I1 分叉、管理端口径不一致。
	r15cAssertUsageInvariant(t, db, m, names)
	if got := r15cAggregateByUser(t, db, m); r15cTotal(got) != 14.0 {
		t.Errorf("删除后该月合计=%.2f（期望 14.00，标签=%v）", r15cTotal(got), r15cLabels(got))
	}
	if got := r15cTotal(mapInt64ToStr(r15cCostsByUser(t, db, "usage_daily", "day", m))); got != 14.0 {
		t.Errorf("删除后日账合计=%.2f（期望 14.00）", got)
	}
	if got := r15cTotal(mapInt64ToStr(r15cCostsByUser(t, db, "usage_monthly", "month", m))); got != 14.0 {
		t.Errorf("删除后月账合计=%.2f（期望 14.00）", got)
	}

	// 明细老化（保留期推进 / 分区清空的等价物）：读源切到账本 —— 金额不得回涨，
	// 也不得出现 label 为数字 user_id 的幽灵行。
	if _, err := db.Exec(`DELETE FROM usage WHERE created_at >= ? AND created_at < ?`, m.start, m.next); err != nil {
		t.Fatal(err)
	}
	agg := r15cAggregateByUser(t, db, m)
	if r15cTotal(agg) != 14.0 {
		t.Errorf("明细老化后该月合计=%.2f（期望 14.00 —— 被删用户的费用不得回涨）labels=%v",
			r15cTotal(agg), r15cLabels(agg))
	}
	if labels := r15cLabels(agg); len(labels) != 1 || labels[0] != "r15c-other" {
		t.Errorf("幽灵行：期望只剩 [r15c-other]，实得 %v", labels)
	}
	// 再跑一轮账本重建（=服务端重启一次）也不得把被抹除的行带回来。
	// 注意：此刻明细已老化 ⇒ 不再断言"明细 == 账本"（永久账本的存在意义就是明细
	// 没了仍能出报表）；此处只钉"账本侧不含被删用户"与"读出的数不回涨"。
	if err := RebuildUsageLedger(db, m.start, m.window); err != nil {
		t.Fatal(err)
	}
	if got := r15cAggregateByUser(t, db, m); r15cTotal(got) != 14.0 || len(got) != 1 {
		t.Errorf("账本重建后被删用户的费用回来了：合计=%.2f labels=%v", r15cTotal(got), r15cLabels(got))
	}
	if got := r15cTotal(mapInt64ToStr(r15cCostsByUser(t, db, "usage_daily", "day", m))); got != 14.0 {
		t.Errorf("账本重建后日账合计=%.2f（期望 14.00）", got)
	}
	if got := r15cTotal(mapInt64ToStr(r15cCostsByUser(t, db, "usage_monthly", "month", m))); got != 14.0 {
		t.Errorf("账本重建后月账合计=%.2f（期望 14.00）", got)
	}
}

// TestR15CDeleteUserErasesBalanceLedgerAndKeepsGlobalInvariant：删除用户后
// I2 仍成立（全局账本合计 == 现存用户余额合计），且返回的被抹除金额可用于审计。
func TestR15CDeleteUserErasesBalanceLedgerAndKeepsGlobalInvariant(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	victim, err := CreateUserWithPassword(db, "r15c-money-a", "Probe-Password-123")
	if err != nil {
		t.Fatal(err)
	}
	other, err := CreateUserWithPassword(db, "r15c-money-b", "Probe-Password-123")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AdjustUserBalance(db, victim, 100.0, "期初发放", "probe-admin"); err != nil {
		t.Fatalf("adjust victim: %v", err)
	}
	if _, err := AdjustUserBalance(db, other, 40.0, "期初发放", "probe-admin"); err != nil {
		t.Fatalf("adjust other: %v", err)
	}
	if _, err := SetUserBalance(db, victim, 70.0, "手工扣减", "probe-admin"); err != nil {
		t.Fatalf("set victim balance: %v", err)
	}
	// 前置：I2 成立。
	r15cAssertBalanceInvariant(t, db)

	erased, err := DeleteUser(db, victim)
	if err != nil {
		t.Fatalf("DeleteUser: %v", err)
	}

	// I2：孤儿流水清零 + 全局合计仍相等（修前这里红）。
	r15cAssertBalanceInvariant(t, db)

	// 其他用户的流水分毫不动。
	var otherRows int
	if err := db.QueryRow(`SELECT COUNT(*) FROM balance_ledger WHERE user_id = ?`, other).Scan(&otherRows); err != nil {
		t.Fatal(err)
	}
	if otherRows == 0 {
		t.Errorf("删除 %d 误伤了其他用户的资金流水", victim)
	}
	sum, err := BalanceLedgerSum(db, victim)
	if err != nil {
		t.Fatal(err)
	}
	if sum != 0 {
		t.Errorf("被删用户的资金流水仍存在：SUM=%.2f", sum)
	}

	// 审计凭据：被抹除的金额必须能说清（否则对账缺口无从解释）。
	if erased.BalanceAmount != 70.0 || erased.BalanceRows < 2 {
		t.Errorf("抹除摘要不对：balance=%.2f rows=%d（期望净额 70.00、至少 2 条流水）",
			erased.BalanceAmount, erased.BalanceRows)
	}
}

// TestR15CDeleteUserErasedSummaryReportsUsage：抹除摘要必须报出用量侧金额，
// 使审计链能回答"删这个用户抹掉了多少计量金额"。
func TestR15CDeleteUserErasedSummaryReportsUsage(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	m := newR15CMonth(t, 2026, time.May, 6)
	victim, err := CreateUserWithPassword(db, "r15c-sum", "Probe-Password-123")
	if err != nil {
		t.Fatal(err)
	}
	r15cInsertUsage(t, db, victim, 12.5, m.day)
	r15cInsertUsage(t, db, victim, 7.5, m.day.Add(time.Hour))
	if err := RebuildUsageLedger(db, m.start, m.window); err != nil {
		t.Fatal(err)
	}
	erased, err := DeleteUser(db, victim)
	if err != nil {
		t.Fatal(err)
	}
	if erased.UsageCost != 20.0 || erased.UsageRequests != 2 {
		t.Errorf("抹除摘要不对：cost=%.2f requests=%d（期望 20.00 / 2）", erased.UsageCost, erased.UsageRequests)
	}
	// 摘要是**事前读数**：抹除后三个关系里该用户的行都必须为 0。
	for _, rel := range []string{"usage", "usage_daily", "usage_monthly"} {
		var n int
		if err := db.QueryRow(fmt.Sprintf(`SELECT COUNT(*) FROM %s WHERE user_id = ?`, rel), victim).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Errorf("%s 仍留有被删用户的 %d 行", rel, n)
		}
	}
}
