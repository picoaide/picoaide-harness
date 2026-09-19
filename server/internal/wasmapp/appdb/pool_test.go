package appdb

// 本文件是 2026-09-19「多读者并发 + 单写者串行」改造的验收用例（WAL + 只读连接池 + 锁拆分）。
//
// 覆盖四件事：
//  1. 读**真的并发**（不是"多个 goroutine 排队"）——用**区间重叠**判定，不靠 CPU 并行度：
//     串行实现（老的 d.mu / 任何覆盖整条语句的互斥量）下，任意两条语句的 [start,end] 区间
//     不可能重叠；并发实现下，屏障后同时进入的 N 条语句区间必然重叠。这个判据在 1 核机器上
//     同样成立（goroutine 被时间片切碎只影响耗时，不影响区间）。
//  2. 读不被写挡住（慢写进行期间读能完成），而**写之间仍然串行**（区间不重叠）。
//  3. 事务内读走 rw（看得到未提交的写，且**不占**只读槽）。
//  4. 关连接排空在途读者（Close 必须等在途读者归还槽位，绝不 use-after-close）。
//
// 另加两条"每条连接都要在场"的门禁：WAL/busy_timeout 与 ATTACH 金丝雀对池里
// **每一条**只读连接逐个校验（只验第一条 = 给后面几条留默认 LIMIT_ATTACHED=10 的缺口）。

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// connInterval 是一条语句的墙钟区间（用于区间重叠判定）。
type connInterval struct {
	start time.Time
	end   time.Time
}

// overlaps 报告两个区间是否有交集。
func (a connInterval) overlaps(b connInterval) bool {
	return a.start.Before(b.end) && b.start.Before(a.end)
}

// slowTableRows 是"慢查询 / 慢写"用的行数：目标是把一次全表扫描压到**毫秒级**
// （-race 下几十毫秒），给区间重叠判定留出足够窗口，同时**远低于单语句 5 s 硬预算**
// ——这是硬约束：并发用例会同时跑 N 条这样的语句，-race + 共享机器上单条可能慢十倍，
// 行数取大了会先撞 statement_timeout（实测 10 万行在 -race 下会超 5 s）。
//
// 行宽约 50 B ⇒ 2.5 万行 ≈ 1.2 MB（远低于 100 MB 硬限）。
const slowTableRows = 25_000

// slowInsertChunk 是批量造数据时每条 INSERT 的行数。
//
// 用**字面量**而不是占位符：平台的 SQLITE_LIMIT_VARIABLE_NUMBER = 128，
// 一条 500 行的多值 INSERT 会有 1000 个参数，必然被引擎拒（这也是"批量造数据
// 不能走参数化"的原因）。500 行 ≈ 27 KB，仍在 SQLLimitSQLLength（64 KiB）以内。
const slowInsertChunk = 500

// newSlowDB 造一个带 slowTableRows 行的库（分块 INSERT，几十条语句）。
func newSlowDB(t *testing.T, appID string, readers int) *DB {
	t.Helper()
	d := newTestDBWithReaders(t, appID, readers)
	defineTable(t, d, "bench_items", col("n", "int"), col("pad", "text"))
	ctx := context.Background()
	var b strings.Builder
	for i := 0; i < slowTableRows; {
		b.Reset()
		b.WriteString("INSERT INTO bench_items(n, pad) VALUES ")
		for j := 0; j < slowInsertChunk && i < slowTableRows; j, i = j+1, i+1 {
			if j > 0 {
				b.WriteString(",")
			}
			fmt.Fprintf(&b, "(%d,'row-%06d-padpadpadpadpadpadpadpadpad')", i, i)
		}
		if _, err := d.Exec(ctx, abi.SQLParams{SQL: b.String()}); err != nil {
			t.Fatalf("批量插入（第 %d 行起）失败：%v", i, err)
		}
	}
	return d
}

// ===== 1. 读并发 =====

