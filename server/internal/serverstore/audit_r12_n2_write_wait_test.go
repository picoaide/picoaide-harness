package serverstore

// R12-N2 · P2-01 / P2-02 回归。
//
// # P2-01：写路径建分区 DDL 的等待必须**有界 + 可观测**
//
// 被审形态（origin/master @ 12540e681c，R12-A 的 P2-01，探针 TestR12AQ3）：
// 结算/预补账事务读 `usage` 取得**隐式** ACCESS SHARE 并持到 COMMIT（提交期不受
// statement_timeout 约束），而写路径的 `CREATE TABLE … PARTITION OF usage` 需要
// `usage` 的 ACCESS EXCLUSIVE —— 两者相撞时**月初第一次计量写入**会同步等待整段
// （真 PG 实测 5.18s/6s 注入，对照 15ms）。旧语义是"裸 db.Exec、无 lock_timeout、
// 无 ctx"（注释明确写"必须等锁"），且**没有任何可观测面** ⇒ 用户可见的停顿既无上界
// 也不可读。变异 `M-Q3-drop-as-anchor` 还证明阻塞者是**隐式** AS（删显式锚点无效）。
//
// 修法：`runPartitionDDLWithBoundedWait`（每次尝试带 lock_timeout、退避重试、
// 整段总预算 = 结算段预算下限 30s、每次命中等进 write_ddl_lock_* 读数）。
// 本文件的判据：
//
//	A. 等待**仍然成功**（预算之内语义与旧实现相同：不把"慢"变成"错"），且
//	   `write_ddl_lock_waits > 0` / `write_ddl_lock_wait_ms_max > 0`（可观测）；
//	B. 预算**真的**有界：把预算压到远小于注入时长 ⇒ 写入在预算内失败（fail-closed）
//	   且 `write_ddl_lock_budget_exhausted == 1`（旧实现会一直挂到锁释放）；
//	C. 对照组：分区已存在时不走 DDL ⇒ 等待账不增长。
//
// # P2-02：`write_blocked_other_months` 的自愈在**同名孤儿**上不得反向
//
// 被审形态（同前，R12-A 的 P2-02，探针 TestR12AQ5）：收敛判据 `round.ExistingMonths`
// 只由 attached 桶拼出，而"挡着该月写入"的恰恰是**孤儿桶**（关系在、不在 usage 树下）
// ⇒ 清理在同一轮里刚报 `skip=orphan-retained:1`（证明它知道关系还在），条目却被
// 自愈逻辑清掉：告警反向漏报，而写入仍然 503。

import (
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// n2InstallSlowCommit 在 usage_daily 上装一个"提交期睡 N 秒"的 DEFERRABLE 约束触发器
// （R11A-03 / R12-A Q3 的同一注入形态：statement_timeout 不覆盖提交期）。
func n2InstallSlowCommit(t *testing.T, db *sql.DB, seconds int) {
	t.Helper()
	for _, s := range []string{
		`CREATE OR REPLACE FUNCTION zz_r12n2_slow() RETURNS trigger AS $$
BEGIN
  PERFORM pg_sleep(` + fmt.Sprint(seconds) + `);
  RETURN NULL;
END $$ LANGUAGE plpgsql`,
		`DROP TRIGGER IF EXISTS zz_r12n2_slow_trg ON usage_daily`,
		`CREATE CONSTRAINT TRIGGER zz_r12n2_slow_trg AFTER INSERT ON usage_daily
		   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zz_r12n2_slow()`,
	} {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("装慢提交触发器: %v", err)
		}
	}
}

// n2StartContendedCleanup 起一轮"会长时间持有 usage 的 ACCESS SHARE"的清理，并返回
// 一个在清理结束后关闭的 channel（调用方用 select 等待）。
type n2CleanupRun struct {
	dur time.Duration
	err error
}

// n2StartContendedCleanup 起一轮清理（它会长时间持有 `usage` 的 ACCESS SHARE），
// 返回一个容量 1 的结果 channel（读它即等待结束）。
func n2StartContendedCleanup(t *testing.T, db *sql.DB) <-chan n2CleanupRun {
	t.Helper()
	ch := make(chan n2CleanupRun, 1)
	go func() {
		t0 := time.Now()
		err := CleanupUsageRetention(db)
		ch <- n2CleanupRun{dur: time.Since(t0), err: err}
	}()
	return ch
}

