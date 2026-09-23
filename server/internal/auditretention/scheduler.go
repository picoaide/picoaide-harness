// Package auditretention 是审计日志保留策略（`settings audit.retention_days`）的
// **周期执行者**（R4-D-4，审计 2026-09-23，P2）。
//
// 缺陷形态（修复前）：`serverstore.PurgeOldAuditLogs` 只有两个调用点 —— 服务启动时
// （`cmd/server/main.go`）与管理员保存配置时（`serverauth/admin.go` 的
// `PutAuditSettings`）。**稳态下没有任何周期执行者**：一个跑几个月的实例只在启动那
// 一次按保留期清理，`audit.retention_days` 形同虚设（写实口径见下文"保留 180 天可配"
// 的说明），审计表会随运行时长单调增长。
//
// 形态与 `internal/reports` / `internal/balance` 的调度器一致（随 ctx 退出、可观测
// 日志、幂等）：
//   - `Start(ctx)` 在后台 goroutine 里跑，**启动先执行一轮**（进程可能停了很久，
//     堆积的超期条目不需要再等一个间隔）；
//   - ctx 取消（SIGTERM/测试收尾）即退出，`Stopped()` 可观测；
//   - `TryRun` 幂等：`PurgeOldAuditLogs` 是按 `created_at < cutoff` 的 DELETE，且保留
//     被删批次里最新的一条作为链锚（0048/0052 的哈希链语义）—— 锚在下一次运行里不会
//     再被删（DELETE 的 EXISTS 要求同批次里还有更新的行），所以重复运行不会反复删同一行。
//
// 间隔取 6 小时：保留期以**天**为单位，清理精度的意义只在"别让表无界增长"；6 小时既
// 远小于任何合理的保留期（最小 1 天），又不会给 DB 增加可感知的负担。
package auditretention

import (
	"context"
	"database/sql"
	"log"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// DefaultTick 是保留策略的检查间隔（6 小时）。
const DefaultTick = 6 * time.Hour

// Scheduler 审计保留策略调度器。
type Scheduler struct {
	db    *sql.DB
	tick  time.Duration
	nowFn func() time.Time
	// onRun 是**仅测试**的观察点（每次 TryRun 之后调用；生产恒为 nil）。
	onRun func()
	// stopped 在后台 goroutine 退出时关闭（`Stopped()` 暴露给测试与运维探针）。
	stopped chan struct{}
}

// NewScheduler 构造调度器（tick/nowFn 可注入，便于测试）。
func NewScheduler(db *sql.DB, tick time.Duration, nowFn func() time.Time) *Scheduler {
	if nowFn == nil {
		nowFn = time.Now
	}
	if tick <= 0 {
		tick = DefaultTick
	}
	return &Scheduler{db: db, tick: tick, nowFn: nowFn, stopped: make(chan struct{})}
}

// Stopped 在后台循环退出后关闭（仅用于关闭可观测性/测试；不要在业务路径里等待它）。
func (s *Scheduler) Stopped() <-chan struct{} { return s.stopped }

// Start 后台启动（ctx 取消即退出；启动先跑一轮以覆盖"停机期间到期的条目"）。
func (s *Scheduler) Start(ctx context.Context) {
	if s == nil || s.db == nil {
		return
	}
	go func() {
		defer close(s.stopped)
		t := time.NewTicker(s.tick)
		defer t.Stop()
		s.TryRun()
		for {
			select {
			case <-ctx.Done():
				log.Printf("audit retention: scheduler stopped (retention_days=%d)", serverstore.AuditRetentionDays(s.db))
				return
			case <-t.C:
				s.TryRun()
			}
		}
	}()
}

// TryRun 执行一轮清理：按当前保留期计算 cutoff 并删掉更早的审计条目。
//
// 幂等（见包注释）；返回本次删除的行数（含被保留的链锚之外的条目数）。
func (s *Scheduler) TryRun() int64 {
	if s == nil || s.db == nil {
		return 0
	}
	days := serverstore.AuditRetentionDays(s.db)
	if days <= 0 {
		// 读失败/非法值都回落默认 180（AuditRetentionDays 的既有语义），不会退化成"永不清理"。
		days = serverstore.DefaultAuditRetentionDays
	}
	cutoff := s.nowFn().Add(-time.Duration(days) * 24 * time.Hour)
	removed, err := serverstore.PurgeOldAuditLogs(s.db, cutoff)
	if err != nil {
		log.Printf("audit retention: purge failed (retention_days=%d cutoff=%s): %v",
			days, cutoff.UTC().Format(time.RFC3339), err)
		if s.onRun != nil {
			s.onRun()
		}
		return 0
	}
	if removed > 0 {
		log.Printf("audit retention: purged %d audit entr(ies) older than %s (retention_days=%d)",
			removed, cutoff.UTC().Format(time.RFC3339), days)
	}
	if s.onRun != nil {
		s.onRun()
	}
	return removed
}
