package serverstore

// R10-G3 泳道 · **服务端保留期：把"金额窗口关闭"的可用性代价收回来**
// （复审 temp/r10/verify-V2/REPORT.md §二 N1~N5 的判据）。
//
// 被审形态（HEAD 2c7088aabd，真 PG 实测）：
//
//	N1（P1）补账被搬进临界区（R10-D-01 关闭金额窗口的代价）⇒ `usage` 的
//	       ACCESS EXCLUSIVE 从 57ms 涨到 10.93/18.95/22.02s（2M 行月分区），
//	       期间**每一次**并发计量写入被挡同样长（errs=0：不是 503，是整段停顿）。
//	N2（P2）"20s 上界"是**每语句**上界，而补账吃到 94%（18866ms/20000ms）⇒
//	       再大一点必然超时，超时又被分类成"延后" ⇒ 该月**永久静默不回收**。
//	N3（P2）连续 N 轮"延后"在运维面零信号（skipped_by_reason 每轮被覆写、
//	       failed_rounds=0）⇒ "刚好有锁竞争"与"保留策略已停摆"逐字同形。
//	N4（P3）`ownerChanged := assertDetachedFromUsage(tx, rel) != nil` 把"复检
//	       自身报错"当成"归属已变"⇒ 真失败被当良性吞掉（failures=0 而关系仍是孤儿）。
//	N5（P3）`ensureUsagePartition` × 清理并发时的瞬时 `partition-bound-unreadable`
//	       （定性见 fix-G3/REPORT.md：**既有**，base f325817ae8 同样复现）。
//
// 本文件的判据（每条都能被打坏；变异实跑见 fix-G3/REPORT.md）：
//
//	G1 回收一个到期月分区时，父表 AEX 窗口必须保持**亚秒级**、并发计量写入
//	   不得被秒级阻塞（复审的量化口径，`R10G_ROWS` 可放大到 2M 行）。
//	G2 "延后"必须**有界**：同一关系连续 N 轮延后即升级为可见告警（/readyz 字段
//	    + 日志），且延后期间**不**进失败面（R10-A-03 的契约不被回退）。
//	G3 归属复检**自身报错**必须 fail-loud（与"归属已变 ⇒ 良性"分开）。
//	G4 冻结期间提交的行必须被结算段的聚合计入（金额守恒）—— 冻结点的确定性复现。
//	G5 结算段失败（DROP 被依赖对象挡住）时，金额必须**仍然可见**（预补账的判据）。
//	G6 结算段预算必须**随工作量推导**（N2①），而不是"每语句 20s"。
//
// 复跑（真 PG）：
//
//	docker exec pg-test psql -U postgres -c "CREATE DATABASE r10g3"
//	cd server && PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/r10g3 \
//	  go test ./internal/serverstore/ -run 'TestR10G' -count=1 -v -timeout 1800s
//	# 2M 行口径（与复审的量化探针同量级）：
//	R10G_ROWS=2000000 go test ./internal/serverstore/ -run 'TestR10G1' -count=1 -v -timeout 1800s

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// r10gRows 是 G1 的种子行数（缺省 2 万；量 AEX 时用 R10G_ROWS=2000000）。
func r10gRows() int {
	if v := os.Getenv("R10G_ROWS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 20_000
}

// r10gLeafBounds 返回某北京月的 [lo, hi) 瞬时（与产品口径同源）。
func r10gLeafBounds(m time.Time) (time.Time, time.Time) {
	return BeijingDayInstant(dayKey(m)), BeijingDayInstant(dayKey(m).AddDate(0, 1, 0))
}

// r10gSeedMonth 在**一条语句**里把 rows 行种子写进 m 月（月分区必须已存在）。
// created_at 落在该月内（第 1..28 天的 10:00 北京时间），因此它们一定被 DROP 带走。
func r10gSeedMonth(t *testing.T, db *sql.DB, uid int64, m time.Time, rows int, cost float64) {
	t.Helper()
	lo, _ := r10gLeafBounds(m)
	if _, err := db.Exec(`INSERT INTO usage (user_id, model, provider_id, prompt_tokens, completion_tokens,
        cache_prompt_tokens, kind, cost, created_at, estimated)
        SELECT $1, 'r10g-seed-' || (g % 7), 0, 10, 20, 0, 'chat', $2,
               $3::timestamptz + ((g % 28) * interval '1 day') + interval '10 hours', FALSE
        FROM generate_series(1, $4) AS g`, uid, cost, lo.UTC(), rows); err != nil {
		t.Fatalf("种子 %d 行进 %s: %v", rows, monthKey(m), err)
	}
}

// r10gIsolateMonths 只留下 keep 里的月关系，其余摘掉并删除 —— 让 AEX 窗口的归属
// 唯一（复审的量化探针同款隔离，否则观测到的第一个窗口可能是别的月）。
func r10gIsolateMonths(t *testing.T, db *sql.DB, keep ...string) {
	t.Helper()
	set := make(map[string]bool, len(keep))
	for _, rel := range keep {
		set[rel] = true
	}
	pre, err := scanUsageMonthTables(db)
	if err != nil {
		t.Fatal(err)
	}
	for _, rel := range append(append([]string{}, pre.Partitions...), pre.AttachedNonLeaf...) {
		if set[rel] {
			continue
		}
		if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + quoteRelationIdent(rel)); err != nil {
			t.Fatalf("摘 %s: %v", rel, err)
		}
		if _, err := db.Exec("DROP TABLE IF EXISTS " + quoteRelationIdent(rel)); err != nil {
			t.Fatalf("删 %s: %v", rel, err)
		}
	}
}