// TestQueriesRunConcurrently 断言 N 个并发 Query **真的同时在跑**：
//
//	(a) 区间最大重叠数 ≥ 2（串行实现下恒为 1）；
//	(b) 并发墙钟 < 串行墙钟（N 次顺序执行的耗时），即确实有加速；
//	(c) 池内连接数 == 1 + readers（读连接池真的建满了）。
//
// 变异方式：把 withReadConn 的快路径去掉（读也走 writeMu 串行）⇒ (a)(b) 变红。
func TestQueriesRunConcurrently(t *testing.T) {
	const readers = 4
	d := newSlowDB(t, "concurrent-app", readers)
	ctx := context.Background()
	q := abi.SQLParams{SQL: "SELECT count(*) FROM bench_items WHERE pad LIKE '%0000%'"}
	run := func() (connInterval, error) {
		iv := connInterval{start: time.Now()}
		_, err := d.Query(ctx, q)
		iv.end = time.Now()
		return iv, err
	}

	// 串行基线：同样的查询顺序跑 N 次。
	var serial time.Duration
	for i := 0; i < readers; i++ {
		iv, err := run()
		if err != nil {
			t.Fatalf("串行基线第 %d 次查询失败：%v", i+1, err)
		}
		serial += iv.end.Sub(iv.start)
	}

	// 并发：屏障后同时进入（goroutine 先起好、等 start 关闭）。
	start := make(chan struct{})
	intervals := make([]connInterval, readers)
	errs := make([]error, readers)
	var wg sync.WaitGroup
	for i := 0; i < readers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			intervals[i], errs[i] = run()
		}(i)
	}
	close(start)
	wallStart := time.Now()
	wg.Wait()
	wall := time.Since(wallStart)

	for i, err := range errs {
		if err != nil {
			t.Fatalf("并发第 %d 个查询失败：%v", i+1, err)
		}
	}
	overlap := maxOverlap(intervals)
	t.Logf("串行 %v（%d 次）/ 并发墙钟 %v（加速 %.2fx）/ 最大同时在跑 %d / 单次约 %v",
		serial, readers, wall, float64(serial)/float64(wall), overlap, serial/time.Duration(readers))

	if overlap < 2 {
		t.Fatalf("并发读没有真的重叠（最大同时在跑 %d）：读路径仍然被串行化了", overlap)
	}
	if overlap != readers {
		// 不是硬失败（调度抖动可能让某一条晚一步进入），但要看见。
		t.Logf("注意：屏障后同时在跑 %d 条（期望 %d），>= 2 即视为并发成立", overlap, readers)
	}
	if wall >= serial {
		t.Fatalf("并发墙钟 %v 未优于串行 %v：读没有真正并发（每次查询 %v）", wall, serial, serial/time.Duration(readers))
	}
	if got := d.sqlDB.Stats().OpenConnections; got != 1+readers {
		t.Fatalf("池内连接数应为 1+%d=%d，实际 %d", readers, 1+readers, got)
	}
}

// maxOverlap 返回一组区间里"同时存在"的最大条数（扫描线；同刻先算 +1）。
func maxOverlap(ivs []connInterval) int {
	type point struct {
		at    time.Time
		delta int
	}
	points := make([]point, 0, len(ivs)*2)
	for _, iv := range ivs {
		if !iv.end.After(iv.start) {
			continue
		}
		points = append(points, point{iv.start, +1}, point{iv.end, -1})
	}
	sort.Slice(points, func(i, j int) bool {
		if points[i].at.Equal(points[j].at) {
			return points[i].delta > points[j].delta
		}
		return points[i].at.Before(points[j].at)
	})
	cur, best := 0, 0
	for _, p := range points {
		cur += p.delta
		if cur > best {
			best = cur
		}
	}
	return best
}

// ===== 2. 读不被写挡住 / 写之间仍串行 =====

