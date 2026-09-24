package serverstore

// R8 修复泳道 F-server 的**判据探针**（对象 = 第 8 轮审计 A 泳道报出的 5 条 P2）。
//
// 与审计方探针的区别：审计探针**记录缺陷**（"写入必然失败"这类断言在修复后应当
// 变红），本文件的探针**记录修复目标**（正确的终态），因此
//   - 在修复前的树上：逐条失败（= 缺陷可复现，见 evidence/before-*.log）；
//   - 在修复后的树上：逐条通过（见 evidence/after-*.log）。
//
// 只使用修复前就存在的标识符（`RecordUsageKind` / `CleanupUsageRetention` /
// `RebuildUsageLedger` / `cleanupDetachedUsageTable` 等），所以同一份文件在两个
// 树上都能编译 —— 红/绿都是真实运行结果，不是编译错误。
// R8-A-3（可观测面）的判据在 audit_r8_retention_status_test.go 与
// cmd/server/usage_retention_readyz_test.go：它们引用的 `CurrentUsageRetentionStatus`
// 与 `/readyz` 的 `usage_retention` 字段是本次**新增**的出口，在修复前的树上不存在。
//
// 每条断言都取"物理事实"（catalog 事实 / `SELECT … FROM usage` 父表求和 /
// 永久日账 / 落盘日志行），不取被审判据自己的分段口径。

import (
	"database/sql"
	"fmt"
	"math"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

// r8srvMultiLevelLeaf 造 `usage → usage_<YYYY>[p] → usage_<YYYYMM>`（叶子精确覆盖
// m 的北京月），返回 (中间父表名, 叶子名)。先摘掉 usage 的全部直接子分区（PG 不允许
// 区间重叠）。
func r8srvMultiLevelLeaf(t *testing.T, db *sql.DB, m time.Time) (string, string) {
	t.Helper()
	r7aDropDirectUsagePartitions(t, db)
	yearRel := fmt.Sprintf("usage_%04d", m.Year())
	leaf := "usage_" + monthKey(m)
	lo := pgInstantArg(BeijingDayInstant(dayKey(m)))
	hi := pgInstantArg(BeijingDayInstant(dayKey(m).AddDate(0, 1, 0)))
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		r6Quote(yearRel), lo, hi)); err != nil {
		t.Fatalf("建中间父表 %s（多级布局）: %v", yearRel, err)
	}
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
		r6Quote(leaf), r6Quote(yearRel), lo, hi)); err != nil {
		t.Fatalf("建叶子分区 %s: %v", leaf, err)
	}
	return yearRel, leaf
}

// r8srvMultiLevelParentWithoutLeaf 只造 `usage → usage_<YYYY>[p]`（覆盖 m 的整年，
// **没有** m 月的叶子）—— "窗口被中间父表覆盖、叶子缺失"的形态。
func r8srvMultiLevelParentWithoutLeaf(t *testing.T, db *sql.DB, m time.Time) string {
	t.Helper()
	r7aDropDirectUsagePartitions(t, db)
	yearRel := fmt.Sprintf("usage_%04d", m.Year())
	yearFrom := time.Date(m.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
	yearTo := yearFrom.AddDate(1, 0, 0)
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		r6Quote(yearRel),
		pgInstantArg(BeijingDayInstant(yearFrom)), pgInstantArg(BeijingDayInstant(yearTo)))); err != nil {
		t.Fatalf("建中间父表 %s: %v", yearRel, err)
	}
	return yearRel
}

// r8srvRelationPlacement 直接读 catalog 返回 "根|直接父"（独立于产品侧判据）。
func r8srvRelationPlacement(t *testing.T, db *sql.DB, rel string) (root, parent string) {
	t.Helper()
	var r, p sql.NullString
	var isPart bool
	if err := db.QueryRow(`SELECT c.relispartition, p.relname, r.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
LEFT JOIN pg_class p ON p.oid = i.inhparent
LEFT JOIN pg_class r ON r.oid = pg_partition_root(c.oid)
WHERE c.relname = ? AND n.nspname = 'public'`, rel).Scan(&isPart, &p, &r); err != nil {
		t.Fatalf("读 %s 的分区位置: %v", rel, err)
	}
	if !isPart {
		return "(not-a-partition)", p.String
	}
	return r.String, p.String
}

