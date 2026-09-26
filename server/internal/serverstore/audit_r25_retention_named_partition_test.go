package serverstore

// audit_r25_retention_named_partition_test.go —— 第二十五轮审计 Y1-B1（P1）的判据。
//
// 缺陷形态（Y1 真 PG 最小反例）：`scanUsageMonthTables` 先按 `usageMonthRelationOf`
// （严格六位数字月名）过滤，于是 DBA 预建的**异名叶子**分区（`usage_2026q3` /
// `usage_2026`）被直接 `continue` ⇒ 既不进 Partitions / Orphans / Shapes，也不进
// unreclaimed / skip_reasons / 失败计数：**既不 DETACH/DROP，也不进任何失败面**。
// 保留期到了也不删，而 `/readyz` 全绿（failed_rounds=0、unreclaimed=[]）；同一轮里
// 规范命名 `usage_202001` 被正常 DROP。与此同时，R24-X4 B4 的读路径修复**只看边界
// 不看名字**（`descendantLeafCoversWindow` / `usagePartitionCoverage`）—— 那些永不
// 清除的分区从此成了报表的**明细真源**。
//
// 修法（本文件的判据对象）：
//   - `scanUsageMonthTables` 的过滤只排除**永久账本**（usage_daily* / usage_monthly）；
//   - 月份归属改由**边界事实**推导（usageRelationShape.reclaimMonths → usageBoundMonths，
//     复用 partitions.go 的同一份边界解析，不新写第二份名字解析）；
//   - 整月对齐的叶子分区按"整块到期"判定（`m = 区间末月`），补账窗口无条件扩到声明
//     边界（否则只会补名义月、随后整块 DROP ⇒ 其余月份明细既不在盘上也没进账本）。
//
// 判据（每一条都能被"把过滤退回六位数字"或"把窗口退回名义月"打红）：
//   A. 季度名（usage_2020q1）/ 整年名（usage_2020）叶子到期后**被回收**：
//      关系消失、明细行不在盘上、金额改由永久账本承载（报表读数不变）、
//      切读源回落账本（读路径不再把它当真源）；
//   B. 规范月名（usage_202001）同样被回收 —— 存量行为的回归对照；
//   C. **未到期**的更宽分区不得被误删（保留期边界判定），且读路径仍认它的明细；
//   D. 永久账本（usage_daily / usage_daily_<YYYY> / usage_monthly）不被这条路径删
//      —— 包括**同一轮补账刚刚建出来**的 usage_daily_<YYYY>。

import (
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"
)

// r25RetentionOn 打开保留期并返回截止月（供用例自检"这个月确实到期了"）。
func r25RetentionOn(t *testing.T, db *sql.DB, months string) time.Time {
	t.Helper()
	if err := SetSetting(db, RetentionMonthsSetting, months); err != nil {
		t.Fatalf("设置保留期 %s: %v", months, err)
	}
	n, err := EffectiveRetentionMonths(db)
	if err != nil {
		t.Fatalf("读生效保留期: %v", err)
	}
	if fmt.Sprint(n) != months {
		t.Fatalf("生效保留期 = %d，want %s", n, months)
	}
	return BeijingMonth(time.Now()).AddDate(0, -n, 0)
}

// r25UsageRowsIn 统计某个关系里的明细行数（关系不存在返回 0）。
func r25UsageRowsIn(t *testing.T, db *sql.DB, rel string) int64 {
	t.Helper()
	var n int64
	if err := db.QueryRow("SELECT count(*) FROM " + quoteRelationIdent(rel)).Scan(&n); err != nil {
		t.Fatalf("统计 %s 行数: %v", rel, err)
	}
	return n
}

// r25ReportTotal 取"报表口径"（明细 ∪ 永久账本）的费用与请求数。
func r25ReportTotal(t *testing.T, db *sql.DB, username string, from, to time.Time) (float64, int64) {
	t.Helper()
	rows, err := UsageAggregateWithLedger(db, from, to, "user", WithUsername(username))
	if err != nil {
		t.Fatalf("聚合（明细 ∪ 账本）: %v", err)
	}
	cost, req := r24Sum(t, rows)
	return cost, req
}

