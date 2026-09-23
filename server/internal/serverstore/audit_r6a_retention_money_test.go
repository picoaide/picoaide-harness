package serverstore

// 复审 V1 §1.5-A / §1.5-B 的回归判据（审计 2026-09-23，两条 P1，均由真 PG 探针
// 实证过静默金额丢失）。两条缺陷都长在同一处保留清理逻辑里，判据也放在一起：
//
//	A｜**孤儿绕过补账**：名为 usage_<YYYYMM> 的**表形态**孤儿（F11 的 DETACH
//	   残留、人工改造、独立二级分区父表）到期时被直接 DROP。它不挂在 usage 下
//	   ⇒ 聚合与永久账本都读不到它的行 ⇒ 明细被删而账本零行（实测同数据同一轮
//	   清理：孤儿路径 ledger_rows_after=0 ↔ 真分区对照 =1）。
//	B｜**错界分区被 DROP**：分区实际持有相邻月前 8 小时的明细（UTC 自然月边界
//	   与北京月差 8 小时），补账只覆盖名义月 ⇒ 相邻月的聚合按"分区在且非空 ⇒
//	   读明细"读到一个已被 DROP 带走的前 8 小时（实测 7 月聚合 11.00 → 1.00，
//	   纯账本 10.00）。
//
// 判据形状：
//   - A：同数据、同一轮清理的**两条路径对拍**（孤儿 vs 真分区对照），账本
//     (行数, 金额) 必须相同且非零 —— 单看孤儿路径非零还不够，对照才说明
//     "与正常分区同一条补账路径"；
//   - B：清理后相邻月的**聚合值 == 账本值 == 清理前的值**（三口径一致）。
//
// 两条都有反例保护：夹具先断言"清理前账本里没有这笔钱"，否则"补账生效"可能
// 只是账本里本来就有（假绿）。

import (
	"database/sql"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"
)

