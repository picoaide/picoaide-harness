package serverstore

// R5-A-9 / R5-A-10 的回归判据（第五轮审计 2026-09-23，报告
// temp/round5-2026-09-23/R5-A-liveness.md §面 2；两条都由真 PG 探针复现过）。
//
//	R5-A-9  一个**错界老分区**让 CleanupUsageRetention 整轮中止（清理被"自己
//	        要清的东西"挡住）⇒ 保留策略永久停摆，只能人工 DROP。
//	R5-A-10 保留期**放大** + 启动补算把已 DROP 的月份**空重建** ⇒ 聚合按
//	        "分区在 ⇒ 读明细"读到空表，永久账本里的金额被静默隐藏（实测
//	        聚合 0.0000 / 账本直读 3.0000）。
//
// 两条判据互补：
//   - 根因判据（TestCleanupNotBlockedByMisboundedOldPartition /
//     TestRebuildLedgerDoesNotRegrowEmptyDetailPartition）钉**产生点**：
//     形态异常不得中止清理、无明细不得建空分区；
//   - 不变量判据（assertMonthEqualsMonthlyLedger）钉**结果**：对同一
//     (user, model, month)，窗口聚合（含账本回退）必须与月账本直读一致 ——
//     这条与"空分区从哪来"无关，所以旧版本遗留的空分区、人工 DDL 都被覆盖。

import (
	"database/sql"
	"math"
	"testing"
	"time"
)