// r25AssertReclaimed 是 A/B 的公共断言：关系被回收 + 明细不在盘上 + 金额转移而没有
// 丢失（账本补齐）+ 读路径回落账本 + 保留状态如实。
func r25AssertReclaimed(t *testing.T, db *sql.DB, username, rel string, months []time.Time, wantTotal float64) {
	t.Helper()
	if relationExists(t, db, rel) {
		t.Fatalf("%s 在保留期清理后仍然存在 —— 异名叶子分区永不被回收（Y1-B1 的缺陷形态）", rel)
	}
	var remaining int64
	for _, m := range months {
		start := dayKey(BeijingMonth(m))
		end := start.AddDate(0, 1, 0)
		var n int64
		if err := db.QueryRow(`SELECT count(*) FROM usage WHERE created_at >= ? AND created_at < ?`,
			BeijingDayInstant(start), BeijingDayInstant(end)).Scan(&n); err != nil {
			t.Fatalf("统计 %s 明细: %v", monthKey(m), err)
		}
		remaining += n
	}
	if remaining != 0 {
		t.Fatalf("%s 回收后仍留下 %d 行明细（DROP 没发生）", rel, remaining)
	}
	from, to := dayKey(BeijingMonth(months[0])), dayKey(BeijingMonth(months[len(months)-1])).AddDate(0, 1, -1)
	got, reqs := r25ReportTotal(t, db, username, from, to)
	if got != wantTotal {
		t.Fatalf("%s 回收后报表读数 = %.4f（req=%d），want %.4f —— "+
			"补账窗口没有覆盖整块分区（只补了名义月就会这样）", rel, got, reqs, wantTotal)
	}
	for _, m := range months {
		r24AssertLedger(t, db, m.Format("2006-01"))
	}
	st := CurrentUsageRetentionStatus()
	if st.FailedRounds != 0 || st.Failures != 0 {
		t.Fatalf("保留清理状态报失败：failed_rounds=%d failures=%d last_error=%q",
			st.FailedRounds, st.Failures, st.LastError)
	}
	if st.ClearedPartitions < 1 {
		t.Fatalf("cleared_partitions=%d，want ≥1（本轮确实 DROP 了分区）", st.ClearedPartitions)
	}
	for _, u := range st.Unreclaimed {
		if strings.HasPrefix(u, rel+"(") {
			t.Fatalf("被回收的 %s 仍出现在 unreclaimed 里：%v", rel, st.Unreclaimed)
		}
	}
}

// TestAuditR25RetentionReclaimsQuarterNamedLeaf —— A①：季度名叶子。
func TestAuditR25RetentionReclaimsQuarterNamedLeaf(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "r25-ret-quarter")
	cutoff := r25RetentionOn(t, db, "1")

	// DBA 预建的季度叶子：名字不是六位数字月（Y1 的现场形态原样复现）。
	r24WidePartition(t, db, "usage_2020q1", "2020-01-01 00:00:00+08", "2020-04-01 00:00:00+08")
	if !BeijingMonth(bjDate(t, "2020-03-01")).Before(cutoff) {
		t.Fatalf("夹具前提不成立：2020 年不在保留期之外（cutoff=%s）", monthKey(cutoff))
	}
	// 三个月各一笔（走生产写路径：写入按区间路由进这个更宽叶子）。
	r24UsageAt(t, db, uid, "r25-q", 3, BeijingDayInstant(bjDate(t, "2020-01-10")))
	r24UsageAt(t, db, uid, "r25-q", 4, BeijingDayInstant(bjDate(t, "2020-02-10")))
	r24UsageAt(t, db, uid, "r25-q", 5, BeijingDayInstant(bjDate(t, "2020-03-10")))
	if n := r25UsageRowsIn(t, db, "usage_2020q1"); n != 3 {
		t.Fatalf("夹具前提不成立：usage_2020q1 里只有 %d 行（want 3）", n)
	}
	// 前提：修复后的读路径此刻把它当明细真源（B4 的覆盖判据）。
	r24AssertDetail(t, db, "2020-02")
	before, _ := r25ReportTotal(t, db, "r25-ret-quarter", bjDate(t, "2020-01-01"), bjDate(t, "2020-03-31"))
	if before != 12 {
		t.Fatalf("回收前报表 = %.4f，want 12", before)
	}

	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	r25AssertReclaimed(t, db, "r25-ret-quarter", "usage_2020q1",
		[]time.Time{bjDate(t, "2020-01-01"), bjDate(t, "2020-02-01"), bjDate(t, "2020-03-01")}, before)
}

