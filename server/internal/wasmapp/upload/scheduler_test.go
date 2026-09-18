package upload

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 分片上传会话回收调度的回归用例（§4.2：会话有效期 30 分钟 ⇒ 过期即回收磁盘）。
//
// 纪律与 events.CleanupScheduler 的用例同款：**不写依赖真实 5 分钟的慢测试** ——
// 注入短 Tick + 计数桩即可断言"周期性调用"，而 Cleanup 自己的边界（哪些目录该删）
// 由 upload_test.go 的真文件系统用例钉住。
//
// 变异方式（改回缺陷实现时哪条必红）：
//   - 去掉 loop 里的 `case <-t.C: s.runOnce(ctx)`（只留启动那一次）⇒
//     TestCleanupSchedulerRunsPeriodically 必红（Runs 永远停在 1）；
//   - 去掉"启动即清一次"⇒ TestCleanupSchedulerRunsImmediately 必红；
//   - 不把回收计数写进日志 ⇒ TestCleanupSchedulerLogsRemovedCount 必红；
//   - Close 不关 stopped / 不等待 ⇒ TestCleanupSchedulerCloseStops 必红；
//   - ctx 取消后不退出 ⇒ TestCleanupSchedulerStopsOnContextCancel 必红；
//   - 缺省 Tick 改成 0（无 ticker）⇒ TestCleanupSchedulerDefaultTick 必红。

// countingCleaner 是 Cleaner 的计数桩：记录调用次数、注入的 now、返回值。
type countingCleaner struct {
	mu      sync.Mutex
	calls   int
	times   []time.Time
	removed int
	err     error
}

func (c *countingCleaner) Cleanup(_ context.Context, now time.Time) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	c.times = append(c.times, now)
	return c.removed, c.err
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
	t.Fatalf("等待回收调用超时：实际 %d 次，want ≥ %d 次（调度没在跑？）", c.Calls(), want)
}

// TestCleanupSchedulerRunsPeriodically 断言调度是**周期性**的（只调一次不算有效期生效）。
func TestCleanupSchedulerRunsPeriodically(t *testing.T) {
	clk := time.Unix(1_700_000_000, 0).UTC()
	cleaner := &countingCleaner{removed: 7}
	s := NewCleanupScheduler(cleaner, CleanupSchedulerOptions{
		Tick:   5 * time.Millisecond,
		Now:    func() time.Time { return clk },
		Logger: func(string, ...any) {},
	})
	s.Start(t.Context())
	waitCalls(t, cleaner, 3)
	s.Close()

	if s.Runs() < 3 {
		t.Fatalf("Runs = %d, want ≥ 3", s.Runs())
	}
	if s.Removed() != int64(7*s.Runs()) {
		t.Fatalf("Removed = %d, want %d（计数必须累计）", s.Removed(), 7*s.Runs())
	}
	// 注入的 now 必须真的被用上（否则过期 cutoff 会跟着墙钟漂）。
	for _, got := range cleaner.Times() {
		if !got.Equal(clk) {
			t.Fatalf("Cleanup 收到的 now = %s, want %s", got, clk)
		}
	}
}

// TestCleanupSchedulerRunsImmediately：启动即清一次（停机期间攒下的过期会话不该等一个周期）。
func TestCleanupSchedulerRunsImmediately(t *testing.T) {
	cleaner := &countingCleaner{}
	s := NewCleanupScheduler(cleaner, CleanupSchedulerOptions{
		Tick:   time.Hour, // 一个周期内不会再触发
		Logger: func(string, ...any) {},
	})
	s.Start(t.Context())
	waitCalls(t, cleaner, 1)
	s.Close()
	if cleaner.Calls() != 1 {
		t.Fatalf("启动后调用次数 = %d, want 1（Tick 是 1 小时）", cleaner.Calls())
	}
}

// TestCleanupSchedulerLogsRemovedCount：回收计数必须有出口（否则"有效期在不在跑"无从判断）。
func TestCleanupSchedulerLogsRemovedCount(t *testing.T) {
	var mu sync.Mutex
	var lines []string
	cleaner := &countingCleaner{removed: 3}
	s := NewCleanupScheduler(cleaner, CleanupSchedulerOptions{
		Tick: time.Hour,
		Logger: func(format string, args ...any) {
			mu.Lock()
			defer mu.Unlock()
			lines = append(lines, fmt.Sprintf(format, args...))
		},
	})
	s.Start(t.Context())
	waitCalls(t, cleaner, 1)
	s.Close()

	mu.Lock()
	defer mu.Unlock()
	if len(lines) == 0 {
		t.Fatal("回收没有写任何日志")
	}
	if !strings.Contains(lines[0], "removed=3") {
		t.Fatalf("日志不含删除计数：%q", lines[0])
	}
	if !strings.Contains(lines[0], limits.UploadSessionTTL.String()) {
		t.Fatalf("日志不含有效期（TTL 单一真源）：%q", lines[0])
	}
}

// TestCleanupSchedulerLogsErrors：失败轮必须计入 Errors 并留下日志（静默失败是禁项）。
func TestCleanupSchedulerLogsErrors(t *testing.T) {
	var logged int
	cleaner := &countingCleaner{err: errors.New("磁盘炸了")}
	s := NewCleanupScheduler(cleaner, CleanupSchedulerOptions{
		Tick:   time.Hour,
		Logger: func(string, ...any) { logged++ },
	})
	s.Start(t.Context())
	waitCalls(t, cleaner, 1)
	s.Close()
	if s.Errors() != 1 {
		t.Fatalf("Errors = %d, want 1", s.Errors())
	}
	if logged == 0 {
		t.Fatal("失败轮没有写日志")
	}
	if s.Removed() != 0 {
		t.Fatalf("失败轮不该累计回收数: %d", s.Removed())
	}
}

