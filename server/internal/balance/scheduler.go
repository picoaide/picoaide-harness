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
	go func() {
		t := time.NewTicker(s.tick)
		defer t.Stop()
		s.TryRun()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.TryRun()
			}
		}
	}()
}

// TryRun 检查并执行当月发放(逐人幂等;只发未领的人)。
func (s *Scheduler) TryRun() {
	settings, err := serverstore.GetBalanceSettings(s.db)
	if err != nil {
		log.Printf("balance: settings lookup: %v", err)
		return
	}
	if settings.MonthlyAmount <= 0 {
		return // 未配置额度 = 不自动发放(与闸门开关无关)
	}
	run, err := serverstore.GrantMonthlyBalance(s.db, settings.MonthlyMode, settings.MonthlyAmount, "", s.nowFn(), 0)
	if err != nil {
		log.Printf("balance: monthly grant: %v", err)
		return
	}
	if run.Granted == 0 {
		return
	}
	log.Printf("balance: monthly grant done month=%s mode=%s amount=%.2f granted=%d skipped=%d",
		run.Month, run.Mode, run.Amount, run.Granted, run.Skipped)
	_ = serverstore.AuditLog(s.db, "system", "balance_grant",
		"month="+run.Month+" mode="+run.Mode+" granted="+strconv.FormatInt(run.Granted, 10)+
			" skipped="+strconv.FormatInt(run.Skipped, 10))
}
