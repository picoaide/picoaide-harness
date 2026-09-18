// Package events 是 WASM 应用平台的**调用事件**通道(设计基线 §4.9):
//
//	应用请求计量 → 有界环形内存 → 单 worker 批量落 wasm_call_events → 7 天保留清理
//
// 三条硬约束:
//
//  1. **Record 绝不阻塞请求路径**:它只做一次内存写入(加锁复制结构体),不碰数据库。
//     落库慢、DB 故障、磁盘满都不会让应用请求变慢 —— 诊断是旁路,不能反过来
//     拖垮被诊断的请求。
//  2. **有界**:环形缓冲满即丢最旧并计数(Dropped);落库失败也计数(Failed)。
//     丢弃是设计的一部分(§4.9「丢最旧并计数」),不是错误路径。
//  3. **不进审计哈希链**(§4.9):调用事件是高频、可丢弃的诊断数据(7 天保留);
//     需要防篡改的是 audit_logs。两者刻意分开,免得每个请求都去抢审计链的
//     全局串行锁。
//
// 已知取舍:落库失败不做重试(重试会在 DB 故障期间把 worker 变成队列堆积源);
// 失败的那批事件直接丢弃并计数,由 Failed() 与 OnError 暴露。
package events

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/picoaide/picoaide/internal/wasmapp/capapi"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// Options 是 Sink 的可调项(零值 = 全部取 limits 里的平台固定值)。
// 存在的意义只是让测试能缩短周期/缩小环,生产不应传非零值。
type Options struct {
	// RingSize 是环形内存容量(默认 limits.CallEventRingSize)。
	RingSize int
	// FlushInterval 是批量落库间隔(默认 limits.CallEventFlushInterval)。
	FlushInterval time.Duration
	// BatchMax 是单次批量落库的最大条数(默认 limits.CallEventBatchMax)。
	BatchMax int
	// RetentionDays 是保留天数(默认 limits.CallEventRetentionDays = 7)。
	RetentionDays int
	// OnError 可选:落库失败回调(默认只在内部计数)。传入方不得阻塞。
	OnError func(error)
}

func (o Options) withDefaults() Options {
	if o.RingSize <= 0 {
		o.RingSize = limits.CallEventRingSize
	}
	if o.FlushInterval <= 0 {
		o.FlushInterval = limits.CallEventFlushInterval
	}
	if o.BatchMax <= 0 {
		o.BatchMax = limits.CallEventBatchMax
	}
	if o.RetentionDays <= 0 {
		o.RetentionDays = limits.CallEventRetentionDays
	}
	return o
}

// flushBudgetIntervals 是单次批量落库占用的 flush 周期数(实现参数,不是平台
// 上限):DB 卡住时 worker 必须能回来,否则事件会一直攒在环里被丢。
const flushBudgetIntervals = 5

// event 是入环的一条事件:调用计量 + **记录时刻**(落库时间是批量时刻,
// 用它当 created_at 会把同一批几百条压到同一个时间点,诊断时间线就糊了)。
type event struct {
	at time.Time
	m  capapi.CallMetrics
}

// Sink 是调用事件的唯一写入通道。零值不可用,必须用 NewSink。
type Sink struct {
	db  *sql.DB
	opt Options

	mu   sync.Mutex
	buf  []event
	head int // 最旧元素下标
	size int // 当前条数

	dropped atomic.Int64 // 环形满 / 关闭后丢弃
	failed  atomic.Int64 // 落库失败丢弃
	written atomic.Int64 // 已成功落库

	started atomic.Bool
	closed  atomic.Bool
	stop    chan struct{}
	done    chan struct{}
}

// NewSink 构造一个 Sink。db 为 nil 时 Sink 只做内存计量(测试用):Record 可用,
// flush 静默跳过 —— 这也让"Record 不碰数据库"成为可断言的契约。
func NewSink(db *sql.DB, opt Options) *Sink {
	o := opt.withDefaults()
	return &Sink{
		db:   db,
		opt:  o,
		buf:  make([]event, o.RingSize),
		stop: make(chan struct{}),
		done: make(chan struct{}),
	}
}

