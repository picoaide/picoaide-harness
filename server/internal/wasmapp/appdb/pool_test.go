package appdb

// 本文件是 2026-09-19「多读者并发 + 单写者串行」改造的验收用例（WAL + 只读连接池 + 锁拆分）。
//
// 覆盖四件事：
//  1. 读**真的并发**（不是"多个 goroutine 排队"）——判据取自**执行期证据**：SQL 里注册的
//     标量函数 `tt_tick(tag)` 在语句执行期间被逐行回调，用每个 tag 的
//     `[首次回调, 末次回调]` 当执行区间，并用回调序列的"连续段数"度量交错程度
//     （详见 tickAt 的注释：为什么"[发起,返回] 区间相交"与"墙钟比大小"都是假绿）。
//  2. 读不被写挡住（慢写执行期间读者**在写结束前**跑完），而**写之间仍然串行**
//     （执行期回调完全分组）。
//  3. 事务内读走 rw（看得到未提交的写，且**不占**只读槽）。
//  4. 关连接排空在途读者（Close 必须等在途读者归还槽位，绝不 use-after-close）。
//
// 另加两条"每条连接都要在场"的门禁：WAL/busy_timeout 与 ATTACH 金丝雀对池里
// **每一条**只读连接逐个校验（只验第一条 = 给后面几条留默认 LIMIT_ATTACHED=10 的缺口）。

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"modernc.org/sqlite"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ===== 执行期证据：SQL 内的 tick 回调 =====
//
// 为什么并发判据**不能**是"[发起,返回] 两个区间相交"（2026-09-19 独立验证 F2，
// 当时这里的两条判据正是这样写的，结果是假绿）：
//
//   - `[发起, 返回]` 把**排队等待**也算进区间。串行实现（读也走 writeMu）下，N 个
//     调用几乎同时起跑（屏障后同时进 Query）、各自错峰结束（谁排在后面谁区间更长），
//     扫描线照样数到 N 条"重叠"——判据恒真；
//   - "并发墙钟 < 串行墙钟"同样无效：串行基线先跑（冷），并发轮次后跑（页缓存已热），
//     实测在**完全串行**的实现上仍给出 1.28–1.31× 的"假加速"。
//
// 有效判据必须来自**语句执行期间**：`tt_tick(tag)` 是注册进 SQLite 的标量函数，
// 它只在语句真正执行到那一行时被调用（排队/等锁期间一次都不会被调用）。于是：
//
//   - 每个 tag 的 `[首次回调, 末次回调]` = **真正的执行区间**；
//   - 回调按时间排序后的"连续同 tag 段数" = 交错程度：完全串行时每个 tag 恰好一段
//     （段数 == 语句数），真并发时高度交错（段数远大于语句数）。
//
// 判据的区分力由反例对照用例 `TestQueriesWithOneReaderAreSerialized` 自证：
// 同一套断言在 `app_db_readers=1`（退化为串行）下给出 重叠 == 1、段数 == 2。
var tickSpinPerCall = 400 * time.Microsecond

type tickEvent struct {
	tag string
	at  time.Time
}

var (
	tickMu     sync.Mutex
	tickEvents []tickEvent
)

// tickAt 记录一次执行期回调并自旋一小段（让"执行区间"有毫秒级宽度）。
func tickAt(tag string) int64 {
	now := time.Now()
	tickMu.Lock()
	tickEvents = append(tickEvents, tickEvent{tag: tag, at: now})
	tickMu.Unlock()
	end := time.Now().Add(tickSpinPerCall)
	for time.Now().Before(end) {
	}
	return now.UnixNano()
}

func tickReset() {
	tickMu.Lock()
	tickEvents = nil
	tickMu.Unlock()
}

func tickSnapshot() []tickEvent {
	tickMu.Lock()
	defer tickMu.Unlock()
	return append([]tickEvent(nil), tickEvents...)
}

// tickRuns 返回回调序列里"连续同 tag 段"的数量：每个 tag 恰好一段 = 完全没有交错。
func tickRuns(evs []tickEvent) int {
	runs, prev := 0, ""
	for _, e := range evs {
		if e.tag != prev {
			runs++
			prev = e.tag
		}
	}
	return runs
}