// r8srvUsageTokensOf 直接对 usage **父表**求和某月的 token 数（物理事实；夹具里的
// 模型没有配价，所以金额恒为 0，不能用金额当"有没有落账"的判据）。
func r8srvUsageTokensOf(t *testing.T, db *sql.DB, m time.Time) int64 {
	t.Helper()
	var tokens int64
	if err := db.QueryRow(`SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) FROM usage
WHERE created_at >= ?::timestamptz AND created_at < ?::timestamptz`,
		BeijingDayInstant(dayKey(m)), BeijingDayInstant(dayKey(m).AddDate(0, 1, 0))).Scan(&tokens); err != nil {
		t.Fatalf("读 %s 的 tokens: %v", monthKey(m), err)
	}
	return tokens
}

// r8srvUsageRowsOf 直接对 usage **父表**求和某月的行数与金额（物理事实）。
func r8srvUsageRowsOf(t *testing.T, db *sql.DB, m time.Time) (int64, float64) {
	t.Helper()
	var n int64
	var cost float64
	if err := db.QueryRow(`SELECT count(*), COALESCE(SUM(cost),0) FROM usage
WHERE created_at >= ?::timestamptz AND created_at < ?::timestamptz`,
		BeijingDayInstant(dayKey(m)), BeijingDayInstant(dayKey(m).AddDate(0, 1, 0))).Scan(&n, &cost); err != nil {
		t.Fatalf("读 %s 的明细: %v", monthKey(m), err)
	}
	return n, cost
}

// ---------------------------------------------------------------------------
// F1 · R8-A-1：多级布局覆盖当月 ⇒ 写路径必须自愈（网关不再 503）
// ---------------------------------------------------------------------------

// TestR8Fix1WritePathSelfHealsUnderMultiLevelLayout 是 R8-A-1 的判据。
//
// 缺陷（修复前）：`partitionReadyErr` 要求**直接父** == usage，于是多级布局一旦覆盖
// **当前月**，每一次 `RecordUsageKind`（= 网关每一次结算落账）都失败 ⇒ 网关唯一出口
// 是 fail-closed 的 503 METERING_FAILED（不交付上游内容），且清理侧的"深层后代只
// 补账不 DETACH"取舍保证它**永不自愈** —— 当月全部对话不可用。
//
// 判据（修复后必须成立的三条）：
//  1. 叶子存在（挂中间父表下）：写入成功、行真的落进那片叶子（tableoid）、
//     父表查询能读到；
//  2. 叶子**缺失**（只有覆盖当月的中间父表）：写入仍成功，并且写路径把当月叶子
//     建在**那个中间父表**下面（挂在 usage 下必然 42P17 overlap）；
//  3. 幂等：重复调用不报错、不重建、不改变布局。
func TestR8Fix1WritePathSelfHealsUnderMultiLevelLayout(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	cur := bjMonth(0)

	// --- 场景 1：叶子存在（挂中间父表下） ---
	yearRel, leaf := r8srvMultiLevelLeaf(t, db, cur)
	if root, parent := r8srvRelationPlacement(t, db, leaf); root != "usage" || parent != yearRel {
		t.Fatalf("夹具有效性：%s 的根=%q 直接父=%q，want usage / %s", leaf, root, parent, yearRel)
	}
	id, err := RecordUsageKind(db, uid, "r8srv-f1", 1000, 500, "chat")
	if err != nil {
		t.Fatalf("多级布局覆盖当月时，计量写入必须成功（修复前这里失败 ⇒ 网关 503 METERING_FAILED，当月对话全不可用）: %v", err)
	}
	if id <= 0 {
		t.Fatalf("写入返回 id=%d，want >0", id)
	}
	if got := r6PartitionOf(t, db, id); got != leaf {
		t.Fatalf("写入的行落在 %s，want %s（多级布局下的月叶子）", got, leaf)
	}
	// 该模型没有配价 ⇒ cost=0（判据是"这一笔有没有落账"，不是金额）。
	if n, _ := r8srvUsageRowsOf(t, db, cur); n != 1 {
		t.Fatalf("%s 的父表明细 = %d 行，want 1", monthKey(cur), n)
	}
	if got := r8srvUsageTokensOf(t, db, cur); got != 1500 {
		t.Fatalf("%s 的 tokens = %d，want 1500", monthKey(cur), got)
	}

	// --- 场景 2：叶子缺失（只有覆盖当月的中间父表） ---
	db2, cleanup2 := NewTestDB(t)
	defer cleanup2()
	if _, err := db2.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	uid2 := mustUserID(t, db2)
	parentRel := r8srvMultiLevelParentWithoutLeaf(t, db2, cur)
	if err := ensureUsagePartition(db2, cur); err != nil {
		t.Fatalf("窗口已被 %s 覆盖、叶子缺失时，写路径必须自愈（把叶子建在那个父表下）: %v", parentRel, err)
	}
	if root, parent := r8srvRelationPlacement(t, db2, "usage_"+monthKey(cur)); root != "usage" || parent != parentRel {
		t.Fatalf("自愈后 usage_%s 应挂在 %s 下（挂 usage 下会 42P17 overlap）；实际 根=%q 直接父=%q",
			monthKey(cur), parentRel, root, parent)
	}
	if _, err := RecordUsageKind(db2, uid2, "r8srv-f1b", 2000, 100, "chat"); err != nil {
		t.Fatalf("自愈后写入仍失败: %v", err)
	}
	if n, _ := r8srvUsageRowsOf(t, db2, cur); n != 1 {
		t.Fatalf("%s 的父表明细 = %d 行，want 1", monthKey(cur), n)
	}
	if got := r8srvUsageTokensOf(t, db2, cur); got != 2100 {
		t.Fatalf("%s 的 tokens = %d，want 2100", monthKey(cur), got)
	}
	// --- 场景 3：幂等 ---
	if err := ensureUsagePartition(db2, cur); err != nil {
		t.Fatalf("重复 ensure 必须幂等（不报错）: %v", err)
	}
	if root, parent := r8srvRelationPlacement(t, db2, "usage_"+monthKey(cur)); root != "usage" || parent != parentRel {
		t.Fatalf("重复 ensure 改变了布局：根=%q 直接父=%q", root, parent)
	}
}

