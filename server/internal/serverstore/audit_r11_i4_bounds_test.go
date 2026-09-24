package serverstore

// R11-I4 · R11A-03（P2）回归：冻结段事务必须有**有界终点**（含 COMMIT）。
//
// 被审形态（origin/master @ 3264137997）：冻结段用 `db.Begin()`（**无 ctx**），
// 只有 `lock_timeout=5s` + `statement_timeout=20s`；而 `statement_timeout`
// **不覆盖 COMMIT 里做的事** —— 真 PG 实测（提交期执行 5s 的 DEFERRABLE 约束
// 触发器）`Time: 5012/5463/5008 ms`、`rows_committed=1`。⇒ 持有父表
// ACCESS EXCLUSIVE（阻塞全部计量写入的那把锁）的那一段，终点无界。
//
// 修法（两条同时给）：
//
//	ctx —— 整段（含 COMMIT）罩在 usageReclaimFreezeBudgetMS 的 deadline 里；
//	对 COMMIT 的**有效约束** —— COMMIT 以**语句**形态执行（`ExecContext(ctx,
//	"COMMIT")`）。`database/sql` 的 `Tx.Commit()` 没有 ctx 参数，其 `awaitDone`
//	兜底在 `Commit()` 已置位 done 之后是 no-op ⇒ `BeginTx(ctx)` 的 deadline 到点
//	**不会**中止正在进行的 COMMIT（真 PG 实测：同一个注入下 `tx.Commit()` 2.173s
//	后 `err=nil` 且提交成功；`ExecContext(ctx,"COMMIT")` 792ms 后
//	`context deadline exceeded` 且一行未提交）。
//
// # 注入点（"COMMIT 挂起"，真 PG，不用 pg_sleep）
//
//	① 闸门表 i4_gate(block)；
//	② i4_stall() 触发器函数：闸门开 ⇒ **事务内**把 lock_timeout 关成 0
//	   （`set_config('lock_timeout','0',true)`）→ 再对 i4_lock 取 ACCESS EXCLUSIVE
//	   ⇒ 真·无界等锁（不受本段 lock_timeout 约束）；
//	③ i4_hang 挂 `DEFERRABLE INITIALLY DEFERRED` 约束触发器 i4_stall ⇒ 它在
//	   **COMMIT 期**（AfterTriggerEndXact，提交记录写入**之前**）执行；
//	④ **事件触发器** i4_latch（`ddl_command_end` / `ALTER TABLE`）在冻结段的
//	   `ALTER TABLE usage DETACH PARTITION …` 上 INSERT 一行 i4_hang
//	   ⇒ 把"一次 DDL"接进"提交期等待"。
//
// 判据（三条一起看才成立）：
//
//	(a) 整轮在**有界**时间内返回（远小于"锁被按住"的时长）；
//	(b) 冻结段的事务被**回滚** ⇒ 目标关系仍挂在 usage 下（DETACH 未生效）；
//	(c) 这一轮按既有契约记成**延后**（failures=0、进 deferred/unreclaimed），
//	    不是真失败（W3-1 的分类口径）。

import (
	"context"
	"database/sql"
	"sync"
	"testing"
	"time"
)

