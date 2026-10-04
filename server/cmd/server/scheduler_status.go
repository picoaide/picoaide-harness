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
// S3-02（审计 2026-10-04，P2）：这张表此前只登记 6 条，而 `main.go` 启动了 9 条 ——
// 启动/关停日志的注释却写着"**全部**后台调度器"（运维据此核对会拿到错误的全集，且
// 缺的三条恰好都是"沉默地不做事"的清理类）。现在 9 条全部经 registerSchedulerStatus /
// registerStartOnlyScheduler 登记进这**一个** registry；装配调用集合与登记集合的
// 双向对账判据见 scheduler_registry_reconcile_test.go。
//
// 读数的可得性按子系统如实登记（`schedulerStatus.MetricsAvailable` + `readings=`）：
//   - 六条自记账调度器 → `readings=scheduler`（四项齐全）；
//   - usage 保留 → `readings=serverstore.usage_retention`（取 serverstore 自己记的账，
//     与 `/readyz` 的 usage_retention 字段同一份）；
//   - 网关文件回收器 / 审计保留 → `readings=assembly.start_only`（这两个子系统不发布
//     运行读数：`llmgateway.StartFileReaper` 是 fire-and-forget 的常驻协程，
//     `auditretention.Scheduler` 只有 Stopped()）—— 状态表只报"已启动 + 启动时刻"，
//     runs/errors 渲染成 `unavailable`，**绝不填 0 冒充读数**。
//
// 出口有两个：
//  1. **启动 / 关停日志**：每个调度器一行 `scheduler status (startup|shutdown): name=…
//     started=… tick=… readings=… runs=… errors=… last_run_at=… last_error=…`（字段齐全、
//     可 grep，与 §7.0 的访问日志同风格）；
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
//
// S3-02（审计 2026-10-04，P2）：新增 gateway_file_reaper / audit_retention /
// usage_retention —— 三条清理类执行者都不在表里，而启动/关停日志声称"全部"。
// 三条共用**同一个** registry（registerStartOnlyScheduler / registerSchedulerObservation），
// 各自的名字常量放在自己的接缝文件里（与 token-retention / audit-chain 同惯例）。
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
	// MetricsAvailable=false 表示该子系统**不发布**运行读数 —— 日志里渲染成
	// `runs=unavailable …`，绝不渲染成 0（"没跑过"与"读不到"在运维面上不能同形；
	// 本仓对"自报 0"有明确纪律，见 wasmCompileStatsProvider 那条）。
	MetricsAvailable bool
	// Source 说明读数从哪来（日志字段 `readings=`），供运维判断这几位该不该信。
	Source    string
	Runs      int64
	Errors    int64
	LastRunAt time.Time
	LastError string
}

// 读数来源（`readings=` 字段的取值；日志与断言共用同一份字面量）。
const (
	// schedulerSourceSelf：调度器自己记账（observableScheduler 的 7 方法面）。
	schedulerSourceSelf = "scheduler"
	// schedulerSourceUsageRetention：读数取自 serverstore 自己记的账
	// （`CurrentUsageRetentionStatus()`，与 `/readyz` 的 usage_retention 字段同一份）。
	schedulerSourceUsageRetention = "serverstore.usage_retention"
	// schedulerSourceStartOnly：子系统不发布运行读数 —— 状态表只如实报"已启动 +
	// 启动时刻"（装配层**直接观测**到的两件事），其余三项 unavailable。
	schedulerSourceStartOnly = "assembly.start_only"
)

// schedulerReadings 是一次运行读数。
type schedulerReadings struct {
	// Available=false ⇒ 其余三项无意义（调用方必须渲染成 unavailable）。
	Available bool
	Runs      int64
	Errors    int64
	LastRunAt time.Time
	LastError string
}

// schedulerObservation 是状态表条目**背后**的可读面：装配层只读它，不自己推断读数。
//
// 两种生产实现：
//   - selfReportedScheduler：调度器自己记账（reports/balance/token-retention/
//     audit-chain/model-sync/directory-sync 六条走这条）；
//   - startOnlyScheduler：子系统不发布运行读数（网关文件回收器 / 审计保留）——
//     只报"已启动 + 启动时刻"，读数一律 unavailable；
//   - usageRetentionObservation：读数来自 serverstore 的保留清理账（同一条
//     startOnlyScheduler 提供启动事实，Readings/Source 被覆写）。
type schedulerObservation interface {
	// Started 报告装配层是否已经启动它。
	Started() bool
	// StartedAt 返回启动时刻（零值 = 未启动）。
	StartedAt() time.Time
	// Readings 每次现取运行读数（不做缓存 —— 缓存会让"调度器死了但状态表还是上次的
	// 快照"，正好丢掉要观测的东西）。
	Readings() schedulerReadings
	// Source 报告读数来源。
	Source() string
}

// selfReportedScheduler 把 observableScheduler（自记账的 7 方法面）适配成可读面。
type selfReportedScheduler struct{ sched observableScheduler }

func (o selfReportedScheduler) Started() bool        { return o.sched.Started() }
func (o selfReportedScheduler) StartedAt() time.Time { return o.sched.StartedAt() }
func (o selfReportedScheduler) Source() string       { return schedulerSourceSelf }
func (o selfReportedScheduler) Readings() schedulerReadings {
	return schedulerReadings{
		Available: true,
		Runs:      o.sched.Runs(),
		Errors:    o.sched.Errors(),
		LastRunAt: o.sched.LastRunAt(),
		LastError: o.sched.LastError(),
	}
}

