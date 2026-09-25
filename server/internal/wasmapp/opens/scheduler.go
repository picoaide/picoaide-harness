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
//	   `[最早明细, 保留期边界日]`（即将被删的那一段）与 `[today-2d, today]`（仍在写入的
//	   那两天）—— 前者的起点是**实际最早行**而不是固定窗口（见 TryRun 的注释：
//	   固定窗口会漏掉积压的旧数据），终点是**日边界**（见 ③）；后者覆盖"今天"与
//	   "昨天跨零点的尾巴"。
//	   不整窗重算 90 天是为了让每轮代价与"超出保留期的行数 + 两天的量"成正比，
//	   而不是与"90 天的总量"成正比（否则这个作业会随平台使用量线性变贵）。
//	③ **保留期是整日粒度**（R19B-01，审计 2026-09-25，P1，**不可逆**）：`purgeBefore`
//	   是保留期边界**那一天**的本地 00:00，汇总上界与清理边界用**同一个值** ⇒ 明细
//	   永远整日一起删，日汇总（整日分桶 + 全量覆盖）不会被"半天明细"重算覆盖而缩水。
//	   判据：日汇总在维护过程中只能变大不能变小
//	   （scheduler_test.go 的 TestSchedulerKeepsDailyRollupAcrossRetentionBoundary）。
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
	// ⚠️ R19B-01（审计 2026-09-25，P1，**不可逆的数据损坏**）：清理边界与汇总上界
	// 必须**一起对齐到本地日边界**。修前这里是裸瞬时 cutoff = now-90d（落在某一天
	// 的正中间），而 `AggregateWasmAppOpens` 是**整日分桶 + 全量覆盖**
	// （ON CONFLICT DO UPDATE SET pv = EXCLUDED.pv）⇒ 清理把边界那一天**只删一半**
	// 之后，下一轮从"剩下的那半天"重算并覆盖同一天，日汇总逐轮缩水；等 cutoff 扫过
	// 该日，明细已删完 ⇒ 长期保留的日汇总永久停在"最后一个 5 分钟 tick 的量"
	// （真 PG 实测：一天 4 次打开 → pv=1，管理端趋势/TOP N 少报约两个数量级，
	// 且**没有任何报错**；历史已坏的行补不回来）。
	//
	// 两条口径（改这里时先读，缺一条就复发）：
	//  ① `purgeBefore` = 保留期边界**那一天**的本地 00:00（唯一真源
	//     serverstore.LocalDay）—— Purge 只删**严格早于**它的行 ⇒ 明细永远**整日
	//     一起删**，不存在"某天被删掉一半"的中间态（那正是缩水的必要条件）；
	//  ② 汇总上界与它**同一个值**，且判据放宽到"最早明细落在边界日或更早"：
	//     Aggregate 的日循环是**闭区间**（含 `LocalDay(toDay)`），所以
	//     `Aggregate(oldest, purgeBefore)` 恰好把"边界日"也整日汇总进去 —— 那一天
	//     正是下一个日界将要整日删除的。保留期语义因此是"整 90 天 + 不足 1 天"，
	//     这是日粒度保留的固有形态（0075/0076 的用例用的就是日对齐 cutoff）。
	//
	// 不变量（判据：scheduler_test.go 的 TestSchedulerKeepsDailyRollupAcrossRetentionBoundary
	// ＋ 复现探针）：**日汇总在维护过程中只能变大不能变小**；出现"被更小的值覆盖"
	// 就意味着某一天曾被部分删除过。
	purgeBefore := serverstore.LocalDay(now.AddDate(0, 0, -serverstore.WasmAppOpensRetentionDays))

	// ---- ① 先汇总 ----
	// (a) **待删区间**：从明细里最早的一行到保留期边界**日**（含边界日）。这一段正是
	//     接下来要 DELETE 掉的行——不先汇总就等于把它们的 UV 永久丢掉（明细是 UV 的唯一来源）。
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
	// 判据放宽到边界日"之内或更早"：边界日当天（oldest 尚未越过 purgeBefore）也必须
	// 被整日汇总 —— 它是下一个日界整日删除的对象，而 Aggregate 的闭区间恰好覆盖它。
	// 若 earliest 已在边界日之后（全新部署/无积压），整个区间无行可算，跳过以省查询。
	if hasOld && oldest.Before(purgeBefore.AddDate(0, 0, 1)) {
		if _, err := serverstore.AggregateWasmAppOpens(ctx, s.db, oldest, purgeBefore); err != nil {
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
	// 与汇总上界**同一个值**（整日边界）：先汇总后清理这条不变量因此仍然成立 ——
	// 被删的每一行都属于"本轮已整日汇总过"的那一天。
	deleted, err := serverstore.PurgeWasmAppOpens(ctx, s.db, purgeBefore)
	if err != nil {
		s.warnf("opens: 明细清理失败（不影响服务，下轮重试）: %v", err)
		return
	}
	if deleted > 0 {
		s.logf("opens: 明细清理完成 purgeBefore=%s deleted=%d", purgeBefore.Format(time.RFC3339), deleted)
	}
}

func (s *Scheduler) logf(format string, args ...any) {
	if s.logger != nil {
		s.logger(format, args...)
	}
}

func (s *Scheduler) warnf(format string, args ...any) { s.logf(format, args...) }