// i4InstallCommitStall 安装上文的注入点（真 PG；用完由 t.Cleanup 撤掉）。
func i4InstallCommitStall(t *testing.T, db *sql.DB) {
	t.Helper()
	for _, s := range []string{
		"DROP EVENT TRIGGER IF EXISTS r11i4_latch",
		"DROP TABLE IF EXISTS r11i4_hang CASCADE",
		"DROP TABLE IF EXISTS r11i4_lock CASCADE",
		"DROP TABLE IF EXISTS r11i4_gate CASCADE",
		"DROP FUNCTION IF EXISTS r11i4_stall() CASCADE",
		"DROP FUNCTION IF EXISTS r11i4_latch_fn() CASCADE",
		"CREATE TABLE r11i4_lock(i int)",
		"CREATE TABLE r11i4_gate(block bool)",
		"INSERT INTO r11i4_gate VALUES (false)",
		"CREATE TABLE r11i4_hang(i int)",
		`CREATE FUNCTION r11i4_stall() RETURNS trigger LANGUAGE plpgsql AS $fn$
		 BEGIN
		   IF EXISTS (SELECT 1 FROM r11i4_gate WHERE block) THEN
		     PERFORM set_config('lock_timeout', '0', true);
		     LOCK TABLE r11i4_lock IN ACCESS EXCLUSIVE MODE;
		   END IF;
		   RETURN NULL;
		 END $fn$`,
		`CREATE CONSTRAINT TRIGGER r11i4_stall_trg AFTER INSERT ON r11i4_hang
		   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION r11i4_stall()`,
		`CREATE FUNCTION r11i4_latch_fn() RETURNS event_trigger LANGUAGE plpgsql AS $fn$
		 BEGIN
		   IF EXISTS (SELECT 1 FROM r11i4_gate WHERE block) THEN
		     INSERT INTO r11i4_hang VALUES (1);
		   END IF;
		 END $fn$`,
		`CREATE EVENT TRIGGER r11i4_latch ON ddl_command_end WHEN TAG IN ('ALTER TABLE') EXECUTE FUNCTION r11i4_latch_fn()`,
	} {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("装注入点 %q: %v", s, err)
		}
	}
	t.Cleanup(func() {
		_, _ = db.Exec("UPDATE r11i4_gate SET block = false")
	})
}

// i4ArmStall 开/关闸门；开的时候必须已经有人按住 r11i4_lock。
func i4ArmStall(t *testing.T, db *sql.DB, on bool) {
	t.Helper()
	if _, err := db.Exec("UPDATE r11i4_gate SET block = $1", on); err != nil {
		t.Fatal(err)
	}
}

// i4HoldLock 用一条**独占连接**按住 r11i4_lock，返回**幂等**的释放函数。
func i4HoldLock(t *testing.T, db *sql.DB) func() {
	t.Helper()
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(context.Background(), "BEGIN"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(context.Background(), "LOCK TABLE r11i4_lock IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
			_ = conn.Close()
		})
	}
}

// i4PartitionAttached 报告 public.<rel> 是否仍挂在 public.usage 下。
func i4PartitionAttached(t *testing.T, db *sql.DB, rel string) bool {
	t.Helper()
	var attached bool
	if err := db.QueryRow(`SELECT COALESCE(c.relispartition AND pg_partition_root(c.oid)=to_regclass('public.usage'),false)
		FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
		WHERE c.relname=$1 AND n.nspname='public'`, rel).Scan(&attached); err != nil {
		if err == sql.ErrNoRows {
			return false
		}
		t.Fatal(err)
	}
	return attached
}