// TestR8Fix1CrossRootPartitionStillFailsLoud 是 R8-A-1 的**反向对照**：判据从"直接
// 父"放宽到"分区树传递根"之后，**真正挂错树**的同名关系仍必须 fail-loud（否则写入
// 会静默落到别的分区树里）。夹具：把 usage_<当月> 挂到另一张分区表 other_usage 下。
func TestR8Fix1CrossRootPartitionStillFailsLoud(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	cur := bjMonth(0)
	r7aDropDirectUsagePartitions(t, db)
	if _, err := db.Exec(`CREATE TABLE r8srv_other (id BIGSERIAL, user_id INT, model TEXT,
prompt_tokens BIGINT, completion_tokens BIGINT, cache_prompt_tokens BIGINT, kind TEXT,
cost DOUBLE PRECISION, created_at TIMESTAMPTZ, estimated BOOLEAN, provider_id INT,
PRIMARY KEY (id, created_at)) PARTITION BY RANGE (created_at)`); err != nil {
		t.Fatalf("建对照分区树: %v", err)
	}
	leaf := "usage_" + monthKey(cur)
	lo := pgInstantArg(BeijingDayInstant(dayKey(cur)))
	hi := pgInstantArg(BeijingDayInstant(dayKey(cur).AddDate(0, 1, 0)))
	if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF r8srv_other FOR VALUES FROM ('%s') TO ('%s')",
		r6Quote(leaf), lo, hi)); err != nil {
		t.Fatalf("把 %s 挂到别的分区树: %v", leaf, err)
	}
	if _, err := RecordUsageKind(db, uid, "r8srv-f1c", 100, 100, "chat"); err == nil {
		t.Fatalf("%s 挂在别的分区树(r8srv_other)下时必须 fail-loud —— 否则写入静默落到不对的表里", leaf)
	}
}

// ---------------------------------------------------------------------------
// F2 · R8-A-2 / R8-D-1：并发/重叠清理轮次里"关系已被别人回收"必须归为良性
// ---------------------------------------------------------------------------