// TestReadsAreNotBlockedByWriter 断言三件事：
//
//	(a) **读与写并发**：一条慢写（auto-commit，持有 SQLite 写锁）进行期间，
//	    另一个 goroutine 的读能在写结束**之前**完成（区间相交）。改造前读要被
//	    d.mu 挡住整条写语句 ⇒ 读区间只会在写区间之后；
//	(b) **写语句必须经过 writeMu**：测试手动持有 writeMu 时，Exec 不得完成；
//	(c) **写与写串行**：两条慢写的总跨度接近两者耗时之和（而不是最大者）——
//	    并发执行时跨度 ≈ max，串行执行时跨度 ≈ d1+d2。
//
// 顺带验证 WAL：写进行期间读不会拿到 database_busy（否则读会以错误收场）。
func TestReadsAreNotBlockedByWriter(t *testing.T) {
	d := newSlowDB(t, "read-write-app", 2)
	ctx := context.Background()
	readQ := abi.SQLParams{SQL: "SELECT count(*) FROM bench_items WHERE pad LIKE '%0000%'"}
	writeQ := abi.SQLParams{SQL: "UPDATE bench_items SET pad = pad || ''"}

	// (a) 读 vs 写：最多试 3 轮（屏障同步后两边的区间都从同一时刻开始；
	// 万一调度把读者推迟到写结束之后，重试一轮即可，串行实现下**每一轮**都不会相交）。
	overlapped := false
	for round := 0; round < 3 && !overlapped; round++ {
		start := make(chan struct{})
		var wg sync.WaitGroup
		var readIV, writeIV connInterval
		var readErr, writeErr error
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			writeIV.start = time.Now()
			_, writeErr = d.Exec(ctx, writeQ)
			writeIV.end = time.Now()
		}()
		go func() {
			defer wg.Done()
			<-start
			readIV.start = time.Now()
			_, readErr = d.Query(ctx, readQ)
			readIV.end = time.Now()
		}()
		close(start)
		wg.Wait()

		if writeErr != nil {
			t.Fatalf("慢写失败：%v", writeErr)
		}
		if readErr != nil {
			t.Fatalf("与写并发的读失败（WAL 下不该被写挡住）：%v", readErr)
		}
		overlapped = readIV.overlaps(writeIV)
		t.Logf("第 %d 轮：写耗时 %v，读耗时 %v，区间相交=%v（读起点在写结束前 %v）",
			round+1, writeIV.end.Sub(writeIV.start), readIV.end.Sub(readIV.start), overlapped,
			writeIV.end.Sub(readIV.start))
	}
	if !overlapped {
		t.Fatal("读与写在 3 轮里都没有重叠：读被写挡住了（读路径与写路径仍然共用一把锁）")
	}

	// (b) 写语句必须持 writeMu：测试占着它时 Exec 不得完成。
	d.writeMu.Lock()
	done := make(chan error, 1)
	go func() {
		_, err := d.Exec(ctx, abi.SQLParams{SQL: "INSERT INTO bench_items(n, pad) VALUES (1, 'mutex-probe')"})
		done <- err
	}()
	select {
	case err := <-done:
		d.writeMu.Unlock()
		t.Fatalf("Exec 没有经过 writeMu（占着锁它竟然完成了）：%v", err)
	case <-time.After(300 * time.Millisecond):
	}
	d.writeMu.Unlock()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("释放 writeMu 后写应成功：%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("释放 writeMu 后写仍未完成")
	}

	// (c) 两条慢写：总跨度应接近两者耗时之和（串行），而不是最大者（并发）。
	var ivs [2]connInterval
	errs := [2]error{}
	start2 := make(chan struct{})
	var wg2 sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg2.Add(1)
		go func(i int) {
			defer wg2.Done()
			<-start2
			ivs[i].start = time.Now()
			_, errs[i] = d.Exec(ctx, writeQ)
			ivs[i].end = time.Now()
		}(i)
	}
	close(start2)
	wg2.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("并发写第 %d 条失败：%v", i+1, err)
		}
	}
	d0, d1 := ivs[0].end.Sub(ivs[0].start), ivs[1].end.Sub(ivs[1].start)
	span := ivs[1].end.Sub(ivs[0].start)
	if ivs[0].end.After(ivs[1].end) {
		span = ivs[0].end.Sub(ivs[1].start)
	}
	shorter := d0
	if d1 < shorter {
		shorter = d1
	}
	// 判据：串行时"后拿到锁的那条"的耗时里包含了等待 ⇒ 它几乎等于总跨度，
	// 而"先拿到锁的那条"只有纯执行时间 ⇒ 较短者明显小于跨度。并发时两者都
	// 从屏障时刻起跑、各自只花纯执行时间 ⇒ 较短者 ≈ 跨度。
	t.Logf("两条写语句：耗时 %v / %v，总跨度 %v（较短者/跨度 = %.2f，串行时应明显 < 0.8）",
		d0, d1, span, float64(shorter)/float64(span))
	if float64(shorter) >= 0.8*float64(span) {
		t.Fatalf("两条写语句的耗时几乎等于总跨度（%v ≈ %v）：它们在并发执行，单写者语义被破坏", shorter, span)
	}

	// 写事务持锁期间，第二个 Begin 仍被拒（同时最多一个事务）。
	tx, err := d.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin 失败：%v", err)
	}
	if _, err := d.Begin(ctx); err == nil {
		t.Fatal("事务已打开时第二个 Begin 必须被拒（同时最多一个事务）")
	} else {
		requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), "tx_already_open")
	}
	if err := d.Rollback(ctx, abi.TxParams{TxID: tx.TxID}); err != nil {
		t.Fatalf("Rollback 失败：%v", err)
	}
}