// r6Quote 把关系名渲染成可安全内联的标识符。本文件**自足**：不依赖产品侧新增
// 的任何符号，因此同一份判据可以直接放进基线副本里跑，用来证明"修前是红的"。
func r6Quote(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// r6LedgerStats 返回某北京月在永久日账 usage_daily 里的 (行数, 金额合计)。
func r6LedgerStats(t *testing.T, db *sql.DB, month time.Time) (int64, float64) {
	t.Helper()
	start := dayKey(BeijingMonth(month))
	end := start.AddDate(0, 1, 0)
	var rows int64
	var cost float64
	if err := db.QueryRow(`SELECT count(*), COALESCE(SUM(cost), 0) FROM usage_daily
		WHERE day >= ?::date AND day < ?::date`,
		start.Format(dateFmt), end.Format(dateFmt)).Scan(&rows, &cost); err != nil {
		t.Fatalf("读 %s 的日账: %v", monthKey(month), err)
	}
	return rows, cost
}

// r6SumCost 求和一次窗口聚合的金额（走 UsageAggregateWithLedger，与报表同口径）。
func r6SumCost(t *testing.T, db *sql.DB, from, to time.Time) float64 {
	t.Helper()
	rows, err := UsageAggregateWithLedger(db, from, to, "model")
	if err != nil {
		t.Fatalf("UsageAggregateWithLedger(%s..%s): %v", from.Format(dateFmt), to.Format(dateFmt), err)
	}
	var sum float64
	for _, r := range rows {
		sum += r.Cost
	}
	return sum
}

// r6DropMonthPartitions 删掉 [from, to]（北京月首）的月分区（含已经不存在的）。
func r6DropMonthPartitions(t *testing.T, db *sql.DB, from, to time.Time) {
	t.Helper()
	for m := BeijingMonth(from); !m.After(BeijingMonth(to)); m = m.AddDate(0, 1, 0) {
		rel := r6Quote("usage_" + monthKey(m))
		_, _ = db.Exec("ALTER TABLE usage DETACH PARTITION " + rel)
		if _, err := db.Exec("DROP TABLE IF EXISTS " + rel); err != nil {
			t.Fatalf("drop %s: %v", rel, err)
		}
	}
}

// r6MakeUTCMonthPartitions 把 [from, to] 的月分区整体改造成 **UTC 自然月**边界
// （比北京月早 8 小时 ⇒ 每个分区持有下一个北京月前 8 小时的明细）。
//
// 两趟：先把整段摘掉（PG 不允许分区区间重叠 ⇒ 不能边摘边建），再按 UTC 自然月建。
func r6MakeUTCMonthPartitions(t *testing.T, db *sql.DB, from, to time.Time) {
	t.Helper()
	r6DropMonthPartitions(t, db, from, to)
	for m := BeijingMonth(from); !m.After(BeijingMonth(to)); m = m.AddDate(0, 1, 0) {
		rel := "usage_" + monthKey(m)
		lo := time.Date(m.Year(), m.Month(), 1, 0, 0, 0, 0, time.UTC)
		hi := lo.AddDate(0, 1, 0)
		if _, err := db.Exec(fmt.Sprintf(
			"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s')",
			r6Quote(rel), lo.Format("2006-01-02 15:04:05-07"), hi.Format("2006-01-02 15:04:05-07"))); err != nil {
			t.Fatalf("建 UTC 自然月分区 %s [%s,%s): %v", rel, lo, hi, err)
		}
	}
}

// r6PartitionOf 返回某行物理落在哪个关系里（夹具有效性判据）。
func r6PartitionOf(t *testing.T, db *sql.DB, id int64) string {
	t.Helper()
	var rel string
	if err := db.QueryRow(`SELECT tableoid::regclass::text FROM usage WHERE id = ?`, id).Scan(&rel); err != nil {
		t.Fatalf("读行的分区: %v", err)
	}
	return rel
}

// r6SeedExpiredRow 在 bjMonth(monthsAgo) 月 10 日写一行固定金额的明细，
// 返回 (行 id, 该月月首)。
func r6SeedExpiredRow(t *testing.T, db *sql.DB, uid int64, monthsAgo int, model string, cost float64) (int64, time.Time) {
	t.Helper()
	m := bjMonth(monthsAgo)
	if err := ensureUsagePartition(db, m); err != nil {
		t.Fatalf("建 %s 的月分区: %v", monthKey(m), err)
	}
	id := usageRowAt(t, db, uid, model, BeijingDayAt(m, 10), cost)
	return id, m
}

// TestUsageRetentionDetachedTableBackfillsLedgerBeforeDrop 是 §1.5-A 的判据（叶子
// 孤儿形态：DETACH 成功但 DROP 失败的 F11 残留）。
//
// 同数据、同一轮清理跑两条路径：孤儿（DETACH 后留有明细）↔ 真分区对照。修前
// 孤儿路径直接 DROP ⇒ 账本 0 行；对照路径先补账再 DETACH+DROP ⇒ 账本 1 行。
// 修后两条路径必须给出**相同且非零**的 (行数, 金额)，孤儿仍照常被清掉。
func TestUsageRetentionDetachedTableBackfillsLedgerBeforeDrop(t *testing.T) {
	const cost = 12.5
	run := func(t *testing.T, orphan bool) (rows int64, amount float64, gone bool) {
		t.Helper()
		db, cleanup := NewTestDB(t)
		defer cleanup()
		if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
			t.Fatal(err)
		}
		if err := SetSetting(db, RetentionMonthsSetting, "1"); err != nil {
			t.Fatal(err)
		}
		uid := mustUserID(t, db)
		_, m := r6SeedExpiredRow(t, db, uid, 2, "m-r6a-orphan", cost)
		if orphan {
			rel := "usage_" + monthKey(m)
			if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + r6Quote(rel)); err != nil {
				t.Fatalf("把 %s 变成孤儿表: %v", rel, err)
			}
		}
		// 反例保护：清理前账本里必须**没有**这笔钱，否则"补账生效"是假绿。
		if rows0, amount0 := r6LedgerStats(t, db, m); rows0 != 0 || amount0 != 0 {
			t.Fatalf("夹具无效：清理前 %s 的日账已有 %d 行 / %.4f", monthKey(m), rows0, amount0)
		}
		if err := CleanupUsageRetention(db); err != nil {
			t.Fatalf("CleanupUsageRetention(orphan=%v): %v", orphan, err)
		}
		rows, amount = r6LedgerStats(t, db, m)
		gone = !relationExists(t, db, "usage_"+monthKey(m))
		if orphan && !gone {
			t.Fatalf("叶子孤儿表 %s 应当照常被清掉（补账成功后才 DROP）", monthKey(m))
		}
		return rows, amount, gone
	}

	orphanRows, orphanCost, _ := run(t, true)
	ctrlRows, ctrlCost, _ := run(t, false)
	if ctrlRows == 0 || math.Abs(ctrlCost-cost) > 1e-9 {
		t.Fatalf("对照路径（真分区）未按预期补账：rows=%d cost=%.4f（want rows=1 cost=%.4f）", ctrlRows, ctrlCost, cost)
	}
	if orphanRows != ctrlRows || math.Abs(orphanCost-ctrlCost) > 1e-9 {
		t.Fatalf("孤儿路径与真分区对照的账本不一致（§1.5-A 未修）：孤儿 rows=%d cost=%.4f ↔ 对照 rows=%d cost=%.4f"+
			"（孤儿不在 usage 之下 ⇒ 不先并入/补账就 DROP 会让这笔金额永久消失）",
			orphanRows, orphanCost, ctrlRows, ctrlCost)
	}
}