// tickSpan 返回某个 tag 的 [首次回调, 末次回调] 执行区间与回调次数。
func tickSpan(evs []tickEvent, tag string) (time.Time, time.Time, int) {
	var first, last time.Time
	n := 0
	for _, e := range evs {
		if e.tag != tag {
			continue
		}
		if n == 0 {
			first = e.at
		}
		last = e.at
		n++
	}
	return first, last, n
}

// tickMaxOverlap 返回一组执行区间的最大同时重叠数（扫描线；同刻先算 +1）。
func tickMaxOverlap(spans [][2]time.Time) int {
	type point struct {
		at    time.Time
		delta int
	}
	points := make([]point, 0, len(spans)*2)
	for _, sp := range spans {
		if !sp[1].After(sp[0]) {
			continue
		}
		points = append(points, point{sp[0], +1}, point{sp[1], -1})
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

// waitForTick 轮询等到某个 tag 出现第一次回调（最多 5 s）。
//
// 用途：让"慢写已经真的在跑"成为**可观测事实**再发起读，避免"读被调度推迟到写之后"
// 造成的假红（回调登记发生在 tickAt 开头 ⇒ 看到首次回调时写还有几乎整条语句要跑）。
func waitForTick(t *testing.T, tag string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, n := tickSpan(tickSnapshot(), tag); n > 0 {
			return
		}
		time.Sleep(200 * time.Microsecond)
	}
	t.Fatalf("等待 tick %q 的首次回调超时（5 s）：慢语句没有跑起来？", tag)
}

// tt_tick 是给 SQL 用的标量函数名（`tt_` 前缀 = 测试专用，避免与应用 SQL 撞名）。
func init() {
	if err := sqlite.RegisterScalarFunction("tt_tick", 1,
		func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
			tag := ""
			if len(args) > 0 {
				if s, ok := args[0].(string); ok {
					tag = s
				}
			}
			return tickAt(tag), nil
		}); err != nil {
		panic(fmt.Sprintf("注册 tt_tick 标量函数失败：%v", err))
	}
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

// tickQuerySQL 造一条"执行期打点"的查询：语句每处理一行就回调 tt_tick(tag) 一次。
func tickQuerySQL(tag string, ticks int) string {
	return fmt.Sprintf("SELECT tt_tick('%s') FROM bench_items LIMIT %d", tag, ticks)
}

// tickWriteSQL 造一条"执行期打点"的慢写：每更新一行回调 tt_tick(tag) 一次。
func tickWriteSQL(tag string, rows int) string {
	return fmt.Sprintf("UPDATE bench_items SET pad = tt_tick('%s') WHERE n < %d", tag, rows)
}

// TestQueriesRunConcurrently 断言 N 个并发 Query **真的同时在执行**：
//
//	(a) 执行区间（回调的 [首次, 末次]）最大重叠 ≥ 2，且期望 == readers；
//	(b) 回调序列的连续段数 > readers —— 完全串行时恰好 == readers（每个 tag 一段）；
//	(c) 池内连接数 == 1 + readers（读连接池真的建满了）。
//
// 判据为什么不是"[发起,返回] 区间相交"或"并发墙钟 < 串行墙钟"：见 tickAt 的注释
// （两者在完全串行的实现上都能通过 —— 这正是 2026-09-19 独立验证发现的假绿）。
// 反例对照见 TestQueriesWithOneReaderAreSerialized。
//
// 变异方式：把 withReadConn 的只读槽快路径删掉（读也走 writeMu 串行）⇒ (a)(b) 变红。
func TestQueriesRunConcurrently(t *testing.T) {
	const readers = 4
	const ticksPerQuery = 60 // 60 × tickSpinPerCall ≈ 24 ms：足够覆盖调度抖动
	d := newSlowDB(t, "concurrent-app", readers)
	ctx := context.Background()

	// 并发：屏障后同时进入（goroutine 先起好、等 start 关闭）。
	start := make(chan struct{})
	errs := make([]error, readers)
	var wg sync.WaitGroup
	for i := 0; i < readers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, errs[i] = d.Query(ctx, abi.SQLParams{SQL: tickQuerySQL(fmt.Sprintf("R%d", i), ticksPerQuery)})
		}(i)
	}
	tickReset()
	wallStart := time.Now()
	close(start)
	wg.Wait()
	wall := time.Since(wallStart)

	for i, err := range errs {
		if err != nil {
			t.Fatalf("并发第 %d 个查询失败：%v", i+1, err)
		}
	}
	evs := tickSnapshot()
	spans := make([][2]time.Time, 0, readers)
	for i := 0; i < readers; i++ {
		tag := fmt.Sprintf("R%d", i)
		first, last, n := tickSpan(evs, tag)
		if n != ticksPerQuery {
			t.Fatalf("tag %s 的回调次数 = %d，want %d（语句没跑满？）", tag, n, ticksPerQuery)
		}
		spans = append(spans, [2]time.Time{first, last})
		t.Logf("%s：执行区间长 %v（%d 次回调）", tag, last.Sub(first), n)
	}
	overlap := tickMaxOverlap(spans)
	runs := tickRuns(evs)
	t.Logf("readers=%d：回调 %d 次，连续段数 %d（== 语句数 %d 即完全串行；越大说明交错越深），执行区间最大重叠 %d，墙钟 %v",
		readers, len(evs), runs, readers, overlap, wall)

	if overlap < 2 {
		t.Fatalf("并发读的执行区间没有重叠（最大同时在执行 %d）：读路径仍然被串行化了", overlap)
	}
	if runs <= readers {
		t.Fatalf("执行期回调的连续段数 = %d，未超过语句数 %d：语句没有真的交错执行（读被串行化）",
			runs, readers)
	}
	if overlap != readers {
		// 不是硬失败（调度抖动可能让某一条晚一步进入），但要看见。
		t.Logf("注意：屏障后同时在执行 %d 条（期望 %d），>= 2 即视为并发成立", overlap, readers)
	}
	if got := d.sqlDB.Stats().OpenConnections; got != 1+readers {
		t.Fatalf("池内连接数应为 1+%d=%d，实际 %d", readers, 1+readers, got)
	}
}