// r10gMeteringInsert 是一次**生产口径**的计量写入（`INSERT INTO usage`，created_at
// = now ⇒ 路由到当月分区）。它必须**不**被"回收一个到期月"挡住（N1 的判据）。
func r10gMeteringInsert(db *sql.DB, uid int64) error {
	_, err := db.Exec(`INSERT INTO usage (user_id, model, provider_id, prompt_tokens, completion_tokens,
        cache_prompt_tokens, kind, cost, created_at, estimated) VALUES ($1,'r10g-live',0,10,20,0,'chat',0.5,now(),false)`, uid)
	return err
}

// TestR10G1ReclaimDoesNotBlockMetering 是 N1 的**量化判据**（复审的口径）：
//
//	① `usage` 的 ACCESS EXCLUSIVE 窗口 = 亚秒级（冻结段只做 DETACH+DROP 级的 DDL，
//	   补账在**只锁 rel** 的结算段里）；
//	② 期间并发计量写入（created_at=now）的最长单次耗时不得被秒级阻塞；
//	③ 回收本身仍然成功（cleared_partitions=1、failures=0）。
//
// 对照（复审实测）：修复前 AEX = 10.93/18.95/22.02s，并发写入最长耗时与窗口逐字相等。
func TestR10G1ReclaimDoesNotBlockMetering(t *testing.T) {
	rows := r10gRows()
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
	nowMonth := BeijingMonth(time.Now())
	rel := "usage_" + monthKey(expired)
	if err := ensureUsagePartition(db, nowMonth); err != nil {
		t.Fatalf("建当月分区: %v", err)
	}
	if err := ensureUsagePartition(db, expired); err != nil {
		t.Fatalf("建到期月分区: %v", err)
	}
	r10gIsolateMonths(t, db, rel, "usage_"+monthKey(nowMonth))

	seedStart := time.Now()
	r10gSeedMonth(t, db, uid, expired, rows, 0.25)
	t.Logf("seed rows=%d elapsed=%s", rows, time.Since(seedStart).Round(time.Millisecond))

	// 观测连接（pg_locks 轮询）与写入者各占一条；池上限 2 是够的（清理自己再占一条）。
	obs, err := sql.Open("pgx", r10f4DSNFor(r10gCurDB(t, db)))
	if err != nil {
		t.Fatal(err)
	}
	defer obs.Close()
	obs.SetMaxOpenConns(2)

	// 计量写入者：稳态里持续写当月，记录**最长**单次 INSERT 耗时。
	stop := make(chan struct{})
	var wg sync.WaitGroup
	var writes, writeErrs, maxLat int64
	var firstErr atomic.Value
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			start := time.Now()
			werr := r10gMeteringInsert(db, uid)
			lat := int64(time.Since(start))
			atomic.AddInt64(&writes, 1)
			if werr != nil {
				atomic.AddInt64(&writeErrs, 1)
				firstErr.CompareAndSwap(nil, werr.Error())
			}
			for {
				cur := atomic.LoadInt64(&maxLat)
				if lat <= cur || atomic.CompareAndSwapInt64(&maxLat, cur, lat) {
					break
				}
			}
			time.Sleep(time.Millisecond)
		}
	}()
	time.Sleep(300 * time.Millisecond)

	// 观测者：轮询 `usage`（父表）的 AccessExclusiveLock 是否 granted，记录所有窗口。
	holdCh := make(chan []time.Duration, 1)
	stopObs := make(chan struct{})
	go func() {
		var wins []time.Duration
		var started time.Time
		deadline := time.Now().Add(10 * time.Minute)
		for time.Now().Before(deadline) {
			select {
			case <-stopObs:
				if !started.IsZero() {
					wins = append(wins, time.Since(started))
				}
				holdCh <- wins
				return
			default:
			}
			var held bool
			qerr := obs.QueryRow(`SELECT COALESCE(bool_or(l.mode='AccessExclusiveLock' AND l.granted),false)
                FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE c.relname='usage' AND n.nspname='public'`).Scan(&held)
			if qerr != nil {
				time.Sleep(2 * time.Millisecond)
				continue
			}
			if held && started.IsZero() {
				started = time.Now()
			} else if !held && !started.IsZero() {
				wins = append(wins, time.Since(started))
				started = time.Time{}
			}
			time.Sleep(2 * time.Millisecond)
		}
		holdCh <- wins
	}()

	roundStart := time.Now()
	cerr := CleanupUsageRetention(db)
	roundElapsed := time.Since(roundStart)
	close(stop)
	wg.Wait()
	close(stopObs)
	wins := <-holdCh
	st := CurrentUsageRetentionStatus()
	var maxHeld, totalHeld time.Duration
	for _, w := range wins {
		totalHeld += w
		if w > maxHeld {
			maxHeld = w
		}
	}
	t.Logf("ROUND: err=%v elapsed=%s cleared=%d failures=%d skipped=%d reasons=%v",
		cerr, roundElapsed.Round(time.Millisecond), st.ClearedPartitions, st.Failures, st.Skipped, st.SkippedByReason)
	t.Logf("AEX(usage) windows=%d max=%s total=%s（pg_locks 实测）",
		len(wins), maxHeld.Round(time.Millisecond), totalHeld.Round(time.Millisecond))
	t.Logf("metering writes=%d errs=%d max_insert_latency=%s firstErr=%v",
		atomic.LoadInt64(&writes), atomic.LoadInt64(&writeErrs),
		time.Duration(atomic.LoadInt64(&maxLat)).Round(time.Millisecond), firstErr.Load())

	if cerr != nil {
		t.Fatalf("回收不得失败: %v", cerr)
	}
	if st.ClearedPartitions != 1 || st.Failures != 0 {
		t.Fatalf("到期月分区必须被回收且不计失败: cleared=%d failures=%d reasons=%v",
			st.ClearedPartitions, st.Failures, st.SkippedByReason)
	}
	if r9aRelationExists(t, db, rel) {
		t.Fatalf("到期月分区 %s 仍在盘上", rel)
	}
	// ① 父表 AEX 窗口**不得是整轮的主导项**（判据与危害同构，且对机器负载自适应）：
	//    目标量级 ≤100ms；判据给"≤1s 或 ≤整轮/4"两条之一即通过 —— 因为窗口内容只剩
	//    冻结段的几次本地往返 + DETACH + **COMMIT 的 WAL flush**，在 IO 饱和的机器上
	//    这一条可以到亚秒级（本泳道实测：同一份代码 6ms/12ms/13ms/67ms/1.009s，
	//    对应整轮 13s/18s/32s/4.2s/27.9s）。
	//    改前形态则必然为红：AEX 9.0–13.8s vs 整轮 9.1–14.2s（占比 ≈99%，且补账
	//    的工作量全在里面）。
	if maxHeld > time.Second && maxHeld > roundElapsed/4 {
		t.Errorf("回收期间 usage 的 ACCESS EXCLUSIVE 窗口 %s 占了整轮 %s 的 %d%% —— "+
			"补账又回到父表锁里了（N1：窗口必须只由 DDL+提交决定，不随行数增长）",
			maxHeld.Round(time.Millisecond), roundElapsed.Round(time.Millisecond), int(100*maxHeld/roundElapsed))
	}
	// ② 并发计量写入不得被"回收的父表锁"挡住：改前的签名是
	//    `max_insert_latency == AEX 窗口`（9.014/14.083/13.547s 逐字相等）；判据取
	//    绝对上界 5s（改前 9–14s ⇒ 必红）—— 低于它的部分在共享机器上主要是 IO
	//    （本泳道实测 0.32–2.40s，且**不**等于窗口）。
	maxInsert := time.Duration(atomic.LoadInt64(&maxLat))
	if maxInsert > 5*time.Second {
		t.Errorf("并发计量写入被挡了 %s（>5s）—— 到期月回收不得阻塞当月计量写入（N1：改前 9.0–14.1s）",
			maxInsert.Round(time.Millisecond))
	}
	if atomic.LoadInt64(&writeErrs) != 0 {
		t.Errorf("并发计量写入必须全部成功（N1 的实测形态是 errs=0 + 整段停顿）: errs=%d firstErr=%v",
			atomic.LoadInt64(&writeErrs), firstErr.Load())
	}
}