// TestUsageRetentionDetachedPartitionedParentBackfillsLedgerAndSkipsDrop 是 §1.5-A
// 的"父表 + 子分区"形态：名为 usage_<YYYYMM> 的**独立**二级分区父表（relkind='p'
// 且 pg_inherits 里有子关系）。
//
// 旧实现把 'p' 也判成"可 DROP TABLE"⇒ 直接删掉整棵子树（含子分区里的明细），
// 账本零行。修后：先按它实际持有的明细补齐账本，再**跳过 DROP 并记录**
// （DROP TABLE 会连子关系一起删，服务端不替管理员做这个决定）。
//
// 金额判据：账本行数与金额必须等于该行本身（与"真分区对照"同口径）。
func TestUsageRetentionDetachedPartitionedParentBackfillsLedgerAndSkipsDrop(t *testing.T) {
	const cost = 7.25
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "1"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	m := bjMonth(2)
	rel := "usage_" + monthKey(m)

	// 先把同名真分区摘掉，再把它重建成**独立的**二级分区父表（不挂在 usage 下）：
	// 这正是 §1.5-A 里"relkind='p' 被判成可直接 DROP"的形态。
	if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + r6Quote(rel)); err != nil {
		t.Fatalf("detach %s: %v", rel, err)
	}
	if _, err := db.Exec("DROP TABLE IF EXISTS " + r6Quote(rel)); err != nil {
		t.Fatalf("drop %s: %v", rel, err)
	}
	if _, err := db.Exec("CREATE TABLE " + r6Quote(rel) +
		" (LIKE usage INCLUDING ALL) PARTITION BY RANGE (created_at)"); err != nil {
		t.Fatalf("建独立二级分区父表 %s: %v", rel, err)
	}
	start := BeijingDayInstant(dayKey(m))
	end := BeijingDayInstant(dayKey(m).AddDate(0, 1, 0))
	child := rel + "_p1"
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
		r6Quote(child), r6Quote(rel),
		start.Format(pgInstantFmt), end.Format(pgInstantFmt))); err != nil {
		t.Fatalf("建子分区 %s: %v", child, err)
	}
	if _, err := db.Exec(`INSERT INTO `+r6Quote(rel)+
		` (user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
		VALUES (?, 'm-r6a-parent', 1000, 500, 'chat', ?, ?, FALSE)`,
		uid, cost, BeijingDayAt(m, 10)); err != nil {
		t.Fatalf("往子分区写明细: %v", err)
	}
	// 反例保护：清理前账本里没有这笔钱。
	if rows0, amount0 := r6LedgerStats(t, db, m); rows0 != 0 || amount0 != 0 {
		t.Fatalf("夹具无效：清理前 %s 的日账已有 %d 行 / %.4f", monthKey(m), rows0, amount0)
	}

	logs := captureRetentionLog(t)
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("父表形态不应报错（补账成功 ⇒ 跳过 DROP 即可）: %v", err)
	}
	rows, amount := r6LedgerStats(t, db, m)
	if rows != 1 || math.Abs(amount-cost) > 1e-9 {
		t.Fatalf("独立二级分区父表被清掉前没有把明细补进账本（§1.5-A 未修）：usage_daily rows=%d cost=%.4f, want rows=1 cost=%.4f",
			rows, amount, cost)
	}
	if !relationExists(t, db, rel) {
		t.Fatalf("%s 被静默 DROP 了：父表/带子关系必须**跳过并记录**（DROP TABLE 会连子关系一起删）", rel)
	}
	if !relationExists(t, db, child) {
		t.Fatalf("子分区 %s 被连带删除（父表不应被 DROP）", child)
	}
	out := logs.String()
	if !strings.Contains(out, "SKIP detached relation "+rel) || !strings.Contains(out, "skipped=") {
		t.Fatalf("跳过父表形态必须留下可 grep 的警告（SKIP detached relation … / skipped=）:\n%s", out)
	}
	// 聚合口径必须与账本一致：该月没有叶子分区 ⇒ 聚合走账本，仍是这笔钱。
	from, to := dayKey(m), dayKey(m).AddDate(0, 1, -1)
	if got := r6SumCost(t, db, from, to); math.Abs(got-cost) > 1e-9 {
		t.Fatalf("父表形态的窗口聚合 %.4f ≠ 账本 %.4f（金额被隐藏或重复计数）", got, amount)
	}
}

