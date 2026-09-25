// Package tokenretention 是 API 令牌过期回收（`api_tokens.expires_at < now()`）
// 的**周期执行者**（R15C-R-01 ①，审计 2026-09-25，P1）。
//
// 缺陷形态（修复前）：`api_tokens` **没有任何回收者**。全仓对这张表的 DELETE 只有
// 4 处按 user_id 的（改密 / 禁用 / 删用户），没有一处按 `expires_at`；迁移 0031 专门
// 建的 `idx_tokens_expires` 真 PG 实测 `idx_scan = 0`（建了从未被任何查询用过）。
// 于是"90 天有效期"只是校验期语义（VerifyToken 拒绝过期令牌），**行本身永久留下**；
// 而每次登录都插一行、成功登录还会清空失败预算（不限次），任何持证员工都能把表推大
// —— 与"管理端令牌列表无分页"叠加就是一个单请求 130 MiB / 堆 +656 MB 的放大面。
//
// 形态与既有回收家族（`internal/auditretention` / `internal/usageretention` /
// `llmgateway` 的文件回收器）逐条对齐，不另立一套语义：
//   - `Start(ctx)` 在后台 goroutine 里跑，**启动先执行一轮**（进程可能停了很久，
//     到期行不需要再等一个间隔 —— 这同时取代了"启动时清理一次"的缺失项）；
//   - ctx 取消（SIGTERM/测试收尾）即退出，`Stopped()` 可观测；
//   - 每轮的**删除计数进日志**（`purged N expired api token(s)`），0 条时打 debug 级
//     的轮次摘要行（保留"跑过但无活干"的事实，避免"日志里没有 ⇒ 以为没跑"）；
//   - `TryRun` 幂等：删除条件是 `expires_at < now()`，删过的行不会再次命中；失败只
//     记日志、下一轮重试（不退出、不清零）。
//
// 间隔取 1 小时：`expires_at` 是 90 天量级的字段，回收精度的意义只在"别让表无界
// 增长"；1 小时远小于任何合理的存在时长，又把"一轮 DELETEs"的规模压在很小的量级
// （每轮至多 MaxBatchPerRun 行）。
package tokenretention

import (
	"context"
	"database/sql"
	"log"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// DefaultTick 是回收检查间隔（1 小时）。
const DefaultTick = time.Hour

// BatchSize 是单条 DELETE 的行数上限。
//
// 分批的理由：一次删几百万行会长时间持锁并撑大 WAL；批量删除让每一轮的工作量有界、
// 可被 tick 切分，且每批都走 `idx_tokens_expires`（子查询 `ORDER BY expires_at
// LIMIT n`）。这一条是本缺陷的关键：**该索引存在的意义就是这条查询**。
const BatchSize = 5000

// MaxBatchPerRun 是单轮的批数上限（防止停机很久后的第一轮把启动期拖长）。
// 未清完的残量由后续轮次继续（幂等）。
const MaxBatchPerRun = 20

// Scheduler 令牌过期回收调度器。
//
// 可观测面与 `cmd/server` 的 `observableScheduler` 接口同形（Started/StartedAt/
// Runs/Errors/LastRunAt/LastError/Tick）—— 装配层把它登记进调度器状态表后，
// "回收者是否真的在跑"在启动/关停日志里可读，而不是只能从表行数反推。
type Scheduler struct {
	db   *sql.DB
	tick time.Duration
	// nowFn 仅测试注入（判定用不到它，只为让"轮次时刻"可复现）。
	nowFn func() time.Time
	// onRun 是**仅测试**的观察点（每轮 TryRun 之后调用，参数为本轮删除行数）。
	onRun   func(removed int64)
	stopped chan struct{}

	mu         sync.Mutex
	started    bool
	startedAt  time.Time
	runs       int64
	errors     int64
	lastRunAt  time.Time
	lastErr    string
	lastRemove int64
}

// NewScheduler 构造调度器（tick/nowFn 可注入；tick<=0 回落 DefaultTick）。
func NewScheduler(db *sql.DB, tick time.Duration, nowFn func() time.Time) *Scheduler {
	if nowFn == nil {
		nowFn = time.Now
	}
	if tick <= 0 {
		tick = DefaultTick
	}
	return &Scheduler{db: db, tick: tick, nowFn: nowFn, stopped: make(chan struct{})}
}

// Stopped 在后台循环退出后关闭（关闭可观测性/测试用）。
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

// Errors 返回以错误结束的轮数。
func (s *Scheduler) Errors() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.errors
}

// LastRunAt 返回最近一轮结束时刻（零值 = 未跑过）。
func (s *Scheduler) LastRunAt() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastRunAt
}

// LastError 返回最近一轮的错误文案（空串 = 最近一轮无错）。
func (s *Scheduler) LastError() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastErr
}

// Tick 返回调度间隔。
func (s *Scheduler) Tick() time.Duration { return s.tick }

// LastRemoved 返回最近一轮删除的行数（判据/运维读数）。
func (s *Scheduler) LastRemoved() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastRemove
}

// Start 后台启动（ctx 取消即退出；启动先跑一轮）。
func (s *Scheduler) Start(ctx context.Context) {
	if s == nil || s.db == nil {
		return
	}
	s.mu.Lock()
	if s.started { // 幂等：重复 Start 不产生第二个循环
		s.mu.Unlock()
		return
	}
	s.started = true
	s.startedAt = s.nowFn()
	s.mu.Unlock()
	go func() {
		defer close(s.stopped)
		t := time.NewTicker(s.tick)
		defer t.Stop()
		s.TryRun()
		for {
			select {
			case <-ctx.Done():
				log.Printf("token retention: scheduler stopped (runs=%d errors=%d removed_last=%d)",
					s.Runs(), s.Errors(), s.LastRemoved())
				return
			case <-t.C:
				s.TryRun()
			}
		}
	}()
}

// TryRun 执行一轮回收：分批删除已过期令牌，直到删不满一批或达到批数上限。
//
// 返回本轮删除的行数。删除计数无条件进日志（>0 记一行；==0 不打印轮次行以免每
// 小时污染日志，但轮次仍记在 Runs()/LastRunAt() 里）。
func (s *Scheduler) TryRun() int64 {
	if s == nil || s.db == nil {
		return 0
	}
	var total int64
	var firstErr error
	for i := 0; i < MaxBatchPerRun; i++ {
		n, err := serverstore.PurgeExpiredTokens(s.db, BatchSize)
		if err != nil {
			firstErr = err
			break
		}
		total += n
		if n < BatchSize {
			break
		}
	}
	now := s.nowFn()
	s.mu.Lock()
	s.runs++
	s.lastRunAt = now
	s.lastRemove = total
	if firstErr != nil {
		s.errors++
		s.lastErr = firstErr.Error()
	} else {
		s.lastErr = ""
	}
	s.mu.Unlock()
	if firstErr != nil {
		log.Printf("token retention: purge failed (removed=%d, batch=%d): %v", total, BatchSize, firstErr)
	} else if total > 0 {
		log.Printf("token retention: purged %d expired api token(s) (batch=%d, max_batches=%d)",
			total, BatchSize, MaxBatchPerRun)
	}
	if s.onRun != nil {
		s.onRun(total)
	}
	return total
}