// usageRowAt 直插一条明细（指定北京月内的某一天与金额），返回行 id。
// 直插而不是走 RecordUsageKind：本文件的判据与"写路径的 ensure"无关。
func usageRowAt(t *testing.T, db *sql.DB, uid int64, model string, at time.Time, cost float64) int64 {
	t.Helper()
	var id int64
	if err := db.QueryRow(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
		VALUES (?, ?, 1000, 500, 'chat', ?, ?, FALSE) RETURNING id`,
		uid, model, cost, at).Scan(&id); err != nil {
		t.Fatalf("insert usage (%s @ %s): %v", model, at.Format(time.RFC3339), err)
	}
	return id
}

// monthWindow 返回某个北京月的闭区间日期值。
func monthWindow(month time.Time) (time.Time, time.Time) {
	start := dayKey(BeijingMonth(month))
	return start, start.AddDate(0, 1, -1)
}

// usageWindowCost 求和某个窗口的聚合（走 UsageAggregateWithLedger，group=model）。
func usageWindowCost(t *testing.T, db *sql.DB, from, to time.Time) map[string]float64 {
	t.Helper()
	rows, err := UsageAggregateWithLedger(db, from, to, "model")
	if err != nil {
		t.Fatalf("UsageAggregateWithLedger(%s..%s): %v", from.Format(dateFmt), to.Format(dateFmt), err)
	}
	out := map[string]float64{}
	for _, r := range rows {
		out[r.Label] = r.Cost
	}
	return out
}

// monthlyLedgerCost 直读月账本 usage_monthly（同一月份的 (model → cost)）。
func monthlyLedgerCost(t *testing.T, db *sql.DB, month time.Time) map[string]float64 {
	t.Helper()
	rows, err := db.Query(`SELECT model, COALESCE(SUM(cost), 0) FROM usage_monthly
		WHERE month = ?::date GROUP BY model`, dayKey(BeijingMonth(month)).Format(dateFmt))
	if err != nil {
		t.Fatalf("read usage_monthly %s: %v", monthKey(month), err)
	}
	defer rows.Close()
	out := map[string]float64{}
	for rows.Next() {
		var model string
		var cost float64
		if err := rows.Scan(&model, &cost); err != nil {
			t.Fatal(err)
		}
		out[model] = cost
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// assertMonthEqualsMonthlyLedger 是 R5-A-10 的**不变量判据**：对同一个
// (user, model, month)，窗口聚合（明细段 + 账本段）必须与月账本直读一致。
//
// 为什么是这两者：窗口聚合是报表/用量中心的口径，月账本是"永久账本"这一事实源；
// 两者不一致就意味着**有金额被静默隐藏**（R5-A-10 的实测形态：聚合 0.0000 /
// 账本 3.0000）。判据与"空分区从何而来"无关，因此对旧版本遗留形态同样有效。
func assertMonthEqualsMonthlyLedger(t *testing.T, db *sql.DB, month time.Time, context string) {
	t.Helper()
	from, to := monthWindow(month)
	got := usageWindowCost(t, db, from, to)
	want := monthlyLedgerCost(t, db, month)
	for model, wantCost := range want {
		gotCost, ok := got[model]
		if !ok {
			t.Fatalf("%s：%s 的 model=%s 在月账本里有 %.4f，窗口聚合里整条缺失（金额被隐藏）",
				context, monthKey(month), model, wantCost)
		}
		if math.Abs(gotCost-wantCost) > 1e-6 {
			t.Fatalf("%s：%s 的 model=%s 窗口聚合 %.4f ≠ 月账本直读 %.4f（不变量被破坏）",
				context, monthKey(month), model, gotCost, wantCost)
		}
	}
	for model, gotCost := range got {
		if _, ok := want[model]; !ok && math.Abs(gotCost) > 1e-6 {
			t.Fatalf("%s：%s 的 model=%s 窗口聚合有 %.4f，但月账本里没有这一行（口径分叉）",
				context, monthKey(month), model, gotCost)
		}
	}
}

// TestCleanupNotBlockedByMisboundedOldPartition 是 R5-A-9 的根因判据。
//
// 构造（与审计探针 1 同形）：一个"极老"的**错界真分区**（UTC 自然月边界，
// 运行期期望的是北京月，差 8 小时；关系名排最前 ⇒ 旧实现第一条就中止）+
// 一个正常的到期月分区。旧行为：CleanupUsageRetention 返回错误，正常的到期
// 分区留在盘上（保留策略永久停摆，只能人工 DROP）。
//
// 修后判据三条：
//  1. 返回 nil（形态异常不再中止整轮）；
//  2. 正常的到期分区**被清掉**（与被跳过的月份无关的清理必须继续）；
//  3. 错界分区本身也被 DETACH+DROP（它才是清理的正当对象），且它持有的那行
//     明细在 DROP 之前已经进账本（该月没有被"补账失败"拖成丢账）。
func TestCleanupNotBlockedByMisboundedOldPartition(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE")
	uid := mustUserID(t, db)

	// 错界真分区：UTC 自然月 2020-01（期望窗口是北京月 2020-01，差 8 小时）。
	if _, err := db.Exec("DROP TABLE IF EXISTS usage_202001"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE usage_202001 PARTITION OF usage
		FOR VALUES FROM ('2020-01-01 00:00:00+00') TO ('2020-02-01 00:00:00+00')`); err != nil {
		t.Fatalf("造错界分区: %v", err)
	}
	// 该分区里放一行：清理必须先把它算进账本再 DROP（否则是丢账，不是清理）。
	usageRowAt(t, db, uid, "misbounded-model", time.Date(2020, 1, 15, 0, 0, 0, 0, time.UTC), 2.5)

	// 保留 2 个月 ⇒ cutoff = 当前北京月 - 2。4 个月前的正常分区本应被清掉。
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	victimRel := "usage_" + monthKey(bjMonth(4))
	if !relationExists(t, db, victimRel) {
		t.Fatalf("夹具无效：%s 不存在（测试库预建分区窗口变了？）", victimRel)
	}

	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("错界老分区让整轮清理中止（R5-A-9 未修）：%v", err)
	}
	if relationExists(t, db, victimRel) {
		t.Fatalf("清理返回了 nil，但无关的到期分区 %s 仍在（清理被自己要清的东西挡住）", victimRel)
	}
	if relationExists(t, db, "usage_202001") {
		t.Fatal("错界分区本身没有被清理（它正是保留策略的正当对象）")
	}
	// 错界分区持有的明细必须先落进账本再 DROP（形状异常 ≠ 可以丢账）。
	var ledgerCost float64
	if err := db.QueryRow(`SELECT COALESCE(SUM(cost), 0) FROM usage_daily
		WHERE user_id = ? AND model = 'misbounded-model' AND day = '2020-01-15'::date`, uid).Scan(&ledgerCost); err != nil {
		t.Fatal(err)
	}
	if math.Abs(ledgerCost-2.5) > 1e-6 {
		t.Fatalf("错界分区被 DROP 前没有把它的明细补进账本：usage_daily = %.4f, want 2.5000（丢账）", ledgerCost)
	}
	// 不变量：窗口聚合与月账本直读一致（该月明细已不在，只能走账本）。
	assertMonthEqualsMonthlyLedger(t, db, time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC), "R5-A-9 清理后")
}

