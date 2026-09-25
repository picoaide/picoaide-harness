package llmgateway

// ModelSyncScheduler 是「渠道模型自动同步 + pending usage 回收」的后台维护者
// （R19B-05，审计 2026-09-25，P2）。
//
// 缺陷形态：此前它是 main() 里的一行裸 goroutine
//（`go llmgateway.SyncLoop(db, time.Hour, nil)`）——**唯一**一条没有 ctx/停止信号、
// 没有运行状态（started/runs/last_error）、也没进 scheduler_status.go、且没有任何
// 装配断言的后台循环之一。它死掉时（那行被删/被挪进不执行的分支/goroutine 因 panic
// 消失）唯一的现象是"上游模型目录不再变化"，而更隐蔽的后果是
// **`serverstore.CleanupPendingUsage` 的周期执行者一起消失**（它是中断流 0-token
// pending 行唯一的闸门，见 SyncIteration 的注释）。
//
// 因此形态与 internal/{reports,balance} 的两个调度器**逐字同构**：自己记账
//（started/startedAt/runs/errors/lastRunAt/lastErr），装配层（cmd/server 的
// background_sync.go 接缝）只读不推断，并由 cmd/server 的装配级用例钉住
// "main() 真的调用、拿到启动期 ctx 与同一个 db"。
//
// 为什么不做成共享包：reports/balance 各自留了一份同样的十几行记账（多一个包要多
// 登记 7 处构建清单，代价远大于重复），这里沿用同一取舍。

import (
	"context"
	"database/sql"
	"sync"
	"time"
)

// ModelSyncScheduler 是模型同步循环的可观测封装。
type ModelSyncScheduler struct {
	db      *sql.DB
	tick    time.Duration
	fetchFn func(url string) ([]byte, error)

	mu        sync.Mutex
	started   bool
	startedAt time.Time
	runs      int64
	errs      int64
	lastRunAt time.Time
	lastErr   string
}

// NewModelSyncScheduler 构造调度器（tick<=0 回落 1 小时；fetchFn 为 nil 时
// SyncOnce 用真实出站）。db 为 nil ⇒ Start/TryRun 都是 no-op、Started() 保持 false
// （可观测面如实反映"没起来"，与其它装配接缝同口径）。
func NewModelSyncScheduler(db *sql.DB, tick time.Duration, fetchFn func(url string) ([]byte, error)) *ModelSyncScheduler {
	if tick <= 0 {
		tick = time.Hour
	}
	return &ModelSyncScheduler{db: db, tick: tick, fetchFn: fetchFn}
}

// Start 后台启动：**启动先跑一轮**（覆盖停机期间），之后每 tick 一次；ctx 取消即退出。
//
// 与修前的 `for { syncIterationLogged(); time.Sleep(interval) }` 的两处关键差别：
//   - 用 `select` 等 ticker/ctx ⇒ **可停止**（修前那个 for 永远不会退出，
//     `time.Sleep` 也不看 ctx：进程关停时它一直挂到进程被杀；测试里更是无法回收）；
//   - 每一轮都记账（Started/StartedAt/Runs/Errors/LastRunAt/LastError），
//     "这条循环是死的"从此有出口。
func (s *ModelSyncScheduler) Start(ctx context.Context) {
	if s == nil || s.db == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s.markStarted()
	go func() {
		t := time.NewTicker(s.tick)
		defer t.Stop()
		for {
			s.TryRun()
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
}

// TryRun 执行一轮并记账（导出让装配级/单元级判据直接调，不必起 goroutine + sleep）。
//
// 轮的语义与修前逐字一致：`SyncIteration`（先清理过期 pending usage，再同步渠道模型）
// ＋ 顶层与逐 provider 的错误日志（syncIterationLogged）。唯一的增量是**返回并把
// 错误记账**，日志文案与判定一字未改。
func (s *ModelSyncScheduler) TryRun() {
	if s == nil || s.db == nil {
		return
	}
	err := syncIterationLogged(s.db, s.fetchFn)
	s.mu.Lock()
	s.runs++
	s.lastRunAt = time.Now()
	if err != nil {
		s.errs++
		s.lastErr = err.Error()
	} else {
		s.lastErr = ""
	}
	s.mu.Unlock()
}

func (s *ModelSyncScheduler) markStarted() {
	s.mu.Lock()
	s.started = true
	s.startedAt = time.Now()
	s.mu.Unlock()
}

// —— 可观测出口（装配层只读）。nil 接收者一律返回零值 ——

// Started 报告后台循环是否已启动。
func (s *ModelSyncScheduler) Started() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.started
}

// StartedAt 返回启动时刻（零值 = 未启动）。
func (s *ModelSyncScheduler) StartedAt() time.Time {
	if s == nil {
		return time.Time{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.startedAt
}

// Runs 返回已执行的轮数。
func (s *ModelSyncScheduler) Runs() int64 {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runs
}

// Errors 返回以错误结束的轮数。
func (s *ModelSyncScheduler) Errors() int64 {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.errs
}

// LastRunAt 返回最近一轮的结束时刻（零值 = 未跑过）。
func (s *ModelSyncScheduler) LastRunAt() time.Time {
	if s == nil {
		return time.Time{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastRunAt
}

// LastError 返回最近一轮的错误文案（空串 = 最近一轮无错）。
func (s *ModelSyncScheduler) LastError() string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastErr
}

// Tick 返回调度间隔。
func (s *ModelSyncScheduler) Tick() time.Duration {
	if s == nil {
		return 0
	}
	return s.tick
}