// ===== 3. 事务内读 =====

// TestReadsInsideTxSeeUncommittedWrites 钉住事务内读的两条语义：
//   - 读**看得到未提交的写**（必须走 rw，不能走 query_only 的只读连接）；
//   - 该读**不占用只读槽**（槽位是给事务外的并发读用的；事务内读走串行路径）。
func TestReadsInsideTxSeeUncommittedWrites(t *testing.T) {
	d := newTestDB(t, "tx-read-app")
	defineTable(t, d, "items", col("v", "text"))
	ctx := context.Background()
	tx, err := d.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin 失败：%v", err)
	}
	mustExec(t, d, "INSERT INTO items(v) VALUES (?)", "uncommitted")

	freeBefore := len(d.roSlots)
	res, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT v FROM items"})
	if err != nil {
		t.Fatalf("事务内查询失败：%v", err)
	}
	if len(res.Rows) != 1 || res.Rows[0][0] != "uncommitted" {
		t.Fatalf("事务内必须看到未提交写：%+v", res.Rows)
	}
	if freeAfter := len(d.roSlots); freeAfter != freeBefore {
		t.Fatalf("事务内读不该占用只读槽（前 %d / 后 %d）——它必须走 rw", freeBefore, freeAfter)
	}
	if err := d.Commit(ctx, abi.TxParams{TxID: tx.TxID}); err != nil {
		t.Fatalf("Commit 失败：%v", err)
	}
	res, err = d.Query(ctx, abi.SQLParams{SQL: "SELECT count(*) FROM items"})
	if err != nil {
		t.Fatalf("提交后查询失败：%v", err)
	}
	if n := res.Rows[0][0].(int64); n != 1 {
		t.Fatalf("提交后应读到 1 行，实际 %d", n)
	}
}

// ===== 4. 关连接排空在途读者 =====