// TestR8Fix2ConcurrentCleanupRoundsAreBenign 是 R8-A-2 的判据。
//
// 缺陷（修复前）：4 路并发清理**全部**返回非 nil，失败明细全是
// `sqlstate=42P01 relation "usage_YYYYMM" does not exist`（别的轮次已把它 DROP）。
// 消费点 `PUT /api/server/admin/gateway`（改保留期）把它翻成 500「保留清理失败」，
// 而配置其实已提交并已审计 ⇒ 管理员看到"没保存成功"会反复重试；调度器每轮告警，
// 真实失败被噪声淹没。判据不自洽：同一函数里的 retentionLedgerWindow 把
// `!probe.Exists` 当良性。
//
// 判据（修复后）：并发轮次**全部返回 nil**；金额三口径不变（并发不产生金额错误）；
// 且"重复处理同一条已被 DROP 的孤儿"（确定性重入）也返回 nil。
func TestR8Fix2ConcurrentCleanupRoundsAreBenign(t *testing.T) {
	const (
		costNormal = 6.25
		costOrphan = 4.5
	)
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
	if err := ensureUsagePartition(db, m); err != nil {
		t.Fatal(err)
	}
	usageRowAt(t, db, uid, "r8srv-f2", BeijingDayAt(m, 10), costNormal)

	_ = captureRetentionLog(t) // 并发轮的日志不打判据，只避免污染测试输出
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make([]error, 4)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			errs[i] = CleanupUsageRetention(db)
		}(i)
	}
	close(start)
	wg.Wait()
	if t.Failed() {
		return
	}
	var nonNil []string
	for i, e := range errs {
		if e != nil {
			nonNil = append(nonNil, fmt.Sprintf("#%d: %v", i, e))
		}
	}
	if len(nonNil) > 0 {
		t.Fatalf("并发清理轮次必须把「关系已被别的轮次回收」归为良性（管理端保存保留期不得因此 500）：%d/%d 轮非 nil: %v",
			len(nonNil), len(errs), nonNil)
	}
	rowsN, ledgerN := r6LedgerStats(t, db, m)
	aggN := r6SumCost(t, db, m, m.AddDate(0, 1, -1))
	if rowsN != 1 || math.Abs(ledgerN-costNormal) > 1e-9 || math.Abs(aggN-costNormal) > 1e-9 {
		t.Fatalf("并发清理后 %s 的口径分叉：账本=(%d,%.4f) 聚合=%.4f，want (1,%.4f)",
			monthKey(m), rowsN, ledgerN, aggN, costNormal)
	}
	if relationExists(t, db, "usage_"+monthKey(m)) {
		t.Fatalf("并发清理后到期分区仍在盘上")
	}

	// 确定性重入：走一遍生产路径回收一个孤儿，再对同一关系调一次
	// cleanupDetachedUsageTable（另一轮的 scan 发生在 DROP 之前时它就会这么做）。
	m2 := bjMonth(3)
	if err := ensureUsagePartition(db, m2); err != nil {
		t.Fatal(err)
	}
	orphan := "usage_" + monthKey(m2)
	usageRowAt(t, db, uid, "r8srv-f2-orphan", BeijingDayAt(m2, 10), costOrphan)
	if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + r6Quote(orphan)); err != nil {
		t.Fatalf("detach %s: %v", orphan, err)
	}
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("孤儿首次处理失败: %v", err)
	}
	if relationExists(t, db, orphan) {
		t.Fatalf("孤儿处理成功后应当被清掉")
	}
	if err := cleanupDetachedUsageTable(db, orphan, m2); err != nil {
		t.Fatalf("重复处理已被 DROP 的孤儿必须返回 nil（修复前：42P01 ⇒ 管理端 500）: %v", err)
	}
	rows2, amount2 := r6LedgerStats(t, db, m2)
	if rows2 != 1 || math.Abs(amount2-costOrphan) > 1e-9 {
		t.Fatalf("孤儿补账后账本 = (%d 行, %.4f)，want (1, %.4f)", rows2, amount2, costOrphan)
	}
}

// ---------------------------------------------------------------------------
// F3 · R8-A-5：单个异常月不得让整个窗口的账本自愈停摆
// ---------------------------------------------------------------------------