// TestUsageRetentionMisboundedPartitionKeepsAdjacentMonthAmount 是 §1.5-B 的判据。
//
// 构造（与复审探针同形，月份相对当前月取，避免写死历史日期）：
//   - retention=2 ⇒ cutoff = bjMonth(2) = m2；m1 = bjMonth(3) 到期、m2 保留；
//   - 把 m1/m2 做成 **UTC 自然月**分区（错界尾段：PG 禁止分区区间重叠 ⇒ 这种
//     "持有相邻月前 8 小时"的形态只能整段尾部都错界才存在）；
//   - 行 A：北京 m2 月 1 日 03:00 → 物理落在 UTC-m1 分区（相邻月前 8 小时）；
//     行 B：北京 m2 月 14 日 10:00 → 落在 UTC-m2 分区（让 m2 的明细段非空）。
//
// 修前：m1 被 DETACH+DROP ⇒ m2 的前 8 小时（10.00）随分区消失，而 m2 分区仍在
// 且非空 ⇒ 聚合读明细 ⇒ 少计 10.00（11.00 → 1.00）。
// 修后：这部分行要么被**并入** m2 的分区（并入成功才 DROP），要么（并入做不
// 到，例如相邻月分区不覆盖那些瞬时）**不删**；无论哪条路，账本都按相邻月
// **整月**补齐 ⇒ 聚合 == 账本 == 清理前的值。
func TestUsageRetentionMisboundedPartitionKeepsAdjacentMonthAmount(t *testing.T) {
	const (
		adjacentCost = 10.0 // 行 A：北京 m2 月 1 日 03:00（落在 UTC-m1 分区）
		inMonthCost  = 1.0  // 行 B：北京 m2 月 14 日（落在 UTC-m2 分区）
	)
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	m1 := bjMonth(3) // 到期（清理对象）
	m2 := bjMonth(2) // 相邻月（保留）

	// 先把 m2 之后的整段尾部摘掉（UTC-m2 与北京 m2+1 分区重叠，PG 不允许共存），
	// 再把 m1/m2 做成 UTC 自然月分区。
	r6DropMonthPartitions(t, db, m2.AddDate(0, 1, 0), BeijingMonth(time.Now()).AddDate(0, 6, 0))
	r6MakeUTCMonthPartitions(t, db, m1, m2)

	idA := usageRowAt(t, db, uid, "m-r6b-adjacent", BeijingDayAt(m2, 3), adjacentCost)
	idB := usageRowAt(t, db, uid, "m-r6b-adjacent", BeijingDayAt(m2.AddDate(0, 0, 13), 10), inMonthCost)
	if got, want := r6PartitionOf(t, db, idA), "usage_"+monthKey(m1); got != want {
		t.Fatalf("夹具无效：北京 %s 月 1 日 03:00 的行落在 %s，want %s（UTC 错界分区没铺出来）",
			monthKey(m2), got, want)
	}
	if got, want := r6PartitionOf(t, db, idB), "usage_"+monthKey(m2); got != want {
		t.Fatalf("夹具无效：北京 %s 月 14 日的行落在 %s，want %s", monthKey(m2), got, want)
	}
	from, to := dayKey(m2), dayKey(m2).AddDate(0, 1, -1)
	before := r6SumCost(t, db, from, to)
	if math.Abs(before-(adjacentCost+inMonthCost)) > 1e-9 {
		t.Fatalf("夹具无效：清理前 %s 的聚合 %.4f，want %.4f", monthKey(m2), before, adjacentCost+inMonthCost)
	}

	logs := captureRetentionLog(t)
	if err := CleanupUsageRetention(db); err != nil {
		// 并入做不到时清理会 fail-loud（保留策略把这条关系交回人工处置）。
		// 这不是失败判据：判据是**钱没丢且两个口径一致**（见下）。
		t.Logf("cleanup 返回错误（错界分区交回人工处置）: %v", err)
	}
	after := r6SumCost(t, db, from, to)
	ledgerCost := func() float64 {
		var c float64
		if err := db.QueryRow(`SELECT COALESCE(SUM(cost), 0) FROM usage_monthly
			WHERE month = ?::date AND model = 'm-r6b-adjacent'`, dayKey(m2).Format(dateFmt)).Scan(&c); err != nil {
			t.Fatal(err)
		}
		return c
	}()
	if math.Abs(after-before) > 1e-9 {
		t.Fatalf("§1.5-B 未修：错界分区被清掉后 %s 的聚合从 %.4f 变成 %.4f（相邻月前 8 小时的明细随分区消失）\n日志:\n%s",
			monthKey(m2), before, after, logs.String())
	}
	if math.Abs(ledgerCost-before) > 1e-9 {
		t.Fatalf("§1.5-B 未修：清理后 %s 的账本 %.4f ≠ 清理前的聚合 %.4f（账本与聚合两个口径分叉）",
			monthKey(m2), ledgerCost, before)
	}
	if math.Abs(after-ledgerCost) > 1e-9 {
		t.Fatalf("§1.5-B 未修：清理后 %s 的聚合 %.4f ≠ 账本 %.4f（金额被静默隐藏）",
			monthKey(m2), after, ledgerCost)
	}
}

