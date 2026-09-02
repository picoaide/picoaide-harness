package reports

import (
	"context"
	"database/sql"
	"log"
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
	go func() {
		t := time.NewTicker(s.tick)
		defer t.Stop()
		for {
			s.tryRun()
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
}

// tryRun 检查并补跑(若有订阅需要)。
func (s *Scheduler) tryRun() {
	now := s.nowFn()
	list, err := serverstore.ListReportSubscriptions(s.db)
	if err != nil {
		log.Printf("reports: list subscriptions: %v", err)
		return
	}
	should := false
	for _, sub := range list {
		if !sub.Enabled {
			continue
		}
		if ShouldRunMonthly(now, sub.LastRunAt) {
			should = true
			break
		}
	}
	if !should {
		return
	}
	ok, failed, err := DispatchAll(context.Background(), s.db, now)
	if err != nil {
		log.Printf("reports: dispatch: %v", err)
		return
	}
	log.Printf("reports: monthly dispatch done (ok=%d failed=%d)", ok, failed)
}
