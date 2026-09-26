package serverstore

// R24-X4 B4（审计 2026-09-26，P1）回归：**更宽分区（季度/整年）覆盖的兄弟月在
// 聚合里回落永久账本** ⇒ 报表静默少计。
//
// 缺陷形态（修前）：
//   - `usageAggregateSegments` 的切读源判据是"有没有与月同名的关系"
//     （`usageMonthRelationOf` 只认 6 位数字月名）；
//   - DBA 预建的季度/整年分区名字是它的**名义月**（`usage_202607` 覆盖 7/8/9 月），
//     于是 8/9 月被判成"没有明细分区" ⇒ 聚合去读 `usage_daily`，而账本只在
//     **启动补算**与**过期回收**两个时刻重建 ⇒ 上次重启之后写入的用量在报表里
//     消失（真 PG 实测 17.00 报成 10.00）。
//
// 修法：判据与**写路径**同源（`usagePartitionCoverage` / `descendantLeafCoversWindow`，
// 见 partitions.go），读路径与写路径看同一份"窗口有没有被叶子分区覆盖"的事实。
//
// 判据（本文件）：
//  1. 月分区 / 季度分区 / 整年分区三种布局下同一个月聚合相等（与明细真值对拍）；
//  2. 跨年边界（Q4 分区覆盖 12 月与次年 1 月是同一株树里的两个叶子）；
//  3. 混源窗口（部分是分区、部分只剩账本）精确；
//  4. 回收后（分区与明细都被 DROP）回落账本，且**不**把有分区的月份算成"无明细"。
//
// 变异（把修复退回"只认同名月分区"）会让 TestR24WidePartitionSiblingMonthReadsDetail
// 与其它三条同时变红（红/绿对照见 temp/r21/fix-25/REPORT.md）。

