// Package auditchain 是审计哈希链校验的**周期执行者**（R16C-03，审计 2026-09-25，P2）。
//
// 缺陷形态（修复前）：`serverstore.VerifyAuditChain` 在生产代码里只有一个调用点
// —— `cmd/server/main.go` 的**启动校验**（`RunAndRecordAuditChainCheck`）；`/server-info`
// 的 `audit` 字段（`serverauth/sysinfo.go`）只是 `AuditChainStatus()` **读缓存**，
// 它不执行校验。于是：
//
//   - 容器化部署几个月不重启是常态 ⇒ "防篡改"在这段窗口里等价于没有：实测篡改
//     2 行审计后**不重启**，`/server-info` 仍答 `chain_intact: true`、时间戳停在
//     启动时刻、日志零告警，直到下次重启才报 `audit hash mismatch`；
//   - 更糟的是"过期结论看起来像实时结论"：`chain_checked_at` 虽然是过去的时刻，
//     但没有任何字段表达"这条结论已经多久没刷新了"。
//
// 本包补上执行者，形态与 `internal/auditretention`（6h）/`internal/usageretention`
// 同款：`Start(ctx)` 起后台循环、随 ctx 退出、`Stopped()` 可观测、`TryRun()` 幂等
// （链校验是只读的全表扫描，重复跑没有副作用）。
//
// 与 auditretention 的两个**有意差异**（都写在判据里）：
//
//  1. **启动不立刻跑一轮**：启动路径已经做过一次全量校验（`main.go` 的
//     `RunAndRecordAuditChainCheck`），周期器再来一遍是纯粹的重复开销。
//     auditretention 立刻跑一轮是因为"停机期间到期的条目"必须马上清掉，
//     而链校验没有这个语义 —— 结论就在缓存里，一个 tick 之内不会变旧到危险。
//  2. **间隔取 1 小时**（auditretention 取 6h）：保留期以天计，而"篡改可见性"的
//     窗口直接等于间隔 ⇒ 1 小时是本包愿意付的成本上限。代价是**每 tick 一次
//     audit_logs 全表只读扫描**（默认保留 180 天，行数与表大小由保留策略约束）；
//     规模与耗时随每轮结论一起记进 `serverstore.AuditChainCheck`
//     （`Rows`/`DurationMS`），并随 `/server-info` 对外可见 —— 开销不可见就没法
//     判断该不该把间隔调长。
package auditchain

import (
	"context"
	"database/sql"
	"log"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// DefaultTick 是链校验的检查间隔（1 小时）。
//
// 与 `serverstore.AuditChainStaleAfter`（结论保质期 = 2×本值）是**一对常量**：
// stale 判据在 serverstore（读侧唯一实现），间隔在这里（调度侧唯一实现），
// 两者不能互相 import（会成环）⇒ 由本包的用例对拍断言 `2*DefaultTick == StaleAfter`。
const DefaultTick = time.Hour

// Scheduler 审计链校验调度器。
type Scheduler struct {
	db   *sql.DB
	tick time.Duration
	// onRun 是**仅测试**的观察点（每轮 TryRun 之后调用；生产恒为 nil）。
	onRun func()
	// stopped 在后台 goroutine 退出时关闭（`Stopped()` 暴露给测试与运维探针）。
	stopped chan struct{}

	mu        sync.Mutex
	started   bool
	startedAt time.Time
	runs      int64
	errors    int64
	lastRun   time.Time
	lastErr   string
	broken    int64
}

// NewScheduler 构造调度器（tick 可注入以便测试；<=0 回落 DefaultTick）。
func NewScheduler(db *sql.DB, tick time.Duration) *Scheduler {
	if tick <= 0 {
		tick = DefaultTick
	}
	return &Scheduler{db: db, tick: tick, stopped: make(chan struct{})}
}

// Stopped 在后台循环退出后关闭（仅用于关闭可观测性/测试；不要在业务路径里等待它）。
func (s *Scheduler) Stopped() <-chan struct{} { return s.stopped }

// Started 报告后台循环是否已启动。
func (s *Scheduler) Started() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.started
}

// StartedAt 返回启动时刻（零值 = 未启动）。
func (s *Scheduler) StartedAt() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.startedAt
}

// Runs 返回已执行的轮数。
func (s *Scheduler) Runs() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runs
}

// Errors 返回**校验本身失败**的轮数（"链断了"不算错误：那是校验成功得出的结论）。
func (s *Scheduler) Errors() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.errors
}

// LastRunAt 返回最近一轮的结束时刻（零值 = 未跑过）。
func (s *Scheduler) LastRunAt() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastRun
}

// Tick 返回调度间隔（装配层把它登记进调度器状态表，见 cmd/server/scheduler_status.go）。
func (s *Scheduler) Tick() time.Duration { return s.tick }

// LastError 返回最近一次校验失败的原因（空 = 没有失败过）。
func (s *Scheduler) LastError() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastErr
}

// LastBrokenID 返回最近一轮报出的断链条目 id（0 = 完好或还没跑过）。
func (s *Scheduler) LastBrokenID() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.broken
}

// Start 后台启动（ctx 取消即退出）。第一轮在**一个 tick 之后**发生：
// 启动路径已经校验过一次（见包注释的差异 1）。
func (s *Scheduler) Start(ctx context.Context) {
	if s == nil || s.db == nil {
		return
	}
	s.mu.Lock()
	s.started = true
	s.startedAt = time.Now()
	s.mu.Unlock()
	go func() {
		defer close(s.stopped)
		t := time.NewTicker(s.tick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				log.Printf("audit chain: scheduler stopped (tick=%s runs=%d errors=%d last_error=%q)",
					s.tick, s.Runs(), s.Errors(), s.LastError())
				return
			case <-t.C:
				s.TryRun()
			}
		}
	}()
}

// TryRun 执行一轮链校验：结果写进 serverstore 的结果缓存（与启动路径同一个），
// 并按结论打一条可 grep 的日志。返回 brokenID（0 = 完好）。
//
// 幂等：只读全表扫描 + 覆盖式记录，没有副作用。
func (s *Scheduler) TryRun() int64 {
	if s == nil || s.db == nil {
		return 0
	}
	start := time.Now()
	brokenID, err := serverstore.RunAndRecordPeriodicAuditChainCheck(s.db)
	s.mu.Lock()
	s.runs++
	s.lastRun = time.Now()
	s.broken = brokenID
	// "断链"不是执行错误 —— 它是**校验成功**得出的结论(发现篡改正是这个不变式的目的),
	// 所以只把"读不出来"计进 errors。判据:`VerifyAuditChain` 对断链**同时**返回
	// brokenID 与 error(既有契约),因此这里必须先看 brokenID,否则断链会被报成
	// "verify failed",R16C-03 要求的 `audit chain BROKEN` 日志就永远不会出现。
	if err != nil && brokenID == 0 {
		s.errors++
		s.lastErr = err.Error()
	}
	s.mu.Unlock()
	detail := serverstore.AuditChainStatusDetail()
	switch {
	case brokenID != 0:
		log.Printf("ERROR audit chain BROKEN at entry id=%d (periodic check: tampering or external modification); "+
			"inspect audit_logs around that id", brokenID)
	case err != nil:
		// 读不出来 ≠ 链是好的：这一轮的结论不可用,必须与"链断了"分开说。
		log.Printf("ERROR audit chain verify failed (periodic check): %v", err)
	default:
		log.Printf("audit chain verified: intact (periodic check rows=%d duration_ms=%d)",
			detail.Rows, time.Since(start).Milliseconds())
	}
	if s.onRun != nil {
		s.onRun()
	}
	return brokenID
}