// TestCleanupSchedulerCloseStops：Close 之后不再有新的轮次，且 Close 是幂等的。
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

	after := cleaner.Calls()
	time.Sleep(20 * time.Millisecond)
	if cleaner.Calls() != after {
		t.Fatalf("Close 之后仍在跑：%d → %d", after, cleaner.Calls())
	}
	// Close 之后再 Start 是 no-op（不能复活）。
	s.Start(t.Context())
	time.Sleep(10 * time.Millisecond)
	if cleaner.Calls() != after {
		t.Fatalf("Close 之后 Start 复活了调度：%d → %d", after, cleaner.Calls())
	}
}

// TestCleanupSchedulerStopsOnContextCancel：随父 ctx 取消退出（进程关停路径）。
func TestCleanupSchedulerStopsOnContextCancel(t *testing.T) {
	cleaner := &countingCleaner{}
	ctx, cancel := context.WithCancel(context.Background())
	s := NewCleanupScheduler(cleaner, CleanupSchedulerOptions{
		Tick:   time.Millisecond,
		Logger: func(string, ...any) {},
	})
	s.Start(ctx)
	waitCalls(t, cleaner, 2)
	cancel()
	done := make(chan struct{})
	go func() { s.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ctx 取消后调度没有退出")
	}
}

// TestCleanupSchedulerRunningState：Running() 必须能区分"构造了但没 Start"与"已在跑"
// （审计 P1-1 / FIX-47 的装配级判据所依赖的只读状态）。
//
// 为什么需要它：装配期两者**完全同形**（都是一个非 nil 指针，未 Start 的 Close 还是
// no-op）⇒ "会话回收调度建好了但没人 Start"这种半接线只能靠肉眼读代码发现，而它的
// 后果是静默的（断线客户端的会话目录永久占盘）。本用例把三态钉住：未 Start / 已 Start /
// 已 Close；另加 nil cleaner（Start 直接返回，不算启动）与 nil 接收者。
func TestCleanupSchedulerRunningState(t *testing.T) {
	cleaner := &countingCleaner{}
	s := NewCleanupScheduler(cleaner, CleanupSchedulerOptions{
		Tick:   time.Millisecond,
		Logger: func(string, ...any) {},
	})
	if s.Running() {
		t.Fatal("未 Start 时 Running() 必须为 false（这正是'构造了但没 Start'的形态）")
	}
	s.Start(t.Context())
	if !s.Running() {
		t.Fatal("Start 之后 Running() 必须为 true（装配级断言靠它）")
	}
	waitCalls(t, cleaner, 1)
	s.Close()
	if s.Running() {
		t.Fatal("Close 之后 Running() 必须为 false")
	}

	// 缺装配（cleaner 为 nil）：Start 是 no-op ⇒ 不能自称 Running。
	if noCleaner := NewCleanupScheduler(nil, CleanupSchedulerOptions{Tick: time.Millisecond}); noCleaner.Running() {
		t.Fatal("nil cleaner 的调度器不能自称 Running")
	}
	var nilS *CleanupScheduler
	if nilS.Running() {
		t.Fatal("nil 接收者必须返回 false（不 panic）")
	}
}

// TestCleanupSchedulerNilSafety：缺装配（cleaner 为 nil）不该 panic，也不该起协程。
func TestCleanupSchedulerNilSafety(t *testing.T) {
	s := NewCleanupScheduler(nil, CleanupSchedulerOptions{Tick: time.Millisecond})
	s.Start(t.Context())
	if s.Runs() != 0 {
		t.Fatalf("nil cleaner 仍在跑: %d", s.Runs())
	}
	s.Close()

	var nilS *CleanupScheduler
	nilS.Start(t.Context())
	nilS.Close()
	if nilS.Runs() != 0 || nilS.Removed() != 0 || nilS.Errors() != 0 {
		t.Fatal("nil 接收者必须安全")
	}
}

// TestCleanupSchedulerDefaultTick：缺省 Tick 来自 limits 的 TTL（防"0 ⇒ 不起 ticker"）。
func TestCleanupSchedulerDefaultTick(t *testing.T) {
	if DefaultCleanupInterval <= 0 || DefaultCleanupInterval > limits.UploadSessionTTL {
		t.Fatalf("DefaultCleanupInterval = %s，必须落在 (0, TTL] 内", DefaultCleanupInterval)
	}
	opt := CleanupSchedulerOptions{}.withDefaults()
	if opt.Tick != DefaultCleanupInterval {
		t.Fatalf("缺省 Tick = %s, want %s", opt.Tick, DefaultCleanupInterval)
	}
	if opt.Now == nil || opt.Logger == nil {
		t.Fatal("缺省 Now/Logger 必须非 nil（否则 runOnce 会 nil panic）")
	}
}

// TestStoreSatisfiesCleaner 是一条编译期契约的运行期镜像：生产装配传的是 *Store。
func TestStoreSatisfiesCleaner(t *testing.T) {
	var c Cleaner = New(Options{DataRoot: t.TempDir()})
	if _, err := c.Cleanup(context.Background(), time.Now()); err != nil {
		t.Fatalf("空根上的 Cleanup 必须安全（返回 0）: %v", err)
	}
}
