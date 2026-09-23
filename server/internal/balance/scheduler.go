// Package balance 员工余额的月度发放调度(0061/0062)。
//
// 设计(docs/planning/2026-09-11-balance-quota-consolidation.md §5.5):
//   - 服务端进程内后台循环,每 10 分钟检查一次;
//   - 幂等锚下沉到「人·月」(balance_grant_items):新入职、漏发、重新启用的
//     员工会被下一轮自动补齐,不再依赖"每北京月一条全体 UPDATE";
//   - 停机跨月后恢复:下一 tick 判定"当月未发放"即补发,不会漏月;
//   - **与 balance.enabled 解耦**:是否发放只由 monthly_amount 决定
//     (闸门开关只决定拦不拦),因此"每月发钱但先不拦人"是可选组合。
package balance

import (
	"context"
	"database/sql"
	"log"
	"strconv"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// defaultTick 发放检查间隔(新员工补发的最坏延迟)。
const defaultTick = 10 * time.Minute

// Scheduler 月度余额发放调度器。
type Scheduler struct {
	db    *sql.DB
	tick  time.Duration
	nowFn func() time.Time

	// —— 运行状态（R6-A-2，审计 2026-09-23，P1）——
	//
	// 缺陷形态:这个调度器此前**零可观测性**（没有"是否已启动",也没有
	// "跑了几轮 / 上次何时 / 上次错误"）—— 而它是**唯一的自动发放路径**
	// （另两个调用点是管理端手动 PUT /balance 与 POST /balance/grant）。
	// 它不再运行时,`balance.enabled=true` 的部署里余额只减不增,员工最终全部
	// 429 BALANCE_EXHAUSTED（全组织 AI 不可用），而没有任何闸门/告警能指出
	// "发放循环是死的"。装配层(cmd/server 的 scheduler_status.go)据此把状态
	// 打进启动/关停日志与进程内状态表。
	mu        sync.Mutex
	started   bool
	startedAt time.Time
	runs      int64
	errs      int64
	lastRunAt time.Time
	lastErr   string
}

// NewScheduler 构造调度器(tick/nowFn 可注入,便于测试)。
func NewScheduler(db *sql.DB, tick time.Duration, nowFn func() time.Time) *Scheduler {
	if nowFn == nil {
		nowFn = time.Now
	}
	if tick <= 0 {
		tick = defaultTick
	}
	return &Scheduler{db: db, tick: tick, nowFn: nowFn}
}

// Start 后台启动(ctx 取消即退出;启动先跑一次以支持停机补发)。
func (s *Scheduler) Start(ctx context.Context) {
	if s == nil || s.db == nil {
		return // nil db = 无事可做(也不该 panic);此时 Started() 保持 false,可观测面如实反映"没起来"
	}
	s.markStarted()
	log.Printf("balance: scheduler started (tick=%s)", s.tick)
	go func() {
		t := time.NewTicker(s.tick)
		defer t.Stop()
		s.TryRun()
		for {
			select {
			case <-ctx.Done():
				log.Printf("balance: scheduler stopped")
				return
			case <-t.C:
				s.TryRun()
			}
		}
	}()
}

// TryRun 检查并执行当月发放(逐人幂等;只发未领的人)。
//
// 每轮的结果（含错误文案）在此记账，供装配层/运维面读取 —— 见下方的可观测出口。
func (s *Scheduler) TryRun() {
	if s == nil || s.db == nil {
		return
	}
	s.runRound(s.tryRun())
}

// tryRun 是 TryRun 的实现体：返回错误供可观测性记账（日志文案与判定逻辑一字未改）。
func (s *Scheduler) tryRun() error {
	settings, err := serverstore.GetBalanceSettings(s.db)
	if err != nil {
		log.Printf("balance: settings lookup: %v", err)
		return err
	}
	if settings.MonthlyAmount <= 0 {
		return nil // 未配置额度 = 不自动发放(与闸门开关无关)
	}
	run, err := serverstore.GrantMonthlyBalance(s.db, settings.MonthlyMode, settings.MonthlyAmount, "", s.nowFn(), 0)
	if err != nil {
		log.Printf("balance: monthly grant: %v", err)
		return err
	}
	if run.Granted == 0 {
		return nil
	}
	log.Printf("balance: monthly grant done month=%s mode=%s amount=%.2f granted=%d skipped=%d",
		run.Month, run.Mode, run.Amount, run.Granted, run.Skipped)
	_ = serverstore.AuditLog(s.db, "system", "balance_grant",
		"month="+run.Month+" mode="+run.Mode+" granted="+strconv.FormatInt(run.Granted, 10)+
			" skipped="+strconv.FormatInt(run.Skipped, 10))
	return nil
}

// —— 可观测出口（R6-A-2）。读数全部由调度器自己记账，装配层只读不推断。——
//
// 与 internal/reports 的同名方法成对存在：两个包互不依赖，因此各留一份极小的
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

// Runs 返回已执行的轮数（含"本月已发完、无事可做"的空转轮）。
func (s *Scheduler) Runs() int64 {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runs
}

// Errors 返回以错误结束的轮数（设置读取失败 / 发放失败）。
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
