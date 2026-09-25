package reports

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// Scheduler 月度报表调度:每小时检查一次是否应补跑上月报表
// (ShouldRunMonthly:last_run 月份早于当前月份或从未运行)。
// 运行在服务端进程内,随主循环退出(不阻塞 main;ctx 取消即停止)。
type Scheduler struct {
	db    *sql.DB
	tick  time.Duration
	nowFn func() time.Time

	// —— 运行状态（R6-A-2，审计 2026-09-23，P1）——
	//
	// 缺陷形态:这个调度器此前**零可观测性** —— 既没有"是否已启动",也没有
	// "跑了几轮 / 上次何时 / 上次错误"的出口。它不再运行时(装配里那行 Start 被删、
	// 被挪进不执行的分支、goroutine 因 panic 消失)唯一的现象是"月报再也不发",
	// 而管理端只看得到 last_run 很旧。装配层(cmd/server 的 scheduler_status.go)
	// 据此把状态打进启动/关停日志与进程内状态表。
	mu        sync.Mutex
	started   bool
	startedAt time.Time
	runs      int64
	errs      int64
	lastRunAt time.Time
	lastErr   string
}

// NewScheduler 构造调度器(nowFn 可注入测试)。
func NewScheduler(db *sql.DB, tick time.Duration, nowFn func() time.Time) *Scheduler {
	if nowFn == nil {
		nowFn = time.Now
	}
	if tick <= 0 {
		tick = time.Hour
	}
	return &Scheduler{db: db, tick: tick, nowFn: nowFn}
}

// Start 后台启动(goroutine);ctx 取消后退出。
func (s *Scheduler) Start(ctx context.Context) {
	if s == nil || s.db == nil {
		return // nil db = 无事可做(也不该 panic);此时 Started() 保持 false,可观测面如实反映"没起来"
	}
	s.markStarted()
	log.Printf("reports: scheduler started (tick=%s)", s.tick)
	go func() {
		t := time.NewTicker(s.tick)
		defer t.Stop()
		for {
			s.runRound(s.tryRun())
			select {
			case <-ctx.Done():
				log.Printf("reports: scheduler stopped")
				return
			case <-t.C:
			}
		}
	}()
}

// tryRun 检查并补跑(若有订阅需要)。
//
// 返回值只用于**可观测性记账**（R6-A-2）：调用方把本轮错误记进状态表，而不是像
// 以前那样"错误只进日志、外部完全看不见"。日志文案与判定逻辑一字未改。
func (s *Scheduler) tryRun() error {
	now := s.nowFn()
	list, err := serverstore.ListReportSubscriptions(s.db)
	if err != nil {
		log.Printf("reports: list subscriptions: %v", err)
		return err
	}
	// should 的判据必须与 DispatchAll 的过滤**同一个实现**（SubscriptionDuePeriod）：
	// 修前这里是 `ShouldRunMonthly`，而 DispatchAll 无条件重推（R19B-02）；R18C-03 之后
	// 只要有一条订阅退避/待补跑，两者就会分叉。现在两侧共用一处策略：
	// 退避窗口内的订阅不再触发整轮（也就不再刷"dispatch done (ok=0 failed=N)"日志）。
	should := false
	for _, sub := range list {
		if _, due := SubscriptionDuePeriod(now, sub); due {
			should = true
			break
		}
	}
	if !should {
		return nil
	}
	ok, failed, err := DispatchAll(context.Background(), s.db, now)
	if err != nil {
		log.Printf("reports: dispatch: %v", err)
		return err
	}
	log.Printf("reports: monthly dispatch done (ok=%d failed=%d)", ok, failed)
	if failed > 0 {
		// 推送失败不是"调度器本身出错"（last_error 已按订阅落库、下月会重试），
		// 但必须让可观测面看得见 —— 否则"订阅永久发不出去"与"一切正常"同形。
		return fmt.Errorf("monthly dispatch: %d subscription(s) failed", failed)
	}
	return nil
}

// —— 可观测出口（R6-A-2）。读数全部由调度器自己记账，装配层只读不推断。——
//
// 与 internal/balance 的同名方法成对存在：两个包互不依赖，因此各留一份极小的
// 记账代码（刻意不为此新建共享包 —— 多一个包要多登记 7 处构建清单，代价远大于
// 这里重复的十几行）。

// Started 报告后台循环是否已启动。
func (s *Scheduler) Started() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.started
}

// StartedAt 返回后台循环的启动时刻（零值 = 未启动）。
func (s *Scheduler) StartedAt() time.Time {
	if s == nil {
		return time.Time{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.startedAt
}

// Runs 返回已执行的轮数（含"没有订阅需要补跑"的空转轮）。
func (s *Scheduler) Runs() int64 {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runs
}

// Errors 返回以错误结束的轮数（订阅列表读失败 / 报表生成失败 / 有订阅推送失败）。
func (s *Scheduler) Errors() int64 {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.errs
}

// LastRunAt 返回最近一轮的结束时刻（零值 = 还没跑过）。
func (s *Scheduler) LastRunAt() time.Time {
	if s == nil {
		return time.Time{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastRunAt
}

// LastError 返回最近一轮的错误文案（空串 = 最近一轮无错）。
func (s *Scheduler) LastError() string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastErr
}

// Tick 返回调度间隔（可观测面展示用）。
func (s *Scheduler) Tick() time.Duration {
	if s == nil {
		return 0
	}
	return s.tick
}

func (s *Scheduler) markStarted() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.started = true
	s.startedAt = time.Now()
}

// runRound 记一轮的执行结果。时刻取进程墙钟：它回答的是"调度器上次动是什么时候"，
// 与业务判定用的 nowFn（可注入、可造假）是两回事。
func (s *Scheduler) runRound(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.runs++
	s.lastRunAt = time.Now()
	if err != nil {
		s.errs++
		s.lastErr = err.Error()
		return
	}
	s.lastErr = ""
}