// TestUsageRetentionWiderPartitionLedgersEveryCoveredMonth 覆盖 §1.5-B 的**第二种
// 可达形态**：名为 usage_<YYYYMM> 的叶子分区比名义月**更宽**（DBA 按季度预建，
// r7 srvbill-3 明确判定为合法配置、写入照常路由），它因此持有后续月份的明细。
//
// 旧实现（也是"直接 DROP"变异）只补**名义月**的账 ⇒ 被它覆盖的后续月份既没有
// 明细分区（它们的名字没被占用）、账本里也没有它们的行 ⇒ 聚合（走账本）读到 0，
// 金额永久消失。
//
// 修后判据：被清掉的那条关系**覆盖到的每个北京月**都必须在永久账本里有数，
// 且窗口聚合与月账本两个口径一致、等于该月真实发生的金额。
//
// 注：本形态下"更宽分区"不是那几个月明细分段的来源（分段判据只认与月同名的
// 关系），所以清理**前**这些月的聚合本来就是 0（明细被那条更宽的命名遮住）。
// 因此这里的判据不是"等于清理前"，而是"清理不得让这笔钱从任何口径里消失" ——
// 它必须被补进永久账本（这正是保留策略对"长期事实源"的承诺）。
func TestUsageRetentionWiderPartitionLedgersEveryCoveredMonth(t *testing.T) {
	const (
		nominalCost = 3.0 // 名义月（分区名所在月）
		secondCost  = 5.0 // 名义月 + 1
		thirdCost   = 2.0 // 名义月 + 2
	)
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	// retention=2 ⇒ cutoff = bjMonth(2)：名义月 = bjMonth(4) 到期，+1/+2 两月保留。
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	nominal := bjMonth(4)
	m2 := nominal.AddDate(0, 1, 0)
	m3 := nominal.AddDate(0, 2, 0)

	// 把名义月改造成**更宽**的三月分区（覆盖 nominal..m3），并把区间里原有的月
	// 分区摘掉（PG 不允许重叠；更宽的分区正是"占用这个名字又不按月切"的形态）。
	r6DropMonthPartitions(t, db, nominal, m3)
	start := BeijingDayInstant(dayKey(nominal))
	end := BeijingDayInstant(dayKey(m3).AddDate(0, 1, 0))
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s')",
		r6Quote("usage_"+monthKey(nominal)), start.Format(pgInstantFmt), end.Format(pgInstantFmt))); err != nil {
		t.Fatalf("建更宽分区 usage_%s: %v", monthKey(nominal), err)
	}
	id1 := usageRowAt(t, db, uid, "m-r6b-wide", BeijingDayAt(nominal, 10), nominalCost)
	id2 := usageRowAt(t, db, uid, "m-r6b-wide", BeijingDayAt(m2, 10), secondCost)
	id3 := usageRowAt(t, db, uid, "m-r6b-wide", BeijingDayAt(m3, 10), thirdCost)
	for id, want := range map[int64]string{id1: "usage_" + monthKey(nominal), id2: "usage_" + monthKey(nominal), id3: "usage_" + monthKey(nominal)} {
		if got := r6PartitionOf(t, db, id); got != want {
			t.Fatalf("夹具无效：行 %d 落在 %s，want %s（更宽分区没铺出来）", id, got, want)
		}
	}

	logs := captureRetentionLog(t)
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("更宽分区不得让清理失败（它是保留策略的正当对象）: %v\n日志:\n%s", err, logs.String())
	}
	if relationExists(t, db, "usage_"+monthKey(nominal)) {
		t.Fatalf("更宽分区 usage_%s 应当被清掉（补账之后）", monthKey(nominal))
	}
	for _, tc := range []struct {
		month time.Time
		want  float64
	}{
		{nominal, nominalCost},
		{m2, secondCost},
		{m3, thirdCost},
	} {
		from, to := dayKey(tc.month), dayKey(tc.month).AddDate(0, 1, -1)
		got, err := UsageAggregateWithLedger(db, from, to, "model")
		if err != nil {
			t.Fatal(err)
		}
		var agg float64
		for _, r := range got {
			agg += r.Cost
		}
		rows, ledger := r6LedgerStats(t, db, tc.month)
		if rows == 0 || math.Abs(ledger-tc.want) > 1e-9 {
			t.Fatalf("更宽分区被清掉后 %s 的永久账本 rows=%d cost=%.4f, want rows>0 cost=%.4f"+
				"（§1.5-B：只补名义月的账 ⇒ 被它覆盖的后续月份金额永久消失）",
				monthKey(tc.month), rows, ledger, tc.want)
		}
		if math.Abs(agg-tc.want) > 1e-9 || math.Abs(agg-ledger) > 1e-9 {
			t.Fatalf("%s 的窗口聚合 %.4f 与账本 %.4f / 真实金额 %.4f 不一致（§1.5-B：两个口径分叉或金额被静默隐藏）",
				monthKey(tc.month), agg, ledger, tc.want)
		}
	}
}