// TestR8Fix3LedgerRebuildIsolatesBadMonth 是 R8-A-5 的判据。
//
// 缺陷（修复前）：`ensureLedgerRelations` 在第一个形态异常的月 `return err`，
// `rebuildUsageLedgerRows` 一次都没跑 ⇒ 同窗口**健康月**的账本也是空的（启动补算
// 静默失效，只剩一行 log.Printf）。
//
// 判据（修复后）：①函数仍 fail-loud（返回非 nil 并点名坏月）；②健康月账本照常补齐；
// ③坏月的账本也照常算出（聚合读 usage 父表，与分区形态无关）。
//
// 坏月形态用**窄覆盖**分区（只覆盖该月前 10 天）：它对写路径是"错界"（fail-loud、
// 需人工处置），因此修复后仍然异常 —— 这正是"逐月隔离"要处理的那一类。
func TestR8Fix3LedgerRebuildIsolatesBadMonth(t *testing.T) {
	const (
		costBad = 3.75
		costOk  = 8.25
	)
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)

	mBad := bjMonth(3)
	mOk := bjMonth(2)
	r6DropMonthPartitions(t, db, mBad, mBad)
	badRel := "usage_" + monthKey(mBad)
	if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s')",
		r6Quote(badRel),
		pgInstantArg(BeijingDayInstant(dayKey(mBad))),
		pgInstantArg(BeijingDayInstant(dayKey(mBad).AddDate(0, 0, 10))))); err != nil {
		t.Fatalf("建窄覆盖分区 %s: %v", badRel, err)
	}
	usageRowAt(t, db, uid, "r8srv-f3-bad", BeijingDayAt(mBad, 2), costBad)
	if err := ensureUsagePartition(db, mOk); err != nil {
		t.Fatalf("建健康月分区 %s: %v", monthKey(mOk), err)
	}
	usageRowAt(t, db, uid, "r8srv-f3-ok", BeijingDayAt(mOk, 10), costOk)
	if err := ensureUsagePartition(db, mBad); err == nil {
		t.Fatalf("夹具有效性：%s 是窄覆盖分区，写路径本应 fail-loud", badRel)
	}
	for _, m := range []time.Time{mBad, mOk} {
		if rows, amount := r6LedgerStats(t, db, m); rows != 0 || math.Abs(amount) > 1e-9 {
			t.Fatalf("夹具有效性：%s 的账本已非空 (%d, %.4f)", monthKey(m), rows, amount)
		}
	}
	from, to := dayKey(mBad), dayKey(mOk).AddDate(0, 1, -1)
	err := RebuildUsageLedger(db, from, to)
	if err == nil {
		t.Fatalf("坏月存在时 RebuildUsageLedger 必须 fail-loud（可观测，不许静默）")
	}
	if !strings.Contains(err.Error(), monthKey(mBad)) {
		t.Fatalf("失败必须点名异常月 %s: %v", monthKey(mBad), err)
	}
	// ② 健康月必须照常补齐（修复前：整轮中止 ⇒ 健康月账本仍为 0）。
	if rows, amount := r6LedgerStats(t, db, mOk); rows != 1 || math.Abs(amount-costOk) > 1e-9 {
		t.Fatalf("健康月 %s 的账本 = (%d 行, %.4f)，want (1, %.4f) —— 一个坏月不得让整窗口的自愈停摆(R8-A-5)",
			monthKey(mOk), rows, amount, costOk)
	}
	// ③ 坏月的账本也照常算出（明细是事实源，聚合读父表）。
	if rows, amount := r6LedgerStats(t, db, mBad); rows != 1 || math.Abs(amount-costBad) > 1e-9 {
		t.Fatalf("异常形态月 %s 的账本 = (%d 行, %.4f)，want (1, %.4f)", monthKey(mBad), rows, amount, costBad)
	}
}