import (
	"database/sql"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// 夹具：全部用未来月份（2099/2098 之外）避免与其它用例互相影响；每个用例
// 自己有独立库（newTestDB），命名不会跨用例污染。
// ---------------------------------------------------------------------------

// r24User 建一个本文件的专用用户。
func r24User(t *testing.T, db *sql.DB, name string) int64 {
	t.Helper()
	id, err := CreateUser(db, &User{Username: name, Source: "local", Status: 1})
	if err != nil {
		t.Fatalf("建用户 %s: %v", name, err)
	}
	return id
}

// r24WidePartition 按**声明边界**造一个更宽分区（季度/整年/双月都行）。
func r24WidePartition(t *testing.T, db *sql.DB, rel, from, to string) {
	t.Helper()
	if _, err := db.Exec("DROP TABLE IF EXISTS " + rel); err != nil {
		t.Fatalf("清理 %s: %v", rel, err)
	}
	if _, err := db.Exec("CREATE TABLE " + rel + " PARTITION OF usage FOR VALUES FROM ('" +
		from + "') TO ('" + to + "')"); err != nil {
		t.Fatalf("构造更宽分区 %s [%s,%s): %v", rel, from, to, err)
	}
}

// r24UsageAt 走**生产写路径**落一笔用量（RecordUsageKind + 归位到指定瞬时），
// cost 单独 UPDATE（测试夹具，模型未定价时生产写路径的 cost 是 0）。
func r24UsageAt(t *testing.T, db *sql.DB, uid int64, model string, cost float64, at time.Time) int64 {
	t.Helper()
	if err := ensureUsagePartition(db, at); err != nil {
		t.Fatalf("确保分区（%s）: %v", at.Format(time.RFC3339), err)
	}
	id, err := RecordUsageKind(db, uid, model, 100, 10, "chat")
	if err != nil {
		t.Fatalf("记录用量: %v", err)
	}
	if _, err := db.Exec(`UPDATE usage SET cost = ?, created_at = ? WHERE id = ?`, cost, at, id); err != nil {
		t.Fatalf("归位用量行: %v", err)
	}
	return id
}

// r24Sum 汇总聚合行（费用 + 请求数）。
func r24Sum(t *testing.T, rows []UsageAggregateRow) (float64, int64) {
	t.Helper()
	var cost float64
	var req int64
	for _, r := range rows {
		cost += r.Cost
		req += r.Requests
	}
	return cost, req
}

// r24Aggregate 同时取"报表读数（明细 ∪ 账本）"与"纯明细真值"。
func r24Aggregate(t *testing.T, db *sql.DB, username string, from, to time.Time) (withLedger, detailCost float64, ledgerReqs, detailReqs int64) {
	t.Helper()
	rows, err := UsageAggregateWithLedger(db, from, to, "user", WithUsername(username))
	if err != nil {
		t.Fatalf("聚合（明细 ∪ 账本）: %v", err)
	}
	withLedger, ledgerReqs = r24Sum(t, rows)
	truth, err := UsageAggregate(db, from, to, "user", WithUsername(username))
	if err != nil {
		t.Fatalf("聚合（纯明细）: %v", err)
	}
	detailCost, detailReqs = r24Sum(t, truth)
	return withLedger, detailCost, ledgerReqs, detailReqs
}

// r24MonthSegments 直接读切读源判据（这是缺陷本体所在的那一层）。
func r24MonthSegments(t *testing.T, db *sql.DB, month string) []usageAggregateSegment {
	t.Helper()
	segs, err := usageAggregateSegments(db, bjDate(t, month+"-01"), bjDate(t, month+"-28"))
	if err != nil {
		t.Fatalf("切读源分段: %v", err)
	}
	return segs
}

// r24AssertDetail 断言该月的切读源是**明细**（且只有一段）。
func r24AssertDetail(t *testing.T, db *sql.DB, month string) {
	t.Helper()
	segs := r24MonthSegments(t, db, month)
	if len(segs) != 1 || !segs[0].detail {
		t.Fatalf("%s 的切读源 = %+v, want 单段 detail=true（更宽分区/明细行所在的那一侧）", month, segs)
	}
}

// r24AssertLedger 断言该月的切读源是**永久账本**（回收后必须回落的那一侧）。
func r24AssertLedger(t *testing.T, db *sql.DB, month string) {
	t.Helper()
	segs := r24MonthSegments(t, db, month)
	if len(segs) != 1 || segs[0].detail {
		t.Fatalf("%s 的切读源 = %+v, want 单段 detail=false（明细已回收 ⇒ 回落账本）", month, segs)
	}
}

// ---------------------------------------------------------------------------
// ① 季度分区：兄弟月（8 月）的聚合必须等于明细真值。
// ---------------------------------------------------------------------------

func TestR24WidePartitionSiblingMonthReadsDetail(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "r24-wide-quarter")

	// 季度分区（名字取名义月 209807）：[2098-07-01+08, 2098-10-01+08) ⇒ 覆盖 7/8/9 月。
	r24WidePartition(t, db, "usage_209807", "2098-07-01 00:00:00+08", "2098-10-01 00:00:00+08")

	aug1 := BeijingDayInstant(bjDate(t, "2098-08-10"))
	aug2 := BeijingDayInstant(bjDate(t, "2098-08-11"))
	r24UsageAt(t, db, uid, "r24-m1", 10, aug1)
	// 启动补算：账本此刻只看到 10.00。
	if err := RebuildUsageLedger(db, bjDate(t, "2098-07-01"), bjDate(t, "2098-08-31")); err != nil {
		t.Fatalf("账本重建: %v", err)
	}
	// 启动补算之后的**新**用量（只进明细，账本要等下次回收才补）。
	r24UsageAt(t, db, uid, "r24-m1", 7, aug2)

	var ledgerCost float64
	if err := db.QueryRow(`SELECT COALESCE(SUM(cost),0) FROM usage_daily WHERE user_id = ?`, uid).Scan(&ledgerCost); err != nil {
		t.Fatalf("读账本: %v", err)
	}
	if ledgerCost != 10 {
		t.Fatalf("夹具前提不成立：账本 cost = %v, want 10（启动补算只看到第一笔）", ledgerCost)
	}

	r24AssertDetail(t, db, "2098-08")
	got, truth, reqs, truthReqs := r24Aggregate(t, db, "r24-wide-quarter",
		bjDate(t, "2098-08-01"), bjDate(t, "2098-08-31"))
	if got != truth || got != 17 {
		t.Fatalf("季度分区兄弟月聚合 = %.4f（req=%d），明细真值 = %.4f（req=%d）；want 17.0000 —— "+
			"回落永久账本会让报表静默少计", got, reqs, truth, truthReqs)
	}
}

