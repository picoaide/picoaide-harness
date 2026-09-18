package events

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 保留期清理调度的回归用例（审计 P1-2：`Cleanup` 曾零调用方 ⇒ 7 天保留未生效）。
//
// 纪律：**不写依赖真实 1 小时的慢测试** —— 注入短 Tick + 计数桩即可断言
// "周期性调用"，而 Cleanup 自己的 SQL 与 7 天 cutoff 由 events_test.go 的真 PG 用例钉住。
//
// 变异验证（改回缺陷实现时哪条必红）：
//   - 去掉 loop 里的 `case <-t.C: s.runOnce(ctx)`（只留启动那一次）⇒
//     TestCleanupSchedulerRunsPeriodically 必红（Runs 永远停在 1）；
//   - 去掉"启动即清一次"⇒ TestCleanupSchedulerRunsImmediately 必红；
//   - 不把删除计数写进日志 ⇒ TestCleanupSchedulerLogsDeletedCount 必红；
//   - Close 不关 stopped / 不等待 ⇒ TestCleanupSchedulerCloseStops 必红；
//   - ctx 取消后不退出 ⇒ TestCleanupSchedulerStopsOnContextCancel 必红。

// countingCleaner 是 Cleaner 的计数桩：记录调用次数、注入的 now、返回值。
type countingCleaner struct {
	mu      sync.Mutex
	calls   int
	times   []time.Time
	deleted int64
	err     error
}

func (c *countingCleaner) Cleanup(_ context.Context, now time.Time) (int64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	c.times = append(c.times, now)
	return c.deleted, c.err
}

func (c *countingCleaner) Calls() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

func (c *countingCleaner) Times() []time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]time.Time(nil), c.times...)
}

// waitCalls 轮询等待调用次数达到 want（有界等待，避免慢测试）。
func waitCalls(t *testing.T, c *countingCleaner, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if c.Calls() >= want {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("等待清理调用超时：实际 %d 次，want ≥ %d 次（调度没在跑？）", c.Calls(), want)
}

// TestCleanupSchedulerRunsPeriodically 是 FIX-17 的核心回归：调度必须**周期**调用
// Cleanup（只调一次不算"7 天保留生效"）。
func TestCleanupSchedulerRunsPeriodically(t *testing.T) {
	clk := time.Unix(1_700_000_000, 0).UTC()
	cleaner := &countingCleaner{deleted: 7}
	s := NewCleanupScheduler(cleaner, CleanupSchedulerOptions{
		Tick:   5 * time.Millisecond,
		Now:    func() time.Time { return clk },
		Logger: func(string, ...any) {},
	})
	s.Start(t.Context())
	waitCalls(t, cleaner, 3) // 周期：至少 3 轮
	s.Close()

	if got := s.Deleted(); got != 7*int64(cleaner.Calls()) {
		t.Fatalf("Deleted=%d，want 7×%d（删除计数必须累计）", got, cleaner.Calls())
	}
	// 注入的 now 必须真的被用上（cutoff 由它推导，不能被 time.Now() 顶掉）。
	for i, ts := range cleaner.Times() {
		if !ts.Equal(clk) {
			t.Fatalf("第 %d 轮用了 %v，want 注入时钟 %v", i, ts, clk)
		}
	}
}

// TestCleanupSchedulerRunsImmediately：进程启动就清一次（停机期间攒下的过期行
// 不该等一个整点），这也是"调度真的接上了"的即时证据。
func TestCleanupSchedulerRunsImmediately(t *testing.T) {
	cleaner := &countingCleaner{}
	s := NewCleanupScheduler(cleaner, CleanupSchedulerOptions{
		Tick:   time.Hour, // 刻意远大于用例时长 ⇒ 只能靠"启动即清一次"通过
		Logger: func(string, ...any) {},
	})
	s.Start(t.Context())
	defer s.Close()
	waitCalls(t, cleaner, 1)
}

// TestCleanupSchedulerLogsDeletedCount：删除计数必须有日志出口（审计 P2-7：
// "丢最旧并计数"的计数没人看得见 = 保留期是否在跑无从判断）。
func TestCleanupSchedulerLogsDeletedCount(t *testing.T) {
	var mu sync.Mutex
	var lines []string
	logf := func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		lines = append(lines, fmt.Sprintf(format, args...))
	}
	cleaner := &countingCleaner{deleted: 42}
	s := NewCleanupScheduler(cleaner, CleanupSchedulerOptions{Tick: time.Hour, Logger: logf})
	s.Start(t.Context())
	waitCalls(t, cleaner, 1)
	s.Close()

	mu.Lock()
	joined := strings.Join(lines, "\n")
	mu.Unlock()
	if !strings.Contains(joined, "deleted=42") {
		t.Fatalf("日志必须带删除计数（deleted=42）：%q", joined)
	}
	if !strings.Contains(joined, fmt.Sprintf("retention_days=%d", limits.CallEventRetentionDays)) {
		t.Fatalf("日志必须带保留天数（单一真源 = limits）：%q", joined)
	}
}