// startOnlyScheduler 记录装配层**直接观测**到的两件事：启动路径确实调用了它的 Start，
// 以及调用发生在何时。子系统不发布运行读数时，这是唯一能如实报出的部分 ——
// 它**不编造** runs/errors（Readings 恒为 Available=false）。
type startOnlyScheduler struct {
	source string
	now    func() time.Time

	mu        sync.Mutex
	started   bool
	startedAt time.Time
}

func newStartOnlyScheduler(source string) *startOnlyScheduler {
	return &startOnlyScheduler{source: source, now: time.Now}
}

// markStarted 由装配接缝在**真的调用了**子系统的 Start 之后调用。
func (s *startOnlyScheduler) markStarted() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.started {
		s.started = true
		s.startedAt = s.now()
	}
}

func (s *startOnlyScheduler) Started() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.started
}

func (s *startOnlyScheduler) StartedAt() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.startedAt
}

func (s *startOnlyScheduler) Source() string { return s.source }

// Readings 如实报"不可得"（Available=false）—— 这一条是本类型的全部意义所在。
func (s *startOnlyScheduler) Readings() schedulerReadings { return schedulerReadings{} }

// schedulerStatusEntry 是登记项：可读面 + 名字（读数每次现取，不做缓存 ——
// 缓存会让"调度器死了但状态表还是最后一次的快照"，正好丢掉要观测的东西）。
type schedulerStatusEntry struct {
	name string
	tick time.Duration
	obs  schedulerObservation
}

var (
	schedulerStatusMu      sync.Mutex
	schedulerStatusEntries []schedulerStatusEntry
)

// registerSchedulerObservation 是状态表的**唯一写入口**（登记 + 幂等覆盖）。
func registerSchedulerObservation(name string, tick time.Duration, obs schedulerObservation) {
	if obs == nil {
		return
	}
	schedulerStatusMu.Lock()
	defer schedulerStatusMu.Unlock()
	for i := range schedulerStatusEntries {
		if schedulerStatusEntries[i].name == name {
			schedulerStatusEntries[i] = schedulerStatusEntry{name: name, tick: tick, obs: obs}
			return
		}
	}
	schedulerStatusEntries = append(schedulerStatusEntries, schedulerStatusEntry{name: name, tick: tick, obs: obs})
}

// registerSchedulerStatus 登记一个**自记账**的调度器（observableScheduler 面）。
//
// 幂等：同名重复登记以最后一次为准，避免测试或未来重复装配时出现两份读数。
func registerSchedulerStatus(name string, tick time.Duration, sched observableScheduler) {
	if sched == nil {
		return
	}
	registerSchedulerObservation(name, tick, selfReportedScheduler{sched: sched})
}

// registerStartOnlyScheduler 登记一个**不发布运行读数**的调度器，返回的句柄由接缝在
// 真的调用了它的 Start 之后 `markStarted()`。
func registerStartOnlyScheduler(name string, tick time.Duration, source string) *startOnlyScheduler {
	obs := newStartOnlyScheduler(source)
	registerSchedulerObservation(name, tick, obs)
	return obs
}

// schedulerStatuses 返回全部已登记调度器的运行快照（按名字排序，便于日志与断言）。
func schedulerStatuses() []schedulerStatus {
	schedulerStatusMu.Lock()
	entries := make([]schedulerStatusEntry, len(schedulerStatusEntries))
	copy(entries, schedulerStatusEntries)
	schedulerStatusMu.Unlock()

	out := make([]schedulerStatus, 0, len(entries))
	for _, e := range entries {
		readings := e.obs.Readings()
		out = append(out, schedulerStatus{
			Name:             e.name,
			Tick:             e.tick,
			Started:          e.obs.Started(),
			StartedAt:        e.obs.StartedAt(),
			MetricsAvailable: readings.Available,
			Source:           e.obs.Source(),
			Runs:             readings.Runs,
			Errors:           readings.Errors,
			LastRunAt:        readings.LastRunAt,
			LastError:        readings.LastError,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// schedulerStatusLine 渲染一行可 grep 的状态（字段名与顺序稳定，便于日志检索）。
//
// 读数不可得（MetricsAvailable=false）时刻意渲染 `runs=unavailable …` 而不是 `runs=0`
// —— 后者会让"子系统不发布读数"与"它一轮都没跑"在读日志的人眼里同形。
func schedulerStatusLine(stage string, st schedulerStatus) string {
	if !st.MetricsAvailable {
		return fmt.Sprintf("scheduler status (%s): name=%s started=%t tick=%s readings=%s "+
			"runs=unavailable errors=unavailable last_run_at=unavailable last_error=%q",
			stage, st.Name, st.Started, st.Tick, st.Source, "")
	}
	lastRun := "never"
	if !st.LastRunAt.IsZero() {
		lastRun = st.LastRunAt.Format(time.RFC3339)
	}
	return fmt.Sprintf("scheduler status (%s): name=%s started=%t tick=%s readings=%s runs=%d errors=%d last_run_at=%s last_error=%q",
		stage, st.Name, st.Started, st.Tick, st.Source, st.Runs, st.Errors, lastRun, st.LastError)
}

// logSchedulerStatuses 把**全部已登记**调度器状态打到启动/关停日志（stage = startup|shutdown）。
//
// "全部"的口径 = `schedulerStatuses()` 的登记集合，而该集合与 `main.go` 的启动调用集合
// 双向对账（scheduler_registry_reconcile_test.go）—— 任何一条启动的新调度器没登记、
// 或登记了却没启动，都会红。
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