// Record 记录一次应用调用。**非阻塞**:只写环形内存,不查库、不写日志;
// 环满则覆盖最旧一条并计入 Dropped(§4.9「丢最旧并计数」)。
//
// 空 Outcome 视作成功(capapi.OutcomeOK):调用方只需在失败路径显式标注,
// 否则"忘记赋值"会把全部正常请求记成失败,诊断面直接失去意义。
func (s *Sink) Record(m capapi.CallMetrics) {
	if s == nil {
		return
	}
	if m.Outcome == "" {
		m.Outcome = capapi.OutcomeOK
	}
	// guest 的 stderr 是不可信字节:截尾并保证合法 UTF-8,否则一条坏字节会让
	// 整批 INSERT 被 PG 拒掉(text 不接受非法 UTF-8),连带丢掉 511 条好事件。
	m.StderrTail = tailUTF8(m.StderrTail, limits.StderrTailBytes)
	ev := event{at: time.Now().UTC(), m: m}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		// 已关闭:没有 worker 会再落库,记入丢弃而不是让它烂在环里。
		s.dropped.Add(1)
		return
	}
	if s.size == len(s.buf) {
		s.buf[s.head] = ev
		s.head = (s.head + 1) % len(s.buf)
		s.dropped.Add(1)
		return
	}
	s.buf[(s.head+s.size)%len(s.buf)] = ev
	s.size++
}

// Start 启动批量落库 worker(FlushInterval 一次)。可重复调用(只有第一次生效);
// ctx 取消即停止并尽力 flush 一次。运行期由调用方持有 ctx(通常是进程生命周期)。
func (s *Sink) Start(ctx context.Context) {
	if s == nil || ctx == nil {
		return
	}
	if s.closed.Load() || !s.started.CompareAndSwap(false, true) {
		return
	}
	go s.loop(ctx)
}

func (s *Sink) loop(ctx context.Context) {
	defer close(s.done)
	t := time.NewTicker(s.opt.FlushInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			s.flush()
			return
		case <-s.stop:
			s.flush()
			return
		case <-t.C:
			s.flush()
		}
	}
}

// Dropped 返回因环满(或已关闭)而丢弃的事件数。
func (s *Sink) Dropped() int64 {
	if s == nil {
		return 0
	}
	return s.dropped.Load()
}

// Failed 返回落库失败而丢弃的事件数(与 Dropped 分开:一个是"内存放不下",
// 一个是"库写不进去",排障方向完全不同)。
func (s *Sink) Failed() int64 {
	if s == nil {
		return 0
	}
	return s.failed.Load()
}

// Written 返回已成功落库的事件数(测试与自检用)。
func (s *Sink) Written() int64 {
	if s == nil {
		return 0
	}
	return s.written.Load()
}

// Close 尽力 flush 环里剩余事件并停止 worker。可重复调用。
func (s *Sink) Close() error {
	if s == nil {
		return nil
	}
	if !s.closed.CompareAndSwap(false, true) {
		return nil
	}
	close(s.stop)
	if s.started.Load() {
		<-s.done // worker 退出前自己 flush 过一次
	}
	s.flush() // 从未 Start(或 worker 已因 ctx 退出)时的兜底
	return nil
}

