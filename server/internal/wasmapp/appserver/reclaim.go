package appserver

import (
	"runtime/debug"
	"sync"
	"time"
)

// 本文件是"把内存真正还给操作系统"的唯一实现（2026-09-18 用户要求"更快释放"）。
//
// 为什么需要它（实测，temp/wasm-mem-probe）：
//   - 一个 3.45 MiB 的 Go 应用编译后，在 wazero 里存活约 6 MiB，但**峰值 RSS 约 25 MB**；
//   - 把 20 个模块全部 Close 之后，RSS 只回落约 20%（仍 +395 MB）——
//     即使显式调用 debug.FreeOSMemory() 也只多回落一点；
//   - 也就是说"Close 了"不等于"内存回到 OS"：Go 的堆会把刚释放的页留着复用，
//     几百个应用的场景下这会表现为"内存只涨不落"。
//
// 因此：**每次真正逐出/大量释放之后，限频地调用一次 debug.FreeOSMemory()**。
// 限频的理由：FreeOSMemory 会触发一次 STW 的强制 GC + scavenge（实测毫秒级到
// 数十毫秒），逐出是高频事件（每轮 sweep 都可能发生），不设间隔会把 CPU 打满。
const (
	// reclaimMinInterval 是两次"归还 OS"之间的最小间隔。
	reclaimMinInterval = 30 * time.Second
	// moduleSweepInterval 是空闲模块/句柄的后台扫描周期。
	moduleSweepInterval = time.Minute
)

// reclaimer 是限频的"归还内存给 OS"执行器。
//
// 语义：
//   - request 返回 true 表示**这次真的调用了** FreeOSMemory；
//   - 距上次不足 min 时只记一笔"合并计数"，等下次真调用时一并写进日志
//     （避免日志噪音，同时不丢"这段时间发生过 N 次释放"这个事实）。
type reclaimer struct {
	mu   sync.Mutex
	min  time.Duration
	last time.Time
	now  func() time.Time
	free func()

	logf    func(format string, args ...any)
	skipped int
}

// newReclaimer 构造执行器（free 为 nil ⇒ 永远不执行，全部走"跳过"分支）。
func newReclaimer(free func(), now func() time.Time, logf func(format string, args ...any)) *reclaimer {
	if now == nil {
		now = time.Now
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &reclaimer{min: reclaimMinInterval, now: now, free: free, logf: logf}
}

// request 请求归还一次内存（reason 只用于日志；freedBytes 是本次逐出的记账量）。
func (r *reclaimer) request(reason string, freedBytes int64) bool {
	if r == nil || r.free == nil {
		return false
	}
	r.mu.Lock()
	now := r.now()
	if !r.last.IsZero() && now.Sub(r.last) < r.min {
		r.skipped++
		r.mu.Unlock()
		return false
	}
	merged := r.skipped
	r.skipped = 0
	r.last = now
	r.mu.Unlock()

	r.free()
	if merged > 0 {
		r.logf("appserver: 归还内存给 OS（%s，本轮合并了 %d 次更早的释放请求）", reason, merged)
	} else {
		r.logf("appserver: 归还内存给 OS（%s，逐出记账 %d KiB）", reason, freedBytes>>10)
	}
	return true
}

// freeOSMemory 是生产用的归还实现（独立函数便于测试替换与变异验证）。
func freeOSMemory() { debug.FreeOSMemory() }
