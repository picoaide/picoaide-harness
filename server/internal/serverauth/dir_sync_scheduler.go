package serverauth

// DirectorySyncScheduler 是「LDAP 目录全量同步」的后台维护者（R19B-05，审计
// 2026-09-25，P2）。
//
// 缺陷形态：此前它是 main() 里的一行裸 goroutine
// （`go serverauth.SyncDirectoryLoop(db, serverauth.LDAPSyncInterval, nil)`）——
// 与 llmgateway.SyncLoop 并列的两条**唯一**没有 ctx/停止信号、没有运行状态、
// 也没进 scheduler_status.go、且没有任何装配断言的循环。它死掉时的现象是
// **离职账号不自动停用、入职不开通、组变化不反映**（管理员只能手点"立即同步"），
// 而启动日志与状态表里一切照常。
//
// 形态与 internal/{reports,balance} 及 llmgateway.ModelSyncScheduler 逐字同构：
// 自己记账，装配层（cmd/server 的 background_sync.go 接缝）只读不推断，
// 由 cmd/server 的装配级用例钉住 main() 里那一行。

import (
	"context"
	"database/sql"
	"log"
	"sync"
	"time"
)

// DirectorySyncScheduler 是目录同步循环的可观测封装。
type DirectorySyncScheduler struct {
	db     *sql.DB
	tick   time.Duration
	runner DirectorySyncRunner

	mu        sync.Mutex
	started   bool
	startedAt time.Time
	runs      int64
	errs      int64
	lastRunAt time.Time
	lastErr   string
}

// NewDirectorySyncScheduler 构造调度器（tick<=0 回落 LDAPSyncInterval；runner 为
// nil 时用生产实现 LDAPDirectorySync）。db 为 nil ⇒ no-op 且 Started() 保持 false。
func NewDirectorySyncScheduler(db *sql.DB, tick time.Duration, runner DirectorySyncRunner) *DirectorySyncScheduler {
	if tick <= 0 {
		tick = LDAPSyncInterval
	}
	return &DirectorySyncScheduler{db: db, tick: tick, runner: runner}
}

// Start 后台启动：启动先跑一轮，之后每 tick 一次；ctx 取消即退出。
//
// 修前的 `for { …; time.Sleep(interval) }` 既不看 ctx（关停停不下来）也不记账。
func (s *DirectorySyncScheduler) Start(ctx context.Context) {
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

// TryRun 执行一轮并记账（导出以便装配级/单元级判据直接调）。日志文案与修前一致。
func (s *DirectorySyncScheduler) TryRun() {
	if s == nil || s.db == nil {
		return
	}
	err := syncDirectoryOnceLogged(s.db, s.runner)
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

// syncDirectoryOnceLogged 执行一轮目录同步并把结果/错误写进日志（修前 SyncDirectoryLoop
// 的循环体逐字搬到这里，唯一增量是把错误返回给调用方记账）。
func syncDirectoryOnceLogged(db *sql.DB, runner DirectorySyncRunner) error {
	if runner == nil {
		runner = LDAPDirectorySync{}
	}
	res, err := runner.Run(db)
	if err != nil {
		log.Printf("ldap directory sync: %v", err)
		return err
	}
	if res.Added > 0 || res.Deact > 0 || res.Updated > 0 {
		log.Printf("ldap directory sync: +%d updated=%d deactivated=%d", res.Added, res.Updated, res.Deact)
	}
	return nil
}

func (s *DirectorySyncScheduler) markStarted() {
	s.mu.Lock()
	s.started = true
	s.startedAt = time.Now()
	s.mu.Unlock()
}

// —— 可观测出口（装配层只读）。nil 接收者一律返回零值 ——

// Started 报告后台循环是否已启动。
func (s *DirectorySyncScheduler) Started() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.started
}

// StartedAt 返回启动时刻（零值 = 未启动）。
func (s *DirectorySyncScheduler) StartedAt() time.Time {
	if s == nil {
		return time.Time{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.startedAt
}

// Runs 返回已执行的轮数。
func (s *DirectorySyncScheduler) Runs() int64 {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runs
}

// Errors 返回以错误结束的轮数。
func (s *DirectorySyncScheduler) Errors() int64 {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.errs
}

// LastRunAt 返回最近一轮的结束时刻（零值 = 未跑过）。
func (s *DirectorySyncScheduler) LastRunAt() time.Time {
	if s == nil {
		return time.Time{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastRunAt
}

// LastError 返回最近一轮的错误文案（空串 = 最近一轮无错）。
func (s *DirectorySyncScheduler) LastError() string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastErr
}

// Tick 返回调度间隔。
func (s *DirectorySyncScheduler) Tick() time.Duration {
	if s == nil {
		return 0
	}
	return s.tick
}