// TestCleanupSchedulerCountsFailures：DB 故障时"保留期没在生效"必须可观测
// （失败轮数 + 失败日志），而不是静默当作清过 0 行。
func TestCleanupSchedulerCountsFailures(t *testing.T) {
	var mu sync.Mutex
	var lines []string
	cleaner := &countingCleaner{err: context.DeadlineExceeded}
	s := NewCleanupScheduler(cleaner, CleanupSchedulerOptions{
		Tick: 5 * time.Millisecond,
		Logger: func(format string, args ...any) {
			mu.Lock()
			defer mu.Unlock()
			lines = append(lines, fmt.Sprintf(format, args...))
		},
	})
	s.Start(t.Context())
	waitCalls(t, cleaner, 2)
	s.Close()

	if s.Errors() == 0 {
		t.Fatal("失败轮数必须计数")
	}
	if s.Deleted() != 0 {
		t.Fatalf("失败轮不该计入删除数：%d", s.Deleted())
	}
	mu.Lock()
	joined := strings.Join(lines, "\n")
	mu.Unlock()
	if !strings.Contains(joined, "清理失败") {
		t.Fatalf("失败必须记日志：%q", joined)
	}
}

// TestCleanupSchedulerCloseStops：Close 后必须真的停下（关停路径不能留后台 goroutine）。
func TestCleanupSchedulerCloseStops(t *testing.T) {
	cleaner := &countingCleaner{}
	s := NewCleanupScheduler(cleaner, CleanupSchedulerOptions{
		Tick:   time.Millisecond,
		Logger: func(string, ...any) {},
	})
	s.Start(t.Context())
	waitCalls(t, cleaner, 2)
	s.Close()
	s.Close() // 幂等

	stopped := cleaner.Calls()
	time.Sleep(30 * time.Millisecond)
	if got := cleaner.Calls(); got != stopped {
		t.Fatalf("Close 后仍在清理：%d → %d", stopped, got)
	}
	// Close 之后再 Start 必须是 no-op（不能把已停的调度重新拉起来）。
	s.Start(t.Context())
	time.Sleep(20 * time.Millisecond)
	if got := cleaner.Calls(); got != stopped {
		t.Fatalf("Close 之后的 Start 不该重新起调度：%d → %d", stopped, got)
	}
}

// TestCleanupSchedulerStopsOnContextCancel：随 ctx 取消退出（进程生命周期契约）。
func TestCleanupSchedulerStopsOnContextCancel(t *testing.T) {
	cleaner := &countingCleaner{}
	s := NewCleanupScheduler(cleaner, CleanupSchedulerOptions{
		Tick:   time.Millisecond,
		Logger: func(string, ...any) {},
	})
	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	waitCalls(t, cleaner, 2)
	cancel()
	select {
	case <-s.done: // 调度 goroutine 必须退出
	case <-time.After(3 * time.Second):
		t.Fatal("ctx 取消后调度 goroutine 未退出（后台泄漏）")
	}
	stopped := cleaner.Calls()
	time.Sleep(20 * time.Millisecond)
	if got := cleaner.Calls(); got != stopped {
		t.Fatalf("ctx 取消后仍在清理：%d → %d", stopped, got)
	}
	s.Close()
}

// TestCleanupSchedulerNilCleanerIsNoop：装配缺失不该 panic，也不该假装在跑。
func TestCleanupSchedulerNilCleanerIsNoop(t *testing.T) {
	s := NewCleanupScheduler(nil, CleanupSchedulerOptions{Logger: func(string, ...any) {}})
	s.Start(t.Context())
	s.Close()
	if s.Runs() != 0 {
		t.Fatalf("nil cleaner 不该有轮次：%d", s.Runs())
	}
	// 零值/nil 接收者也要安全（Close 在平台销毁路径上会被调用）。
	var nilSched *CleanupScheduler
	nilSched.Close()
	if nilSched.Runs() != 0 || nilSched.Deleted() != 0 || nilSched.Errors() != 0 {
		t.Fatal("nil 调度器的读数应为 0")
	}
}

// TestCleanupSchedulerDefaults：缺省值必须只有一份（Tick/Now/Logger）。
func TestCleanupSchedulerDefaults(t *testing.T) {
	s := NewCleanupScheduler(&countingCleaner{}, CleanupSchedulerOptions{})
	if s.opt.Tick != DefaultCleanupInterval {
		t.Fatalf("Tick=%v want %v", s.opt.Tick, DefaultCleanupInterval)
	}
	if s.opt.Now == nil || s.opt.Logger == nil {
		t.Fatal("Now/Logger 必须有缺省实现")
	}
}

// TestCleanupSchedulerDeletesExpiredRowsOnRealDB：调度器 → Cleanup → **真 PG** 的
// 端到端闭环（审计 UNVERIFIED 第 4 条只验证过 SQL/参数形状；这里证明真的删掉了）。
//
// 不依赖真实 1 小时：注入 10ms 的 Tick，插入一条"8 天前"的事件，等它消失。
func TestCleanupSchedulerDeletesExpiredRowsOnRealDB(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	sink := NewSink(db, Options{RingSize: 8})
	appID := "cleanup-sched-app"
	if _, err := db.Exec(`INSERT INTO wasm_call_events (app_id, user_id, outcome, created_at)
		VALUES ($1, 1, 'ok', $2)`, appID, time.Now().UTC().AddDate(0, 0, -limits.CallEventRetentionDays-1)); err != nil {
		t.Fatal(err)
	}
	s := NewCleanupScheduler(sink, CleanupSchedulerOptions{
		Tick:   10 * time.Millisecond,
		Logger: func(string, ...any) {},
	})
	s.Start(t.Context())
	defer s.Close()

	deadline := time.Now().Add(5 * time.Second)
	for {
		var n int
		if err := db.QueryRow(`SELECT count(*) FROM wasm_call_events WHERE app_id = $1`, appID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			if s.Deleted() == 0 {
				t.Fatal("表里删掉了行，但调度器的删除计数仍为 0（可观测断链）")
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("超期事件未被清理：仍有 %d 行（7 天保留未生效）", n)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