// ---------------------------------------------------------------------------
// ② 整年分区 + 跨年边界：每个月的切读源都必须是明细。
// ---------------------------------------------------------------------------

func TestR24YearWidePartitionCoversEveryMonth(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "r24-wide-year")

	// 一级整年分区，名字不含 6 位月（usage_2098）——usageMonthRelationOf 完全不认它。
	r24WidePartition(t, db, "usage_2098", "2098-01-01 00:00:00+08", "2099-01-01 00:00:00+08")

	months := []string{"2098-02", "2098-08", "2098-12"}
	// 每笔都**先写后补算**（账本同步），再在补算之后补一笔 —— 模拟真实现场：
	// 账本只到"上次重启那一刻"，之后写入的用量只在明细里（B4 的少计来源）。
	for _, m := range months {
		r24UsageAt(t, db, uid, "r24-m1", 3, BeijingDayInstant(bjDate(t, m+"-15")))
	}
	if err := RebuildUsageLedger(db, bjDate(t, "2098-01-01"), bjDate(t, "2098-12-31")); err != nil {
		t.Fatalf("账本重建: %v", err)
	}
	for _, m := range months {
		r24UsageAt(t, db, uid, "r24-m1", 2, BeijingDayInstant(bjDate(t, m+"-16")))
	}
	for _, m := range months {
		r24AssertDetail(t, db, m)
		got, truth, _, _ := r24Aggregate(t, db, "r24-wide-year", bjDate(t, m+"-01"), bjDate(t, m+"-28"))
		if got != 5 || truth != 5 {
			t.Fatalf("%s 聚合 = %.4f（明细真值 %.4f）, want 5.0000（整年分区覆盖的月份不得回落永久账本）", m, got, truth)
		}
	}
	// 反向对照：账本已同步（明细不领先）时读账本 —— 读数必须与明细一致。
	if err := RebuildUsageLedger(db, bjDate(t, "2098-01-01"), bjDate(t, "2098-12-31")); err != nil {
		t.Fatalf("账本二次重建: %v", err)
	}
	r24AssertLedger(t, db, "2098-08")
	if got, truth, _, _ := r24Aggregate(t, db, "r24-wide-year", bjDate(t, "2098-08-01"), bjDate(t, "2098-08-28")); got != truth || got != 5 {
		t.Fatalf("账本同步后 2098-08 聚合 = %.4f（明细真值 %.4f）, want 5.0000（两侧必须一致）", got, truth)
	}
}