// TestAuditR25RetentionReclaimsYearNamedLeaf —— A②：整年名叶子。
func TestAuditR25RetentionReclaimsYearNamedLeaf(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "r25-ret-year")
	cutoff := r25RetentionOn(t, db, "1")

	// 一级整年分区，名字不含六位月（usageMonthRelationOf 完全不认它）。
	r24WidePartition(t, db, "usage_2020", "2020-01-01 00:00:00+08", "2021-01-01 00:00:00+08")
	if !BeijingMonth(bjDate(t, "2020-12-01")).Before(cutoff) {
		t.Fatalf("夹具前提不成立：2020 年不在保留期之外（cutoff=%s）", monthKey(cutoff))
	}
	r24UsageAt(t, db, uid, "r25-y", 6, BeijingDayInstant(bjDate(t, "2020-02-10")))
	r24UsageAt(t, db, uid, "r25-y", 7, BeijingDayInstant(bjDate(t, "2020-11-10")))
	if n := r25UsageRowsIn(t, db, "usage_2020"); n != 2 {
		t.Fatalf("夹具前提不成立：usage_2020 里只有 %d 行（want 2）", n)
	}
	r24AssertDetail(t, db, "2020-11")
	before, _ := r25ReportTotal(t, db, "r25-ret-year", bjDate(t, "2020-02-01"), bjDate(t, "2020-11-30"))
	if before != 13 {
		t.Fatalf("回收前报表 = %.4f，want 13", before)
	}

	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	// 只断言"有关系的那两个月"的切读源（整年分区覆盖的其余月份本来就没有明细）。
	if relationExists(t, db, "usage_2020") {
		t.Fatalf("usage_2020 在保留期清理后仍然存在 —— 异名叶子分区永不被回收（Y1-B1）")
	}
	for _, m := range []string{"2020-02", "2020-11"} {
		r24AssertLedger(t, db, m)
	}
	got, _ := r25ReportTotal(t, db, "r25-ret-year", bjDate(t, "2020-02-01"), bjDate(t, "2020-11-30"))
	if got != before {
		t.Fatalf("回收后报表读数 = %.4f，want %.4f（整年分区的补账窗口必须覆盖整块）", got, before)
	}
	st := CurrentUsageRetentionStatus()
	if st.FailedRounds != 0 || st.Failures != 0 || st.ClearedPartitions < 1 {
		t.Fatalf("保留状态不如实：failed_rounds=%d failures=%d cleared=%d",
			st.FailedRounds, st.Failures, st.ClearedPartitions)
	}
}

// TestAuditR25RetentionReclaimsCanonicalMonthLeaf —— B：规范月名的回归对照。
//
// 这条**修复前也是绿的**（六位数字月名一直都在回收面里）。它是"修复没有把存量
// 行为弄坏"的对照：新过滤必须仍然覆盖规范月名，且补账/回落账本的口径不变。
func TestAuditR25RetentionReclaimsCanonicalMonthLeaf(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "r25-ret-month")
	cutoff := r25RetentionOn(t, db, "1")

	if !BeijingMonth(bjDate(t, "2020-01-01")).Before(cutoff) {
		t.Fatalf("夹具前提不成立：2020-01 不在保留期之外（cutoff=%s）", monthKey(cutoff))
	}
	// 规范命名（走生产写路径建分区）。
	r24UsageAt(t, db, uid, "r25-c", 8, BeijingDayInstant(bjDate(t, "2020-01-10")))
	if !relationExists(t, db, "usage_202001") {
		t.Fatalf("夹具前提不成立：usage_202001 没建出来")
	}
	before, _ := r25ReportTotal(t, db, "r25-ret-month", bjDate(t, "2020-01-01"), bjDate(t, "2020-01-31"))

	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	r25AssertReclaimed(t, db, "r25-ret-month", "usage_202001",
		[]time.Time{bjDate(t, "2020-01-01")}, before)
}