// TestRebuildLedgerDoesNotRegrowEmptyDetailPartition 是 R5-A-10 的根因判据
// （钉**产生点**：无明细的月份不得被建出空分区）。
//
// 构造（与审计探针 2 同形）：
//
//	① 6 个月前写 2×cost=1.5 → 重建账本 → 聚合 3.00；
//	② retention=1 + 清理 ⇒ 该月分区被 DROP（账本仍在，聚合仍 3.00）；
//	③ retention=6 + 与 cmd/server/main.go 启动补算同形的 RebuildUsageLedger。
//
// 旧行为：③ 为该月建出**空**分区 ⇒ 聚合按"分区在 ⇒ 读明细"读到 0.0000，而账本
// 直读仍是 3.0000（永久少计）。修后：③ 不建空分区（该月没有明细），聚合仍走账本。
func TestRebuildLedgerDoesNotRegrowEmptyDetailPartition(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE")
	uid := mustUserID(t, db)

	// 6 个月前：既在启动补算窗口（now-6m..now）里，又早于 retention=1 的 cutoff。
	m := bjMonth(6)
	rel := "usage_" + monthKey(m)
	if !relationExists(t, db, rel) {
		t.Fatalf("夹具无效：%s 不存在（测试库预建分区窗口变了？）", rel)
	}
	from, to := monthWindow(m)
	at := BeijingMonthInstant(m).Add(10 * time.Hour)
	usageRowAt(t, db, uid, "r5a-empty-model", at, 1.5)
	usageRowAt(t, db, uid, "r5a-empty-model", at.Add(time.Hour), 1.5)
	if err := RebuildUsageLedger(db, from, to); err != nil {
		t.Fatalf("RebuildUsageLedger: %v", err)
	}
	assertMonthEqualsMonthlyLedger(t, db, m, "重建后")

	// ① 保留期缩到 1 个月 ⇒ 该月明细分区被 DROP（先补账）。
	if err := SetSetting(db, RetentionMonthsSetting, "1"); err != nil {
		t.Fatal(err)
	}
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if relationExists(t, db, rel) {
		t.Fatalf("%s 应已被 DROP（保留 1 个月，该月是 6 个月前）", rel)
	}
	// R4-C-4 的修复点：分区不在 ⇒ 回落永久账本，金额仍在。
	if got := usageWindowCost(t, db, from, to)["r5a-empty-model"]; math.Abs(got-3.0) > 1e-6 {
		t.Fatalf("分区被 DROP 后应回落账本得 3.0000，实际 %.4f", got)
	}

	// ② 保留期放大到 6 个月 + 启动补算（与 cmd/server/main.go 同形）。
	if err := SetSetting(db, RetentionMonthsSetting, "6"); err != nil {
		t.Fatal(err)
	}
	windowFrom := BeijingDay(time.Now()).AddDate(0, -6, 0)
	if err := RebuildUsageLedger(db, windowFrom, time.Now()); err != nil {
		t.Fatalf("startup-style rebuild: %v", err)
	}
	winStart, _ := monthWindow(m)
	if BeijingMonth(windowFrom).After(winStart) {
		t.Skipf("启动窗口（%s 起）未覆盖 %s，本次判据不适用", windowFrom.Format(dateFmt), monthKey(m))
	}
	if relationExists(t, db, rel) {
		t.Fatalf("启动补算为**没有明细**的月份 %s 建出了空分区（R5-A-10 的根因："+
			"聚合会把它判成明细源，账本里的 3.00 被隐藏）", rel)
	}
	if got := usageWindowCost(t, db, from, to)["r5a-empty-model"]; math.Abs(got-3.0) > 1e-6 {
		t.Fatalf("启动式重建后窗口聚合 = %.4f, want 3.0000（永久少计）", got)
	}
	assertMonthEqualsMonthlyLedger(t, db, m, "启动式重建后")
}

// TestUsageAggregateFallsBackToLedgerWhenEmptyDetailPartitionExists 是 R5-A-10
// 的**纵深防御**判据（钉结果：空分区不得胜过一个非空的永久账本）。
//
// 根因修在产生点之后，仍有两条路径能留下"空分区 + 有账本"：
//   - 旧版本已经产生的空分区（升级现场，不会自己消失）；
//   - 人工 DDL / 运维脚本建出的同月空分区。
//
// 所以判据必须独立于产生点构造：这里**手工**建出空分区（先 DROP 真分区，再以
// 同名建一个空分区），断言聚合回落到永久账本、且与月账本直读一致。
func TestUsageAggregateFallsBackToLedgerWhenEmptyDetailPartitionExists(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE")
	uid := mustUserID(t, db)

	m := bjMonth(4)
	from, to := monthWindow(m)
	usageRowAt(t, db, uid, "r5a-stale-empty-model", BeijingMonthInstant(m).Add(9*time.Hour), 7.25)
	if err := RebuildUsageLedger(db, from, to); err != nil {
		t.Fatalf("RebuildUsageLedger: %v", err)
	}
	// 手工制造"分区在但为空"的形态（等价于旧版本的启动补算产物）。
	dropUsageMonthPartition(t, db, m)
	spec := usageMonthPartitionSpec(m)
	if _, err := db.Exec("CREATE TABLE " + spec.relation() + " PARTITION OF " + spec.parent +
		" FOR VALUES FROM ('" + spec.from + "') TO ('" + spec.to + "')"); err != nil {
		t.Fatalf("重建空分区: %v", err)
	}
	if !relationExists(t, db, spec.relation()) {
		t.Fatal("夹具无效：空分区没建出来")
	}
	var detailRows int
	if err := db.QueryRow(`SELECT COUNT(*) FROM usage WHERE created_at >= ?::timestamptz AND created_at < ?::timestamptz`,
		spec.from, spec.to).Scan(&detailRows); err != nil {
		t.Fatal(err)
	}
	if detailRows != 0 {
		t.Fatalf("夹具无效：分区里还有 %d 行明细", detailRows)
	}
	if got := usageWindowCost(t, db, from, to)["r5a-stale-empty-model"]; math.Abs(got-7.25) > 1e-6 {
		t.Fatalf("分区存在但为空时聚合读了空明细：%.4f, want 7.2500（账本里的金额被隐藏）", got)
	}
	assertMonthEqualsMonthlyLedger(t, db, m, "空分区遗留")
}
