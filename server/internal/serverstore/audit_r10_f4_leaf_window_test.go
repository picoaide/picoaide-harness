package serverstore

// R10-F4 泳道 · 叶子窗口与前半轮的有界语义（R10-D-01 P1 / R10-D-02 P2）。
//
// 被修形态（HEAD f325817ae8，真 PG 实测）：
//
//	T1 叶子窗口：`reclaimUsagePartitionAtomically` 的"持锁复检"被
//	   `if !shape.leafTable()` 门住 —— 而**叶子月分区正是产品实际布局**
//	   （ensureUsagePartition 建的就是它）；`retentionBackfill`（补账）在临界区
//	   **之外**。于是 [补账, DROP] 之间**提交**到该分区的行被 `DROP TABLE` 级联
//	   删除、且没进账本 ⇒ 明细与金额双失，而本轮 `cleared_partitions=N
//	   failures=0 skipped=0`、`/readyz` 全绿。审计方 3 轮实测
//	   SILENT_LOSS=5.00/6.00/4.00。
//	T2 前半轮无界：任一会话对任一月分区持 ACCESS EXCLUSIVE ⇒ 整轮无界挂住
//	   （probeUsagePartition 的 pg_get_expr 要打开关系、补账要读父表），而
//	   `PUT /api/server/admin/…` 是**同步**调用 ⇒ 管理端请求一起挂到 HTTP 写超时。
//
// 修复后的判据：
//
//	① 每一轮的金额都守恒：`明细(若还在) + 永久账本` == `种子 + 成功提交的行`
//	   ⇒ **SILENT_LOSS=0.00（3 轮逐轮断言）**；
//	② 阻塞源在场时，整轮必须在有界时间内返回（lock_timeout ⇒ 55P03 ⇒ 按 timeout
//	   分类延后），且**一行数据都没动**；解除阻塞后下一轮自愈回收；
//	③ 4 路并发清理 3 轮：良性竞态不得把轮次变成失败（failures 必须留在 0）。
//
// 复跑（真 PG）：
//
//	docker exec pg-test psql -U postgres -c "CREATE DATABASE r10f4"
//	cd server && PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/r10f4 \
//	  go test ./internal/serverstore/ -run 'TestR10F4T' -count=1 -v