// Cleanup 删除超过保留期(limits.CallEventRetentionDays)的调用事件,返回删除条数。
// now 由调用方注入:保留期边界必须可测,不能靠 time.Now() 隐式取值。
func (s *Sink) Cleanup(ctx context.Context, now time.Time) (int64, error) {
	if s == nil || s.db == nil {
		return 0, errors.New("events: sink 未绑定数据库")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if now.IsZero() {
		now = time.Now()
	}
	cutoff := now.UTC().AddDate(0, 0, -s.opt.RetentionDays)
	res, err := s.db.ExecContext(ctx, `DELETE FROM wasm_call_events WHERE created_at < $1`, cutoff)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// flush 把环里的条目分批落库。所有 DB 操作都在锁外(drain 只做内存搬移),
// 因此无论落库多慢,Record 都不会被拖住。
func (s *Sink) flush() {
	if s.db == nil {
		return
	}
	for {
		batch := s.drain(s.opt.BatchMax)
		if len(batch) == 0 {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), s.opt.FlushInterval*flushBudgetIntervals)
		err := s.insert(ctx, batch)
		cancel()
		if err != nil {
			s.failed.Add(int64(len(batch)))
			if s.opt.OnError != nil {
				s.opt.OnError(err)
			}
			return // 不再继续:DB 已经不可用,继续只会再失败并拖长时间
		}
		s.written.Add(int64(len(batch)))
	}
}

// drain 取出至多 max 条事件(先进先出)。返回的切片由调用方独占。
func (s *Sink) drain(max int) []event {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.size
	if n > max {
		n = max
	}
	if n == 0 {
		return nil
	}
	out := make([]event, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, s.buf[(s.head+i)%len(s.buf)])
	}
	s.head = (s.head + n) % len(s.buf)
	s.size -= n
	return out
}

// insert 用一条多值 INSERT 落一批事件(单条语句 = 单次往返,批量才有意义)。
func (s *Sink) insert(ctx context.Context, batch []event) error {
	if len(batch) == 0 {
		return nil
	}
	args := make([]any, 0, len(batch)*callEventColumns)
	for i := range batch {
		m := batch[i].m
		args = append(args, m.AppID, m.UserID, m.Outcome, m.ReasonCode, m.CPUMs, m.PeakMemory,
			m.HostCalls, m.HostCallMS, m.QueueWaitMS, m.ResponseSize, m.DBRows, m.DBBytes,
			m.GuestExitCode, m.StderrTail, batch[i].at)
	}
	_, err := s.db.ExecContext(ctx, buildInsertSQL(len(batch)), args...)
	return err
}

// callEventColumns 是 wasm_call_events 的写入列数(与 §4.9 字段表一一对应)。
const callEventColumns = 15

// buildInsertSQL 生成一条多值 INSERT:列顺序必须与 insert 的 args 顺序严格一致。
// 单独成函数是为了让占位符拼接可被测试直接断言(拼接错了 PG 只会回一句
// "syntax error at or near $1",排障成本远高于一条断言)。
func buildInsertSQL(rows int) string {
	var b strings.Builder
	b.WriteString(`INSERT INTO wasm_call_events
		(app_id, user_id, outcome, reason_code, cpu_ms, peak_memory_bytes, host_call_count,
		 host_call_ms, queue_wait_ms, response_bytes, db_rows, db_bytes, guest_exit_code,
		 stderr_tail, created_at) VALUES `)
	for i := 0; i < rows; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteByte('(')
		for col := 0; col < callEventColumns; col++ {
			if col > 0 {
				b.WriteByte(',')
			}
			fmt.Fprintf(&b, "$%d", i*callEventColumns+col+1)
		}
		b.WriteByte(')')
	}
	return b.String()
}

// tailUTF8 取字符串尾部至多 max 字节,并对齐到 rune 边界后保证合法 UTF-8。
// PG 的 text 拒绝非法 UTF-8:一条坏字节会让整批 INSERT 失败,连带丢掉同批
// 全部事件 —— 这类"因为一条 stderr 而丢掉 512 条诊断"的失败必须堵死。
func tailUTF8(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return strings.ToValidUTF8(s, "\uFFFD")
	}
	s = s[len(s)-max:]
	for len(s) > 0 && !utf8.RuneStart(s[0]) {
		s = s[1:]
	}
	return strings.ToValidUTF8(s, "\uFFFD")
}