func TestR24CrossYearQuarterBoundary(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "r24-cross-year")

	// 跨年两株兄弟叶子：Q4 与次年 Q1。名字刻意用**季度形态**（usage_2098q4 /
	// usage_2099q1）—— 判据只看**边界**，与名字形态无关（usageMonthRelationOf 对
	// 这两个名字一律不认，覆盖扫描照样命中）。
	r24WidePartition(t, db, "usage_2098q4", "2098-10-01 00:00:00+08", "2099-01-01 00:00:00+08")
	r24WidePartition(t, db, "usage_2099q1", "2099-01-01 00:00:00+08", "2099-04-01 00:00:00+08")

	r24UsageAt(t, db, uid, "r24-dec", 4, BeijingDayInstant(bjDate(t, "2098-12-20")))
	r24UsageAt(t, db, uid, "r24-jan", 5, BeijingDayInstant(bjDate(t, "2099-01-10")))
	if err := RebuildUsageLedger(db, bjDate(t, "2098-12-01"), bjDate(t, "2099-01-31")); err != nil {
		t.Fatalf("账本重建: %v", err)
	}
	// 补算之后的新用量（账本落后 ⇒ 明细领先）——这一步是 B4 少计的来源。
	r24UsageAt(t, db, uid, "r24-dec", 1, BeijingDayInstant(bjDate(t, "2098-12-21")))
	r24UsageAt(t, db, uid, "r24-jan", 1, BeijingDayInstant(bjDate(t, "2099-01-11")))
	for month, want := range map[string]float64{"2098-12": 5, "2099-01": 6} {
		r24AssertDetail(t, db, month)
		got, truth, _, _ := r24Aggregate(t, db, "r24-cross-year", bjDate(t, month+"-01"), bjDate(t, month+"-28"))
		if got != want || truth != want {
			t.Fatalf("%s 聚合 = %.4f（明细真值 %.4f）, want %.4f", month, got, truth, want)
		}
	}
}

// ---------------------------------------------------------------------------
// ③ 混源窗口：双月宽分区（7/8 月）+ 月分区（9 月）+ 只剩账本（5 月）精确相加。
// ---------------------------------------------------------------------------

func TestR24MixedSourceWindowIsExact(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "r24-mixed")

	// 宽分区覆盖 7/8 月，名字取名义月 209807。
	r24WidePartition(t, db, "usage_209807", "2098-07-01 00:00:00+08", "2098-09-01 00:00:00+08")
	// 9 月自己一个月分区（走生产创建路径）。
	if err := ensureUsagePartition(db, BeijingDayInstant(bjDate(t, "2098-09-15"))); err != nil {
		t.Fatalf("建 9 月分区: %v", err)
	}
	// 5 月的用量先落明细 + 补账，然后把该月分区 DROP（模拟保留期回收）。
	r24UsageAt(t, db, uid, "r24-may", 5, BeijingDayInstant(bjDate(t, "2098-05-09")))
	r24UsageAt(t, db, uid, "r24-aug", 4, BeijingDayInstant(bjDate(t, "2098-08-09")))
	r24UsageAt(t, db, uid, "r24-sep", 3, BeijingDayInstant(bjDate(t, "2098-09-09")))
	if err := RebuildUsageLedger(db, bjDate(t, "2098-05-01"), bjDate(t, "2098-09-30")); err != nil {
		t.Fatalf("账本重建: %v", err)
	}
	// 补算之后的新用量（只有明细有）⇒ 宽分区月份按明细读。
	r24UsageAt(t, db, uid, "r24-aug", 1, BeijingDayInstant(bjDate(t, "2098-08-10")))
	r24UsageAt(t, db, uid, "r24-sep", 1, BeijingDayInstant(bjDate(t, "2098-09-10")))
	if _, err := db.Exec("DROP TABLE IF EXISTS usage_209805"); err != nil {
		t.Fatalf("回收 5 月分区: %v", err)
	}

	r24AssertLedger(t, db, "2098-05")
	r24AssertDetail(t, db, "2098-08")
	r24AssertDetail(t, db, "2098-09")

	got, _, reqs, _ := r24Aggregate(t, db, "r24-mixed", bjDate(t, "2098-05-01"), bjDate(t, "2098-09-30"))
	if got != 14 || reqs != 5 {
		t.Fatalf("混源窗口聚合 = %.4f（req=%d）, want 14.0000（req=5：账本月 5 + 宽分区月 4+1 + 月分区月 3+1，不重不漏）", got, reqs)
	}
}