// TestR8Fix3bLedgerRebuildPreparesLaterMonths 是 R8-A-5 的另一半：**逐月隔离**。
//
// 为什么单独一条：即使 `RebuildUsageLedger` 改成"聚合无条件执行"，只要
// `ensureLedgerRelations` 仍在第一个异常月 `return err`，窗口里**更晚的月份**就
// 不会被准备 —— 最典型的是 `usage_daily_<年>` 年分区（账本写入目标）没被建出来，
// 于是整条聚合语句在真实 PG 上失败，**健康月的账本照样是空的**。
//
// 夹具：坏月在前（2025-11，窄覆盖分区 ⇒ 写路径 fail-loud），健康月在后（2026-07）；
// 两个年分区（usage_daily_2025/2026）在夹具里先删掉 —— 让"建年分区"成为这一轮
// 真的要做的事（真实形态：新库/历史清理后年分区缺失）。
func TestR8Fix3bLedgerRebuildPreparesLaterMonths(t *testing.T) {
	const costOk = 5.25
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	if _, err := db.Exec("DROP TABLE IF EXISTS usage_daily_2025, usage_daily_2026"); err != nil {
		t.Fatalf("清掉年分区（让这一轮必须自己建）: %v", err)
	}

	mBad := bjMonth(10) // 2025-11（更早 ⇒ 迭代在前）
	mOk := bjMonth(2)   // 2026-07（更晚 ⇒ 只有逐月隔离才能轮到它）
	if mBad.Year() == mOk.Year() {
		t.Skipf("夹具依赖跨年窗口（当前 %s / %s 同年）", monthKey(mBad), monthKey(mOk))
	}
	r6DropMonthPartitions(t, db, mBad, mBad)
	badRel := "usage_" + monthKey(mBad)
	if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s')",
		r6Quote(badRel),
		pgInstantArg(BeijingDayInstant(dayKey(mBad))),
		pgInstantArg(BeijingDayInstant(dayKey(mBad).AddDate(0, 0, 5))))); err != nil {
		t.Fatalf("建窄覆盖分区 %s: %v", badRel, err)
	}
	usageRowAt(t, db, uid, "r8fix3b-bad", BeijingDayAt(mBad, 1), 1.0)
	if err := ensureUsagePartition(db, mOk); err != nil {
		t.Fatalf("建健康月分区 %s: %v", monthKey(mOk), err)
	}
	usageRowAt(t, db, uid, "r8fix3b-ok", BeijingDayAt(mOk, 10), costOk)
	if rows, amount := r6LedgerStats(t, db, mOk); rows != 0 || math.Abs(amount) > 1e-9 {
		t.Fatalf("夹具有效性：%s 的账本已非空 (%d, %.4f)", monthKey(mOk), rows, amount)
	}

	from, to := dayKey(mBad), dayKey(mOk).AddDate(0, 1, -1)
	if err := RebuildUsageLedger(db, from, to); err == nil {
		t.Fatalf("坏月存在时必须 fail-loud（可观测）")
	}
	rows, amount := r6LedgerStats(t, db, mOk)
	if rows != 1 || math.Abs(amount-costOk) > 1e-9 {
		t.Fatalf("窗口里更晚的健康月 %s 的账本 = (%d 行, %.4f)，want (1, %.4f)："+
			"ensureLedgerRelations 必须在异常月之后继续准备其余月份（含 usage_daily 年分区），"+
			"否则聚合在真实 PG 上写不进去(R8-A-5 的逐月隔离)", monthKey(mOk), rows, amount, costOk)
	}
}

// ---------------------------------------------------------------------------
// F4 · R8-A-4：月名中间父表不再"每一轮 fold-adjacent 失败"
// ---------------------------------------------------------------------------

