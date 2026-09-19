// Package opens 是 WASM 应用**打开计数**（F16）的后台维护者：日汇总 upsert + 明细过期清理。
//
// 为什么必须有它（R2I-8 的 finding 原文：「0075 只有 DDL 没有维护者」）：
// 迁移 0075 只建了两张表，而 §8.9 的口径是"明细 90 天、日汇总长期保留"——
// 没有作业，明细会无限增长（隐私与体量双输），日汇总永远是空的（管理端看板全零，
// 而"全零"与"真的没人用"在数据上长得一样）。
//
// 调度范式照 `internal/balance`（进程内 ticker + 启动先跑一次 + 幂等重算）：
// 不引入外部调度器、不依赖 cron，停机期间的窗口由下一轮 tick 自然补齐
// （因为汇总本身是**按天全量重算**，不是增量累加 —— 漏跑一轮不会丢数据）。
//
// ⚠️ 两条硬不变量（改这个文件时先读它们）：
//
//	① **先汇总后清理**：`Purge` 只在 `Aggregate` 成功之后执行。反过来会让被删掉的
//	   那一窗明细的 UV 永久丢失（明细是 UV 的唯一来源，汇总表只有聚合结果）。
//	② **汇总只覆盖仍可能变化的日子与待删区间**：每次 tick 重算
//	   `[最早明细, cutoff]`（即将被删的那一段）与 `[today-2d, today]`（仍在写入的
//	   那两天）—— 前者的起点是**实际最早行**而不是固定窗口（见 TryRun 的注释：
//	   固定窗口会漏掉积压的旧数据），后者覆盖"今天"与"昨天跨零点的尾巴"。
//	   不整窗重算 90 天是为了让每轮代价与"超出保留期的行数 + 两天的量"成正比，
//	   而不是与"90 天的总量"成正比（否则这个作业会随平台使用量线性变贵）。
package opens

import (
	"context"
	"database/sql"
	"log"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// defaultTick 是维护间隔。
//
// 5 分钟：看板按天看趋势，分钟级延迟没有意义；而每次 tick 只重算 4~5 天，
// 代价恒定且小。取更长的间隔（如 1 小时）会让"今天"的数字在大部分时间里是陈旧的，
// 管理员打开面板时看到的是过期数据。
const defaultTick = 5 * time.Minute

// DefaultTick 返回默认维护间隔（装配层用它，避免把常量再抄一遍）。
func DefaultTick() time.Duration { return defaultTick }

// Scheduler 是打开计数的维护调度器。
type Scheduler struct {
	db     *sql.DB
	tick   time.Duration
	nowFn  func() time.Time
	logger func(format string, args ...any)
}

// NewScheduler 构造调度器（tick/nowFn/logger 可注入，便于测试与装配）。
func NewScheduler(db *sql.DB, tick time.Duration, nowFn func() time.Time) *Scheduler {
	if nowFn == nil {
		nowFn = time.Now
	}
	if tick <= 0 {
		tick = defaultTick
	}
	return &Scheduler{db: db, tick: tick, nowFn: nowFn, logger: log.Printf}
}

// Start 后台启动（ctx 取消即退出；启动先跑一次，支持停机补齐）。
func (s *Scheduler) Start(ctx context.Context) {
	if s == nil || s.db == nil {
		return
	}
	go func() {
		t := time.NewTicker(s.tick)
		defer t.Stop()
		s.TryRun(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.TryRun(ctx)
			}
		}
	}()
}

// TryRun 执行一轮"先汇总后清理"。任何失败都只记日志（计数维护不能影响服务可用性）。
func (s *Scheduler) TryRun(ctx context.Context) {
	if s == nil || s.db == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	now := s.nowFn().UTC()
	cutoff := now.AddDate(0, 0, -serverstore.WasmAppOpensRetentionDays)

	// ---- ① 先汇总 ----
	// (a) **待删区间**：从明细里最早的一行到保留期边界。这一段正是接下来要 DELETE
	//     掉的行——不先汇总就等于把它们的 UV 永久丢掉（明细是 UV 的唯一来源）。
	//
	//     为什么起点取"实际最早行"而不是固定窗口：停机/降级期间明细会积压，
	//     固定窗口（例如边界前后各一天）会把更早的那批直接删掉而从不汇总
	//     （实测形态：100 天前的明细被清，日汇总恒为 0，且没有任何报错）。
	//     代价与"超出保留期的行数"成正比 —— 稳态下每轮只多算一天的量级。
	oldest, hasOld, oerr := serverstore.OldestWasmAppOpen(ctx, s.db)
	if oerr != nil {
		s.warnf("opens: 查最早明细失败，本轮不清理（先汇总后清理）: %v", oerr)
		return
	}
	if hasOld && oldest.Before(cutoff) {
		if _, err := serverstore.AggregateWasmAppOpens(ctx, s.db, oldest, cutoff); err != nil {
			s.warnf("opens: 待删区间汇总失败，本轮不清理（先汇总后清理）: %v", err)
			return
		}
	}
	// (b) 活动窗：今天（仍在写入）与昨天（跨零点写入的尾巴）——
	//     这两天的数字随时在变，每轮都要重算（汇总本身是按天全量覆盖，幂等）。
	if _, err := serverstore.AggregateWasmAppOpens(ctx, s.db, now.AddDate(0, 0, -2), now); err != nil {
		s.warnf("opens: 活动窗汇总失败，本轮不清理: %v", err)
		return
	}

	// ---- ② 后清理 ----
	deleted, err := serverstore.PurgeWasmAppOpens(ctx, s.db, cutoff)
	if err != nil {
		s.warnf("opens: 明细清理失败（不影响服务，下轮重试）: %v", err)
		return
	}
	if deleted > 0 {
		s.logf("opens: 明细清理完成 cutoff=%s deleted=%d", cutoff.Format(time.RFC3339), deleted)
	}
}

func (s *Scheduler) logf(format string, args ...any) {
	if s.logger != nil {
		s.logger(format, args...)
	}
}

func (s *Scheduler) warnf(format string, args ...any) { s.logf(format, args...) }
