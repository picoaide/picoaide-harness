package main

// 后台调度器的**可观测出口**（R6-A-2，审计 2026-09-23，P1）。
//
// 为什么需要它：`reports` 与 `balance` 两个调度器此前是裸调用，既没有装配判据
// （见 schedulers.go 的文件头），也**没有任何运行观测出口** —— 它们不运行时
// 唯一的现象是"月报不发 / 余额不发"，而这两个现象都被别的机制掩盖（月报的
// last_run 只是"很旧"；余额耗尽的 429 看起来像"该充值了"）。可观测面必须至少
// 回答四件事：**是否已启动 / 跑了几轮 / 上次何时 / 上次错误**。
//
// 形态与本仓既有的同类出口一致（`serverstore.AuditChainStatus()` + 启动日志、
// `wasmapp/events` 与 `wasmapp/upload` 的 CleanupScheduler.Runs()/Errors()、
// `usageretention`/`auditretention` 的 Stopped()）：调度器自己记账，装配层只读
// 不推断，读数是**过程事实**（跑了几轮 / 上次错误）而不是从日志里猜。
//
// 出口有两个：
//  1. **启动 / 关停日志**：每个调度器一行 `scheduler status (startup|shutdown): name=…
//     started=… tick=… runs=… errors=… last_run_at=… last_error=…`（字段齐全、可 grep，
//     与 §7.0 的访问日志同风格）；
//  2. **进程内状态表** `schedulerStatuses()`：按名字排序的结构化快照，供测试与
//     后续消费面使用。
//
// 为什么不直接挂到 /readyz 或 admin server-info：那两个面分别属于
// `internal/wasmapp/readyz`（需要按它的发布闸门登记表逐条登记"阻塞/自愈路径"）与
// `internal/serverauth`（/server-info）—— 都是别的泳道正在改的文件。这里的
// `schedulerStatuses()` 就是给它们准备的接缝：要挂上去时读这一个是唯一实现，
// 不要各写一份。

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"
)

// 调度器名字（登记键；日志与状态表共用同一份字面量）。
//
// R19B-05（审计 2026-09-25，P2）：新增 model_sync / directory_sync —— 这两条后台循环
// 此前**根本没进**这张表（也没有 ctx 与任何装配判据），是进程内最后两条"死了没人知道"
// 的周期执行者（其中模型同步循环还是 CleanupPendingUsage 的唯一周期执行者）。
const (
	schedulerReports       = "reports"
	schedulerBalance       = "balance"
	schedulerModelSync     = "model_sync"
	schedulerDirectorySync = "directory_sync"
)

// observableScheduler 是装配接缝要求的完整面：能被 Start(ctx)，且能报出运行状态。
//
// 两个生产实现（*reports.Scheduler / *balance.Scheduler）各自提供同名同签名的方法；
// 用**接口**而不是具体类型，是为了让装配级用例能替换成桩（断言参数与调用发生）。
type observableScheduler interface {
	Start(ctx context.Context)
	// Started 报告后台循环是否已启动。
	Started() bool
	// StartedAt 返回启动时刻（零值 = 未启动）。
	StartedAt() time.Time
	// Runs 返回已执行的轮数。
	Runs() int64
	// Errors 返回以错误结束的轮数。
	Errors() int64
	// LastRunAt 返回最近一轮的结束时刻（零值 = 未跑过）。
	LastRunAt() time.Time
	// LastError 返回最近一轮的错误文案（空串 = 最近一轮无错）。
	LastError() string
	// Tick 返回调度间隔。
	Tick() time.Duration
}

// schedulerStatus 是一个调度器的可读运行快照。
type schedulerStatus struct {
	Name      string
	Tick      time.Duration
	Started   bool
	StartedAt time.Time
	Runs      int64
	Errors    int64
	LastRunAt time.Time
	LastError string
}

// schedulerStatusEntry 是登记项：调度器句柄 + 名字（读数每次现取，不做缓存 ——
// 缓存会让"调度器死了但状态表还是最后一次的快照"，正好丢掉要观测的东西）。
type schedulerStatusEntry struct {
	name  string
	tick  time.Duration
	sched observableScheduler
}

var (
	schedulerStatusMu      sync.Mutex
	schedulerStatusEntries []schedulerStatusEntry
)

// registerSchedulerStatus 登记一个已装配的调度器（幂等：同名重复登记以最后一次为准，
// 避免测试或未来重复装配时出现两份读数）。
func registerSchedulerStatus(name string, tick time.Duration, sched observableScheduler) {
	if sched == nil {
		return
	}
	schedulerStatusMu.Lock()
	defer schedulerStatusMu.Unlock()
	for i := range schedulerStatusEntries {
		if schedulerStatusEntries[i].name == name {
			schedulerStatusEntries[i] = schedulerStatusEntry{name: name, tick: tick, sched: sched}
			return
		}
	}
	schedulerStatusEntries = append(schedulerStatusEntries, schedulerStatusEntry{name: name, tick: tick, sched: sched})
}

// schedulerStatuses 返回全部已登记调度器的运行快照（按名字排序，便于日志与断言）。
func schedulerStatuses() []schedulerStatus {
	schedulerStatusMu.Lock()
	entries := make([]schedulerStatusEntry, len(schedulerStatusEntries))
	copy(entries, schedulerStatusEntries)
	schedulerStatusMu.Unlock()

	out := make([]schedulerStatus, 0, len(entries))
	for _, e := range entries {
		out = append(out, schedulerStatus{
			Name:      e.name,
			Tick:      e.tick,
			Started:   e.sched.Started(),
			StartedAt: e.sched.StartedAt(),
			Runs:      e.sched.Runs(),
			Errors:    e.sched.Errors(),
			LastRunAt: e.sched.LastRunAt(),
			LastError: e.sched.LastError(),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// schedulerStatusLine 渲染一行可 grep 的状态（字段名与顺序稳定，便于日志检索）。
func schedulerStatusLine(stage string, st schedulerStatus) string {
	lastRun := "never"
	if !st.LastRunAt.IsZero() {
		lastRun = st.LastRunAt.Format(time.RFC3339)
	}
	return fmt.Sprintf("scheduler status (%s): name=%s started=%t tick=%s runs=%d errors=%d last_run_at=%s last_error=%q",
		stage, st.Name, st.Started, st.Tick, st.Runs, st.Errors, lastRun, st.LastError)
}

// logSchedulerStatuses 把全部调度器状态打到启动/关停日志（stage = startup|shutdown）。
//
// 为什么两个时点都打：启动行证明"装配真的把它们启动了"（这是 R6-A-2 的核心判据，
// 也是运维重启后第一眼能看到的证据）；关停行带上 runs/errors/last_error，是
// "这个进程存活期间发放循环到底跑没跑"的最终对账口径。
func logSchedulerStatuses(stage string) {
	statuses := schedulerStatuses()
	if len(statuses) == 0 {
		log.Printf("scheduler status (%s): none registered", stage)
		return
	}
	lines := make([]string, 0, len(statuses))
	for _, st := range statuses {
		lines = append(lines, schedulerStatusLine(stage, st))
	}
	log.Print(strings.Join(lines, "\n"))
}