// TestR8Fix4MonthNamedMiddleParentNoLongerFailsEveryRound 是 R8-A-4 的判据。
//
// 夹具：`usage_<m1>[p]`（名字像月分区、实际是中间父表，覆盖 [m1, m2)）+ 其子分区
// `usage_<m2>`。m1 到期（保留期 2 个月 ⇒ cutoff = m2）。
//
// 缺陷（修复前）：清理 m1 时 `win.exact=false` ⇒ 行级探测发现 m2 的行 ⇒
// `foldAdjacentMonthsIntoUsage` 调 `ensureUsagePartition(m2)` ⇒ 该叶子的直接父是
// `usage_<m1>`（≠ usage）⇒ 判据拒绝 ⇒ **每一轮**都 fold-adjacent 失败 ⇒
// `usage.retention_months` 在这个库上永远保存不下（管理端每次 500）。
//
// 判据（修复后，两个方向都要成立）：
//   - 子树里还有**保留期内**的月份（本用例）⇒ 不回收但**不失败**：清理返回 nil、
//     日志按原因点名（`reason=subtree-retained`）、子分区与明细原样保留、
//     三口径一致；同轮的普通到期月照常被清掉（错误隔离不退化）。
//   - 子树整个都已到期（第二条用例）⇒ 该回收的就回收，账本口径正确。
func TestR8Fix4MonthNamedMiddleParentNoLongerFailsEveryRound(t *testing.T) {
	const (
		costM2 = 7.5
		costM4 = 3.25
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
	m1 := bjMonth(3) // 名字月（到期）
	m2 := bjMonth(2) // 子分区月（保留期内）
	m4 := bjMonth(4) // 另一个普通到期月（错误隔离的对照）

	r6DropMonthPartitions(t, db, m1, m2)
	parentRel := "usage_" + monthKey(m1)
	childRel := "usage_" + monthKey(m2)
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		r6Quote(parentRel),
		pgInstantArg(BeijingDayInstant(dayKey(m1))), pgInstantArg(BeijingDayInstant(dayKey(m2).AddDate(0, 1, 0))))); err != nil {
		t.Fatalf("建月名中间父表 %s: %v", parentRel, err)
	}
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
		r6Quote(childRel), r6Quote(parentRel),
		pgInstantArg(BeijingDayInstant(dayKey(m2))), pgInstantArg(BeijingDayInstant(dayKey(m2).AddDate(0, 1, 0))))); err != nil {
		t.Fatalf("建子分区 %s: %v", childRel, err)
	}
	id := usageRowAt(t, db, uid, "r8srv-f4", BeijingDayAt(m2, 10), costM2)
	if got := r6PartitionOf(t, db, id); got != childRel {
		t.Fatalf("夹具有效性：行落在 %s，want %s", got, childRel)
	}
	if err := ensureUsagePartition(db, m4); err != nil {
		t.Fatalf("建对照月分区 %s: %v", monthKey(m4), err)
	}
	controlRel := "usage_" + monthKey(m4)
	usageRowAt(t, db, uid, "r8srv-f4-control", BeijingDayAt(m4, 10), costM4)

	logs := captureRetentionLog(t)
	for round := 1; round <= 3; round++ {
		logs.Reset()
		if err := CleanupUsageRetention(db); err != nil {
			t.Fatalf("第 %d 轮清理不得失败（修复前每轮 fold-adjacent 失败 ⇒ 管理端保存保留期固定 500）: %v\n%s",
				round, err, logs.String())
		}
		out := logs.String()
		// 字面量钉住"未回收原因"这个**对外契约**（它进日志与 /readyz 的
		// skip_reasons）：探针不引用实现常量，这样同一份文件在修复前的树上也能
		// 编译并以断言失败的方式变红（红/绿都是真实运行结果）。
		if !strings.Contains(out, "reason=subtree-retained") {
			t.Fatalf("第 %d 轮必须按原因点名「子树里仍有保留期内的行」（可观测）:\n%s", round, out)
		}
		if !strings.Contains(out, parentRel) {
			t.Fatalf("第 %d 轮的点名里没有 %s:\n%s", round, parentRel, out)
		}
		if strings.Contains(out, "fold-adjacent") {
			t.Fatalf("第 %d 轮不应再出现 fold-adjacent 失败:\n%s", round, out)
		}
		if !relationExists(t, db, childRel) {
			t.Fatalf("第 %d 轮后保留期内的子分区 %s 被删（明细会丢）", round, childRel)
		}
		if n, cost := r8srvUsageRowsOf(t, db, m2); n != 1 || math.Abs(cost-costM2) > 1e-9 {
			t.Fatalf("第 %d 轮后 %s 的明细 = (%d, %.4f)，want (1, %.4f)", round, monthKey(m2), n, cost, costM2)
		}
		// "保留但不回收"分支**不补账**：明细仍在 usage 子树里、聚合读明细，金额可见
		// 且正确；账本是降维缓存（启动补算 + 回收前补账覆盖了"明细会消失"的路径），
		// 这里没有明细消失 ⇒ 不需要它。判据取"明细 + 聚合"这两条事实。
		agg := r6SumCost(t, db, m2, m2.AddDate(0, 1, -1))
		if math.Abs(agg-costM2) > 1e-9 {
			t.Fatalf("第 %d 轮后 %s 的窗口聚合 %.4f，want %.4f", round, monthKey(m2), agg, costM2)
		}
		if round == 1 && relationExists(t, db, controlRel) {
			t.Fatalf("错误隔离失效：无关的到期月 %s 被一起留在盘上:\n%s", controlRel, out)
		}
		if raw := r7aRawDetailCost(t, db, m4); round == 1 && math.Abs(raw) > 1e-9 {
			t.Fatalf("对照月 %s 的明细未被清掉（残留 %.4f）", monthKey(m4), raw)
		}
	}
}