// ---------------------------------------------------------------------------
// ④ 回收后回落：宽分区被 DROP（明细随之消失）后，该月必须读账本而不是读空明细。
// ---------------------------------------------------------------------------
func TestR24DroppedWidePartitionFallsBackToLedger(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "r24-reclaim")

	r24WidePartition(t, db, "usage_209807", "2098-07-01 00:00:00+08", "2098-10-01 00:00:00+08")
	r24UsageAt(t, db, uid, "r24-aug", 6, BeijingDayInstant(bjDate(t, "2098-08-09")))
	if err := RebuildUsageLedger(db, bjDate(t, "2098-07-01"), bjDate(t, "2098-08-31")); err != nil {
		t.Fatalf("账本重建: %v", err)
	}
	// 补算之后的新用量 ⇒ 明细领先 ⇒ 该月按明细读（B4 的正常形态）。
	r24UsageAt(t, db, uid, "r24-aug", 1, BeijingDayInstant(bjDate(t, "2098-08-10")))
	r24AssertDetail(t, db, "2098-08")
	if got, truth, _, _ := r24Aggregate(t, db, "r24-reclaim", bjDate(t, "2098-08-01"), bjDate(t, "2098-08-31")); got != 7 || truth != 7 {
		t.Fatalf("回收前聚合 = %.4f（明细真值 %.4f）, want 7.0000", got, truth)
	}

	if _, err := db.Exec("DROP TABLE IF EXISTS usage_209807"); err != nil {
		t.Fatalf("回收宽分区: %v", err)
	}
	r24AssertLedger(t, db, "2098-08")
	got, truth, _, _ := r24Aggregate(t, db, "r24-reclaim", bjDate(t, "2098-08-01"), bjDate(t, "2098-08-31"))
	if truth != 0 {
		t.Fatalf("夹具前提不成立：明细真值 = %.4f, want 0（分区已回收）", truth)
	}
	if got != 6 {
		t.Fatalf("回收后聚合 = %.4f, want 6.0000（必须回落永久账本：账本里是补算那一刻的 6，不是明细的 7）", got)
	}
}

// ---------------------------------------------------------------------------
// ⑤ R5-A-10 的「补齐」：更宽分区覆盖的月份**明细已被行级删除**（分区还在、行为空）
// 时，必须按 R5-A-10 的既有纵深防御回落永久账本 —— 判据从"同名月分区"扩到
// "覆盖该月的叶子分区"之后，这一层不能漏（否则宽分区布局下会读出 0）。
// ---------------------------------------------------------------------------

func TestR24WidePartitionEmptyMonthFallsBackToLedger(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "r24-wide-empty")

	r24WidePartition(t, db, "usage_209807", "2098-07-01 00:00:00+08", "2098-10-01 00:00:00+08")
	id := r24UsageAt(t, db, uid, "r24-aug", 6, BeijingDayInstant(bjDate(t, "2098-08-09")))
	if err := RebuildUsageLedger(db, bjDate(t, "2098-07-01"), bjDate(t, "2098-08-31")); err != nil {
		t.Fatalf("账本重建: %v", err)
	}
	// 行级删除（网关失败路径的真实入口：明细没了、账本还在）。
	if err := DeleteUsage(db, id); err != nil {
		t.Fatalf("行级删除明细: %v", err)
	}
	r24AssertLedger(t, db, "2098-08")
	got, truth, _, _ := r24Aggregate(t, db, "r24-wide-empty", bjDate(t, "2098-08-01"), bjDate(t, "2098-08-31"))
	if truth != 0 {
		t.Fatalf("夹具前提不成立：明细真值 = %.4f, want 0", truth)
	}
	if got != 6 {
		t.Fatalf("宽分区下「分区在但为空」的月份聚合 = %.4f, want 6.0000（必须回落永久账本）", got)
	}
}