// TestAuditR25RetentionKeepsPartiallyRetainedWidePartition —— C：未到期的更宽分区不得
// 被误删（保留期边界判定：整块都已到期才动手）。
//
// 现场形态：DBA 预建了**今年整年**的分区。它同时覆盖保留期内的月份（本月）与
// 到期月份（今年 1 月）—— "按月名/按区间首月"判定的实现会把它整块 DROP 掉，
// 连带删掉保留期内的明细。判据：关系在、行在、读路径仍认它的明细。
func TestAuditR25RetentionKeepsPartiallyRetainedWidePartition(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "r25-ret-keep")
	r25RetentionOn(t, db, "1")

	curMonth := BeijingMonth(time.Now())
	year := curMonth.Year()
	rel := fmt.Sprintf("usage_%d", year)
	// 今年整年分区与既有的月分区重叠 ⇒ 先摘掉今年的月分区（测试夹具动作）。
	r6DropMonthPartitions(t, db,
		time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC),
		time.Date(year, 12, 1, 0, 0, 0, 0, time.UTC))
	r24WidePartition(t, db, rel,
		fmt.Sprintf("%d-01-01 00:00:00+08", year), fmt.Sprintf("%d-01-01 00:00:00+08", year+1))

	// 本月的一笔（保留期内）+ 今年 1 月的一笔（到期）—— 都必须活着。
	at := BeijingDayInstant(bjDate(t, fmt.Sprintf("%d-%02d-10", year, int(curMonth.Month()))))
	r24UsageAt(t, db, uid, "r25-keep", 9, at)
	before, _ := r25ReportTotal(t, db, "r25-ret-keep", dayKey(curMonth), dayKey(curMonth).AddDate(0, 1, -1))
	if before != 9 {
		t.Fatalf("夹具前提不成立：本月报表 = %.4f，want 9", before)
	}
	r24AssertDetail(t, db, curMonth.Format("2006-01"))

	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	if !relationExists(t, db, rel) {
		t.Fatalf("%s 覆盖的最后一个北京月（%s）仍在保留期内，整块分区**不得**被 DROP "+
			"（否则连带删掉保留期内的明细）", rel, monthKey(curMonth))
	}
	if n := r25UsageRowsIn(t, db, rel); n == 0 {
		t.Fatalf("%s 还在但明细没了", rel)
	}
	got, _ := r25ReportTotal(t, db, "r25-ret-keep", dayKey(curMonth), dayKey(curMonth).AddDate(0, 1, -1))
	if got != before {
		t.Fatalf("保留期内月份的报表读数 = %.4f，want %.4f", got, before)
	}
	r24AssertDetail(t, db, curMonth.Format("2006-01"))
}

// TestAuditR25RetentionKeepsPermanentLedgerRelations —— D：永久账本不被这条路径删。
//
// 覆盖两个方向：
//   - `usage_monthly`（普通表，无分区边界）与 `usage_daily` / `usage_daily_<YYYY>`
//     必须原样在（Y1-B1 的修法把过滤从"六位数字月名"放宽到"只排除永久账本"，
//     放宽过头就会在这里丢账本 —— 那是不可逆的数据损失）；
//   - **同一轮补账刚刚建出来**的 `usage_daily_<YYYY>`（回收 2020 年分区时新建）
//     也必须在同一轮里活下来。
func TestAuditR25RetentionKeepsPermanentLedgerRelations(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "r25-ret-ledger")
	r25RetentionOn(t, db, "1")

	r24WidePartition(t, db, "usage_2020q1", "2020-01-01 00:00:00+08", "2020-04-01 00:00:00+08")
	r24UsageAt(t, db, uid, "r25-l", 5, BeijingDayInstant(bjDate(t, "2020-02-10")))

	before := map[string]int64{}
	for _, rel := range []string{"usage_daily", "usage_daily_2026", "usage_monthly"} {
		if !relationExists(t, db, rel) {
			t.Fatalf("夹具前提不成立：%s 不存在", rel)
		}
		before[rel] = r25UsageRowsIn(t, db, rel)
	}

	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	if relationExists(t, db, "usage_2020q1") {
		t.Fatalf("夹具前提不成立：到期分区没被回收（本用例要的是「同一轮里账本活着」）")
	}
	for rel, n := range before {
		if !relationExists(t, db, rel) {
			t.Fatalf("永久账本 %s 被保留期清理删掉了 —— 不可逆的数据损失", rel)
		}
		if got := r25UsageRowsIn(t, db, rel); got < n {
			t.Fatalf("永久账本 %s 的行数从 %d 掉到 %d", rel, n, got)
		}
	}
	// 同一轮补账新建的账本年分区（2020 年）也必须活着，并且真被写进了金额。
	if !relationExists(t, db, "usage_daily_2020") {
		t.Fatalf("补账新建的 usage_daily_2020 在同轮被删（账本自己的关系不得参与保留期）")
	}
	rows, cost := r6LedgerStats(t, db, bjDate(t, "2020-02-01"))
	if rows != 1 || cost != 5 {
		t.Fatalf("usage_daily_2020 的 2020-02 账本 = (%d, %.4f)，want (1, 5)", rows, cost)
	}
}

// ---------------------------------------------------------------------------
// 判据的**单元面**：归属推导与补账窗口的两个开关各自承重
// ---------------------------------------------------------------------------