// TestQueriesWithOneReaderAreSerialized 是上面那条判据的**反例对照**：只读槽只有
// 一条时（app_db_readers=1），两个并发 Query 必然退化为串行 —— 同一套执行期判据
// 必须给出 重叠 == 1、段数 == 2（= 语句数）。它同时自证判据不是恒真：
// 若把"读真并发"的判据写成"调用区间相交"，这条反例根本拦不住（串行下调用区间照样相交）。
//
// 变异方式：让 takeReadSlot 在 readers=1 时仍能并发（例如忽略槽位数）⇒ 本用例变红。
func TestQueriesWithOneReaderAreSerialized(t *testing.T) {
	const ticksPerQuery = 40
	d := newSlowDB(t, "serial-readers-app", 1)
	ctx := context.Background()

	start := make(chan struct{})
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, errs[i] = d.Query(ctx, abi.SQLParams{SQL: tickQuerySQL(fmt.Sprintf("S%d", i), ticksPerQuery)})
		}(i)
	}
	tickReset()
	wallStart := time.Now()
	close(start)
	wg.Wait()
	wall := time.Since(wallStart)

	for i, err := range errs {
		if err != nil {
			t.Fatalf("第 %d 个查询失败：%v", i+1, err)
		}
	}
	evs := tickSnapshot()
	f0, l0, n0 := tickSpan(evs, "S0")
	f1, l1, n1 := tickSpan(evs, "S1")
	if n0 != ticksPerQuery || n1 != ticksPerQuery {
		t.Fatalf("回调次数应为 %d/%d，实际 %d/%d", ticksPerQuery, ticksPerQuery, n0, n1)
	}
	overlap := tickMaxOverlap([][2]time.Time{{f0, l0}, {f1, l1}})
	runs := tickRuns(evs)
	t.Logf("app_db_readers=1：连续段数 %d（2=完全串行），执行区间重叠 %d，墙钟 %v（两条执行区间之和 %v）",
		runs, overlap, wall, l0.Sub(f0)+l1.Sub(f1))

	if overlap != 1 {
		t.Fatalf("app_db_readers=1 时两条语句的执行区间仍重叠（%d）：没有退化为串行", overlap)
	}
	if runs != 2 {
		t.Fatalf("app_db_readers=1 时执行期回调段数 = %d，want 2（每个 tag 一段 = 串行）", runs)
	}
	if got := d.sqlDB.Stats().OpenConnections; got != 2 {
		t.Fatalf("readers=1 时池内连接数应为 2，实际 %d", got)
	}
}

// ===== 2. 读不被写挡住 / 写之间仍串行 =====

