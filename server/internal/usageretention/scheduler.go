// Package usageretention 是 usage 明细保留策略（`settings usage.retention_months`）
// 的**周期执行者**（R5-A-11，审计 2026-09-23，P1）。
//
// 缺陷形态（修复前）：`serverstore.CleanupUsageRetention` 只有两个调用点 ——
// 服务启动时（`cmd/server/main.go`）与管理员保存保留期时
// （`llmgateway/admin.go` 的 `PUT /api/server/admin/gateway`）。**稳态下没有
// 任何周期执行者**：一个常年不重启、不改配置的实例里，超期月分区与明细永不
// 删除（磁盘随经过的北京月数单调增长），而 `usage.retention_months` 在 webadmin
// 与文档里的承诺是"到期 DROP 分区"。**同一缺陷形态在审计侧已由
// `internal/auditretention` 修好（R4-D-4），usage 侧当时漏掉了** —— 所以本包
// 的形态与它逐条对齐（这是刻意的：两个保留策略的执行者不允许有两套语义）。
//
// 形态：
//   - `Start(ctx)` 在后台 goroutine 里跑，**启动先执行一轮**（进程可能停了很久，
//     堆积的超期分区不需要再等一个间隔；它同时取代原先"启动时清理一次"的那次调用）；
//   - ctx 取消（SIGTERM/测试收尾）即退出，`Stopped()` 可观测；
//   - `TryRun` 幂等：`CleanupUsageRetention` 是"枚举实际存在的月关系 → 对早于
//     cutoff 的逐个补账后 DETACH+DROP"，重复执行不会重复删同一分区，也不会因为
//     已经没有可删的分区而报错；
//   - 失败只记日志、**下一轮重试**（不清零、不退出）。
//
// 间隔取 6 小时：保留期的单位是**月**，清理精度的意义只在"别让表无界增长"；
// 6 小时远小于任何合理的保留期（最小 1 个月），又不会给 DB 增加可感知的负担
// （一轮的量级 = 当月新增分区数 + 需要补账的过期月数）。
package usageretention

import (
	"context"
	"database/sql"
	"log"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// DefaultTick 是保留策略的检查间隔（6 小时，与 auditretention.DefaultTick 同值）。
const DefaultTick = 6 * time.Hour

// Scheduler usage 明细保留策略调度器。
type Scheduler struct {
	db   *sql.DB
	tick time.Duration
	// onRun 是**仅测试**的观察点（每次 TryRun 之后调用，带本轮的错误；生产恒为 nil）。
	onRun func(err error)
	// stopped 在后台 goroutine 退出时关闭（`Stopped()` 暴露给测试与运维探针）。
	stopped chan struct{}
}

// NewScheduler 构造调度器（tick 可注入，便于测试；<=0 回落 DefaultTick）。
func NewScheduler(db *sql.DB, tick time.Duration) *Scheduler {
	if tick <= 0 {
		tick = DefaultTick
	}
	return &Scheduler{db: db, tick: tick, stopped: make(chan struct{})}
}

// Stopped 在后台循环退出后关闭（仅用于关闭可观测性/测试；不要在业务路径里等待它）。
func (s *Scheduler) Stopped() <-chan struct{} { return s.stopped }

// Start 后台启动（ctx 取消即退出；启动先跑一轮以覆盖"停机期间到期的分区"）。
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
				log.Printf("usage retention: scheduler stopped (retention_months=%d)",
					retentionMonthsForLog(s.db))
				return
			case <-t.C:
				s.TryRun()
			}
		}
	}()
}

// TryRun 执行一轮清理：按当前保留期 DROP 早于 cutoff 的明细月分区。
//
// 幂等（见包注释）；失败只记日志并返回错误（调用方/下一轮继续重试）。
func (s *Scheduler) TryRun() error {
	if s == nil || s.db == nil {
		return nil
	}
	err := serverstore.CleanupUsageRetention(s.db)
	if err != nil {
		log.Printf("usage retention: cleanup failed (retention_months=%d): %v",
			retentionMonthsForLog(s.db), err)
	} else {
		log.Printf("usage retention: round done (retention_months=%d)", retentionMonthsForLog(s.db))
	}
	if s.onRun != nil {
		s.onRun(err)
	}
	return err
}

// retentionMonthsForLog 只用于日志/可观测性：读失败回落默认值（不影响清理本身
// —— CleanupUsageRetention 内部对非法/缺失配置有自己的回落语义）。
func retentionMonthsForLog(db *sql.DB) int {
	n, err := serverstore.EffectiveRetentionMonths(db)
	if err != nil {
		return serverstore.DefaultRetentionMonths
	}
	return n
}