// r10gCurDB 返回当前测试库名（阻塞源/观测连接必须连到同一个库）。
func r10gCurDB(t *testing.T, db *sql.DB) string {
	t.Helper()
	var cur string
	if err := db.QueryRow("SELECT current_database()").Scan(&cur); err != nil {
		t.Fatal(err)
	}
	return cur
}

// TestR10G2DeferralIsBoundedAndVisible 是 N2② + N3 的判据（R10-H3 按 W3-4 修订）：
//
//	① 延后期间**不进失败面**（err=nil / failures=0 / failed_rounds=0 / last_error=""）
//	   —— R10-A-03 的契约不能被回退（管理端保存保留期不得因此 500）；
//	② 但延后必须**累积可见**：deferred_streak / deferred_relations /
//	   last_deferred_at / oldest_unreclaimed_* 逐轮推进；
//	③ **计入 streak 的是调度轮次**（W3-4）：管理端保存保留期会同步多跑一轮
//	   （llmgateway/admin.go），分钟级连点不得把 streak 推过阈值 —— 否则
//	   `deferred_stalled=true` 是分钟级假告警，而它的语义是"≈30h 的真实停摆"；
//	④ 按**调度节奏**（6h/轮）连续 usageRetentionDeferredStallRounds 轮之后必须升级：
//	   deferred_stalled=true + stalled_relations 点名（"永久静默不回收"的告警面）；
//	⑤ 阻塞解除后必须自愈：关系被回收、streak 归零、deferred_stalled 回落，
//	   而 deferred_stalled_rounds（累计轮数）保留；
//	⑥ 这些字段必须真的进**机器可读面**（/readyz 就是把 UsageRetentionStatus 整个
//	   marshal 进 usage_retention 字段，见 cmd/server/usage_retention_readyz.go）。
func TestR10G2DeferralIsBoundedAndVisible(t *testing.T) {
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
	rel := "usage_" + monthKey(expired)
	if err := ensureUsagePartition(db, expired); err != nil {
		t.Fatal(err)
	}
	r10gSeedMonth(t, db, uid, expired, 5, 0.5)

	blocker, err := sql.Open("pgx", r10f4DSNFor(r10gCurDB(t, db)))
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Close()
	btx, err := blocker.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := btx.Exec("LOCK TABLE ONLY usage IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}

	resetUsageRetentionStatusForTest()
	// ---- ③ 管理端"连点保存"形态：同一进程内连续 N 轮（分钟级），只能把 streak 记到 1 ----
	for round := 1; round <= usageRetentionDeferredStallRounds+1; round++ {
		start := time.Now()
		cerr := CleanupUsageRetention(db)
		st := CurrentUsageRetentionStatus()
		t.Logf("RAPID ROUND %d: err=%v elapsed=%s streak=%v max_streak=%d stalled=%v oldest=%s/%d reasons=%v",
			round, cerr, time.Since(start).Round(time.Millisecond), st.DeferredStreak, st.MaxDeferredStreak,
			st.DeferredStalled, st.OldestUnreclaimedMonth, st.OldestUnreclaimedRounds, st.SkippedByReason)

		// ① 延后不是失败（R10-A-03 的契约）。
		if cerr != nil || st.Failures != 0 || st.FailedRounds != 0 || st.LastError != "" {
			t.Fatalf("rapid round %d: 等锁超时必须走「延后」而不是失败: err=%v failures=%d failed_rounds=%d last_error=%q",
				round, cerr, st.Failures, st.FailedRounds, st.LastError)
		}
		// ② 累积可见（本轮延后的关系 + 最近延后时刻）。
		if len(st.DeferredRelations) == 0 || st.LastDeferredAt == "" {
			t.Errorf("rapid round %d: 必须给出本轮延后的关系与最近延后时刻: deferred_relations=%v last_deferred_at=%q",
				round, st.DeferredRelations, st.LastDeferredAt)
		}
		// ③ 分钟级连点**不得**推进 streak（W3-4）：这正是"连点 5 次保存即假告警"的形态。
		if st.DeferredStreak[rel] != 1 {
			t.Errorf("rapid round %d: deferred_streak[%s] = %d，want 1 —— "+
				"管理端保存触发的即时轮次不得计入 streak（W3-4：否则连点 %d 次保存就是一次假停摆）",
				round, rel, st.DeferredStreak[rel], usageRetentionDeferredStallRounds)
		}
		if st.DeferredStalled {
			t.Fatalf("rapid round %d: 分钟级连点把 deferred_stalled 推成 true（假告警）: streak=%v", round, st.DeferredStreak)
		}
	}
	// ③ 的补充：真实停摆仍然可判 —— 单调的 oldest_unreclaimed_*（W3-3）在连点下也逐轮推进。
	st := CurrentUsageRetentionStatus()
	if st.OldestUnreclaimedMonth == "" || st.OldestUnreclaimedRounds < int64(usageRetentionDeferredStallRounds) {
		t.Errorf("连点轮次下 oldest_unreclaimed_* 必须仍然逐轮推进（它是「长期没回收」的权威判据）: %q/%d",
			st.OldestUnreclaimedMonth, st.OldestUnreclaimedRounds)
	}

	// ---- ④ 调度节奏（6h/轮）：同一个记账点、同样的事实，按调度间隔推进 ⇒ 必须升级 ----
	// 时间维度无法在用例里真实等待（阈值 ≈30h），所以这里驱动**唯一记账点**
	// recordUsageRetentionRound —— 本轮的过程事实取自上面**真实**跑出来的那一轮
	// （DeferredRelations / Unreclaimed / Relations 都来自生产路径），只把 EndedAt
	// 按 6h 步进。这样判据钉住的是"跨调度轮次计数"，而不是"我们等 30 小时"。
	resetUsageRetentionStatusForTest()
	real := usageRetentionRound{
		EndedAt:           time.Now(),
		Scanned:           true,
		ConfiguredMonths:  2,
		Relations:         6,
		Skipped:           6,
		SkippedByReason:   map[string]int{usageSkipLockTimeout: 6},
		Unreclaimed:       []string{rel + "(" + usageSkipLockTimeout + ")"},
		DeferredRelations: []string{rel},
	}
	recordUsageRetentionRound(real, nil)
	for round := 2; round <= usageRetentionDeferredStallRounds; round++ {
		scheduled := real
		scheduled.EndedAt = real.EndedAt.Add(time.Duration(round-1) * 6 * time.Hour)
		recordUsageRetentionRound(scheduled, nil)
		st := CurrentUsageRetentionStatus()
		t.Logf("SCHEDULED ROUND %d: streak=%v max=%d stalled=%v stalled_rels=%v stalled_rounds=%d",
			round, st.DeferredStreak, st.MaxDeferredStreak, st.DeferredStalled, st.StalledRelations, st.DeferredStalledRounds)
		if st.DeferredStreak[rel] != round {
			t.Errorf("scheduled round %d: deferred_streak[%s] = %d，want %d（6h 调度轮必须逐轮计入；"+
				"管理端即时轮次不计入不得把这条真实停摆路径一起关掉）", round, rel, st.DeferredStreak[rel], round)
		}
		if want := round >= usageRetentionDeferredStallRounds; st.DeferredStalled != want {
			t.Errorf("scheduled round %d: deferred_stalled = %v，want %v（阈值 %d 个调度轮次）",
				round, st.DeferredStalled, want, usageRetentionDeferredStallRounds)
		}
		if round >= usageRetentionDeferredStallRounds {
			if !containsRel(st.StalledRelations, rel) {
				t.Errorf("scheduled round %d: stalled_relations 必须点名 %s，实得 %v", round, rel, st.StalledRelations)
			}
			if st.DeferredStalledRounds == 0 {
				t.Errorf("scheduled round %d: deferred_stalled_rounds 必须累计（它是「停摆轮数」的计数面）", round)
			}
		}
	}

	// ⑥ 机器可读面：/readyz 的 usage_retention 就是这个结构体的 JSON。
	raw, jerr := json.Marshal(CurrentUsageRetentionStatus())
	if jerr != nil {
		t.Fatal(jerr)
	}
	for _, key := range []string{
		`"deferred_stalled":true`, `"stalled_relations"`, `"deferred_streak"`,
		`"max_deferred_streak"`, `"deferred_relations"`, `"last_deferred_at"`, `"deferred_stalled_rounds"`,
		`"oldest_unreclaimed_month"`, `"oldest_unreclaimed_rounds"`, `"oldest_unreclaimed_since"`,
	} {
		if !strings.Contains(string(raw), key) {
			t.Errorf("/readyz.usage_retention 缺少可机器读的字段 %s：%s", key, raw)
		}
	}
	t.Logf("readyz JSON: %s", raw)

	// ---- ⑤ 解除阻塞后自愈（回到真实清理路径）----
	if err := btx.Rollback(); err != nil {
		t.Fatal(err)
	}
	stalledRounds := CurrentUsageRetentionStatus().DeferredStalledRounds
	cerr := CleanupUsageRetention(db)
	st2 := CurrentUsageRetentionStatus()
	t.Logf("RECOVERY: err=%v cleared=%d failures=%d streak=%v stalled=%v stalled_rounds=%d oldest=%q",
		cerr, st2.ClearedPartitions, st2.Failures, st2.DeferredStreak, st2.DeferredStalled,
		st2.DeferredStalledRounds, st2.OldestUnreclaimedMonth)
	if cerr != nil || st2.Failures != 0 {
		t.Fatalf("阻塞解除后必须自愈: err=%v failures=%d reasons=%v", cerr, st2.Failures, st2.SkippedByReason)
	}
	if r9aRelationExists(t, db, rel) {
		t.Fatalf("阻塞解除后到期关系 %s 仍未被回收", rel)
	}
	if st2.DeferredStalled || st2.MaxDeferredStreak != 0 {
		t.Errorf("自愈之后 streak/stalled 必须回落（否则告警永不收敛）: stalled=%v max_streak=%d streak=%v",
			st2.DeferredStalled, st2.MaxDeferredStreak, st2.DeferredStreak)
	}
	if st2.OldestUnreclaimedMonth != "" {
		t.Errorf("该月被回收之后 oldest_unreclaimed_month 必须清空（它只在真的还有未回收月时保留）: %q", st2.OldestUnreclaimedMonth)
	}
	if st2.DeferredStalledRounds < stalledRounds {
		t.Errorf("deferred_stalled_rounds 不得回退（它是累计计数）: %d -> %d", stalledRounds, st2.DeferredStalledRounds)
	}
}

// containsRel 报告清单里是否含该关系（"名字+原因"与裸名字两种形态都认）。
func containsRel(list []string, rel string) bool {
	for _, item := range list {
		if item == rel || strings.HasPrefix(item, rel+"(") {
			return true
		}
	}
	return false
}

// TestR10G3OwnershipProbeErrorIsFailLoud 是 N4 的判据（确定性故障注入）。
//
// 注入形态与复审的 `owner_check_error_in_tx` 变异一致：只让**事务句柄**上的归属
// 复检报错（池上的前置复检照常）。注入之后：
//
//	① 整轮必须 fail-loud（err != nil / failures>=1 / failed_relations 点名）——
//	   旧实现把它当成"归属已变 ⇒ 良性 deferred"，整轮 err=nil/failures=0，
//	   日志还断言"它已回到 usage 分区树里"（与事实相反）；
//	② 关系必须原样留着（fail-loud 不得顺手 DROP）；
//	③ 金额必须仍然可见：预补账已经把它写进永久账本（N1 的保险丝），
//	   报表口径（UsageAggregateWithLedger）不得因为这条关系没能回收而少计。
func TestR10G3OwnershipProbeErrorIsFailLoud(t *testing.T) {
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
	rel := "usage_" + monthKey(expired)
	// 表形态孤儿（不在 usage 分区树里）⇒ 走孤儿路径的持锁复检。
	if _, err := db.Exec("DROP TABLE IF EXISTS public." + quoteRelationIdent(rel)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE public." + quoteRelationIdent(rel) + " (LIKE usage INCLUDING DEFAULTS)"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO `+quoteRelationIdent(rel)+` (id, user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
        VALUES (990101, $1, 'r10g-n4', 10, 10, 'chat', 4.25, $2, FALSE)`, uid, BeijingDayAt(expired, 10)); err != nil {
		t.Fatal(err)
	}

	// 故障注入：只让事务句柄上的复检报错（池上的前置复检不受影响）。
	usageOwnershipProbeHook = func(q usageQuerier, gotRel string) error {
		if gotRel != rel {
			return nil
		}
		if _, isTx := q.(*sql.Tx); isTx {
			return fmt.Errorf("R10-G3 故障注入：事务内的 catalog 读失败")
		}
		return nil
	}
	t.Cleanup(func() { usageOwnershipProbeHook = nil })

	resetUsageRetentionStatusForTest()
	cerr := CleanupUsageRetention(db)
	st := CurrentUsageRetentionStatus()
	stillThere := r9aRelationExists(t, db, rel)
	t.Logf("round err=%v failures=%d failed_relations=%v skipped=%d reasons=%v relationStillExists=%v",
		cerr, st.Failures, st.FailedRelations, st.Skipped, st.SkippedByReason, stillThere)
	t.Logf("last_error=%q", st.LastError)

	// ①②
	if cerr == nil || st.Failures == 0 {
		t.Errorf("归属复检**自身报错**必须 fail-loud（旧实现当良性吞掉）: err=%v failures=%d last_error=%q",
			cerr, st.Failures, st.LastError)
	}
	if !containsRel(st.FailedRelations, rel) {
		t.Errorf("失败关系必须进机器可读面 failed_relations: %v", st.FailedRelations)
	}
	if !stillThere {
		t.Errorf("fail-loud 之后关系必须原样留着（不得顺手 DROP）: %s 已消失", rel)
	}
	// ③ 预补账的保险丝：报表口径仍然看得到这笔钱。
	want := 4.25
	if got := r6SumCost(t, db, dayKey(expired), dayKey(expired).AddDate(0, 1, -1)); got < want-1e-9 {
		t.Errorf("结算段失败时金额必须仍然可见（预补账）: 报表口径 = %.4f，want >= %.4f", got, want)
	}

	// 注入撤掉之后必须自愈（fail-loud 只延后一轮）。
	usageOwnershipProbeHook = nil
	cerr2 := CleanupUsageRetention(db)
	st2 := CurrentUsageRetentionStatus()
	t.Logf("RECOVERY: err=%v failures=%d cleared_detached=%d relationStillExists=%v",
		cerr2, st2.Failures, st2.ClearedDetached, r9aRelationExists(t, db, rel))
	if cerr2 != nil || st2.Failures != 0 {
		t.Fatalf("注入撤掉后必须自愈: err=%v failures=%d", cerr2, st2.Failures)
	}
	if r9aRelationExists(t, db, rel) {
		t.Errorf("自愈轮未回收孤儿 %s", rel)
	}
	if got := r6SumCost(t, db, dayKey(expired), dayKey(expired).AddDate(0, 1, -1)); got < want-1e-9 {
		t.Errorf("回收之后金额必须仍在（账本）：报表口径 = %.4f，want >= %.4f", got, want)
	}
}

// TestR10G4RowCommittedDuringFreezeIsLedgered 是"冻结点"的**确定性**复现：
//
// 交错：另一条连接先 `BEGIN; INSERT INTO usage(…, created_at=到期月)`（这行**未提交**，
// 但已经按元组路由拿到 rel 的 RowExclusive）⇒ 清理的冻结段卡在 `LOCK rel AEX` 上。
// 此刻提交那一行，清理继续：DETACH → 结算段聚合（`usage ∪ rel`）→ DROP。
//
// 判据：① 冻结期间提交的行必须被账本/报表覆盖（金额守恒，一格不差）；
//
//	② 回收成功（cleared_partitions=1、failures=0）；
//	③ 这行**不能**出现"插进已摘表、随后被 DROP 删掉"的形态（那正是把补账
//	   移出临界区会重新打开的窗口）。
func TestR10G4RowCommittedDuringFreezeIsLedgered(t *testing.T) {
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
	rel := "usage_" + monthKey(expired)
	if err := ensureUsagePartition(db, expired); err != nil {
		t.Fatal(err)
	}
	// 只留"到期月 + 当月"：腾出的 AEX 窗口/回收条数才是这条判据的（否则模板库里
	// 更早的月分区会被一起回收，cleared_partitions 不是 1）。
	r10gIsolateMonths(t, db, rel, "usage_"+monthKey(BeijingMonth(time.Now())))
	const seedCost = 0.25
	const lateCost = 7.0
	r10gSeedMonth(t, db, uid, expired, 40, seedCost)

	writer, err := sql.Open("pgx", r10f4DSNFor(r10gCurDB(t, db)))
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	if _, err := writer.Exec("SET statement_timeout = 0"); err != nil {
		t.Fatal(err)
	}
	wtx, err := writer.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wtx.Exec(`INSERT INTO usage (user_id, model, provider_id, prompt_tokens, completion_tokens,
        cache_prompt_tokens, kind, cost, created_at, estimated) VALUES ($1,'r10g-late',0,10,20,0,'chat',$2,$3,false)`,
		uid, lateCost, BeijingDayAt(expired, 10).UTC()); err != nil {
		t.Fatalf("未提交行必须能插进到期月分区（夹具前提）: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- CleanupUsageRetention(db) }()

	// 等到清理真的卡在 rel 的锁上（catalog + pg_locks，不看返回值）。
	waitForLockWait(t, db, 20*time.Second)
	var stillAttached bool
	if err := db.QueryRow(`SELECT COALESCE(c.relispartition AND pg_partition_root(c.oid)=to_regclass('public.usage'), false)
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname=$1 AND n.nspname='public'`, rel).Scan(&stillAttached); err != nil {
		t.Fatal(err)
	}
	t.Logf("清理卡在冻结段时：%s 仍挂在 usage 下 = %v", rel, stillAttached)
	if !stillAttached {
		t.Fatalf("夹具前提不成立：清理还没拿到 rel 的锁，关系就已不在 usage 树下")
	}

	if err := wtx.Commit(); err != nil {
		t.Fatalf("提交冻结期间的行: %v", err)
	}
	select {
	case cerr := <-done:
		t.Logf("round err=%v", cerr)
		if cerr != nil {
			t.Fatalf("回收不得失败: %v", cerr)
		}
	case <-time.After(120 * time.Second):
		t.Fatal("提交之后清理仍未返回（有界语义失效）")
	}
	st := CurrentUsageRetentionStatus()
	want := 40*seedCost + lateCost
	got := r6SumCost(t, db, dayKey(expired), dayKey(expired).AddDate(0, 1, -1))
	ledgerRows, ledgerCost := r6LedgerStats(t, db, expired)
	t.Logf("cleared=%d failures=%d；报表口径=%.4f 账本(%d 行)=%.4f；want=%.4f",
		st.ClearedPartitions, st.Failures, got, ledgerRows, ledgerCost, want)
	if st.ClearedPartitions != 1 || st.Failures != 0 {
		t.Fatalf("到期分区必须被回收且不计失败: cleared=%d failures=%d reasons=%v",
			st.ClearedPartitions, st.Failures, st.SkippedByReason)
	}
	if r9aRelationExists(t, db, rel) {
		t.Fatalf("到期分区 %s 仍在盘上", rel)
	}
	if got < want-1e-9 {
		t.Errorf("冻结期间提交的行丢了：报表口径 = %.4f，want %.4f（金额窗口被重新打开）", got, want)
	}
	if ledgerCost < want-1e-9 {
		t.Errorf("永久账本没有覆盖冻结期间提交的行：账本 = %.4f，want %.4f", ledgerCost, want)
	}
}

// waitForLockWait 等一个"正在等 relation 锁"的后端出现（清理卡在冻结段的判据；
// 纯观测，不看返回值）。
func waitForLockWait(t *testing.T, db *sql.DB, budget time.Duration) {
	t.Helper()
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		var n int
		if err := db.QueryRow(`SELECT count(*) FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock' AND query LIKE '%LOCK TABLE%'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n > 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%s 内没有观测到「清理卡在等锁上」的后端（夹具前提不成立）", budget)
}

// TestR10G5SettleFailureKeepsMoneyVisible 是 N1 的**失败面判据**（预补账为什么必须存在）：
//
// 让结算段的 `DROP` 必然失败（分区上挂一个依赖视图 ⇒ 2BP01）。R10-G3 之后
// "摘下来"（DETACH，冻结段）与"补账+DROP"（结算段）不在同一个事务里，所以失败时
// 关系会留成**孤儿**（旧实现会整体回滚、关系仍挂在 usage 下）—— 这时候如果账本
// 还是旧的，那个月的金额就会**从所有读数面上消失**（明细已被摘走、账本没补）。
//
// 判据：
//
//	① 这一轮仍然 fail-loud（failures>=1、failed_relations 点名、err != nil）；
//	② 但**报表口径必须仍然看得到这笔钱**（预补账已提交）；
//	③ 依赖对象撤掉后自愈回收，金额不变。
func TestR10G5SettleFailureKeepsMoneyVisible(t *testing.T) {
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
	rel := "usage_" + monthKey(expired)
	if err := ensureUsagePartition(db, expired); err != nil {
		t.Fatal(err)
	}
	const cost = 3.75
	r10gSeedMonth(t, db, uid, expired, 7, cost)
	want := 7 * cost
	// 依赖对象：DROP TABLE 会因它报 2BP01（真失败，不是超时、也不是良性竞态）。
	if _, err := db.Exec("CREATE VIEW r10g_dep_view AS SELECT id FROM " + quoteRelationIdent(rel)); err != nil {
		t.Fatalf("建依赖视图: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP VIEW IF EXISTS r10g_dep_view") })

	resetUsageRetentionStatusForTest()
	cerr := CleanupUsageRetention(db)
	st := CurrentUsageRetentionStatus()
	afterFail := r6SumCost(t, db, dayKey(expired), dayKey(expired).AddDate(0, 1, -1))
	t.Logf("round err=%v failures=%d failed_relations=%v；报表口径=%.4f want=%.4f",
		cerr, st.Failures, st.FailedRelations, afterFail, want)
	if cerr == nil || st.Failures == 0 {
		t.Fatalf("DROP 被依赖对象挡住必须 fail-loud: err=%v failures=%d", cerr, st.Failures)
	}
	if !containsRel(st.FailedRelations, rel) {
		t.Errorf("失败关系必须进机器可读面: %v", st.FailedRelations)
	}
	// ② 这一条是关键：关系已经被摘下来了（明细不再被 usage 聚合读到），
	// 报表只能靠账本 —— 账本必须已经有数（预补账）。
	if afterFail < want-1e-9 {
		t.Errorf("结算段失败之后金额从读数面上消失了：报表口径 = %.4f，want %.4f"+
			"（N1 的保险丝：预补账必须在冻结之前把金额落进账本）", afterFail, want)
	}

	if _, err := db.Exec("DROP VIEW IF EXISTS r10g_dep_view"); err != nil {
		t.Fatal(err)
	}
	resetUsageRetentionStatusForTest()
	if cerr2 := CleanupUsageRetention(db); cerr2 != nil {
		t.Fatalf("依赖对象撤掉后必须自愈: %v", cerr2)
	}
	if r9aRelationExists(t, db, rel) {
		t.Errorf("自愈轮未回收 %s", rel)
	}
	if got := r6SumCost(t, db, dayKey(expired), dayKey(expired).AddDate(0, 1, -1)); got < want-1e-9 {
		t.Errorf("回收之后金额必须仍在: 报表口径 = %.4f，want %.4f", got, want)
	}
}

// TestR10G6SettleBudgetIsWorkloadDerived 是 N2① 的判据：预算必须**随工作量推导**
// （而不是"每语句 20s"——复审实测 2M 行的补账吃到 20s 预算的 94%，再大一点就必然
// 超时，而超时被分类成"延后" ⇒ 永久静默不回收）。
func TestR10G6SettleBudgetIsWorkloadDerived(t *testing.T) {
	cases := []struct {
		rows int64
		want int
	}{
		{0, usageReclaimSettleFloorMS},
		{-1, usageReclaimSettleFloorMS},
		{100, usageReclaimSettleFloorMS}, // base 15s + 2ms ⇒ 吃下限
		{2_000_000, 15000 + 40_000},      // 复审的量化口径：2M 行 ⇒ 55s（重载实测 18.9s 的 2.9 倍）
		{100_000_000, usageReclaimSettleCeilMS},
	}
	for _, tc := range cases {
		if got := usageReclaimSettleBudgetMS(tc.rows); got != tc.want {
			t.Errorf("usageReclaimSettleBudgetMS(%d) = %d，want %d", tc.rows, got, tc.want)
		}
	}
	if usageReclaimSettleBudgetMS(2_000_000) <= usageReclaimStatementBudgetMS {
		t.Errorf("2M 行的结算段预算 %dms 不得小于等于旧的'每语句 20s'(%dms)：复审实测这条聚合要 18866ms，"+
			"预算不随工作量推导就必然把大月份判成永久延后（N2①）",
			usageReclaimSettleBudgetMS(2_000_000), usageReclaimStatementBudgetMS)
	}
	// 预算的输入必须**扛得住"没 ANALYZE 过的大表"**：reltuples 在"刚批量灌完数据、
	// 还没 ANALYZE"时是 -1/0（复审的 2M 行量化夹具正是这个形态，本泳道实测它让预算
	// 退回 30s 下限 ⇒ 3 轮里 2 轮 statement-timeout 延后）。所以第二个廉价估计
	// （pg_relation_size/每行字节）必须参与。
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if got := usageReclaimEstimatedRows(db, "usage_不存在的关系"); got != 0 {
		t.Errorf("读不到的关系必须估成 0 行，实得 %d", got)
	}
	if got := usageReclaimBudgetForRelation(db, "usage_不存在的关系"); got != usageReclaimSettleFloorMS {
		t.Errorf("估不出行数时必须回落下限 %d，实得 %d", usageReclaimSettleFloorMS, got)
	}
	m := bjMonth(3)
	rel := "usage_" + monthKey(m)
	if err := ensureUsagePartition(db, m); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	const rows = 60_000
	r10gSeedMonth(t, db, uid, m, rows, 0.5)
	var reltuples float64
	if err := db.QueryRow(`SELECT c.reltuples FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relname=$1 AND n.nspname='public'`, rel).Scan(&reltuples); err != nil {
		t.Fatal(err)
	}
	est := usageReclaimEstimatedRows(db, rel)
	t.Logf("未 ANALYZE 的表：reltuples=%.0f pg_relation_size 反推后估计=%d 行（实际写入 %d 行）", reltuples, est, rows)
	if reltuples > 0 {
		t.Logf("（本环境 PG 已自动 ANALYZE，跳过'reltuples 无效'的前置）")
	}
	if est <= 0 {
		t.Errorf("没 ANALYZE 的大表必须能**从表大小**反推行数（否则预算退回下限 ⇒ 大月份每轮超时）：est=%d", est)
	}
	if est < rows/4 {
		t.Errorf("反推的行数 %d 远小于实际 %d（低估会让预算偏窄 ⇒ 延后）", est, rows)
	}
	if est > rows*4 {
		t.Errorf("反推的行数 %d 远大于实际 %d（128 字节/行的估计失真）", est, rows)
	}
	// 非叶子（声明式分区父表**自身没有存储**：pg_relation_size=0）：估计必须按
	// pg_partition_tree 把叶子的字节求和，否则多级布局下又退回下限预算。
	// 用一个**空窗口**（2099 年）建多级夹具，避免与模板库里已有的月分区重叠。
	parent := "usage_2099"
	leaf := "usage_209901"
	lo := BeijingDayInstant(time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC))
	mid := BeijingDayInstant(time.Date(2099, 2, 1, 0, 0, 0, 0, time.UTC))
	hi := BeijingDayInstant(time.Date(2099, 3, 1, 0, 0, 0, 0, time.UTC))
	if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		quoteRelationIdent(parent), pgInstantArg(lo), pgInstantArg(hi))); err != nil {
		t.Fatalf("建中间父表 %s: %v", parent, err)
	}
	if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
		quoteRelationIdent(leaf), quoteRelationIdent(parent), pgInstantArg(lo), pgInstantArg(mid))); err != nil {
		t.Fatalf("建深层叶子 %s: %v", leaf, err)
	}
	if _, err := db.Exec(`INSERT INTO `+quoteRelationIdent(leaf)+` (user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
        VALUES ($1, 'r10g-budget', 10, 10, 'chat', 0.5, $2, FALSE)`, uid, BeijingDayAt(time.Date(2099, 1, 10, 0, 0, 0, 0, time.UTC), 10)); err != nil {
		t.Fatalf("往深层叶子写明细: %v", err)
	}
	var parentReltuples float64
	_ = db.QueryRow(`SELECT c.reltuples FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relname=$1 AND n.nspname='public'`, parent).Scan(&parentReltuples)
	parentEst := usageReclaimEstimatedRows(db, parent)
	t.Logf("非叶子 %s（自身无存储, reltuples=%.0f）：pg_partition_tree 求和后估计=%d 行", parent, parentReltuples, parentEst)
	if parentEst <= 0 {
		t.Errorf("非叶子关系的行数估计必须按叶子字节求和（否则多级布局下预算退回下限）: est=%d", parentEst)
	}
}