// TestReadsAreNotBlockedByWriter 断言三件事：
//
//	(a) **读与写真并发**：慢写执行期间发起的读，其执行区间（回调的 [首次, 末次]）
//	    与写的执行区间重叠，且读的**末次回调在写的末次回调之前** —— 读是在写还没
//	    结束时就跑完的。判据取自执行期回调，不是"[发起,返回] 区间相交"（后者在
//	    串行实现下恒真：读被 writeMu 挡住时，它的调用区间恰好横跨整条写）；
//	(b) **写语句必须经过 writeMu**：测试手动持有 writeMu 时，Exec 不得完成；
//	(c) **写与写串行**：两条慢写的执行期回调**完全分组**（段数 == 2）且区间不重叠。
//
// 顺带验证 WAL：写进行期间读不会拿到 database_busy（否则读会以错误收场）。
func TestReadsAreNotBlockedByWriter(t *testing.T) {
	d := newSlowDB(t, "read-write-app", 2)
	ctx := context.Background()

	// (a) 读 vs 写：先让写真的跑起来（等到它的首次回调 —— 这是"写正在执行"的
	// 可观测事实），此时读**必然**落在写的执行窗口内，不受调度抖动影响。
	// 写 200 行 ≈ 80 ms，读 40 行 ≈ 16 ms ⇒ 余量充足。
	const writeRows = 200
	const readTicks = 40
	tickReset()
	writeDone := make(chan error, 1)
	go func() {
		_, err := d.Exec(ctx, abi.SQLParams{SQL: tickWriteSQL("WL", writeRows)})
		writeDone <- err
	}()
	waitForTick(t, "WL")
	if _, err := d.Query(ctx, abi.SQLParams{SQL: tickQuerySQL("RL", readTicks)}); err != nil {
		t.Fatalf("与写并发的读失败（WAL 下不该被写挡住）：%v", err)
	}
	if err := <-writeDone; err != nil {
		t.Fatalf("慢写失败：%v", err)
	}
	evs := tickSnapshot()
	firstR, lastR, nR := tickSpan(evs, "RL")
	firstW, lastW, nW := tickSpan(evs, "WL")
	if nR != readTicks || nW != writeRows {
		t.Fatalf("回调次数应为读 %d / 写 %d，实际 %d / %d", readTicks, writeRows, nR, nW)
	}
	t.Logf("写执行区间 %v（%d 次回调），读执行区间 %v（起点在写区间内 %v 处，末次回调早于写结束 %v）",
		lastW.Sub(firstW), nW, lastR.Sub(firstR), firstR.Sub(firstW), lastW.Sub(lastR))
	if !firstR.Before(lastW) {
		t.Fatal("读的执行区间与写没有重叠：读是在写结束之后才开始执行的（读被写挡住了）")
	}
	if !lastR.Before(lastW) {
		t.Fatal("读的末次回调发生在写结束之后：读没有在写执行期间跑完（读被写挡住了）")
	}

	// (b) 写语句必须持 writeMu：测试占着它时 Exec 不得完成。
	// 插入行的 n 取 999999：**(c) 的 tick 谓词是 `n < 40`**，这一行不能混进去
	// （否则下面按"回调次数 == 行数"做的断言会因为多一行而假红）。
	d.writeMu.Lock()
	done := make(chan error, 1)
	go func() {
		_, err := d.Exec(ctx, abi.SQLParams{SQL: "INSERT INTO bench_items(n, pad) VALUES (999999, 'mutex-probe')"})
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

	// (c) 两条慢写：执行期回调必须完全分组（段数 == 2）且区间不重叠 —— 单写者语义。
	tickReset()
	errs := [2]error{}
	start2 := make(chan struct{})
	var wg2 sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg2.Add(1)
		go func(i int) {
			defer wg2.Done()
			<-start2
			_, errs[i] = d.Exec(ctx, abi.SQLParams{SQL: tickWriteSQL(fmt.Sprintf("W%d", i), 40)})
		}(i)
	}
	close(start2)
	wg2.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("并发写第 %d 条失败：%v", i+1, err)
		}
	}
	evs = tickSnapshot()
	f0, l0, n0 := tickSpan(evs, "W0")
	f1, l1, n1 := tickSpan(evs, "W1")
	if n0 != 40 || n1 != 40 {
		t.Fatalf("两条写的回调次数应为 40/40，实际 %d/%d", n0, n1)
	}
	runs := tickRuns(evs)
	ov := tickMaxOverlap([][2]time.Time{{f0, l0}, {f1, l1}})
	t.Logf("写 vs 写：连续段数 %d（2=完全串行），执行区间重叠 %d，W0 区间长 %v，W1 区间长 %v",
		runs, ov, l0.Sub(f0), l1.Sub(f1))
	if runs != 2 {
		t.Fatalf("两条写的执行期回调段数 = %d，want 2：两条写在并发执行，单写者语义被破坏", runs)
	}
	if ov != 1 {
		t.Fatalf("两条写的执行区间重叠 = %d，want 1：两条写在并发执行", ov)
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

// TestEnableWALLockedRejectsNonWALJournalMode 是 `enableWALLocked` 那条
// 「读回必须 == "wal"」断言的**判别性**用例（2026-09-19 独立验证 F3）。
//
// 为什么必须有它：正常文件系统上 `PRAGMA journal_mode = WAL` 的读回**恒为 "wal"**，
// 所以把断言弱化成 `err == nil` 之后，全量产品用例**一道都不会红**（独立验证实测
// 0 红）—— 也就是说这条"不许静默降级"的断言此前**没有任何测试保护**。
// 判据必须选"引擎会返回非 wal **且不报错**"的形态：`:memory:` 库正是现场
// （`PRAGMA journal_mode = WAL` 返回 "memory"、err=nil）；只读连接不行
// （报 SQLITE_READONLY，那是错误路径，区分不出断言强弱）。
//
// 变异方式：把 `if !strings.EqualFold(strings.TrimSpace(mode), "wal")` 去掉
// （或改成 `if false && …`，= 只判 err==nil）⇒ 本用例必红。
func TestEnableWALLockedRejectsNonWALJournalMode(t *testing.T) {
	ctx := context.Background()

	// (1) 反例：`PRAGMA journal_mode=WAL` 返回非 wal 且不报错。
	//
	// 这条连接**不经过 appdb.Open**：连接钩子只托管应用库路径
	// （`isGuardedAppDBPath`），`:memory:` 不在其中 ⇒ 可以拿裸连接。
	mem, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("sql.Open(:memory:)：%v", err)
	}
	t.Cleanup(func() { _ = mem.Close() })
	conn, err := mem.Conn(ctx)
	if err != nil {
		t.Fatalf("Conn(:memory:)：%v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	var mode string
	if qerr := conn.QueryRowContext(ctx, "PRAGMA journal_mode = WAL").Scan(&mode); qerr != nil {
		t.Fatalf("该形态必须「返回非 wal 且不报错」才具备判别力，PRAGMA 却报错了：%v", qerr)
	}
	if strings.EqualFold(strings.TrimSpace(mode), "wal") {
		t.Fatalf("前提不成立：:memory: 库的 journal_mode 读回 %q（本用例要的是非 wal 形态）", mode)
	}
	t.Logf(":memory: 上 `PRAGMA journal_mode = WAL`：err=nil、读回 %q（= 静默降级现场）", mode)

	werr := enableWALLocked(ctx, conn)
	if werr == nil {
		t.Fatalf("读回 %q（非 wal）时 enableWALLocked 返回 nil：字符串断言已退化成 err==nil，"+
			"静默接受非 WAL 日志（而多读者并发正是建立在 WAL 上，delete/memory 日志下读会退化成 SQLITE_BUSY）",
			mode)
	}
	e, ok := apperr.As(werr)
	if !ok {
		t.Fatalf("应是 apperr，实际 %T：%v", werr, werr)
	}
	if e.Code != apperr.CodeInternal {
		t.Fatalf("错误码 = %s，want INTERNAL（fail-closed，宁可不提供服务）：%v", e.Code, e)
	}
	// 错误里必须带期望值与实际读回值（弱化成 err==nil 时连这条信息都没有）。
	if got, _ := e.Details["want"].(string); got != "wal" {
		t.Fatalf("details.want = %q，want \"wal\"", got)
	}
	if got, _ := e.Details["got"].(string); got != mode {
		t.Fatalf("details.got = %q，want %q（回显实际读回值）", got, mode)
	}

	// (2) 对照：正常库（Open 时已切成 wal）上 enableWALLocked 必须通过 ——
	// 证明上面不是"总是报错"的空断言。
	d := newTestDB(t, "wal-readback-ok")
	if err := enableWALLocked(ctx, d.writeConn()); err != nil {
		t.Fatalf("正常库（journal_mode 已是 wal）上 enableWALLocked 不该报错：%v", err)
	}
}

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