// TestCloseDrainsInFlightReaders 用**确定性**方式验证"关连接前先排空在途读者"：
//
//	(1) 测试自己占用一个只读槽（等价于"有一个读者正在执行语句"）⇒ Close 必须**阻塞**；
//	(2) 归还槽位 ⇒ Close 立即完成；
//	(3) 慢查询进行中调 Close ⇒ 查询必须正常返回（绝不 use-after-close）；
//	(4) Close 之后按需重连仍可用，且槽位守恒没被破坏。
//
// 变异方式：closeLocked 去掉 drainReadSlots ⇒ (1) 立刻变红（Close 会在读者脚下关连接）。
func TestCloseDrainsInFlightReaders(t *testing.T) {
	d := newSlowDB(t, "drain-app", 2)
	ctx := context.Background()

	// (1)(2) 手动占槽：这是"在途读者"的最小可判定形态。
	held, ok := d.takeReadSlot(ctx)
	if !ok {
		t.Fatal("应从只读池取到一条连接")
	}
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		_ = d.Close()
	}()
	select {
	case <-closed:
		t.Fatal("Close 没有等待在途读者（槽位仍被占用却已经关完）")
	case <-time.After(300 * time.Millisecond):
	}
	d.putReadSlot(held)
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("归还槽位后 Close 仍未完成")
	}

	// (3) 真读者 + Close 并发：读必须成功（不能读到被关掉的连接）。
	slow := abi.SQLParams{SQL: "SELECT count(*) FROM bench_items WHERE pad LIKE '%0000%'"}
	readDone := make(chan error, 1)
	readerStart := make(chan struct{})
	go func() {
		<-readerStart
		_, err := d.Query(ctx, slow)
		readDone <- err
	}()
	close(readerStart)
	time.Sleep(20 * time.Millisecond) // 尽量让读者先进入语句（断言本身不依赖它）
	if err := d.Close(); err != nil {
		t.Fatalf("Close 失败：%v", err)
	}
	if err := <-readDone; err != nil {
		t.Fatalf("关闭期间在途读者必须正常完成（use-after-close）：%v", err)
	}

	// (4) 重连仍可用，且槽位守恒（readers 个槽都在）。
	if _, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT count(*) FROM bench_items"}); err != nil {
		t.Fatalf("Close 后按需重连必须可用：%v", err)
	}
	if got := len(d.roSlots); got != d.readers {
		t.Fatalf("重连后只读槽应回到 %d 个，实际 %d", d.readers, got)
	}
	if !d.ready() {
		t.Fatal("重连后 ready() 应为真")
	}
}

// ===== 5. WAL 与 busy_timeout 逐条连接 =====

// TestJournalModeWALAndBusyTimeoutOnEveryConn 钉住三件事：
//   - **新库首次 Open 即 WAL**（journal_mode 是库级持久设置，connectLocked 断言读回 "wal"）；
//   - 池里**每一条**连接（全部只读 + rw）读回 journal_mode=wal 与 busy_timeout=期望值；
//   - Close 后重连（新的一代连接）仍满足同样条件（busy_timeout 是连接级参数，必须重设）。
func TestJournalModeWALAndBusyTimeoutOnEveryConn(t *testing.T) {
	d := newTestDBWithReaders(t, "wal-app", 4)
	ctx := context.Background()

	assertEveryConn := func(stage string) {
		t.Helper()
		conns := allPoolConns(d)
		if len(conns) != 1+d.readers {
			t.Fatalf("[%s] 期望 %d 条持有连接，实际 %d", stage, 1+d.readers, len(conns))
		}
		for _, c := range conns {
			var mode string
			if err := c.conn.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil {
				t.Fatalf("[%s][%s] 读回 journal_mode 失败：%v", stage, c.name, err)
			}
			if !strings.EqualFold(mode, "wal") {
				t.Fatalf("[%s][%s] journal_mode 应为 wal，实际 %q", stage, c.name, mode)
			}
			if bt := pragmaInt64(t, c.conn, "busy_timeout"); bt != limits.AppDBBusyTimeout.Milliseconds() {
				t.Fatalf("[%s][%s] busy_timeout 应为 %d ms，实际 %d", stage, c.name,
					limits.AppDBBusyTimeout.Milliseconds(), bt)
			}
		}
		t.Logf("[%s] %d 条连接全部读回 journal_mode=wal、busy_timeout=%dms", stage, len(conns),
			limits.AppDBBusyTimeout.Milliseconds())
	}
	assertEveryConn("首次 Open")

	// 库级持久：平台自省连接（引擎层只读，走的是另一条全新连接）也看到 wal。
	ro, err := sql.Open("sqlite", "file:"+d.Path()+"?mode=ro&_pragma=query_only(1)")
	if err != nil {
		t.Fatalf("sql.Open(ro) 失败：%v", err)
	}
	defer ro.Close()
	var mode string
	if err := ro.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil {
		t.Fatalf("平台自省连接读回 journal_mode 失败：%v", err)
	}
	if !strings.EqualFold(mode, "wal") {
		t.Fatalf("journal_mode 是库级持久设置，自省连接也应看到 wal，实际 %q", mode)
	}

	// 重连（新的一代连接）：连接级参数必须重设、库级设置必须保持。
	if err := d.Close(); err != nil {
		t.Fatalf("Close 失败：%v", err)
	}
	if _, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT 1"}); err != nil {
		t.Fatalf("重连查询失败：%v", err)
	}
	assertEveryConn("重连")

	// WAL sidecar 与主库同权限（0600）：它们是应用数据的一部分。
	if fi, err := os.Stat(d.Path() + "-wal"); err == nil {
		if perm := fi.Mode().Perm(); perm != 0o600 {
			t.Fatalf("-wal 权限应为 0600，实际 %o", perm)
		}
	} else {
		t.Logf("当前没有 -wal 文件（已检查点并清理）：%v", err)
	}
}