import (
	"database/sql"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// r10f4DSNFor 把测试 DSN 的库名换成指定库（阻塞源/观测连接必须与用例同库）。
func r10f4DSNFor(name string) string {
	u, err := url.Parse(PgTestDSN())
	if err != nil {
		return PgTestDSN()
	}
	u.Path = "/" + name
	return u.String()
}

// r10f4Insert 是一次真实计量写入（走 `INSERT INTO usage` 的元组路由）。
func r10f4Insert(db *sql.DB, uid int64, model string, at time.Time, cost float64) error {
	_, err := db.Exec(`INSERT INTO usage (user_id, model, provider_id, prompt_tokens, completion_tokens,
        cache_prompt_tokens, kind, cost, created_at, estimated) VALUES ($1,$2,0,10,20,0,'chat',$3,$4,false)`,
		uid, model, cost, at.UTC())
	return err
}

// r10f4CountMonth 数某北京月还留在明细里的行数。
func r10f4CountMonth(t *testing.T, db *sql.DB, m time.Time) int64 {
	t.Helper()
	lo := BeijingDayInstant(dayKey(m))
	hi := BeijingDayInstant(dayKey(m).AddDate(0, 1, 0))
	var n int64
	if err := db.QueryRow(`SELECT count(*) FROM usage WHERE created_at >= $1 AND created_at < $2`,
		lo.UTC(), hi.UTC()).Scan(&n); err != nil {
		t.Fatalf("count month %s: %v", monthKey(m), err)
	}
	return n
}

// TestR10F4T1LeafWindowKeepsCommittedMoney 是 D-01 的确定性复现（3 轮，逐轮断言守恒）。
//
// 交错形态：清理正在回收一个**叶子**月分区时，另一条连接持续向该月提交明细行。
// 判据 = 「200 条种子 × 0.25 + 成功提交的行数 × 1.0」必须等于清理后
// `UsageAggregateWithLedger`（与报表同口径）的合计 ⇒ SILENT_LOSS 必须逐轮为 0.00。
//
// 注意 `insertErrs` 里被 DROP 带走的失败插入**本来就不该算成功**（它们没提交成功），
// 所以口径只看 `okInserts` —— 口径本身不能成为"把丢账算成失败"的后门。
func TestR10F4T1LeafWindowKeepsCommittedMoney(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	expired := bjMonth(3)
	if err := ensureUsagePartition(db, expired); err != nil {
		t.Fatalf("ensure partition: %v", err)
	}
	for i := 0; i < 200; i++ {
		if err := r10f4Insert(db, uid, fmt.Sprintf("seed-%d", i%7), BeijingDayAt(expired, 10), 0.25); err != nil {
			t.Fatal(err)
		}
	}
	rels, err := scanUsageMonthTables(db)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("candidate partitions=%v orphans=%v nonleaf=%v", rels.Partitions, rels.Orphans, rels.AttachedNonLeaf)

	const seedCost = 0.25
	const liveCost = 1.0
	for round := 1; round <= 3; round++ {
		// 每轮把过期月分区重新建出来（上一轮已被清掉），并把该月**清空**。
		if err := ensureUsagePartition(db, expired); err != nil {
			t.Fatalf("round %d: ensure partition: %v", round, err)
		}
		lo := BeijingDayInstant(dayKey(expired))
		hi := BeijingDayInstant(dayKey(expired).AddDate(0, 1, 0))
		if _, err := db.Exec(`DELETE FROM usage WHERE created_at >= $1 AND created_at < $2`, lo.UTC(), hi.UTC()); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`DELETE FROM usage_daily WHERE day >= $1::date AND day < $2::date`,
			dayKey(expired).Format(dateFmt), dayKey(expired).AddDate(0, 1, 0).Format(dateFmt)); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 200; i++ {
			if err := r10f4Insert(db, uid, fmt.Sprintf("seed-%d", i%7), BeijingDayAt(expired, 10), seedCost); err != nil {
				t.Fatal(err)
			}
		}
		if _, seedLedger := r6LedgerStats(t, db, expired); seedLedger != 0 {
			t.Fatalf("round %d: 夹具前提不成立 —— 清理前账本里已经有 %v（补账生效必须从零开始）", round, seedLedger)
		}

		var okInserts, failedInserts, noPartition int64
		stop := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			at := BeijingDayAt(expired, 10)
			for {
				select {
				case <-stop:
					return
				default:
				}
				if err := r10f4Insert(db, uid, "live-writer", at, liveCost); err != nil {
					atomic.AddInt64(&failedInserts, 1)
					if strings.Contains(err.Error(), "no partition of relation") {
						atomic.AddInt64(&noPartition, 1)
					}
					time.Sleep(time.Millisecond)
					continue
				}
				atomic.AddInt64(&okInserts, 1)
			}
		}()
		time.Sleep(80 * time.Millisecond) // 让写入者先进入稳态
		okBefore := atomic.LoadInt64(&okInserts)
		cerr := CleanupUsageRetention(db)
		close(stop)
		wg.Wait()
		ok := atomic.LoadInt64(&okInserts)
		bad := atomic.LoadInt64(&failedInserts)
		nop := atomic.LoadInt64(&noPartition)

		expected := 200*seedCost + float64(ok)*liveCost
		agg := r6SumCost(t, db, dayKey(expired), dayKey(expired).AddDate(0, 1, -1))
		lrows, lcost := r6LedgerStats(t, db, expired)
		lost := expected - agg
		st := CurrentUsageRetentionStatus()
		t.Logf("ROUND %d: cleanupErr=%v okInserts=%d(稳态前=%d,清理期间=%d) insertErrs=%d(noPartition=%d) rowsLeft=%d",
			round, cerr, ok, okBefore, ok-okBefore, bad, nop, r10f4CountMonth(t, db, expired))
		t.Logf("ROUND %d: MONEY expected=%.2f aggregate_after=%.2f ledger(%d rows)=%.2f SILENT_LOSS=%.2f",
			round, expected, agg, lrows, lcost, lost)
		t.Logf("ROUND %d: cleared_partitions=%d failures=%d skipped=%d reasons=%v",
			round, st.ClearedPartitions, st.Failures, st.Skipped, st.SkippedByReason)

		// —— 硬判据（审计方的口径）：金额守恒 ⇒ SILENT_LOSS 每轮 0.00。
		if lost > 1e-9 {
			t.Errorf("ROUND %d 静默丢账：SILENT_LOSS=%.2f（明细+账本 < 种子+成功提交）；"+
				"叶子月分区是产品实际布局，[补账, DROP] 之间提交的行必须被补账覆盖或用持锁复检挡住"+
				"（R10-D-01）", round, lost)
		}
		if cerr != nil {
			t.Errorf("ROUND %d 清理返回非 nil（并发写入不该让保留清理变成失败）: %v", round, cerr)
		}
	}
}