// n2WaitForUsageAccessShare 等到**另一个会话**在 public.usage 上持有 ACCESS SHARE
// （= 清理的结算段已经进入并读到了父表）。判据取自 pg_locks，不靠 sleep 猜。
func n2WaitForUsageAccessShare(t *testing.T, db *sql.DB, budget time.Duration) bool {
	t.Helper()
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		var n int
		// **必须按 database 过滤**：pg_locks 是集群级的，而 pg_class 的 oid 只在库内唯一
		// —— 不加这一条会匹配到**别的测试库**里同名 oid 的锁（本用例第一版就因此
		// 假绿：以为清理持着 AS，其实那是另一个库里的会话）。
		err := db.QueryRow(`SELECT count(*) FROM pg_locks l
JOIN pg_class c ON c.oid = l.relation
JOIN pg_namespace ns ON ns.oid = c.relnamespace
WHERE l.locktype = 'relation' AND l.granted AND l.mode = 'AccessShareLock'
  AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND ns.nspname = 'public' AND c.relname = 'usage' AND l.pid <> pg_backend_pid()`).Scan(&n)
		if err == nil && n > 0 {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

// n2HoldUsageAccessShare 起一个侧连接，在**显式事务**里持 `public.usage` 的
// ACCESS SHARE 直到 hold 结束（release 由返回的函数触发）。
//
// 为什么用显式持锁而不是"清理的提交期睡眠"做夹具：真 PG 实测两者都成立（见
// TestAuditR12N2WriteDDLWaitIsBoundedAndObservable 的 D 段），但清理**何时**进入
// 持锁段不可控 ⇒ 判据会变成时序赌博。这里把"有竞争者持 AS"这件事做成确定的。
func n2HoldUsageAccessShare(t *testing.T, db *sql.DB, hold time.Duration) (release func()) {
	t.Helper()
	side, err := openPG(r10f4DSNFor(r10gCurDB(t, db)))
	if err != nil {
		t.Fatal(err)
	}
	conn, err := side.Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(t.Context(), "BEGIN"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(t.Context(), "LOCK TABLE ONLY "+quoteRelationIdent("usage")+" IN ACCESS SHARE MODE"); err != nil {
		t.Fatal(err)
	}
	if !n2WaitForUsageAccessShare(t, db, 5*time.Second) {
		t.Fatalf("夹具无效：侧连接持了 AS，但 5s 内没有在 pg_locks 里观察到它")
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		time.Sleep(hold)
		_, _ = conn.ExecContext(t.Context(), "ROLLBACK")
		_ = conn.Close()
		_ = side.Close()
	}()
	var once sync.Once
	return func() { once.Do(func() { <-done }) }
}

// TestAuditR12N2WriteDDLWaitIsBoundedAndObservable 是 P2-01 的判据 A + B。
//
// 被审形态（R12-A P2-01）：写路径的 `CREATE TABLE … PARTITION OF usage` 需要 `usage`
// 的 ACCESS EXCLUSIVE，而清理轮的预补账/结算事务读 `usage` 取得**隐式** ACCESS SHARE
// 并持到 COMMIT（真 PG 实测：提交期的 DEFERRABLE 约束触发器睡眠期间锁**仍然持有**，
// 同事务的 AEX 请求照样超时）⇒ 月初第一次计量写入同步等待整段（R12-A 实测 5.18s，
// 对照 15ms），而这条等待此前既无上界也无任何读数。
func TestAuditR12N2WriteDDLWaitIsBoundedAndObservable(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	n2Reset(t, db)
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)

	nowMonth := BeijingMonth(time.Now())
	next := nowMonth.AddDate(0, 1, 0)
	for _, m := range []time.Time{nowMonth, next} {
		rel := "usage_" + monthKey(m)
		if r9aRelationExists(t, db, rel) {
			n2DropMonth(t, db, m)
		}
		t.Cleanup(func() { _, _ = db.Exec("DROP TABLE IF EXISTS public." + quoteRelationIdent(rel)) })
	}

	// A. 竞争者持 AS 3s ⇒ 写入**等**（waits>0）但仍在预算内成功，且等待可读。
	resetUsageRetentionStatusForTest()
	release := n2HoldUsageAccessShare(t, db, 3*time.Second)
	t0 := time.Now()
	_, werr := RecordUsageKind(db, uid, "r12n2-p201-a", 100, 50, "chat")
	waited := time.Since(t0)
	release()
	st := CurrentUsageRetentionStatus()
	t.Logf("P2-01(A)：竞争 3s ⇒ 首次写入耗时=%v err=%v | waits=%d max_ms=%d exhausted=%d",
		waited.Round(time.Millisecond), werr, st.WriteDDLLockWaits, st.WriteDDLLockWaitMSMax, st.WriteDDLLockBudgetExhausted)
	if werr != nil {
		t.Fatalf("预算（%dms）之内的等待必须仍然成功（旧语义是「必须等锁」—— 不能把慢变成错）：%v",
			usageWritePartitionDDLWaitBudgetMS, werr)
	}
	if waited < 2*time.Second {
		t.Fatalf("夹具无效：竞争者持锁 3s，而写入只用了 %v ⇒ 本用例没有咬到锁等待", waited.Round(time.Millisecond))
	}
	if st.WriteDDLLockWaits == 0 || st.WriteDDLLockWaitMSMax <= 0 {
		t.Errorf("写路径被锁挡住的这段等待**没有可观测面**（waits=%d max_ms=%d）—— "+
			"R12-A P2-01 的核心缺口就是「这条等待没有任何读数」", st.WriteDDLLockWaits, st.WriteDDLLockWaitMSMax)
	}

	// B. 有界：预算压到 400ms、退避 60ms ⇒ 3s 的占用一定耗尽预算（旧实现会一直挂到锁释放）。
	oldBudget, oldDelay, oldAttempt := usageWritePartitionDDLWaitBudgetMS, usageWritePartitionDDLRetryDelay, usageWritePartitionDDLAttemptMS
	usageWritePartitionDDLWaitBudgetMS, usageWritePartitionDDLRetryDelay, usageWritePartitionDDLAttemptMS = 400, 60*time.Millisecond, 120
	t.Cleanup(func() {
		usageWritePartitionDDLWaitBudgetMS, usageWritePartitionDDLRetryDelay, usageWritePartitionDDLAttemptMS = oldBudget, oldDelay, oldAttempt
	})
	resetUsageRetentionStatusForTest()
	release2 := n2HoldUsageAccessShare(t, db, 3*time.Second)
	t1 := time.Now()
	_, werr2 := recordUsageKindAtCached(db, uid, 0, "r12n2-p201-b", 100, 50, 0, "chat", false, BeijingDayAt(next, 5))
	boundedDur := time.Since(t1)
	release2()
	st2 := CurrentUsageRetentionStatus()
	t.Logf("P2-01(B)：预算压到 400ms、竞争 3s ⇒ 写入耗时=%v err=%v | exhausted=%d",
		boundedDur.Round(time.Millisecond), werr2, st2.WriteDDLLockBudgetExhausted)
	if werr2 == nil {
		t.Errorf("预算（400ms）远小于占用（3s）时写入却成功了 —— 等待仍然无界")
	}
	if boundedDur > 2*time.Second {
		t.Errorf("有界语义失效：写入等了 %v（预算 400ms）", boundedDur.Round(time.Millisecond))
	}
	if st2.WriteDDLLockBudgetExhausted == 0 {
		t.Errorf("预算耗尽没有任何读数（write_ddl_lock_budget_exhausted=0）")
	}
	if !strings.Contains(fmt.Sprint(werr2), "总预算") {
		t.Errorf("预算耗尽的错误文案必须点明「有界」这件事（便于运维区分「慢」与「错」）：%v", werr2)
	}

	// C. 对照组：预算恢复、无竞争、且该月分区已存在（A 段建好了）⇒ 不走 DDL，等待账不增长。
	usageWritePartitionDDLWaitBudgetMS, usageWritePartitionDDLRetryDelay, usageWritePartitionDDLAttemptMS = oldBudget, oldDelay, oldAttempt
	before := CurrentUsageRetentionStatus().WriteDDLLockWaits
	if _, werr := RecordUsageKind(db, uid, "r12n2-p201-c", 10, 5, "chat"); werr != nil {
		t.Fatalf("对照写入失败: %v", werr)
	}
	after := CurrentUsageRetentionStatus().WriteDDLLockWaits
	t.Logf("P2-01(C) 对照：分区已存在时的普通写入 ⇒ waits %d→%d（应不变）", before, after)
	if after != before {
		t.Errorf("分区已存在时不该走 DDL 等待（waits %d→%d）", before, after)
	}

	// D. **量化**（不设硬断言，只留数字）：清理轮次与写入重叠时的真实停顿。
	//    夹具与 R12-A Q3 同源（usage_daily 上的 DEFERRABLE 约束触发器让提交期睡 6s）。
	if err := ensureUsagePartition(db, bjMonth(3)); err != nil {
		t.Fatal(err)
	}
	usageRowAt(t, db, uid, "r12n2-p201-d", BeijingDayAt(bjMonth(3), 10), 9.0)
	n2DropMonth(t, db, next.AddDate(0, 1, 0))
	n2InstallSlowCommit(t, db, 6)
	t.Cleanup(func() { _, _ = db.Exec("DROP TRIGGER IF EXISTS zz_r12n2_slow_trg ON usage_daily") })
	done := n2StartContendedCleanup(t, db)
	time.Sleep(1200 * time.Millisecond)
	t2 := time.Now()
	_, werrD := recordUsageKindAtCached(db, uid, 0, "r12n2-p201-d", 100, 50, 0, "chat", false, BeijingDayAt(next.AddDate(0, 1, 0), 5))
	durD := time.Since(t2)
	run := <-done
	stD := CurrentUsageRetentionStatus()
	t.Logf("P2-01(D) 量化：清理整轮=%v err=%v | 同刻首次写入=%v err=%v | waits=%d max_ms=%d",
		run.dur.Round(time.Millisecond), run.err, durD.Round(time.Millisecond), werrD,
		stD.WriteDDLLockWaits, stD.WriteDDLLockWaitMSMax)
}

// TestAuditR12N2OrphanWriteBlockEntrySurvivesSelfHeal 是 P2-02 的判据。
func TestAuditR12N2OrphanWriteBlockEntrySurvivesSelfHeal(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	n2Reset(t, db)
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	retained := bjMonth(1) // 仍在保留期内 ⇒ 清理**不能**删它，只点名
	rel := "usage_" + monthKey(retained)
	n2DropMonth(t, db, retained)
	if _, err := db.Exec("CREATE TABLE " + quoteRelationIdent(rel) + " (LIKE public.usage INCLUDING ALL)"); err != nil {
		t.Fatalf("造同名孤儿 %s: %v", rel, err)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP TABLE IF EXISTS public." + quoteRelationIdent(rel)) })

	resetUsageRetentionStatusForTest()
	noteUsagePartitionWriteFailure(retained, &partitionLayoutError{
		kind: usagePartitionKindOrphanNameCollision, action: "人工处置",
		msg: "保留期内同名孤儿挡着该月写入(用例注入)",
	})
	before := CurrentUsageRetentionStatus()
	if len(before.WriteBlockedOtherMonths) != 1 {
		t.Fatalf("夹具无效：注入的条目没进 write_blocked_other_months（%+v）", before.WriteBlockedOtherMonths)
	}
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	after := CurrentUsageRetentionStatus()
	exists := r9aRelationExists(t, db, rel)
	t.Logf("P2-02：关系 %s 仍存在=%v | other_months=%d %v | skip=%v cleared=%d",
		rel, exists, len(after.WriteBlockedOtherMonths), after.WriteBlockedOtherMonths,
		after.SkippedByReason, after.ClearedPartitions)
	if !exists {
		t.Fatalf("夹具无效：孤儿被清掉了（本用例要的形状是「关系还在、写入仍被挡」）")
	}
	if len(after.WriteBlockedOtherMonths) == 0 {
		t.Errorf("关系 %s 还在（该月写入仍然 503 METERING_FAILED），但 `write_blocked_other_months` 条目"+
			"被自愈逻辑清掉了 —— 收敛判据只统计**挂在 usage 树下的**月关系，孤儿桶不进集合 ⇒ "+
			"告警反向漏报（R11A-04 的反向）", rel)
	}
	// 反向对照：真的被回收掉的月，条目必须消失（自愈不能变成"永不清"）。
	expired := bjMonth(3)
	if err := ensureUsagePartition(db, expired); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	usageRowAt(t, db, uid, "r12n2-p202", BeijingDayAt(expired, 10), 1.5)
	noteUsagePartitionWriteFailure(expired, &partitionLayoutError{
		kind: usagePartitionKindOrphanNameCollision, action: "人工处置", msg: "到期月回收窗口内写入被挡(用例注入)",
	})
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("第二轮清理失败: %v", err)
	}
	final := CurrentUsageRetentionStatus()
	gone := !r9aRelationExists(t, db, "usage_"+monthKey(expired))
	t.Logf("P2-02 对照：到期月 %s 已被回收=%v | 条目=%v", monthKey(expired), gone, final.WriteBlockedOtherMonths)
	if !gone {
		t.Fatalf("夹具/形态不符：到期月 %s 本轮没被回收", monthKey(expired))
	}
	for _, m := range final.WriteBlockedOtherMonths {
		if m.Month == monthKey(expired) {
			t.Errorf("已回收月份 %s 的条目仍在（自愈不能变成永不清）", monthKey(expired))
		}
	}
	if len(final.WriteBlockedOtherMonths) == 0 {
		t.Errorf("仍在保留期内、且关系还在的那个月（%s）的条目被连带清掉了 —— 收敛判据过宽", monthKey(retained))
	}
}