// TestAuditR25ReclaimMonthAttribution 钉住"月份归属按事实推导"的判定表。
//
// 变异：把 reclaimMonths 退回 `usageMonthRelationOf`（只认六位数字月名）⇒
// 季度/整年两行当场报 ok=false（它们在真实清理里会被静默跳过）。
func TestAuditR25ReclaimMonthAttribution(t *testing.T) {
	bound := func(from, to string) string {
		return "FOR VALUES FROM ('" + from + "') TO ('" + to + "')"
	}
	cases := []struct {
		name      string
		rel       string
		bound     string
		wantFirst string
		wantLast  string
		wantOK    bool
	}{
		{"规范月名（边界恰为该月）", "usage_202001",
			bound("2020-01-01 00:00:00+08", "2020-02-01 00:00:00+08"), "202001", "202001", true},
		{"季度名（整月对齐的三段）", "usage_2020q1",
			bound("2020-01-01 00:00:00+08", "2020-04-01 00:00:00+08"), "202001", "202003", true},
		{"整年名（整月对齐的十二段）", "usage_2020",
			bound("2020-01-01 00:00:00+08", "2021-01-01 00:00:00+08"), "202001", "202012", true},
		{"季度名但边界错位（UTC 自然月）⇒ 名字不认、按边界给出区间", "usage_2020q1",
			bound("2020-01-01 00:00:00+00", "2020-04-01 00:00:00+00"), "202001", "202004", true},
		{"月名但边界错位 ⇒ 仍取**名字月**（fold 的窗口锚点，存量口径）", "usage_202001",
			bound("2020-01-01 00:00:00+00", "2020-02-01 00:00:00+00"), "202001", "202001", true},
		{"普通表（无边界）⇒ 回落到名字", "usage_202001", "", "202001", "202001", true},
		{"永久账本（无边界 + 名字不是月）⇒ 不参与保留期", "usage_monthly", "", "", "", false},
		{"DEFAULT 分区（边界读不懂 + 名字不是月）⇒ 不参与保留期", "usage_2020q1", "DEFAULT", "", "", false},
		{"MINVALUE..MAXVALUE ⇒ 不参与保留期", "usage_2020",
			"FOR VALUES FROM (MINVALUE) TO (MAXVALUE)", "", "", false},
	}
	for _, tc := range cases {
		shape := usageRelationShape{Bound: tc.bound}
		first, last, ok := shape.reclaimMonths(tc.rel)
		if ok != tc.wantOK {
			t.Errorf("%s：ok=%v，want %v（rel=%s）", tc.name, ok, tc.wantOK, tc.rel)
			continue
		}
		if !ok {
			continue
		}
		if monthKey(first) != tc.wantFirst || monthKey(last) != tc.wantLast {
			t.Errorf("%s：区间 = [%s, %s]，want [%s, %s]",
				tc.name, monthKey(first), monthKey(last), tc.wantFirst, tc.wantLast)
		}
	}
}

// TestAuditR25LedgerWindowExactOnlyForAlignedBounds 钉住补账窗口的两个方向。
//
// `exact=true` 会**跳过**"相邻月并入"（foldAdjacentMonthsIntoUsage），所以这条
// 判据必须双向：
//   - 整月对齐的（异名）分区 ⇒ exact=true（它不可能持有区间外的行，并入只会把整块
//     行 DELETE+INSERT 重写一遍）；
//   - 边界错位（UTC 自然月）⇒ exact=false：下界落在北京月中间时，`win.boundFrom`
//     只能取到**日**粒度，上一个月末尾那几小时的行要靠 detailMonthsOutside + fold
//     领回 —— 判据放宽过头（一律 true）会把那些行留在原地随 DROP 一起消失。
func TestAuditR25LedgerWindowExactOnlyForAlignedBounds(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()

	r24WidePartition(t, db, "usage_2020q1", "2020-01-01 00:00:00+08", "2020-04-01 00:00:00+08")
	if win := retentionLedgerWindow(db, "usage_2020q1", bjDate(t, "2020-03-01")); !win.exact {
		t.Fatalf("整月对齐的季度分区必须 exact=true（否则会走一次无意义的相邻月并入）")
	}
	// 规范月名分区（回归对照：修复前也是 true）。用 2019-12 避免与上面的季度分区重叠。
	r24WidePartition(t, db, "usage_201912", "2019-12-01 00:00:00+08", "2020-01-01 00:00:00+08")
	if win := retentionLedgerWindow(db, "usage_201912", bjDate(t, "2019-12-01")); !win.exact {
		t.Fatalf("规范月名分区必须 exact=true（存量行为）")
	}
	// 边界错位（UTC 自然月）：起止都不是北京月界 ⇒ 必须 false。
	r24WidePartition(t, db, "usage_2020q2", "2020-04-01 00:00:00+00", "2020-07-01 00:00:00+00")
	if win := retentionLedgerWindow(db, "usage_2020q2", bjDate(t, "2020-05-01")); win.exact {
		t.Fatalf("边界错位的分区必须 exact=false（要靠 fold 领回上一个月末尾那几小时的行）")
	}
}
