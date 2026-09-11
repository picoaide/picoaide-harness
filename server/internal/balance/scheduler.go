// Package balance 员工余额的月度发放调度(0061)。
//
// 设计:
//   - 服务端进程内后台循环(与 reports 月度调度同构),每小时检查一次;
//   - 幂等锚在 DB(balance_grants.month),跨实例/重启/重入只会发放一次;
//   - 停机跨月后恢复:下一个 tick 判定"当月未发放"即补发,不会漏月;
//   - 只有 balance.enabled 且月度额度 > 0 时才自动发放(管理员显式开启,
//     避免存量部署升级后静默改余额)。
package balance

import (
	"context"
	"database/sql"
	"log"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

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
		tick = time.Hour
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

// TryRun 检查并执行当月发放(幂等)。
func (s *Scheduler) TryRun() {
	settings, err := serverstore.GetBalanceSettings(s.db)
	if err != nil {
		log.Printf("balance: settings lookup: %v", err)
		return
	}
	if !settings.Enabled || settings.MonthlyAmount <= 0 {
		return
	}
	grant, granted, err := serverstore.GrantMonthlyBalance(s.db, settings.MonthlyMode, settings.MonthlyAmount, "", s.nowFn())
	if err != nil {
		log.Printf("balance: monthly grant: %v", err)
		return
	}
	if !granted {
		return
	}
	log.Printf("balance: monthly grant done month=%s mode=%s amount=%.2f affected=%d",
		grant.Month, grant.Mode, grant.Amount, grant.Affected)
	_ = serverstore.AuditLog(s.db, "system", "balance_grant",
		"month="+grant.Month+" mode="+grant.Mode+" affected="+itoa(grant.Affected))
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