// ===== 6. ATTACH 金丝雀逐条只读连接 =====

// TestAttachCanaryHoldsOnEveryPooledReadConn 防"只加固了第一条只读连接"：
// 池里**每一条**只读连接都必须是独立的连接，且每条都带 LIMIT_ATTACHED=0
// （ATTACH 被引擎拒，且错误串是"挂载数超限"）。
//
// 变异方式：connectLocked 里只对 ros[0] 调 hardenConnLocked ⇒ 本用例变红。
func TestAttachCanaryHoldsOnEveryPooledReadConn(t *testing.T) {
	const readers = 4
	d := newTestDBWithReaders(t, "canary-all-app", readers)
	ctx := context.Background()
	if ros := poolReadConnsForTest(d); len(ros) != readers {
		t.Fatalf("应持有 %d 条只读连接，实际 %d", readers, len(ros))
	}
	seen := map[*sql.Conn]bool{}
	for i, conn := range poolReadConnsForTest(d) {
		if seen[conn] {
			t.Fatalf("ros[%d] 与前面的连接重复（池里应是 %d 条独立连接）", i, readers)
		}
		seen[conn] = true
		if got := pragmaInt64(t, conn, "max_page_count"); got != int64(limits.AppDBMaxPageCount) {
			t.Fatalf("ros[%d] max_page_count 应为 %d，实际 %d", i, limits.AppDBMaxPageCount, got)
		}
		if _, err := conn.ExecContext(ctx, "ATTACH ':memory:' AS canary_all"); err == nil {
			t.Fatalf("ros[%d] 上 ATTACH 竟然成功：这条只读连接没有加固", i)
		} else if !strings.Contains(err.Error(), canaryAttachErrFragment) {
			t.Fatalf("ros[%d] 的 ATTACH 错误串不含 %q：%v", i, canaryAttachErrFragment, err)
		}
		// 只读标志也逐条核对（query_only 是连接级参数）。
		if qo := pragmaInt64(t, conn, "query_only"); qo != 1 {
			t.Fatalf("ros[%d] query_only 应为 1，实际 %d", i, qo)
		}
	}
	// 每条只读连接都能真正并发地跑查询（加固之后仍可用）。
	var wg sync.WaitGroup
	errs := make([]error, readers)
	start := make(chan struct{})
	for i := 0; i < readers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, errs[i] = d.Query(ctx, abi.SQLParams{SQL: "SELECT 1"})
		}(i)
	}
	close(start)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("第 %d 条只读连接上的查询失败：%v", i+1, err)
		}
	}
}