// TestR10F4T2FirstHalfIsBoundedAndRecovers 是 D-02 的确定性复现（修复后语义）。
//
// 阻塞源：另一条连接把 ACCESS EXCLUSIVE 按在**被回收关系**上（模拟另一轮清理的临界区、
// 管理员 ALTER/VACUUM FULL/REINDEX、长事务）。旧实现在**前半轮**（catalog 探测里的
// pg_get_expr 要打开关系、补账要读父表）没有任何 lock_timeout/context ⇒ 整轮无界挂住
// （审计方实测 >15s 仍未返回，且管理端是同步调用）。
//
// 修复后的判据：
//
//	① 整轮在**有界**时间内返回（前两处等锁各自 5s 上界 ⇒ 实测应远小于 15s）；
//	② 阻塞期间**一行数据都没动**（关系仍在、仍挂在 usage 下、无子关系）；
//	③ 阻塞解除后下一轮**自愈**：关系被回收、failures=0（超时是延后，不是失败）。
func TestR10F4T2FirstHalfIsBoundedAndRecovers(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	expired := bjMonth(3)
	if err := ensureUsagePartition(db, expired); err != nil {
		t.Fatal(err)
	}
	rel := "usage_" + monthKey(expired)
	for i := 0; i < 5; i++ {
		if err := r10f4Insert(db, uid, "seed", BeijingDayAt(expired, 10), 0.5); err != nil {
			t.Fatal(err)
		}
	}

	// 阻塞源必须连到 NewTestDB 建出来的那个临时库（PgTestDSN 的库名不是它）。
	var curDB string
	if err := db.QueryRow("SELECT current_database()").Scan(&curDB); err != nil {
		t.Fatal(err)
	}
	blocker, err := sql.Open("pgx", r10f4DSNFor(curDB))
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Close()
	bctx := t.Context()
	btx, err := blocker.BeginTx(bctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := btx.Exec("LOCK TABLE " + quoteRelationIdent(rel) + " IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}

	// 清理在**另一个 goroutine**里跑：这样"无界阻塞"是可观测的，而不是把用例自己挂死。
	type roundRes struct {
		err     error
		elapsed time.Duration
	}
	done := make(chan roundRes, 1)
	start := time.Now()
	go func() {
		err := CleanupUsageRetention(db)
		done <- roundRes{err: err, elapsed: time.Since(start)}
	}()
	// 观测必须走**另一条连接**：清理 goroutine 可能占着池里的连接阻塞在锁上，
	// 用同一个池查询会被池上限卡死（那是探针自身的 artifact）。
	obs, oerr := sql.Open("pgx", r10f4DSNFor(curDB))
	if oerr != nil {
		t.Fatal(oerr)
	}
	defer obs.Close()
	var res roundRes
	hung := false
	const bounded = 15 * time.Second
	select {
	case res = <-done:
	case <-time.After(bounded):
		hung = true
	}
	t.Logf("BLOCKED ROUND: hung(>%s)=%v elapsed=%s err=%v", bounded, hung, time.Since(start).Round(time.Millisecond), res.err)
	if hung {
		rows, qerr := obs.Query(`SELECT a.pid, a.state, a.wait_event_type, COALESCE(a.wait_event,''), left(a.query, 120)
            FROM pg_stat_activity a WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
              AND a.wait_event_type = 'Lock'`)
		if qerr == nil {
			for rows.Next() {
				var pid int
				var state, wet, wev, q string
				if err := rows.Scan(&pid, &state, &wet, &wev, &q); err != nil {
					t.Fatal(err)
				}
				t.Logf("BLOCKED BACKEND pid=%d state=%s wait=%s/%s query=%q", pid, state, wet, wev, q)
			}
			rows.Close()
		}
		t.Errorf("前半轮仍无界挂住（>%s 未返回）：任一月分区的 ACCESS EXCLUSIVE 不得让整轮（以及同步调用它的管理端请求）无限等待（R10-D-02）", bounded)
	}

	// 阻塞期间的数据事实（全部来自 catalog，不看返回值）。
	var exists, attached, isPart, kids bool
	if err := obs.QueryRow(`SELECT true,
      EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class p ON p.oid=i.inhparent WHERE i.inhrelid=to_regclass($1) AND p.relname='usage'),
      (SELECT relispartition FROM pg_class WHERE oid=to_regclass($1)),
      (SELECT count(*)>0 FROM pg_inherits WHERE inhparent=to_regclass($1))`,
		"public."+rel).Scan(&exists, &attached, &isPart, &kids); err != nil {
		t.Fatalf("catalog probe: %v", err)
	}
	t.Logf("WHILE BLOCKED: exists=%v stillAttachedToUsage=%v isPartition=%v hasChildren=%v",
		exists, attached, isPart, kids)
	if !exists || !attached || !isPart {
		t.Errorf("阻塞期间数据被动了：exists=%v attached=%v isPartition=%v（有界语义必须整体回滚）",
			exists, attached, isPart)
	}

	// 阻塞期间的失败必须是 **timeout 分类**（延后），不是"真失败"。
	if !hung {
		st := CurrentUsageRetentionStatus()
		t.Logf("BLOCKED ROUND 记账：failures=%d skipped=%d reasons=%v unreclaimed=%v last_error=%q",
			st.Failures, st.Skipped, st.SkippedByReason, st.Unreclaimed, st.LastError)
		if st.Failures != 0 || res.err != nil {
			t.Errorf("锁竞争被记成失败（R10-A-03：超时必须与真失败可区分）: err=%v failures=%d last_error=%q",
				res.err, st.Failures, st.LastError)
		}
		if st.SkippedByReason[usageSkipLockTimeout] == 0 && st.SkippedByReason[usageSkipStatementTimeout] == 0 {
			t.Errorf("超时没有被记成可读的延后原因（skipped_by_reason=%v）", st.SkippedByReason)
		}
	}

	if err := btx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if hung {
		select {
		case res = <-done:
			t.Logf("UNBLOCKED ROUND: elapsed=%s err=%v", res.elapsed.Round(time.Millisecond), res.err)
		case <-time.After(60 * time.Second):
			t.Logf("UNBLOCKED ROUND: 解除阻塞后 60s 仍未返回")
		}
	}
	// 自愈：阻塞解除后下一轮必须成功回收。
	resetUsageRetentionStatusForTest()
	cerr2 := CleanupUsageRetention(db)
	st2 := CurrentUsageRetentionStatus()
	var stillThere bool
	if err := obs.QueryRow(`SELECT to_regclass($1) IS NOT NULL`, "public."+rel).Scan(&stillThere); err != nil {
		t.Fatal(err)
	}
	t.Logf("RECOVERY ROUND: err=%v roundFailures=%d cleared_partitions=%d relationStillExists=%v",
		cerr2, st2.Failures, st2.ClearedPartitions, stillThere)
	if cerr2 != nil || st2.Failures != 0 {
		t.Errorf("阻塞解除后必须自愈（不得留下永久失败）: err=%v failures=%d", cerr2, st2.Failures)
	}
	if stillThere {
		t.Errorf("阻塞解除后到期关系 %s 仍未被回收", rel)
	}
}

// TestR10F4T3ConcurrentRoundsStayBenign 是"良性竞态唯一出口"在真并发下的判据
// （3 轮 × 4 路）：任何一轮都不允许把"另一个执行者已经把它清掉/改挂"记成失败 ——
// 那正是管理端保存保留期偶发 500「保留清理失败」的来源。
func TestR10F4T3ConcurrentRoundsStayBenign(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	for i := 1; i <= 6; i++ {
		m := bjMonth(i)
		if err := ensureUsagePartition(db, m); err != nil {
			t.Fatal(err)
		}
		if err := r10f4Insert(db, uid, "conc", BeijingDayAt(m, 10), 0.5); err != nil {
			t.Fatal(err)
		}
	}
	for round := 1; round <= 3; round++ {
		resetUsageRetentionStatusForTest()
		const lanes = 4
		var wg sync.WaitGroup
		errs := make([]error, lanes)
		for i := 0; i < lanes; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				errs[i] = CleanupUsageRetention(db)
			}(i)
		}
		wg.Wait()
		nonNil := 0
		for _, e := range errs {
			if e != nil {
				nonNil++
			}
		}
		st := CurrentUsageRetentionStatus()
		t.Logf("ROUND %d: lanes=%d nonNil=%d rounds=%d failed_rounds=%d failures=%d reasons=%v last_error=%q",
			round, lanes, nonNil, st.RoundNumber, st.FailedRounds, st.Failures, st.SkippedByReason, st.LastError)
		if nonNil > 0 {
			t.Errorf("ROUND %d: %d/%d 路返回非 nil（良性竞态必须走同一个出口）: %v", round, nonNil, lanes, errs)
		}
		if st.Failures != 0 || st.FailedRounds != 0 {
			t.Errorf("ROUND %d: 良性竞态不得计入失败: failures=%d failed_rounds=%d last_error=%q",
				round, st.Failures, st.FailedRounds, st.LastError)
		}
		// 恢复现场：把过期月分区重新建出来，下一轮可复现同一形态。
		for i := 1; i <= 6; i++ {
			_ = ensureUsagePartition(db, bjMonth(i))
		}
	}
}