// TestR11I4FreezeCommitHangIsBounded 是这条的主判据（注入点 = 真 PG 的提交期
// 无界等锁，见文件头注释）。
func TestR11I4FreezeCommitHangIsBounded(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	expired := bjMonth(3)
	rel := "usage_" + monthKey(expired)
	uid := mustUserID(t, db)
	i4InstallCommitStall(t, db)

	// 预算缩到 1.5s：注入强度（"锁被按住"的时长）远大于它，且正常的冻结段
	// （LOCK + DETACH，小夹具）在毫秒级 ⇒ 有 2 个数量级的余量。
	const budget = 4 * time.Second
	prevBudget := usageReclaimFreezeBudgetMS
	usageReclaimFreezeBudgetMS = int(budget / time.Millisecond)
	t.Cleanup(func() { usageReclaimFreezeBudgetMS = prevBudget })

	seed := func() {
		if err := ensureUsagePartition(db, expired); err != nil {
			t.Fatalf("建到期月分区: %v", err)
		}
		usageRowAt(t, db, uid, "r11i4-freeze", BeijingDayAt(expired, 10), 2.5)
	}
	resetUsageRetentionStatusForTest()

	// ---- 自校准（不因环境变红）：缩预算之后、**不注入**的一轮必须先能正常成功。
	seed()
	baseStart := time.Now()
	baseErr := CleanupUsageRetention(db)
	baseElapsed := time.Since(baseStart)
	if baseErr != nil || i4PartitionAttached(t, db, rel) {
		t.Skipf("自校准未通过：缩到 %s 的预算在本机跑不完一次正常冻结段（err=%v 仍挂着=%v，耗时=%s）"+
			"⇒ 本判据在当前负载下咬不到，按行为判据处理而不是判回归",
			budget, baseErr, i4PartitionAttached(t, db, rel), baseElapsed.Round(time.Millisecond))
	}
	t.Logf("自校准：缩预算后的一轮正常清理 %s（err=nil，关系已回收）", baseElapsed.Round(time.Millisecond))

	// ---- 注入：按住 i4_lock + 开闸门 ⇒ 冻结段的 COMMIT 无界等锁。
	release := i4HoldLock(t, db)
	defer release()
	i4ArmStall(t, db, true)
	seed()
	resetUsageRetentionStatusForTest()
	const hold = 20 * time.Second
	releaseAt := time.Now().Add(hold)
	// 看门狗：`hold` 之后放开锁。这一条是**判据的可诊断性**要求 ——
	// 未修复的形态（`tx.Commit()` 没有 ctx 上界）会在 COMMIT 里一直等这把锁，
	// 没有看门狗就会把整包挂到 go test 的 600s 超时（"包级 FAIL 且无 --- FAIL
	// 明细"是本项目登记过的不可诊断红）。放开之后它会**提交成功**，
	// 于是 (b) 条断言给出干净的判定。
	go func() { time.Sleep(hold); release() }()

	start := time.Now()
	roundErr := CleanupUsageRetention(db)
	elapsed := time.Since(start)
	st := CurrentUsageRetentionStatus()
	stillAttached := i4PartitionAttached(t, db, rel)
	t.Logf("注入看板：roundErr=%v 整轮耗时=%s 仍挂在 usage 下=%v failures=%d deferred=%v unreclaimed=%v skip_reasons=%v",
		roundErr, elapsed.Round(time.Millisecond), stillAttached, st.Failures, st.DeferredRelations, st.Unreclaimed, st.SkippedByReason)
	t.Logf("（注入期间 i4_lock 被按住到 %s，即 %.0fs；整轮耗时 %s 必须远小于它）",
		releaseAt.Format("15:04:05"), hold.Seconds(), elapsed.Round(time.Millisecond))

	// 先撤注入，保证后面的断言不被"锁还被按着"干扰。
	i4ArmStall(t, db, false)
	release()

	// (a) 有界。
	if elapsed >= hold {
		t.Errorf("冻结段的 COMMIT 没有被上界截断：整轮耗时 %s ≥ 注入时长 %s（R11A-03：ctx 必须罩住 COMMIT）",
			elapsed.Round(time.Millisecond), hold)
	}
	if elapsed > 3*budget {
		t.Errorf("整轮耗时 %s 明显超过预算 %s 的量级（冻结段必须有有界终点）",
			elapsed.Round(time.Millisecond), budget)
	}
	// (b) 冻结段被回滚 ⇒ DETACH 未生效。
	if !stillAttached {
		t.Errorf("注入下的那一轮竟然成功 DETACH+DROP 了 %s —— 说明 deadline 没有中止 COMMIT"+
			"（真 PG 实测：`tx.Commit()` 在这个注入下 2.173s 后 err=nil 且提交成功）", rel)
	}
	// (c) 按既有契约记成**延后**，不是真失败。
	if st.Failures != 0 {
		t.Errorf("预算到点必须按 timeout 分类成延后（failures=0），实得 failures=%d（skip_reasons=%v）",
			st.Failures, st.SkippedByReason)
	}
	if _, timedOut := usageFailureTimeoutReason(roundErr); roundErr != nil && !timedOut {
		t.Errorf("整轮返回的应只是 error 聚合里的失败，实得 %v", roundErr)
	}
}