// TestR8Fix4ExpiredSubtreeStillReclaimed 是 F4 的另一半：子树**整个**都已到期时，
// 月名中间父表必须照常被回收（判据不能为了"不失败"而变成"永不回收"）。
//
// 同时钉住 R8-A-1 的连带修法：fold 里对相邻月的 `ensureUsagePartition` 现在按
// **传递根**判定，所以这个形态不再抛错；被 DROP 的子树里的明细在 DROP 之前已经补进
// 永久账本（补账窗口按行事实扩到相邻月），因此聚合（回落账本）与账本一致。
func TestR8Fix4ExpiredSubtreeStillReclaimed(t *testing.T) {
	const costM2 = 6.0
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "1"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	m1 := bjMonth(3) // 名字月（到期）
	m2 := bjMonth(2) // 子分区月（同样到期：cutoff = bjMonth(1)）

	r6DropMonthPartitions(t, db, m1, m2)
	parentRel := "usage_" + monthKey(m1)
	childRel := "usage_" + monthKey(m2)
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		r6Quote(parentRel),
		pgInstantArg(BeijingDayInstant(dayKey(m1))), pgInstantArg(BeijingDayInstant(dayKey(m2).AddDate(0, 1, 0))))); err != nil {
		t.Fatalf("建月名中间父表 %s: %v", parentRel, err)
	}
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
		r6Quote(childRel), r6Quote(parentRel),
		pgInstantArg(BeijingDayInstant(dayKey(m2))), pgInstantArg(BeijingDayInstant(dayKey(m2).AddDate(0, 1, 0))))); err != nil {
		t.Fatalf("建子分区 %s: %v", childRel, err)
	}
	// 只往**子分区**（m2 月）写行：中间父表按 RANGE 分区，m1 月没有子分区 ⇒ 往 m1 月
	// 写行会被 PG 拒（23514）。这正是"相邻月明细落在名字月之外"的形态。
	usageRowAt(t, db, uid, "r8srv-f4b-m2", BeijingDayAt(m2, 10), costM2)

	logs := captureRetentionLog(t)
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("子树整个都已到期时清理必须成功: %v\n%s", err, logs.String())
	}
	if relationExists(t, db, parentRel) {
		t.Fatalf("整株子树都已到期，%s 应被回收（判据不得退化成「永不回收」）", parentRel)
	}
	// 子分区月（m2）的明细随子树一起被 DROP，但 DROP 之前已经补进永久账本 ⇒ 聚合
	// 回落账本、读数不变（这是 §1.5-B 的判据：并入 + 补账必须在 DROP 之前完成）。
	rows, ledger := r6LedgerStats(t, db, m2)
	agg := r6SumCost(t, db, m2, m2.AddDate(0, 1, -1))
	if rows != 1 || math.Abs(ledger-costM2) > 1e-9 || math.Abs(agg-costM2) > 1e-9 {
		t.Fatalf("%s 回收后口径分叉：账本=(%d,%.4f) 聚合=%.4f，want (1,%.4f)\n%s",
			monthKey(m2), rows, ledger, agg, costM2, logs.String())
	}
	// 名字月（m1）本来就没有明细 ⇒ 账本为空、聚合为 0（不得凭空多算）。
	if rows1, ledger1 := r6LedgerStats(t, db, m1); rows1 != 0 || math.Abs(ledger1) > 1e-9 {
		t.Fatalf("%s 没有明细，账本却写了 (%d, %.4f)", monthKey(m1), rows1, ledger1)
	}
	if agg1 := r6SumCost(t, db, m1, m1.AddDate(0, 1, -1)); math.Abs(agg1) > 1e-9 {
		t.Fatalf("%s 没有明细，聚合却读出 %.4f", monthKey(m1), agg1)
	}
}
