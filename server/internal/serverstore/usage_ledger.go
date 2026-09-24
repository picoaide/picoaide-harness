package serverstore

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"
)

// RetentionMonthsSetting 明细保留月数(settings 键):
//
//	缺省/非法 = 6 个月;>0 = 保留 N 个月;0 = 永不删除;最大值 120。
const RetentionMonthsSetting = "usage.retention_months"

// DefaultRetentionMonths 默认保留月数(用户要求:默认 6 个月)。
const DefaultRetentionMonths = 6

// maxRetentionMonths 后台可配置上限(10 年)。
const maxRetentionMonths = 120

// monthKey 返回 YYYYMM 字符串(如 202608)。
func monthKey(t time.Time) string {
	return t.Format("200601")
}

// yearKey 返回 YYYY 字符串。
func yearKey(t time.Time) string {
	return t.Format("2006")
}

// ensureUsagePartition 幂等创建某月的 usage 分区(如 usage_202608)。
// 写路径(RecordUsage*)与账本生成均先调用,保证当月分区存在。
// ensureUsagePartition guarantees the month partition exists before a usage
// row is written. 2026-09-08 P2-7: the hot path used to run
// `CREATE TABLE IF NOT EXISTS ... PARTITION OF` on EVERY recorded call (the
// 2000-concurrency profile named this DDL a DB bottleneck). It now does a
// cheap catalog probe (to_regclass, a syscache lookup) and only issues the DDL
// when the partition is actually missing — correct across databases, unlike a
// process-global month cache (each test uses its own temp database).
//
// P1-3(审计 2026-09-12):「探测 → 建表」之间没有锁,月初并发请求会同时判定
// "分区不存在",后者报 42P07(IF NOT EXISTS 的存在性检查用语句快照,挡不住
// 另一会话刚提交的同名分区)→ 该请求整条 usage 不落账(未计费的 200)。
// 名字被抢占即达到目的,42P07 视为成功;但必须复检占用者是真分区,不能把
// F11 的同名孤儿表一起吞掉。
func ensureUsagePartition(db *sql.DB, month time.Time) error {
	// F11(审计 2026-09-11):探测必须区分「真分区」与「同名孤儿表」。
	// 旧实现只看 to_regclass:若某月分区被 DETACH 成功但 DROP 失败,孤儿表
	// 仍在 catalog 中,探测会误判"已存在"而不再建分区,该月所有计量写入
	// 直接报 "no partition of relation usage found for row"。
	//
	// P1-3(审计 2026-09-12)/年分区同族(2026-09-13):探测→建表的竞态与
	// 42P07 兜底复检统一在 partitions.go 的 ensureRangePartition 里实现,
	// 年分区 ensureUsageDailyPartition 走同一个 helper。
	return ensureRangePartition(db, usageMonthPartitionSpec(month))
}

// usageMonthPartitionSpec 是某**北京月**的 usage 明细分区规格的**唯一构造点**
// (R5-A-9/R5-A-10,审计 2026-09-23):创建路径(ensureUsagePartition)与清理路径
// 的"该月分区形态是否就绪"判定必须看同一份期望窗口 —— 两处各拼一次窗口会让
// "清理认为异常、创建认为正常"这类分叉静默成立。
//
// 分区边界用**显式 UTC 偏移**的瞬时字面量:分区范围(timestamptz)不随 PG 会话
// 时区漂移(裸日期 '2026-09-01' 会被按会话时区解析,UTC 会话下建出的分区范围
// 与北京月错开 8 小时)。
//
// 归一到北京月:写入路径传的是"真实瞬时"(2026-09-10 时区缺陷修复前按进程 TZ
// 取月,UTC 容器在北京每月 1 日 00:00-08:00 会去建/查上个月分区,当月分区缺失
// → INSERT 报 "no partition of relation usage found for row")。
func usageMonthPartitionSpec(month time.Time) partitionSpec {
	month = BeijingMonth(month)
	start := dayKey(month)
	end := start.AddDate(0, 1, 0)
	return partitionSpec{
		parent: "usage",
		key:    monthKey(month),
		from:   pgInstantArg(BeijingDayInstant(start)),
		to:     pgInstantArg(BeijingDayInstant(end)),
	}
}

func dayKey(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// ensureUsageDailyPartition 幂等创建某年的 usage_daily 分区(如 usage_daily_2026)。
// 2026-09-13 P1-3 同族修复:此前只有一条裸 CREATE TABLE IF NOT EXISTS,缺少月
// 分区那样的 42P07 兜底复检(16 并发首写实证 5–15/16 报
// `relation "usage_daily_2027" already exists`)。现在与月分区共用
// partitions.go 的 ensureRangePartition —— 同一 helper,不允许再分叉。
func ensureUsageDailyPartition(db *sql.DB, year time.Time) error {
	start := time.Date(year.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(1, 0, 0)
	return ensureRangePartition(db, partitionSpec{
		parent: "usage_daily",
		key:    yearKey(year),
		// day 是 DATE 列,分区边界沿用既有裸日期口径。
		from: start.Format("2006-01-02"),
		to:   end.Format("2006-01-02"),
	})
}

// RebuildUsageLedger 从 usage 明细 UPSERT 日账/月账(幂等,可重复执行)。
// 明细是事实源,账本是降维缓存:崩溃/漏跑后可全窗口重算,永无洞。
// from/to 为闭区间日期;只处理窗口内 created_at 所属的"天",并按天聚合后
// 顺带更新所属月份。
//
// R5-A-10(审计 2026-09-23,P1):**只为"该月确实有明细"的月份建明细分区**。
// 旧实现对窗口内每个月无条件 `ensureUsagePartition` —— 保留期曾调小(过期月
// 分区被 DROP、账本完整)后调大并重启,启动补算会为这些月建出**空**分区;而
// 聚合的分段判据是"该月关系是否存在 ⇒ 读明细"(R4-C-4),于是这些月在用量中心
// 与月报里恒为 0 —— 永久账本里的金额被静默隐藏(真 PG 实测 聚合 0.0000 /
// 账本直读 3.0000)。空分区是**只在重建路径上产生**的伪明细源,所以修在产生点。
//
// 注意 usage_daily 的年分区仍对窗口内每个月无条件 ensure:它是**账本自己的**
// 关系(写聚合结果的目标),与"明细是否存在"无关,也不是聚合分段的判据来源
// (scanUsageMonthTables 只认 usage_<6 位数字>,usage_daily_<YYYY> 不参与)。
//
// R8-A-5(审计 2026-09-24,P2)的错误隔离:`ensureLedgerRelations` 改**逐月**隔离
// ——旧实现在第一个形态异常的月就 `return err`,`rebuildUsageLedgerRows` 一次都
// 没跑 ⇒ 一个坏月让**整个窗口**的账本自愈(含同窗口的健康月)整轮中止,而调用方
// (cmd/server 的启动补算)只 `log.Printf` 一行。现在:坏月只记日志 + 点名,健康月
// 照常补齐,聚合照常执行;函数末尾把失败**聚合**成一个错误返回(仍 fail-loud,
// 调用方能看见、能重试)。这与 CleanupUsageRetention 的逐关系隔离同形。
func RebuildUsageLedger(db *sql.DB, from, to time.Time) error {
	if from.IsZero() || to.IsZero() || from.After(to) {
		return nil
	}
	// 归一到北京日期值(调用方常传 time.Now() 之类的瞬时):日界/月界一律走
	// BeijingDay,不掺入进程 TZ。
	from, to = normalizeDayRange(from, to)
	if from.After(to) {
		return nil
	}
	relErr := ensureLedgerRelations(db, from, to)
	// 聚合**无条件**执行:明细是事实源,聚合读 usage 父表,与"该月分区形态"无关
	// (R5-A-9 的分离正是为此)。一个坏月不得让健康月的账本留在空值上。
	aggErr := rebuildUsageLedgerRows(db, from, to)
	switch {
	case relErr != nil && aggErr != nil:
		return fmt.Errorf("%w;账本聚合亦失败: %v", relErr, aggErr)
	case relErr != nil:
		return relErr
	default:
		return aggErr
	}
}

// ensureLedgerRelations 为窗口内的月份准备关系:usage_daily 年分区**无条件**
// 建(账本写入目标),usage 明细月分区**按需**建(该月一行明细都没有就不建,
// 见 RebuildUsageLedger 的 R5-A-10 说明)。
//
// 逐月错误隔离(R8-A-5):单个月的异常(错界分区、同名孤儿、非叶子形态、跨 schema
// 的挂载……)只让**那个月**的关系留空并进日志,其余月份照常准备。失败清单在末尾
// 聚合成一个错误返回 —— 既不静默(调用方能看到非 nil),也不让整轮自愈停摆。
func ensureLedgerRelations(db *sql.DB, from, to time.Time) error {
	var failures []string
	for m := dayKey(from); !m.After(dayKey(to)); m = m.AddDate(0, 1, 0) {
		if err := ensureUsageDailyPartition(db, m); err != nil {
			// 年分区是账本**自己**的关系(写不进去 = 真失败),但仍只隔离到该月:
			// 其余月份的年分区照建,聚合照跑(失败会在聚合里再次现形,不是静默)。
			failures = append(failures, fmt.Sprintf("usage_daily_%s: %v", yearKey(m), err))
			log.Printf("usage ledger: usage_daily_%s 的年分区未就绪(该月账本写入会被 PG 拒绝): %v", yearKey(m), err)
			continue
		}
		hasDetail, err := usageMonthHasDetail(db, m)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: 探测明细存在性失败: %v", monthKey(m), err))
			continue
		}
		if !hasDetail {
			// 该月没有明细 ⇒ 不建空分区(建了会让聚合把该月判成"有明细"从而
			// 隐藏账本金额)。当月的新写入由写路径 RecordUsage 自己 ensure。
			continue
		}
		if err := ensureUsagePartition(db, m); err != nil {
			failures = append(failures, fmt.Sprintf("usage_%s: %v", monthKey(m), err))
			log.Printf("usage ledger: usage_%s 的明细分区未就绪(该月明细仍在,账本按父表聚合照算): %v", monthKey(m), err)
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("usage ledger: %d relation(s) not ready for the rebuild window (%s..%s);"+
			"其余月份已照常补算(R8-A-5:单个异常月不得让整个窗口的自愈停摆): %s",
			len(failures), from.Format(dateFmt), to.Format(dateFmt), strings.Join(failures, " | "))
	}
	return nil
}

// usageMonthHasDetail 探测某北京月内 usage 是否**至少有一行**明细。
//
// 只做 LIMIT 1 存在性检查:分区裁剪把扫描限制在该月分区上,而该分区里的每一行
// 都落在窗口内 ⇒ 命中即返回,与分区行数无关。
//
// 这个探测**不需要分区存在**:月分区是写时惰性创建的,而读路径查的是父表 ——
// 缺分区时同样返回"没有行"(缺分区 ≠ 有行),正是我们要的语义。
func usageMonthHasDetail(db *sql.DB, month time.Time) (bool, error) {
	start := dayKey(BeijingMonth(month))
	end := start.AddDate(0, 1, 0)
	var one int
	err := db.QueryRow(`SELECT 1 FROM usage
	                     WHERE created_at >= ?::timestamptz AND created_at < ?::timestamptz
	                     LIMIT 1`,
		pgInstantArg(BeijingDayInstant(start)), pgInstantArg(BeijingDayInstant(end))).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// rebuildUsageLedgerRows 是账本重算的**纯聚合**部分:明细 → usage_daily →
// usage_monthly(UPSERT,幂等)。**不建任何关系**。
//
// 与 RebuildUsageLedger 的分离是 R5-A-9 的修法:聚合读的是 usage **父表**,
// 与"该月分区的形态"无关(分区边界错位/读不懂/二级分区里的行照样能被聚合)。
// 清理路径因此可以在**不要求分区就绪**的前提下先补账、再 DETACH+DROP ——
// 旧实现经 RebuildUsageLedger 无条件 ensureUsagePartition,一个错界老分区让
// 整轮清理中止(清理被"自己要清的东西"挡住,保留策略永久停摆)。
func rebuildUsageLedgerRows(db *sql.DB, from, to time.Time) error {
	return rebuildUsageLedgerRowsOnPool(db, from, to, nil)
}

// rebuildUsageLedgerRowsOnPool 是账本聚合的**池上**入口：两条 UPSERT 放进一个
// 事务，并把 search_path 与判据钉成同源（R11A-02）。
//
// 为什么需要它：`db.Exec` 走的是**会话默认** search_path，而账本聚合的来源
// （`FROM usage`）与写入目标（`usage_daily` / `usage_monthly`）都是未限定名 ⇒
// shadow schema 在场时会把**虚构金额**写进永久账本（真 PG 实测：账本被 shadow 的
// 999.00 覆盖，真实明细 12.50 未进账本）。走 `applyUsageRetentionBudget` 的那条
// 路径已经钉了同一句，这里是池上入口的对应收口（启动补算 / 相邻月并入失败的兜底
// 补账）。
//
// **不加时间上界**：这两条 UPSERT 的既有预算是调用方的事（启动补算、自愈重试），
// 本函数只负责"判据与动作看到同一个对象"。
func rebuildUsageLedgerRowsOnPool(db *sql.DB, from, to time.Time, extraSources []string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // 提交成功后回滚是 no-op
	if err := pinUsageSearchPath(tx); err != nil {
		return err
	}
	if err := rebuildUsageLedgerRowsFrom(tx, from, to, extraSources); err != nil {
		return err
	}
	return tx.Commit()
}

// ledgerDetailSource 构造"日账聚合的明细来源"：无额外来源时就是 `usage`
// （保持热路径/启动补算的 SQL 与执行计划逐字不变）；有额外来源时是
// `usage` 与它们的 UNION ALL **同一个子查询** —— 必须一次聚合，不能分两次
// UPSERT：同一个 (user_id, model, day) 在两边都有行时，两次 UPSERT 会让后一次
// 把前一次的金额**覆盖**成自己那一份（静默少计，正是 §1.5-A 要防的形状）。
//
// **额外来源的资格（R7-A，P1，别再踩）**：`extraSources` 只允许放**不在 usage
// 分区树里**的关系。这条不是风格问题而是正确性前提 —— `SELECT … FROM usage`
// 已经包含整棵 usage 子树（含多级布局 `usage → usage_<YYYY> → usage_<YYYYMM>`
// 的孙辈叶子）的行，把其中任何一个再 union 进来，同一行就会被算**两遍**
// （真 PG 实测：同数据同一轮清理，日账/月账 12.5 → 25.0）。判据链见
// usageRelationShape.attachedToUsage（传递根）、scanUsageMonthTables 的分桶，
// 以及 cleanupDetachedUsageTable 入口的 assertDetachedFromUsage（动手前复检）。
//
// 列集只取账本聚合真正用到的 7 列（显式列名）：额外来源不需要与 usage 完全同
// 形，但必须含这 7 列，否则查询 fail-loud、由调用方按"跳过并记录"处置。
func ledgerDetailSource(extraSources []string) string {
	if len(extraSources) == 0 {
		return "usage"
	}
	cols := "user_id, model, created_at, prompt_tokens, completion_tokens, cache_prompt_tokens, cost"
	parts := []string{"SELECT " + cols + " FROM usage"}
	for _, rel := range extraSources {
		parts = append(parts, "SELECT "+cols+" FROM "+quoteRelationIdent(rel))
	}
	return "(" + strings.Join(parts, " UNION ALL ") + ") AS usage_detail"
}

// rebuildUsageLedgerRowsFrom 是 rebuildUsageLedgerRows 的"明细来源可扩展"版本：
// extraSources 里的关系（清理路径的**表形态孤儿**）与 usage 一起参与同一次聚合。
//
// R10-D-01（P1）：句柄从 `*sql.DB` 放宽到 usageExecer —— 清理路径的补账必须在
// **与 DETACH/DROP 同一个持锁事务**里跑（见 reclaimUsagePartitionAtomically /
// dropDetachedOrphanAtomically），否则 [补账, DROP] 之间提交的行会被 DROP 级联
// 删除且没进账本（真 PG 实测 SILENT_LOSS=5.00/6.00/4.00，而 failures=0/skipped=0）。
func rebuildUsageLedgerRowsFrom(db usageExecer, from, to time.Time, extraSources []string) error {
	from, to = normalizeDayRange(from, to)
	if from.IsZero() || to.IsZero() || from.After(to) {
		return nil
	}
	source := ledgerDetailSource(extraSources)
	// 日账:按 (user_id, model, day) 聚合明细;UPSERT 覆盖(幂等)。
	// PG 用 ON CONFLICT (user_id, model, day) DO UPDATE。
	// 日桶与边界都走固定 +8h(北京墙钟)与绝对瞬时(会话时区无关),见 beijing.go。
	if _, err := db.Exec(`
		INSERT INTO usage_daily (user_id, model, day, prompt_tokens, completion_tokens, cache_prompt_tokens, requests, cost)
		SELECT user_id, model, (`+bjWallExpr("created_at")+`)::date AS day,
		       SUM(prompt_tokens), SUM(completion_tokens), SUM(cache_prompt_tokens),
		       COUNT(*), SUM(cost)
		FROM `+source+`
		WHERE created_at >= ?::timestamptz AND created_at < ?::timestamptz
		  AND (`+bjWallExpr("created_at")+`)::date >= ?::date
		  AND (`+bjWallExpr("created_at")+`)::date <= ?::date
		GROUP BY user_id, model, day
		ON CONFLICT (user_id, model, day) DO UPDATE SET
		  prompt_tokens = EXCLUDED.prompt_tokens,
		  completion_tokens = EXCLUDED.completion_tokens,
		  cache_prompt_tokens = EXCLUDED.cache_prompt_tokens,
		  requests = EXCLUDED.requests,
		  cost = EXCLUDED.cost`,
		dayStartArg(from), dayEndArgInclusive(to),
		from.Format(dateFmt), to.Format(dateFmt)); err != nil {
		return fmt.Errorf("rebuild usage_daily: %w", err)
	}
	// 月账:从日账按月份聚合(只用本窗口覆盖的月,避免全量重扫)。
	// 边界月取**整月**(date_trunc 到月初、下月月初开区间):usage_daily 中
	// 窗口外的旧日数据保留不删,聚合因此单调收敛——不会把完整月账覆盖成
	// "仅窗口内几天"的部分和。2026-09-01 审计(B2):此前 WHERE day BETWEEN
	// from..to 使启动补算(from = now.AddDate(0,-N,0),非整月对齐)每次启动
	// 都把 from/to 所在月的月账 OVERWRITE 成部分月数据,明细分区 DROP 后
	// 永久亏空(真 PG 复现:整月重建 requests=2 → 部分窗口重建后被覆盖为 1)。
	if _, err := db.Exec(`
		INSERT INTO usage_monthly (user_id, model, month, prompt_tokens, completion_tokens, cache_prompt_tokens, requests, cost)
		SELECT user_id, model, date_trunc('month', day)::date AS month,
		       SUM(prompt_tokens), SUM(completion_tokens), SUM(cache_prompt_tokens),
		       SUM(requests), SUM(cost)
		FROM usage_daily
		WHERE day >= (date_trunc('month', ?::date))::date
		  AND day < (date_trunc('month', ?::date) + interval '1 month')::date
		GROUP BY user_id, model, month
		ON CONFLICT (user_id, model, month) DO UPDATE SET
		  prompt_tokens = EXCLUDED.prompt_tokens,
		  completion_tokens = EXCLUDED.completion_tokens,
		  cache_prompt_tokens = EXCLUDED.cache_prompt_tokens,
		  requests = EXCLUDED.requests,
		  cost = EXCLUDED.cost`,
		from.Format(dateFmt), to.Format(dateFmt)); err != nil {
		return fmt.Errorf("rebuild usage_monthly: %w", err)
	}
	return nil
}

// EffectiveRetentionMonths 返回明细保留月数(settings;缺省/非法 = 默认 6;0=永久)。
func EffectiveRetentionMonths(db *sql.DB) (int, error) {
	v, ok, err := GetSetting(db, RetentionMonthsSetting)
	if err != nil {
		return 0, err
	}
	if !ok {
		return DefaultRetentionMonths, nil
	}
	n, err := ParseRetentionMonths(v)
	if err != nil {
		return DefaultRetentionMonths, nil
	}
	return n, nil
}

// ParseRetentionMonths 校验保留月数输入(0~120;0=永久)。供后台 API 校验。
func ParseRetentionMonths(v string) (int, error) {
	var n int
	if _, err := fmt.Sscanf(strings.TrimSpace(v), "%d", &n); err != nil {
		return 0, err
	}
	if n < 0 || n > maxRetentionMonths {
		return 0, fmt.Errorf("retention out of range [0,%d]: %d", maxRetentionMonths, n)
	}
	return n, nil
}

// usageMonthTables 是一次"usage 月关系"扫描的结果（R4-C-8，审计 2026-09-23）。
//
// 为什么要有它：月分区是**写时惰性创建**的（ensureUsagePartition 在当月第一次计量
// 写入时才建），所以"某个月完全没有用量"的部署会在表名序列里留下一个**洞**。旧实现
// 从 cutoffMonth-1 逐月往回走、在第一个缺失月份就 `break`（注释理由是"更早月份已没有
// 表"），于是洞一旦落在要清理的区间里，更早的分区**永远不会**被清理 —— 该月已经过去，
// created_at 不会再落进去，分区不会被重建 ⇒ 洞是永久的，`usage.retention_months`
// 对更早月份静默失效（只占磁盘、不丢数据，因为 DROP 前已重建账本）。
//
// 修法：**枚举实际存在的关系**（事实），不按名字猜连续性（假设）。
type usageMonthTables struct {
	// Partitions 是挂在 usage 下（**传递地**：直接分区、二级/多级子分区都算）的
	// **叶子**月分区（relispartition=true 且 relkind='r'），按关系名升序 ——
	// 升序即时间升序（YYYYMM）。
	//
	// R7-A（P1）：判据从"直接父是 usage"改成**传递根是 usage**。多级布局
	// `usage → usage_<YYYY> → usage_<YYYYMM>` 里的孙辈叶子同样是 usage 明细的
	// 来源（`SELECT … FROM usage` 会读到它的行），因此：
	//   - 清理按普通分区路径处理它（补账**不带** extraSources ⇒ 不重复计）；
	//   - usageAggregateSegments 的"该月明细分区存在"判据也认它 ⇒ 该月聚合读
	//     明细而不是回落账本（此前它被判成孤儿，明细对聚合**永久不可见**，
	//     该月读数静默偏小）。
	Partitions []string
	// AttachedNonLeaf 是挂在 usage 下（同样**传递地**）、但**自身又是分区父表**
	// 的月关系（relispartition=true 且 relkind='p'，二级分区）。
	//
	// R6-A-1（复审 V1 §1.5-A）：它们同样是 usage 的明细来源（`SELECT … FROM
	// usage` 会读到子分区里的行），所以清理必须与叶子分区走**同一条**路径
	// （先补账再 DETACH+DROP，见 CleanupUsageRetention）。
	AttachedNonLeaf []string
	// Orphans 是名为 usage_<YYYYMM> 但**不**是 usage 后代的关系（F11 的 DETACH
	// 残留、被手工换成 VIEW 的异常形态、独立的二级分区父表…）。它们没有分区
	// 身份，但同样占着名字：留着会让该月的新写入撞同名关系而失败，所以清理
	// 必须一并处理。
	//
	// 这一定义是**金额安全**的前提：孤儿补账走 `usage ∪ 孤儿` 的 UNION ALL，
	// 只有"该关系不在 usage 之下"时两边才**不相交**（否则同一行算两遍、账本
	// 翻倍）。判据已经过传递祖先，落桶之后还在 cleanupDetachedUsageTable 入口
	// 再按 catalog 事实复检一次（assertDetachedFromUsage，双保险）。
	Orphans []string
	// Shapes 是关系名 → 形态。**清理按形态分流**（R6-A-1 复审 V1 的修法）：
	// 判据是 catalog 的**事实**（relkind / pg_inherits 父子 / 子关系数），
	// 不是名字，也不是"能不能 DROP TABLE"这一条。
	//
	// 它取代了旧的 `Kinds map[string]string`（relkind 的第二个投影）：R6-A-1
	// 之后"能不能 DROP"取决于**形态**而不是单个 relkind（叶子表 vs 父表；
	// 视图形态另有 DROP VIEW 动词 —— PG 42809 `"x" is not a table` 正是旧实现
	// 一律硬发 DROP TABLE 的后果），两份投影会分叉，只留这一份。
	Shapes map[string]usageRelationShape
}

// usageRelationShape 是一个名为 usage_<YYYYMM> 的关系的形态事实。
type usageRelationShape struct {
	Kind   string // pg_class.relkind
	Parent string // pg_inherits 的父关系名（'' = 无父表）
	// Root 是分区树的**传递根**关系名（pg_partition_root；非分区 = ''）。
	// 只判一层父表是不够的：`usage → usage_<YYYY> → usage_<YYYYMM>` 这种多级
	// 布局（DBA 手写 DDL 即可产生，见 attachedToUsage）里的孙辈叶子直接父是
	// usage_<YYYY>，但它**仍然挂在 usage 上**。
	Root string
	// AttachedUsage 报告该关系的传递根**就是 public.usage**（判据按 oid，
	// 见 scanUsageMonthTables 的 SQL）：与 Root=="usage" 的区别只在"另一个
	// schema 里同名"的形态上（R8-A-7），那种关系不是 usage 的后代。
	AttachedUsage bool
	// DirectParentUsage 报告该关系的**直接**父关系就是 public.usage（判据同样按
	// **oid**，来自 scanUsageMonthTables 的 `p.oid = to_regclass('public.usage')`）。
	//
	// R10-A-07（P3）：`directChildOfUsage()` 此前比的是 `Parent == "usage"`（裸
	// relname）—— 与 R8-A-7 已经统一到 oid 的 attachedToUsage 不同口径：另一个
	// schema 里同名 `usage` 下的 `public.usage_<YYYYMM>` 会被判成"usage 的直接子
	// 分区"，随后的 `ALTER TABLE usage DETACH PARTITION` 报 42809/42P01（fail-loud，
	// 不是静默），但判据面与统一口径不一致、且产出误导性的失败。现在两个判据同源
	// **同事实**（都是 oid 比较），`Parent` 只用于展示与拼 DDL。
	DirectParentUsage bool
	Partition         bool // pg_class.relispartition
	Children          int  // pg_inherits 里以本关系为父的关系数
	// ReclaimWindow 是本轮**进入临界区之前**算好的补账窗口（名义月 ∪ 该关系实际持有
	// 的行覆盖的北京日 ∪ 相邻月整月，见 retentionLedgerWindow 与 CleanupUsageRetention）。
	//
	// R10-D-01（P1）：补账必须与 DETACH/DROP 在**同一个持锁事务**里 —— 叶子月分区
	// 正是产品实际布局，而 [补账, DROP] 之间提交的行会被 DROP 级联删除且没进账本
	// （真 PG 实测 SILENT_LOSS=5.00/6.00/4.00，而 failures=0/skipped=0）。窗口是
	// 临界区的**输入**，所以随形态一起传（零值 ⇒ 按关系名的名义月，见
	// reclaimUsagePartitionAtomically 的兼容分支）。
	ReclaimWindow retentionWindow
}

// attachedToUsage 报告该关系是不是 usage 的**后代分区**（传递祖先：直接分区、
// 二级/多级子分区都算）。
//
// R7-A（审计 2026-09-24，P1，已实证静默金额多计）的修法：此前的判据是
// `Partition && Parent == "usage"` —— **只看直接父**，于是一株仍然挂在 usage 上
// 的孙辈叶子被判成孤儿：
//
//   - 孤儿补账走 `usage ∪ 孤儿` 的 UNION ALL，而 `SELECT … FROM usage` **本来
//     就已经包含这棵子树的行** ⇒ 同一行算两遍（真 PG 实测：同数据同一轮清理，
//     账本 12.5 → 25.0，日账/月账一起翻倍，且不会再被后续轮次纠正）；
//   - 随后孤儿循环把它 DROP ⇒ 删掉一株**活分区**（金额真的从 usage 里消失），
//     善后 ensureUsagePartition 报 42P17 `would overlap partition "usage_2026"`
//     ⇒ 该月的新写入永久 503 METERING_FAILED。
//
// 判据取**传递根**（pg_partition_root）而不是直接父：后者只是传递关系的一层。
// 形态可由 DBA 手写 DDL 产生（`migrations-pg/**` 只建一级，所以这不是迁移产物，
// 但它是**静默金额错误**，不能因为"我们没建过"就按不支持处理）。
//
// 注意"根"会随 DETACH 变化，这正是我们要的语义：把 usage_<YYYY> 整棵摘下来之后，
// 它下面的叶子的根就变成 usage_<YYYY>（≠ usage）⇒ 自动回到孤儿语义 —— 那一刻
// `SELECT … FROM usage` 确实读不到它们了，必须与 usage 做同一次 UNION 聚合。
//
// R8-A-7：判据取**oid 相等**（AttachedUsage，来自 SQL 的
// `pg_partition_root(c.oid) = to_regclass('public.usage')`），不是裸 relname ——
// 另一个 schema 里也有一张叫 usage 的分区表时，挂在它下面的 public.usage_<YYYYMM>
// 不是本表的后代（旧判据会把它误判成后代：既不清理、又让聚合切到明细段读出 0）。
func (s usageRelationShape) attachedToUsage() bool { return s.Partition && s.AttachedUsage }

// directChildOfUsage 报告该关系是不是**直接**挂在 usage 下。
//
// 只有这一层能做 `ALTER TABLE usage DETACH PARTITION <rel>`：更深的子分区属于
// 别的父表（`usage_<YYYY>`），摘它等于替管理员拆分区树（同一棵子树里可能还有
// 别的月份）⇒ 清理只补账、不 DETACH/DROP（见 CleanupUsageRetention 的 SKIP 分支）。
//
// R10-A-07：判据取 DirectParentUsage（**oid** 比较，与 attachedToUsage 同源同事实），
// 不再是 `Parent == "usage"` 的裸 relname 比较 —— 另一个 schema 里同名的 usage
// 下的关系不是本表的直接子分区。
func (s usageRelationShape) directChildOfUsage() bool { return s.DirectParentUsage }

// tableLike 报告该关系是不是"可能持有 usage 明细行"的表形态。
// 视图/物化视图不在此列：它们没有自己的明细行（物化视图的内容是派生的），
// DROP 它们不会带走 usage 的明细。
func (s usageRelationShape) tableLike() bool { return s.Kind == "r" || s.Kind == "p" }

// leafTable 报告该关系是不是**可以安全 DROP 的叶子表**（无子关系）。
// 父表（relkind='p' 或存在 pg_inherits 子关系）不在此列：DROP TABLE 会连子
// 关系一起删，服务端不替管理员做这个决定（见 CleanupUsageRetention）。
func (s usageRelationShape) leafTable() bool { return s.Kind == "r" && s.Children == 0 }

// dropStatementForViewLike 返回清理**非表明细形态**（视图 / 物化视图）占名时
// 要发的 SQL。
//
// R6-A-1（复审 V1 §1.5-A）后表形态（'r'/'p'）**不再**走这个函数：它们可能持有
// usage 明细行，而孤儿关系不在 usage 之下 ⇒ 聚合与账本都读不到它的行，直接
// DROP 就是**金额永久丢失**（复审探针实证：同数据同一轮清理，孤儿路径
// `ledger_rows_after=0` ↔ 真分区对照 `=1`）。表形态现在走 planDetachedCleanup +
// dropDetachedOrphanAtomically（先并入 + 持锁补账，再决定 DROP）。
//
// 其余形态（索引、序列、外部表、复合类型…）→ **跳过**：同名的非表对象是人工
// 事故，服务端不替管理员决定删它（与 misboundedPartitionErr「不自动 DROP/改写
// 外来对象」同一条纪律），调用方记警告并计入 skipped。
//
// R10-D-05（P3）：映射本身收在 dropDDLForRelKind（**唯一一份** relkind → DROP
// 动词），本函数只是它在"清理路径可删集合"上的投影（只 v/m）。
func dropStatementForViewLike(rel, kind string) (stmt string, ok bool) {
	stmt, ok = dropDDLForRelKind(rel, kind)
	if !ok {
		return "", false
	}
	return stmt, kind == "v" || kind == "m"
}

// dropDDLForRelKind 返回"清理一个占用了 usage_<YYYYMM> 名字的关系"可执行的 DDL
// —— **唯一一份** relkind → DROP 动词映射（R10-D-05，P3）。
//
// 缺陷形态：`/readyz` 的 write_blocked_action 对**任何**非分区占名都写"确认无用
// 再由人工 DROP TABLE <rel>"，而索引/序列/视图/物化视图下这句话**不可执行**
// （`… is not a table`；真 PG 10 种同名形态实测：i/S/v/m 全中）—— 运维照着做只
// 会拿到一个错。现在按 relkind 分流，与清理路径共用同一份映射，两处不会分叉。
//
// ok=false = 服务端不提供可执行指引（外部表之外的怪形态留给人工判断，与清理路径
// "服务端不替管理员决定删非表对象"同一条纪律）。
func dropDDLForRelKind(rel, kind string) (stmt string, ok bool) {
	ident := quoteRelationIdent(rel)
	switch kind {
	case "r", "p":
		// 'p' = 自身又是分区父表：DROP TABLE 会连子关系一起删 ⇒ 调用方必须先用
		// pg_inherits 确认整株子树都能删（清理路径只对叶子走 DROP）。
		return "DROP TABLE IF EXISTS " + ident, true
	case "v":
		return "DROP VIEW IF EXISTS " + ident, true
	case "m":
		return "DROP MATERIALIZED VIEW IF EXISTS " + ident, true
	case "i":
		return "DROP INDEX IF EXISTS " + ident, true
	case "S":
		return "DROP SEQUENCE IF EXISTS " + ident, true
	case "f":
		return "DROP FOREIGN TABLE IF EXISTS " + ident, true
	}
	return "", false
}

// quoteRelationIdent 把 catalog 里的关系名渲染成可安全内联的标识符
// （双引号包裹 + 内部双引号翻倍）。关系名来自 pg_class（不受外部输入控制），
// 但形态判定通过之后一律经本函数内联 —— 不再出现裸拼接的名字。
func quoteRelationIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// usageDetailMonthExpr 是"明细行所属北京月"的 SQL 表达式（YYYYMM 文本），
// 与 Go 侧 monthKey/BeijingMonth 同一口径（固定 +8h，见 beijing.go）。
func usageDetailMonthExpr(col string) string {
	return "to_char(" + bjWallExpr(col) + ", 'YYYYMM')"
}

// usageDayPredicate 返回"某列落在 [from, to] 北京日闭区间内"的 SQL 片段。
func usageDayPredicate(col string) string {
	day := bjWallExpr(col) + "::date"
	return day + " >= ?::date AND " + day + " <= ?::date"
}

// relationColumnNames 返回 public.<rel> 的列名（attnum 升序，已删列跳过）。
// 列集是动态读的（不是硬编码常量）：未来迁移给 usage 加列时，并入路径要么
// 带上新列、要么在"关系缺列"的判据上 fail-loud，不会静默丢列。
func relationColumnNames(db *sql.DB, rel string) ([]string, error) {
	rows, err := db.Query(`SELECT a.attname FROM pg_attribute a
WHERE a.attrelid = to_regclass('public.' || ?) AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`, rel)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("relation %s not found in public schema", rel)
	}
	return out, nil
}

// usageMonthRelationOf 解析关系名 usage_<YYYYMM>，返回该月（UTC 月首）与是否合法。
// 严格六位数字 + 合法月号：名字像 usage_2026（年）+ 后缀、或 usage_daily_2026
// 这类兄弟关系一律不参与月分区判定。
func usageMonthRelationOf(rel string) (time.Time, bool) {
	const prefix = "usage_"
	if !strings.HasPrefix(rel, prefix) {
		return time.Time{}, false
	}
	key := rel[len(prefix):]
	if len(key) != 6 {
		return time.Time{}, false
	}
	for i := 0; i < len(key); i++ {
		if key[i] < '0' || key[i] > '9' {
			return time.Time{}, false
		}
	}
	year, month := 0, 0
	for i := 0; i < 6; i++ {
		d := int(key[i] - '0')
		if i < 4 {
			year = year*10 + d
		} else {
			month = month*10 + d
		}
	}
	if month < 1 || month > 12 {
		return time.Time{}, false
	}
	return time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.UTC), true
}

// scanUsageMonthTables 枚举 public 模式下全部名为 usage_<YYYYMM> 的关系，分成
// 「真分区」与「孤儿」两桶（见 usageMonthTables 的说明）。
//
// **有意排除 usage_daily_***（R11A-06，P3，**有意不回收，不是漏做**）：永久账本
// `usage_daily` / `usage_monthly` **没有任何回收路径**，全仓不存在
// `DELETE FROM usage_daily` / `DROP TABLE …usage_daily…`。保留期（settings
// `usage.retention_months`）按定义只作用于**明细**月分区 —— 账本是"明细被删之后
// 仍然要能出报表"的那一份（见 rebuildUsageLedgerRowsFrom 的注释）。
// 后果如实认账：账本行数按 (user, model, day) 无界增长（年分区**个数**有界，行数
// 无界），磁盘随"用户数 × 模型数 × 天数"单调增长。
// 为什么不在本次修：给它加保留期是**产品决策**（"报表能回溯多久"），不是缺陷修复
// —— 顺手加一条回收会让历史报表静默变短，正是本仓反复登记的"静默少计"形态。
// 已登记在 temp/r11/fix-I4/REPORT.md 的"需主控决策"一节。
//
// 只读一次 catalog（pg_class + pg_inherits）：比旧实现逐月一条查询更省往返，
// 且判据是**事实**（枚举）而不是**假设**（名字连续）—— R4-C-8 的根因正是后者。
func scanUsageMonthTables(db *sql.DB) (usageMonthTables, error) {
	rows, err := db.Query(`SELECT c.relname, COALESCE(p.relname, ''), c.relispartition, c.relkind,
       (SELECT count(*) FROM pg_inherits ch WHERE ch.inhparent = c.oid),
       CASE WHEN c.relispartition THEN COALESCE(root.relname, '') ELSE '' END,
       COALESCE(c.relispartition AND pg_partition_root(c.oid) = to_regclass('public.usage'), false),
       COALESCE(p.oid = to_regclass('public.usage'), false)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
LEFT JOIN pg_class p ON p.oid = i.inhparent
LEFT JOIN pg_class root ON root.oid = pg_partition_root(c.oid)
WHERE n.nspname = 'public' AND c.relname LIKE 'usage\_%'
ORDER BY c.relname`)
	if err != nil {
		return usageMonthTables{}, err
	}
	defer rows.Close()
	out := usageMonthTables{Shapes: map[string]usageRelationShape{}}
	for rows.Next() {
		var rel, parent, kind, root string
		var isPartition, attached, directParent sql.NullBool
		var children int
		if err := rows.Scan(&rel, &parent, &isPartition, &kind, &children, &root, &attached, &directParent); err != nil {
			return usageMonthTables{}, err
		}
		if _, ok := usageMonthRelationOf(rel); !ok {
			continue // usage_daily_2026 之类的兄弟关系
		}
		shape := usageRelationShape{
			Kind:      kind,
			Parent:    parent,
			Root:      root,
			Partition: isPartition.Valid && isPartition.Bool,
			// R8-A-7:归属判据按 **oid** 比较(pg_partition_root = public.usage),
			// 不比裸 relname —— 另一个 schema 里同名的分区树不算 usage 的后代。
			AttachedUsage: attached.Valid && attached.Bool,
			// R10-A-07:直接父同样按 **oid** 比较（与上面同源同事实）。
			DirectParentUsage: directParent.Valid && directParent.Bool,
			Children:          children,
		}
		out.Shapes[rel] = shape
		if shape.attachedToUsage() {
			if kind == "r" {
				out.Partitions = append(out.Partitions, rel)
			} else {
				out.AttachedNonLeaf = append(out.AttachedNonLeaf, rel)
			}
			continue
		}
		out.Orphans = append(out.Orphans, rel)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// R6-A-1 复审 V1 §1.5-A / §1.5-B（审计 2026-09-23，两条 P1，均已实证静默
// 金额丢失）的清理侧修法。两条的**公共判据**：
//
//	表形态的关系在被 DROP 之前，它持有的每一行明细都必须已经落到永久账本，
//	并且不能从"仍然读明细的那个月"的明细段里消失。
//
//	A｜孤儿绕过补账：名为 usage_<YYYYMM> 的表形态孤儿（F11 的 DETACH 残留、
//	   人工改造、独立二级分区父表）到期时被直接 DROP —— 它不在 usage 之下，
//	   聚合与账本都读不到它的行（探针实测：孤儿路径 ledger_rows_after=0 ↔
//	   真分区对照 =1）。
//	B｜错界分区被 DROP：分区实际持有相邻月前 8 小时的明细（UTC 自然月边界与
//	   北京月差 8 小时），补账只覆盖名义月 ⇒ 相邻月的聚合按"分区在且非空 ⇒
//	   读明细"读到一个已被 DROP 带走的前 8 小时（探针实测：7 月聚合
//	   11.00 → 1.00，纯账本 10.00）。
//
// 修法分两步，都以 catalog/明细的**事实**为判据：
//
//  1. 相邻月并入（foldAdjacentMonthsIntoUsage）：把"北京月 ≠ 名义月"的行
//     **原子地**移进 usage（按 created_at 路由到正确月份分区）。这一步同时
//     是 B 的"聚合少计"修法 —— 行回到相邻月的明细分区里之后，聚合与补账后
//     的账本自然一致（判据：清理后聚合 == 账本 == 清理前的值）。
//     行**无处可去**时（相邻月的分区不覆盖这些瞬时；PG 禁止分区区间重叠 ⇒
//     "错界尾段"形态必然如此）**不删**：跳过并记录，账本照样补齐。
//  2. 补账（retentionBackfill）：孤儿必须在**同一次**聚合里 union 进来
//     （usage ∪ 孤儿）。分两次 UPSERT 会把同一个 (user,model,day) 的金额
//     互相覆盖成其中一份 —— 那也是一种静默少计。
// ---------------------------------------------------------------------------

// detailMonthsOutside 返回 <rel> 里落在 [start, end] 北京日闭区间**之外**的
// 明细分属的北京月（升序，月首日期值）。空关系返回空切片。
//
// 判据取自行本身（不是分区边界）：边界读不懂、更宽覆盖、二级分区、孤儿表都
// 用同一个查询回答"它到底持有哪些月份的行"。
//
// R10-D-02（P2）：读 <rel> 会等它的锁 ⇒ 这一读也要有界（等锁上界）。清理路径
// 是**被管理端同步调用**的，无界等待会把 HTTP 请求一起挂住。
func detailMonthsOutside(db *sql.DB, rel string, start, end time.Time) ([]time.Time, error) {
	q := fmt.Sprintf(`SELECT DISTINCT %s AS m FROM %s WHERE NOT (%s) ORDER BY 1`,
		usageDetailMonthExpr("created_at"), quoteRelationIdent(rel), usageDayPredicate("created_at"))
	var out []time.Time
	err := withUsageLockBudget(db, usageReclaimLockTimeoutMS, func(tx *sql.Tx) error {
		rows, qerr := tx.Query(q, start.Format(dateFmt), end.Format(dateFmt))
		if qerr != nil {
			return fmt.Errorf("scan detail months of %s: %w", rel, qerr)
		}
		defer rows.Close()
		for rows.Next() {
			var key string
			if err := rows.Scan(&key); err != nil {
				return err
			}
			m, perr := time.Parse("200601", key)
			if perr != nil {
				return fmt.Errorf("scan detail months of %s: 无法解析月份标签 %q: %w", rel, key, perr)
			}
			out = append(out, m)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// moveRowsIntoUsage 原子地把 <rel> 里满足 where 的行移进 usage（按 created_at
// 路由到正确月份分区），返回移动的行数。
//
// 单条语句（`WITH moved AS (DELETE … RETURNING …) INSERT INTO usage …`）：
// 要么两边都成，要么原样回滚 —— 半路失败不会留下"删了但没写"或"两份都在"
// （后者会让同一次聚合把同一行算两遍）。
//
// 列集是**动态**读出来的（relationColumnNames），并要求 <rel> 含 usage 的
// 全部列：列集不一致的关系（人工建的怪表）一律 fail-loud，由调用方按"跳过并
// 记录"处置 —— 绝不按列序猜（猜错就是把别的列的值写进金额列）。
//
// R10-D-02（P2）：整条语句包在带等锁上界的事务里 —— 它既要读 rel 又要写 usage，
// 任一侧被 ACCESS EXCLUSIVE 挡住时不能让清理轮（以及同步等它的管理端请求）无界挂住。
func moveRowsIntoUsage(db *sql.DB, rel, where string, args ...any) (int64, error) {
	usageCols, err := relationColumnNames(db, "usage")
	if err != nil {
		return 0, fmt.Errorf("read usage columns: %w", err)
	}
	relCols, err := relationColumnNames(db, rel)
	if err != nil {
		return 0, err
	}
	have := make(map[string]bool, len(relCols))
	for _, c := range relCols {
		have[c] = true
	}
	var missing []string
	for _, c := range usageCols {
		if !have[c] {
			missing = append(missing, c)
		}
	}
	quoted := make([]string, 0, len(usageCols))
	for _, c := range usageCols {
		quoted = append(quoted, quoteRelationIdent(c))
	}
	cols := strings.Join(quoted, ", ")
	if len(missing) > 0 {
		return 0, fmt.Errorf("relation %s 的列集与 usage 不一致（缺 %s）:拒绝按列序猜着搬运明细", rel, strings.Join(missing, ","))
	}
	stmt := fmt.Sprintf(`WITH moved AS (DELETE FROM %s WHERE %s RETURNING %s)
INSERT INTO usage (%s) SELECT %s FROM moved`, quoteRelationIdent(rel), where, cols, cols, cols)
	var moved int64
	err = withUsageLockBudget(db, usageReclaimLockTimeoutMS, func(tx *sql.Tx) error {
		res, eerr := tx.Exec(stmt, args...)
		if eerr != nil {
			return eerr
		}
		n, rerr := res.RowsAffected()
		if rerr != nil {
			return rerr
		}
		moved = n
		return nil
	})
	if err != nil {
		return 0, err
	}
	return moved, nil
}

// foldAdjacentMonthsIntoUsage 把 <rel> 里"北京月 ∈ months（≠ 名义月 m）"的明细
// 并入 usage 的对应月份分区，返回实际移动的行数。
//
// 返回错误时调用方**不得 DROP 该关系**：那些行还留在 rel 里，DROP 会让相邻月的
// 明细段永久少计（§1.5-B 的实证形态）。调用方按"跳过并记录"处置，但**补账照做**
// （窗口按 months 扩到整月）⇒ 聚合与账本都不丢、且两者一致。
func foldAdjacentMonthsIntoUsage(db *sql.DB, rel string, m time.Time, months []time.Time) (int64, error) {
	if len(months) == 0 {
		return 0, nil
	}
	start := dayKey(m)
	end := start.AddDate(0, 1, -1)
	// 目标分区先就绪：错界分区持有的相邻月明细要落回 usage，就必须有覆盖它们的
	// 月份分区（ensureUsagePartition 会按北京月建；同名关系被外来对象占用时
	// fail-loud ⇒ 由调用方跳过并记录，绝不覆盖别人的关系）。
	for _, mm := range months {
		if err := ensureUsagePartition(db, mm); err != nil {
			return 0, fmt.Errorf("相邻月 %s 的分区未就绪,无法并入该月的明细: %w", monthKey(mm), err)
		}
	}
	moved, err := moveRowsIntoUsage(db, rel, "NOT ("+usageDayPredicate("created_at")+")",
		start.Format(dateFmt), end.Format(dateFmt))
	if err != nil {
		return 0, fmt.Errorf("把 %s 持有的相邻月明细并入 usage: %w", rel, err)
	}
	keys := make([]string, 0, len(months))
	for _, mm := range months {
		keys = append(keys, monthKey(mm))
	}
	log.Printf("usage retention: %s 持有 %d 行落在相邻月(%s)的明细,已并入 usage 对应分区"+
		"(R6-A-1/复审 §1.5-B:错界分区的明细不得随 DROP 一起消失)",
		rel, moved, strings.Join(keys, ","))
	return moved, nil
}

// usagePartitionRoot 返回 public.<rel> 所在分区树的**传递根**关系名
// （pg_partition_root；非分区 / 关系不存在 = 空串），以及"该根是不是
// public.usage"（按 oid 判定，见 attachedToUsage 的 R8-A-7 说明）。
//
// 与 scanUsageMonthTables 的 attachedToUsage 判据**同源同事实**（同一个
// pg_partition_root + 同一个 oid 比较），只是入口不同：那里是"扫一遍全部月关系"，
// 这里是"核对某一个关系"。两处若分叉，"落桶"与"动手前复检"就会给出不同结论。
// R10-A-01（P1）：参数从 `*sql.DB` 放宽到 usageQuerier —— 同一个判据既要能在**池**上
// 问（落桶后的前置复检），也要能在**临界区的事务**里问（持锁复检，见
// dropDetachedOrphanAtomically）。两处若各写一份 SQL，"落桶/前置/持锁"三个结论就会
// 分叉，而这正是 R10-A-01/R10-A-02 的缺陷形态。
func usagePartitionRoot(q usageQuerier, rel string) (string, bool, error) {
	var root string
	var attached sql.NullBool
	err := q.QueryRow(`SELECT CASE WHEN c.relispartition THEN COALESCE(r.relname, '') ELSE '' END,
       COALESCE(c.relispartition AND pg_partition_root(c.oid) = to_regclass('public.usage'), false)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_class r ON r.oid = pg_partition_root(c.oid)
WHERE c.relname = ? AND n.nspname = 'public'`, rel).Scan(&root, &attached)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return root, attached.Valid && attached.Bool, nil
}

// usageOwnershipState 是"这个关系此刻挂在谁下面"的**三态**结论（R10-G3 · N4）。
//
// 为什么必须是三态而不是 `err != nil`：`assertDetachedFromUsage` 这一条判据此前
// 同时承担两种完全不同的语义 ——
//
//	① 它确实还挂在 usage 分区树里（**可判定的 catalog 事实**，调用方按良性
//	   deferred 处理：本轮不动它）；
//	② 它自己的 catalog 读失败了（**判据没跑成**，必须 fail-loud）。
//
// 复审 N4 的故障注入实测：一次真的读失败被当成"归属已变 ⇒ 良性"，整轮
// `err=nil / failures=0`，日志还断言"它已回到 usage 分区树里"（与事实相反）。
// 判据与动作之间不允许夹着"对失败的猜测"，所以把结论**结构化成三态**：
// attached / detached 是事实，unknown 是失败 —— 调用方按状态分支，只有 unknown
// 走 fail-loud。
type usageOwnershipState int

const (
	// usageOwnershipUnknown：判据**没跑成**（catalog 读失败/超时）⇒ 必须 fail-loud。
	usageOwnershipUnknown usageOwnershipState = iota
	// usageOwnershipDetached：catalog 事实 = 不是 usage 的**后代**分区（含关系已不存在）。
	usageOwnershipDetached
	// usageOwnershipAttached：catalog 事实 = 传递根就是 public.usage。
	usageOwnershipAttached
)

// usageOwnership 是三态判据的返回值（判据 SQL 的唯一实现在 usagePartitionRoot）。
type usageOwnership struct {
	rel   string
	state usageOwnershipState
	// root 是传递根关系名（state==attached 时非空）。
	root string
	// probeErr 非 nil ⇔ state == usageOwnershipUnknown。
	probeErr error
}

// attached 是调用方唯一需要的投影：它决定"能不能按孤儿口径补账/能不能 DROP"。
// detached 不出投影函数 —— 判据的两个事实分支都走 `!attached()`（见调用点的
// switch），多一个恒等函数只会让"判据面"看起来有两处。
func (o usageOwnership) attached() bool { return o.state == usageOwnershipAttached }

// guardErr 把"它确实挂在 usage 分区树里"渲染成固定错误（唯一文案实现）。
//
// 这条错误只在**判据回归**时出现（落桶判据与 catalog 事实不一致），是"账本翻倍
// + 删活分区"这两件静默事故的唯一守卫；正常路径上 attached 是一个**良性**结论
// （并发轮次/本轮自己的 adopt 把它领回了 usage），调用方按状态分支处理，不再借
// 错误通道表达（N4）。
func (o usageOwnership) guardErr() error {
	root := o.root
	attached := o.state == usageOwnershipAttached
	if attached {
		where := fmt.Sprintf("传递根 = %q", root)
		if root == "usage" {
			where = "传递根 = usage"
		}
		return fmt.Errorf("%s 是 usage 的**后代**分区（%s）却被当成孤儿:"+
			"它的行已经能被 `SELECT … FROM usage` 读到,再与 usage 做 UNION ALL 会把同一行算两遍"+
			"(账本金额翻倍),DROP 还会删掉一株活分区;拒绝处理,请人工核对该分区树", o.rel, where)
	}
	return nil
}

// usageOwnershipProbeHook 是**仅测试**的故障注入点（生产恒为 nil，形态与
// cleanupDetachedStepHook 同源）：让"归属复检自身报错"这条路径可以被**确定性**
// 复现（R10-G3 · N4 的判据）—— 复审的故障注入是"只让事务句柄上的复检报错"，
// 这里用一个受控回调达到同一形态，不必改产品代码。
//
// 回调返回非 nil ⇒ usageOwnershipOf 按 **unknown（判据没跑成）** 上报，调用方
// 必须 fail-loud；返回 nil ⇒ 判据照常执行。
var usageOwnershipProbeHook func(q usageQuerier, rel string) error

// usageOwnershipOf 是归属判据的**唯一实现**（R10-A-01/A-04 的守卫 + R10-G3 的三态）。
//
// 判据 SQL 与落桶判据同源同事实（usagePartitionRoot：pg_partition_root 的 oid 比较）。
// 关系不存在（ErrNoRows）是 detached（"这一刻确实不在 usage 树里"），**不是** unknown
// —— 判据不建立在对失败的猜测上，两种情况必须分开。
func usageOwnershipOf(q usageQuerier, rel string) usageOwnership {
	own := usageOwnership{rel: rel, state: usageOwnershipDetached}
	if usageOwnershipProbeHook != nil {
		if err := usageOwnershipProbeHook(q, rel); err != nil {
			own.state = usageOwnershipUnknown
			own.probeErr = fmt.Errorf("核对 %s 的分区树根: %w", rel, err)
			return own
		}
	}
	root, attached, err := usagePartitionRoot(q, rel)
	if err != nil {
		own.state = usageOwnershipUnknown
		own.probeErr = fmt.Errorf("核对 %s 的分区树根: %w", rel, err)
		return own
	}
	own.root = root
	if attached {
		own.state = usageOwnershipAttached
	}
	return own
}

// assertDetachedFromUsage 是"孤儿"这一概念的**双保险**（R7-A，P1）。
//
// 孤儿补账走 `usage ∪ 孤儿` 的 UNION ALL，正确性前提是**该关系不在 usage 的
// 分区树里** —— `SELECT … FROM usage` 已经包含整棵子树（含多级布局的孙辈叶子）
// 的行，再 union 一次就是同一行算两遍（静默多计，实测 12.5 → 25.0），随后
// DROP 还会删掉一株仍然挂在 usage 上的活分区。
//
// 落桶判据（scanUsageMonthTables 的传递祖先 + attachedToUsage）已经保证这一点；
// 这里在**动手之前**再按 catalog 事实复检一次：判定与动作各自独立成立，任何一条
// 回归都在这里 fail-loud（调用方记失败并**不 DROP**），而不是把金额写错。
//
// R10-A-01（P1）：复检的**入口**有多处，判据只有 usageOwnershipOf 这一份实现 ——
//   - 落桶之后的**前置复检**（池）；归属在这里变了 ⇒ 良性 deferred（见
//     CleanupUsageRetention 的孤儿分支，R10-A-02）；
//   - 临界区里**持锁复检**（事务）：此刻归属与行集合都已冻结，判定与 DROP 之间
//     不再有窗口（R10-A-01 的 H1/H2 都发生在"判定一处、动作用另一份谓词"上）。
//
// R10-G3（N4）：本函数是 usageOwnershipOf 的**薄封装**（"能不能按孤儿处理"），
// 保留给只关心布尔结论的调用点；临界区与前置复检改用三态结论，把"判据自身报错"
// 与"归属已变"分开（见 usageOwnershipState）。
func assertDetachedFromUsage(q usageQuerier, rel string) error {
	own := usageOwnershipOf(q, rel)
	if own.probeErr != nil {
		return own.probeErr
	}
	return own.guardErr()
}

// usageRelationGone 报告"这个关系现在已经不存在了"（并发/重叠的清理轮次里，另一个
// 执行者已经把它回收掉）。
//
// R8-A-2/R8-D-1：这是**良性竞态**，不是失败 —— 判据与同一函数里的
// retentionLedgerWindow 的 `!probe.Exists`（"并发下已被别人清掉 ⇒ 仍是可继续 DROP
// 的状态"）同口径。旧实现把 DETACH 复检里的 `sql.ErrNoRows`（关系已被 DROP）与
// 探测窗口时的 42P01 一律 noteFailure ⇒ 管理端保存保留期时偶发 500
// 「保留清理失败」（配置其实已提交并已审计），调度器每轮告警、真实失败被淹没。
//
// 探测失败（读不到 catalog）**不算** gone：判据不建立在对失败的猜测上。
//
// R10-D-02（P2）：探测带等锁上界（探测里的 pg_get_expr 会打开关系）—— 清理路径
// 被管理端**同步**调用，等锁必须有界；超时按 timeout 分类延后（R10-A-03），
// 不会在这里被误判成"关系已消失"。
func usageRelationGone(db *sql.DB, rel string) bool {
	probe, err := probeUsagePartitionBudget(db, rel, usageMonthPartitionSpec(time.Now()).parent, usageReclaimLockTimeoutMS)
	return err == nil && !probe.Exists
}

// usageFailureIsBenignRace 报告这次失败是否只是"另一个清理轮次（或管理员）已经把该
// 关系回收掉"造成的 —— R8-A-2/R8-D-1 的良性口径，R9C-2 把它收成**唯一出口**
// （见 CleanupUsageRetention 的 noteFailure）。
//
// 判据 = **catalog 事实**：该关系此刻已不存在。
//
//   - 关系不存在 ⇒ 本轮对它的任何工作都没有对象了（谁清掉的、以什么错误失败都一样），
//     记失败只会把运维面淹在 42P01 噪声里，并把管理端保存保留期变成偶发 500。
//   - 关系**还在** ⇒ 任何失败都必须 fail-loud。注意这里刻意**不**只看 SQLSTATE：
//     `rebuild usage_daily: relation "usage_daily_2027" does not exist`(42P01) 的
//     失败主体是账本关系，被处理的月关系还在 ⇒ 必须让人看见；反过来"等锁时关系被
//     另一会话 DROP"给出的可能不是 42P01（而是 could not open relation with OID 这类），
//     只看码会漏。判据取"对象是否还在"这一事实，两侧都成立。
//
// 每次判定多一次 catalog 探测：只在**失败路径**上发生，不在热路径。
func usageFailureIsBenignRace(db *sql.DB, rel string, err error) bool {
	if err == nil {
		return false
	}
	if !usageRelationGone(db, rel) {
		return false
	}
	code, ok := pgErrorCode(err)
	if !ok {
		code = "unknown"
	}
	log.Printf("usage retention: BENIGN %s 已被并发轮次(或管理员)回收(sqlstate=%s): %v;"+
		"本轮不计失败(R9C-2:良性竞态的唯一出口)", rel, code, err)
	return true
}

// cleanupDetachedStepHook 是**仅测试**的注入点（生产恒为 nil，形态与 migrate.go 的
// testMigrationHook 同源）：在"孤儿/脱离关系"清理路径的两个语句边界上各调一次，
// 供确定性复现 R9C-2 的 W3/W4 窗口 —— 探针在回调里用**另一条连接**把关系 DROP 掉
// （R10-A-01 的探针则在这里用**生产入口** ensureUsagePartition 把它领回 usage），
// 再放行，于是"关系在两条语句之间被并发回收/改挂"这件事不再依赖调度运气。
//
//	step = "detail-months"：min/max 探测之后、detailMonthsOutside（W3）之前；
//	step = "backfill"     ：detailMonthsOutside 与相邻月并入之后、进入临界区之前（W4）。
var cleanupDetachedStepHook func(rel, step string)

// detachedCleanupPlan 是"表形态孤儿"清理在**临界区之前**算好的全部输入。
type detachedCleanupPlan struct {
	// winFrom/winTo 是补账窗口：名义月 ∪ 该关系实际持有的行覆盖的北京日 ∪
	// 相邻月的**整月**（见 retentionLedgerWindow 的同一条纪律）。
	winFrom, winTo time.Time
	// foldErr 非 nil = 相邻月并入失败（相邻月的分区覆盖不到那些瞬时，或同名关系被
	// 外来对象占用）⇒ 临界区里**只补账、不 DROP**：那些行还在 rel 里，DROP 就是
	// 丢账；补账照做（窗口已扩到整月）⇒ 聚合与账本仍然一致、都不丢（§1.5-B）。
	foldErr error
}

// planDetachedCleanup 处理"名为 usage_<YYYYMM> 的**表形态**孤儿"（relkind='r'/'p'，
// 且**不是** usage 的后代 —— 见 assertDetachedFromUsage）在临界区之前的全部前置工作。
//
// 为什么不能直接 DROP（§1.5-A 实证）：孤儿不在 usage 之下 ⇒ `SELECT … FROM
// usage` 读不到它的行，聚合与永久账本双双失明；DROP 之后那些金额就再也没有
// 任何来源。所以清理顺序被固定成：
//
//  1. 相邻月明细并入（foldAdjacentMonthsIntoUsage）—— 与 B 同一修法；
//  2. 补账：把孤儿与 usage 放进**同一次**聚合（union），窗口 = 名义月 ∪
//     该关系实际持有的行所覆盖的北京日 ∪ 相邻月的**整月**。
//
// R10-A-01（P1）：第 2 步**不在这里做**。它的位置被移到临界区里（持锁之后、
// DROP 之前，见 dropDetachedOrphanAtomically）—— 判据（"它不是 usage 的后代"）
// 与动作（`usage ∪ rel` 的 UNION ALL 补账 + `DROP TABLE`）之间此前隔着多轮 SQL
// 往返（同机秒级），而生产路径**会**在这个窗口里把同名孤儿领回 usage 下
// （ensureUsagePartition → adoptDetachedMonthPartition）：
//
//	H1 账本翻倍：rel 已在 usage 树下 ⇒ 同一行被算两遍（实测 12.5 → 25.0）；
//	H2 活分区被删：`DROP TABLE IF EXISTS rel` 对"已挂回 usage 的分区"成功
//	   ⇒ 清理路径静默拆掉一块 usage 分区树，而整轮 err=nil/failures=0/skipped=0。
//
// 本函数的**唯一**正确性前提仍是"该关系不是 usage 的后代"，所以前置复检留在这里
// fail-loud；临界区里还有一次**持锁复检**（同一个 assertDetachedFromUsage）。
func planDetachedCleanup(db *sql.DB, rel string, m time.Time) (detachedCleanupPlan, error) {
	plan := detachedCleanupPlan{winFrom: dayKey(m), winTo: dayKey(m).AddDate(0, 1, -1)}
	// R8-A-2/R8-D-1：关系已经被**另一个**清理轮次（或管理员）回收掉了 ⇒ 良性，
	// 直接返回（补账随之无意义：行已经不在盘上）。判据与 retentionLedgerWindow
	// 的 `!probe.Exists` 同口径 —— 同一个函数里两处对"关系不存在"给出相反结论
	// 就是判据不自洽，而它的表现是"管理端保存保留期偶发 500"。
	if usageRelationGone(db, rel) {
		log.Printf("usage retention: %s 已不存在(并发/重叠的清理轮次或管理员已回收);按良性处理,不再补账也不 DROP", rel)
		return plan, nil
	}
	// R7-A（P1）双保险：这里的**唯一**正确性前提是"该关系不是 usage 的后代"
	// （否则补账的 union 会把同一行算两遍）。落桶判据已经过传递祖先，这里在
	// 动手前再按 catalog 事实复检一次：判据回归（例如退回"只看直接父"）时在这里
	// fail-loud，而不是静默把金额写成两倍、再把一株活分区 DROP 掉。
	if err := assertDetachedFromUsage(db, rel); err != nil {
		return plan, err
	}
	// 实际持有的行覆盖的北京日（空关系返回 NULL ⇒ 只有名义月窗口）。
	// R10-D-02：这一读也要有界（等锁上界），否则前半轮会被任一月分区的
	// ACCESS EXCLUSIVE 无界挂住。
	lo, hi, err := detachedWindowBounds(db, rel)
	if err != nil {
		if usageRelationGone(db, rel) {
			// 探测与 DROP 之间被另一轮回收（42P01）—— 同上，良性。
			log.Printf("usage retention: %s 在探测窗口前已被并发轮次回收;按良性处理", rel)
			return plan, nil
		}
		return plan, fmt.Errorf("探测 %s 持有的明细窗口: %w", rel, err)
	}
	if lo.Valid {
		if d := BeijingDay(lo.Time); d.Before(plan.winFrom) {
			plan.winFrom = d
		}
	}
	if hi.Valid {
		if d := BeijingDay(hi.Time); d.After(plan.winTo) {
			plan.winTo = d
		}
	}
	if cleanupDetachedStepHook != nil { // 仅测试：见该变量的注释（R9C-2 的 W3）
		cleanupDetachedStepHook(rel, "detail-months")
	}
	months, err := detailMonthsOutside(db, rel, dayKey(m), dayKey(m).AddDate(0, 1, -1))
	if err != nil {
		return plan, err
	}
	if len(months) > 0 {
		// 账本窗口必须覆盖相邻月的**整月**：那些月的明细分区还在（聚合会读明细），
		// 账本必须与它一致（否则同一个月的两个口径给出两个数）。
		if months[0].Before(plan.winFrom) {
			plan.winFrom = months[0]
		}
		if last := months[len(months)-1].AddDate(0, 1, -1); last.After(plan.winTo) {
			plan.winTo = last
		}
	}
	_, plan.foldErr = foldAdjacentMonthsIntoUsage(db, rel, m, months)
	if cleanupDetachedStepHook != nil { // 仅测试：见该变量的注释（R9C-2 的 W4）
		cleanupDetachedStepHook(rel, "backfill")
	}
	return plan, nil
}

// cleanupDetachedUsageTable 是**历史入口**（既有回归用例
// audit_r8_retention_fix_test.go 用它断言"重复处理已被 DROP 的孤儿必须返回 nil"）：
// 语义已经收窄为"前置计划算完，可以进入临界区"（nil = 可以）。
//
// 补账与 DROP 现在都在 dropDetachedOrphanAtomically 的**同一个持锁事务**里
// （R10-A-01），所以这里不再有"返回 nil 表示明细已被账本覆盖"的含义 ——
// 名字保留只为兼容既有调用点与用例，判定/动作的唯一实现是 planDetachedCleanup
// 与 dropDetachedOrphanAtomically。
func cleanupDetachedUsageTable(db *sql.DB, rel string, m time.Time) error {
	_, err := planDetachedCleanup(db, rel, m)
	return err
}

// detachedWindowBounds 读 public.<rel> 的 min/max(created_at)（清理路径专用：
// 带等锁上界，R10-D-02）。
func detachedWindowBounds(db *sql.DB, rel string) (lo, hi sql.NullTime, err error) {
	err = withUsageLockBudget(db, usageReclaimLockTimeoutMS, func(tx *sql.Tx) error {
		return tx.QueryRow(fmt.Sprintf(`SELECT min(created_at), max(created_at) FROM %s`,
			quoteRelationIdent(rel))).Scan(&lo, &hi)
	})
	return lo, hi, err
}

// usageReclaimPreBackfill 是回收的**第 0 步**（池上、无锁、可长）：在冻结之前把
// "此刻可见的金额"先写进永久账本（R10-G3 · N1 的保险丝）。
//
// 为什么需要它：R10-G3 之后，"摘下来"（DETACH）与"补账"不再在同一个事务里 ——
// 摘下来的那一刻起，该月明细就**不再被 `SELECT … FROM usage` 读到**（读面按
// `usageAggregateSegments` 的判据回落账本）。如果后面的结算段失败（DROP 被依赖
// 对象挡住、锁超时、语句超时、进程被杀），没有这一份预补账的话，那个月的金额就会
// **从所有读数面上消失**（账本还是旧的、明细已被摘走），而报表只会静默少计。
// 有了它：任何一步失败时账本都已经覆盖到"冻结之前"的金额，缺口只剩
// [预补账快照, 冻结] 这段亚秒级窗口里的提交行 —— 那些行仍在盘上（没被 DROP），
// 下一轮的孤儿路径会把它们与 usage 一起聚合（`usage ∪ rel`）后补上。
//
// 口径选择（判据同源）：extraSources 只允许放**不在 usage 分区树里**的关系
// （见 ledgerDetailSource 的 R7-A 注释）。所以这里先按三态判据问一次归属：
//
//	attached ⇒ 它的行本来就在 `SELECT … FROM usage` 里 ⇒ 单源口径；
//	detached ⇒ `usage` 读不到它的行 ⇒ 与它做同一次 UNION ALL 聚合；
//	unknown  ⇒ 判据没跑成 ⇒ **不猜**：整个预补账直接失败（fail-loud，调用方
//	           按 noteFailure 分类；结算段的权威复检还会再判一次）。
//
// 预补账的代价 = 同窗口多跑一遍聚合（2M 行月分区实测 2.5s 空载 / 18.9s 重载），
// 换来的是"回收的任何一步失败都不会让金额失明"。这是**有意的取舍**：回收是
// 每个月一次的后台动作，而金额可见性是读数面的硬口径。
func usageReclaimPreBackfill(db *sql.DB, rel string, from, to time.Time) error {
	from, to = normalizeDayRange(from, to)
	if from.IsZero() || to.IsZero() || from.After(to) {
		return nil
	}
	own := usageOwnershipOf(db, rel)
	if own.state == usageOwnershipUnknown {
		return fmt.Errorf("预补账前核对 %s 的归属失败（判据没跑成，不猜）: %w", rel, own.probeErr)
	}
	extra := []string{rel}
	if own.attached() {
		extra = nil
	}
	// 账本**自己的**关系（usage_daily 年分区）必须先备好，否则聚合写不进去
	// （这一步只建账本关系，不碰 usage 明细分区）。
	if err := ensureRetentionLedgerRelations(db, from, to); err != nil {
		return err
	}
	return withUsageSettleBudget(db, rel, func(tx *sql.Tx) error {
		return rebuildUsageLedgerRowsFrom(tx, from, to, extra)
	})
}

// preBackfillFailure 把预补账的失败归类（R10-D-02 的"整轮上界与关系数无关"）。
//
// 预补账的聚合读的是 `usage` **父表** ⇒ 它等的那把锁就是父表的锁；所以
// **锁等待超时（55P03）**记成 `lock-usage`：调用方的 noteReclaimOutcome 会据此置位
// "父表被占"，本轮其余关系**直接按同一原因延后**（与冻结段的第一把锁超时同义）。
// 不这么归类的话，每一条关系都会各自吃掉一个 5s 等锁预算 ⇒ 整轮时长重新变成
// "关系数 × 5s"，而管理端是**同步**调用这一轮的（R10-D-02 的"上界与关系数无关"）。
//
// **语句**超时（57014，例如某个月太大撞上按行数推导的预算）不按父表锁竞争归类：
// 那是这一条关系自己的工作量大，其余关系不该被它牵连（它们各自的预算是各自的）。
// 非超时错误仍然按自己的 op 记（真失败 fail-loud，不冒充锁竞争）。
func preBackfillFailure(rel string, err error) usageReclaimResult {
	if code, ok := pgErrorCode(err); ok && code == pgSQLStateLockNotAvailable {
		return usageReclaimResult{outcome: usageReclaimFailed, op: "lock-usage", err: err}
	}
	return usageReclaimResult{outcome: usageReclaimFailed, op: "rebuild-ledger-pre", err: err}
}

// usageSettleRequest 是**结算段**的输入。
type usageSettleRequest struct {
	rel string
	// from/to 是补账窗口（名义月 ∪ 该关系实际持有的行覆盖的北京日 ∪ 相邻月整月）。
	from, to time.Time
	// dropStmt 非空 ⇒ 聚合之后 DROP 它；空 ⇒ 只补账、不 DROP（相邻月并入失败、
	// 或调用方明确要求"父表/带子关系留给人工处置"）。
	//
	// 注意这里**没有** shape/cutoffMonth：非叶子关系的"子树里还有保留期内的行"
	// 闸门必须在**冻结（DETACH）之前**判定（见 reclaimUsagePartitionAtomically），
	// 摘了再判会把不该摘的子树摘成一个孤儿。
	dropStmt string
	// kind 是该关系的 relkind（`pg_class.relkind`），**只用于"结算段对目标关系取哪把
	// 锁"这一步**（R12-N2 P1-03）。空串 = 未提供 ⇒ 按表形态处理（attached 路径的
	// 关系必然是表/分区；孤儿路径由调用方把 shape.Kind 传进来）。
	kind string
}

// settleUsageReclaim 是回收的**第 2 段**（只锁目标关系，可以长）：
//
//	`LOCK ONLY usage ACCESS SHARE`（锁序锚点，见下）
//	→ `LOCK rel ACCESS EXCLUSIVE`（冻结目标子树：写入/ATTACH/DETACH 全部挡住）
//	→ 复检归属（三态：attached ⇒ 良性 deferred 且补账去掉额外来源；unknown ⇒ fail-loud）
//	→ 聚合补账（与 DROP **同一个事务**）
//	→ DROP（可选）
//	→ COMMIT
//
// 为什么可以只锁 rel 而不锁父表的 ACCESS EXCLUSIVE（R10-G3 · N1 的核心）：
//
//	① 父表 AEX 只被"冻结段"用来做 `ALTER TABLE usage DETACH PARTITION`（PG 的
//	   DETACH 需要父表 AEX），而补账与 DROP **不需要**它 —— DROP 一个**已经摘下来**
//	   的表只取它自己的 AEX（真 PG 实测：对仍挂在父表下的分区 DROP 才会取父表 AEX，
//	   所以本段必须先 DETACH，见 reclaimUsagePartitionAtomically）。
//	② `LOCK ONLY usage IN ACCESS SHARE` 是**锁序锚点**：写入路径的顺序是
//	   `usage`（RowExclusive）→ 元组路由经过的每一级分区，父表 DDL 也是
//	   `usage`（AEX）→ 子表。AS 与 RowExclusive **相容**（不挡任何计量写入、也不挡
//	   另一轮的结算段），但它保证本事务**此后不会为了 usage 再去等锁** ⇒ "持有 rel
//	   的 AEX 的同时等 usage"这条环不可能成立（否则与另一轮冻结段的
//	   `usage AEX → rel AEX` 构成死锁）。等锁本身仍有 5s 上界（55P03 ⇒ 延后）。
//	③ 行集合的冻结点是**冻结段的 DETACH**（那一提交之后 `INSERT INTO usage` 的
//	   元组路由再也找不到 rel），本段的 rel AEX 让"再领回"（ATTACH 对被挂的表取
//	   AEX，PG 18.6 实测）也进不来；聚合与 DROP 同事务 ⇒ 被本段挡住的那个写入者
//	   只能在 COMMIT 之后继续，而那时表已经被 DROP（PG 重开关系失败）⇒ 不存在
//	   "插进已摘表、随后被 DROP 删掉"的行。
//
// 归属三态（N4）：attached ⇒ 它已经被（另一轮或本轮的 adopt）领回 usage 树下 ⇒
// **不 DROP**（H2：删它就是静默拆分区树）且补账去掉额外来源（H1：union 会算两遍），
// 按良性 deferred 返回；unknown（判据没跑成）⇒ fail-loud。
func settleUsageReclaim(db *sql.DB, req usageSettleRequest) usageReclaimResult {
	rel := req.rel
	budgetMS := usageReclaimBudgetForRelation(db, rel)
	// N2②：整段的**总**上界（含 COMMIT）。每语句上界（statement_timeout）挡不住
	// "多条语句各自刚好不超"的叠加，所以再加一层 ctx deadline。
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(budgetMS)*time.Millisecond)
	defer cancel()
	// W3-1：本段所有失败的出口都过 usageBudgetError —— 预算到点这件事**没有
	// SQLSTATE**（见 usageFailureTimeoutReason），必须在知道 ctx 状态的地方打标记，
	// 否则它会被记成真失败（管理端 500 + failed_rounds++，且每轮都失败）。
	fail := func(op string, err error) usageReclaimResult {
		return usageReclaimResult{outcome: usageReclaimFailed, op: op, err: usageBudgetError(ctx, err)}
	}
	// 说明（R11A-03）：本段用 `*sql.Tx` 而**不是** `usageBoundedTx`，因为三个既有
	// 回归用例（R10-G3 / R10-H W1 ×2）用 `q.(*sql.Tx)` 作为**事务内 vs 池上**的
	// 故障注入判别器（usageOwnershipProbeHook）。那三处判据不在本泳道的改动面内，
	// 不能为了"顺手把结算段的 COMMIT 也收口"而打断它们。
	// ⇒ 代价如实登记：本段的 COMMIT 仍然只有 ctx 的**语句级**中止（`BeginTx(ctx)`），
	// 提交期处理（提交记录写入之后的等待）不受它约束。真正持有父表 ACCESS
	// EXCLUSIVE 的是**冻结段**，那一段已按 R11A-03 收口（usageBoundedTx）。
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fail("begin-settle", err)
	}
	defer tx.Rollback() //nolint:errcheck // 提交成功后回滚是 no-op
	rollback := func() { _ = tx.Rollback() }

	if err := applyUsageRetentionBudget(tx, usageReclaimLockTimeoutMS, budgetMS); err != nil {
		rollback()
		return fail("set-lock-timeout", err)
	}
	// 锁序锚点（见函数注释 ②）：先 usage（AS，不挡任何写入），再 rel（AEX，冻结）。
	//
	// W3-8（P3）· **已知且接受的代价**：这把 `usage` 的 ACCESS SHARE 会一直持到本段
	// COMMIT，而**另一轮**的冻结段要 `LOCK ONLY usage ACCESS EXCLUSIVE` ⇒ 两轮重叠
	// 时，后到的那一轮在"拿父表锁"这一步等到 lock_timeout（5s）后被分类成
	// **延后**（`op=lock-usage`，err=nil/failures=0，下一轮重试）—— 实测
	// `并发第二轮：err=<nil> wall=5.045s`。判定为可接受：
	//   - 轮内关系是**串行**处理的（第一条关系的结算在第二条开始前已提交），所以
	//     只有"6h 调度轮与启动/管理端触发的即时轮次重叠"才付这个代价；
	//   - 代价是"延后一轮"（有界、可见、无死锁），不是失败、不是丢数据；
	//   - 反向的取舍更差：把锚点挪到 rel 之后（或去掉）就破坏了"持 rel 的同时不再
	//     为 usage 等锁"这条保证 ⇒ 与另一轮 `usage AEX → rel AEX` 成环，PG 死锁
	//     检测会随机杀掉一方（那才是真失败）。锚点必须在 rel 之前，而 ALTER/LOCK
	//     的锁在 PG 里都持到事务结束 ⇒ **没有**"只锚一下再放掉"的写法。
	if _, err := tx.Exec("LOCK TABLE ONLY " + quoteRelationIdent("usage") + " IN ACCESS SHARE MODE"); err != nil {
		rollback()
		return usageReclaimLockFailure(func() bool { return usageRelationGone(db, rel) }, "lock-usage", err)
	}
	// R12-N2（P1-03）：**结算段对目标关系取哪把锁必须按 relkind 分流**。
	//
	// 缺陷形态（R12-A P1-03）：这一句对**物化视图**直接失败 —— PG 的
	// `RangeVarCallbackForLockTable` 不接受 matview（真 PG 18.6 实测：
	// `LOCK TABLE <matview> IN ACCESS EXCLUSIVE MODE` ⇒ **42809**
	// `cannot lock relation "…" / This operation is not supported for materialized
	// views.`，`ACCESS SHARE` 同样 42809）。于是月名被 `CREATE MATERIALIZED VIEW
	// usage_<YYYYMM>` 占住时：R11 的零窗口分支（usageReclaimWindowUnderLock 的
	// `from.IsZero()` 短路）**根本到不了**，这一条关系每轮都进 failures、关系永不
	// 回收、管理端保存保留期每轮 500（`/readyz` 的 reclaim_stalled 永久为真）。
	// 对照：**普通视图**可以 LOCK（同一个回调允许 `RELKIND_VIEW`）⇒ 旧实现的 VIEW
	// 形态恰好能过，matview 形态不能 —— 这就是"同族只收口了一条"。
	//
	// 判据：视图/物化视图**不持有明细行**，所以"判据（窗口）与动作（聚合 + DROP）
	// 出自同一个持锁区间"这条金额纪律对它们**没有对象**（零窗口、没有 created_at
	// 列）。因此：
	//
	//	r/p/其它可锁形态 —— 原样 `ACCESS EXCLUSIVE`（表形态的钱账窗口靠它）；
	//	m（物化视图）    —— **不取锁**（PG 结构上不支持；它的正确性判据是同一事务里
	//	                    的归属复检 + DROP MATERIALIZED VIEW 自身的锁）；
	//	v（视图）        —— 保持原样（可锁，且锁住"判据与动作同一窗口"的成本为零）。
	//
	// 不允许"按 kind 猜"：`kind` 由调用方的 catalog 事实（shape.Kind）传入，空串按
	// 表形态处理（缺省保守）。
	if lockStmt := usageReclaimTargetLock(rel, req.kind); lockStmt != "" {
		if _, err := tx.Exec(lockStmt); err != nil {
			rollback()
			return usageReclaimLockFailure(func() bool { return usageRelationGone(db, rel) }, "lock-subtree", err)
		}
	}
	// 关系已被并发轮次回收：拿锁成功说明它刚刚还在，这里只是把"不存在"也归良性。
	exists, xerr := usageRelationExistsTx(tx, rel)
	if xerr != nil {
		rollback()
		return fail("verify-exists", xerr)
	}
	if !exists {
		rollback()
		return usageReclaimResult{outcome: usageReclaimGone, op: "verify-exists"}
	}
	// 非叶子关系的"子树里还有保留期内的行"闸门由**冻结段**在 DETACH 之前判定
	// （摘了再判会把不该摘的子树摘下来 ⇒ 白留一个孤儿）；这里只留一条断言式的
	// 复检口径：调用方若把非叶子关系送到这里，形状参数必须一致（避免"判定一处、
	// 动作用另一份谓词"）。
	// 归属复检（N4：三态）。
	own := usageOwnershipOf(tx, rel)
	if own.state == usageOwnershipUnknown {
		// **判据没跑成** ≠ 归属已变：必须 fail-loud（复审 N4 的故障注入实测：
		// 旧实现把它当良性吞掉，整轮 err=nil/failures=0 而关系仍是孤儿）。
		rollback()
		return fail("verify-ownership", own.probeErr)
	}
	ownerChanged := own.attached()
	extra := []string{rel}
	if ownerChanged {
		// 它已经回到 usage 树下 ⇒ 它的行本来就在 `SELECT … FROM usage` 里，
		// 再 union 一次就是把同一行算两遍（H1：12.5 → 25.0）。
		extra = nil
	}
	// R11A-01（P1）：**窗口的算定与使用必须在同一个持锁区间内**。
	//
	// 缺陷形态：补账窗口（[from, to]）是调用方在**冻结之前**按"扫描时刻关系里
	// 实际持有的行"算好的（retentionLedgerWindow → detailMonthsOutside），而冻结
	// （DETACH）在预补账的整窗口聚合之后才发生 —— 于是 [窗口算定, 冻结] 之间
	// **提交**、且北京日落在窗口之外的计量行，两边聚合都读不到，却随 DROP 一起
	// 消失（真 PG 探针：`SILENT_LOSS=7.0000`，而该轮
	// `err=nil/cleared=5/skipped=0/failures=0`、/readyz 全绿）。
	//
	// 此刻 rel 上已有 ACCESS EXCLUSIVE（行集合**不可能**再增加），归属也已复检
	// ⇒ 关系自身的 min/max(created_at) 就是这段窗口的**事实**。用它单向扩窗：
	// 判据（窗口）与动作（聚合 + DROP）出自同一个持锁区间，没有第二条时间线。
	// 只扩不缩 ⇒ 原窗口覆盖的月一个不少（相邻月并入的语义不变）。
	if wfrom, wto, werr := usageReclaimWindowUnderLock(tx, rel, req.from, req.to); werr != nil {
		rollback()
		return fail("window-under-lock", werr)
	} else {
		req.from, req.to = wfrom, wto
	}
	// 持锁补账（R10-D-01）：此刻行集合已冻结 ⇒ 补账覆盖的行 = 接下来 DROP 会删掉的行。
	// 与 DROP 同事务：不存在"补了没删 / 删了没补"的中间态（任何一步失败都回滚）。
	if !req.from.IsZero() && !req.to.IsZero() {
		if err := rebuildUsageLedgerRowsFrom(tx, req.from, req.to, extra); err != nil {
			rollback()
			return fail("rebuild-ledger-detached", err)
		}
	}
	if ownerChanged || req.dropStmt == "" {
		if err := tx.Commit(); err != nil {
			return fail("commit-settle-backfill", err)
		}
		if ownerChanged {
			// 良性 deferred：一行数据都没动（DROP 没做），账本按"此刻归属"口径补齐。
			return usageReclaimResult{outcome: usageReclaimNotAttached, op: "verify-ownership"}
		}
		// 只补账、不 DROP（相邻月并入失败 / 父表带子关系留给人工处置）。
		return usageReclaimResult{outcome: usageReclaimBackfilled, op: "backfill-under-lock"}
	}
	if _, err := tx.Exec(req.dropStmt); err != nil {
		rollback()
		return fail("drop-relation", err)
	}
	if err := tx.Commit(); err != nil {
		return fail("commit-settle-drop", err)
	}
	return usageReclaimResult{outcome: usageReclaimDropped, op: "settle-drop"}
}

// usageReclaimTargetLock 给出结算段对**目标关系**该执行的那一句 LOCK（R12-N2 P1-03），
// 返回空串表示"该形态不取锁"（不是"跳过安全检查"：调用方仍然在同一事务里复检归属，
// 且 DROP 语句自己会取它需要的锁）。
//
// 分流的**唯一依据**是 relkind（`pg_class.relkind`）：
//
//	r  普通表 / p 分区表  ⇒ ACCESS EXCLUSIVE（表形态的金额窗口靠它）
//	v  视图              ⇒ ACCESS EXCLUSIVE（PG 允许 LOCK 视图；保持既有语义）
//	m  物化视图          ⇒ **不取锁**（PG 结构上不支持任何 LOCK，见调用点注释）
//	其它（""/i/S/f…）    ⇒ ACCESS EXCLUSIVE（缺省保守：非视图形态本就该按表口径处理）
//
// 为什么不是"给 matview 取 ACCESS SHARE"：真 PG 18.6 实测那句同样报 42809
// （`cannot lock relation … This operation is not supported for materialized views`），
// 换锁级别解决不了 —— 只有"不取锁"这一条路。
func usageReclaimTargetLock(rel, kind string) string {
	if kind == "m" {
		return ""
	}
	return "LOCK TABLE " + quoteRelationIdent(rel) + " IN ACCESS EXCLUSIVE MODE"
}

// usageReclaimWindowUnderLock 在**持 rel 的 ACCESS EXCLUSIVE 时**重算补账窗口
// （R11A-01 的修法：判据与动作同源、同一个持锁区间）。
//
// 语义：
//
//	rel 此刻的行集合已经冻结 ⇒ min/max(created_at) 是**事实**；
//	把窗口单向**扩**到覆盖这两个北京日（只扩不缩）：
//	  - 空关系（min/max 皆 NULL）⇒ 窗口原样返回；
//	  - 零窗口（调用方没给）⇒ 直接取 [min 的北京日, max 的北京日]。
//
// 为什么用"关系自身的 min/max"而不是"再跑一遍 detailMonthsOutside"：
// 前者是**同一次持锁区间里的单条聚合**（无锁、无 TOCTOU），代价 O(1) 索引扫描；
// 后者要按谓词扫行、再解析月份，且在"刚好被本段挡住的那个写入者"上并不更准。
//
// 上界由**声明边界**保证：PG 强制分区约束 ⇒ rel 里不可能有边界之外的行，所以
// "实际行窗口 ⊆ 声明边界窗口"是事实（账本关系按声明边界预先备齐，见
// reclaimUsagePartitionAtomically 的 ensureRetentionLedgerRelations）。
func usageReclaimWindowUnderLock(q usageQuerier, rel string, from, to time.Time) (time.Time, time.Time, error) {
	// 零窗口 = 调用方**明确要求不补账**（`dropDetachedOrphanAtomically` 的
	// 视图/物化视图占名分支：它们不持有明细行，也没有 `created_at` 列）。
	// 这里必须同口径跳过 —— 否则 `SELECT min(created_at)` 会在 VIEW 上报 42703，
	// 把一条本来只需 `DROP VIEW` 的良性关系变成真失败
	// （`TestUsageRetentionViewOccupiedMonthNameIsClearedNotStalling` 抓到的回归）。
	if from.IsZero() || to.IsZero() {
		return from, to, nil
	}
	var lo, hi sql.NullTime
	if err := q.QueryRow(fmt.Sprintf(`SELECT min(created_at), max(created_at) FROM %s`,
		quoteRelationIdent(rel))).Scan(&lo, &hi); err != nil {
		return from, to, fmt.Errorf("读取 %s 的实际行窗口: %w", rel, err)
	}
	if lo.Valid {
		if d := BeijingDay(lo.Time); !d.IsZero() && (from.IsZero() || d.Before(from)) {
			from = d
		}
	}
	if hi.Valid {
		if d := BeijingDay(hi.Time); !d.IsZero() && (to.IsZero() || d.After(to)) {
			to = d
		}
	}
	return from, to, nil
}

// dropDetachedOrphanAtomically 是**孤儿路径**的收口：与 attached 路径
// （reclaimUsagePartitionAtomically）**同形** ——
//
//	预补账（池上、无锁：把"此刻可见的金额"先落进账本，见 usageReclaimPreBackfill）
//	→ 结算段（settleUsageReclaim：只锁 rel 的 AEX）
//	＝ 持锁复检归属（同一个三态判据，不是第二份谓词）
//	→ 持锁补账（`usage ∪ rel` 的**同一次**聚合）
//	→ DROP（或按调用方要求只补账）
//	→ COMMIT
//
// 归属在**动手时**已变（另一轮或本轮自己的 adopt 把它领回了 usage）⇒
// usageReclaimNotAttached：良性 deferred，一行不动、不记失败（与
// `usageReclaimNotAttached` 在 attached 路径上的语义逐字同构，R10-A-02 要的
// 就是这个对照物）。
//
// R10-G3（N1）：孤儿关系**已经是摘下来的**，所以这一段不需要父表的 ACCESS
// EXCLUSIVE（旧实现为了"锁序"把它一起锁上，于是整窗口聚合全程挡住所有计量写入）
// —— 只用 `LOCK ONLY usage ACCESS SHARE` 做锁序锚点，长锁只落在 rel 上。
//
// R12-N2（P1-03）：`kind` 是该关系的 relkind（调用方的 catalog 事实
// `usageRelationShape.Kind`），一路传到结算段的"取哪把锁"那一步 —— 物化视图形态
// 不能 LOCK（42809），必须在这里分流而不是在锁那里猜。
func dropDetachedOrphanAtomically(db *sql.DB, rel, kind string, plan detachedCleanupPlan, dropStmt string) usageReclaimResult {
	// 第 0 步：预补账（口径选择在 usageReclaimPreBackfill 里，判据同源）。
	if err := usageReclaimPreBackfill(db, rel, plan.winFrom, plan.winTo); err != nil {
		return preBackfillFailure(rel, err)
	}
	return settleUsageReclaim(db, usageSettleRequest{
		rel:      rel,
		kind:     kind,
		from:     plan.winFrom,
		to:       plan.winTo,
		dropStmt: dropStmt,
	})
}

// retentionWindow 是"清理某个到期月关系之前必须补算的账本窗口"+ 该关系的形态
// 判定（R5-A-9；exact 由 R6-A-1 复审 V1 §1.5-B 增加）。
type retentionWindow struct {
	from, to time.Time
	shapeErr error
	// exact 报告该关系的**实际边界**是否恰好就是名义北京月窗口（可解析且逐值
	// 相等）。false ⇒ 调用方必须做"相邻月并入"检查（错界 / 更宽覆盖 / 二级分区
	// / 边界读不懂 / 同名孤儿都是 false）。这一条是 §1.5-B 的判据入口：只有边界
	// 恰等于名义月时，"分区里不可能有别的月的行"才是**事实**而不是假设。
	exact bool
	// R11A-01：boundFrom/boundTo 是该关系**声明边界**覆盖的北京日窗口（边界可
	// 解析时；否则零值）。它不是补账窗口，而是补账窗口的**上界** —— PG 强制分区
	// 约束 ⇒ rel 里不可能有声明边界之外的行，所以"结算段按实际行重算出来的窗口"
	// 一定落在它里面。用途只有一个：账本**自己的**关系（usage_daily 年分区）必须
	// 在进入冻结段之前按这个上界备齐（见 reclaimUsagePartitionAtomically）。
	boundFrom, boundTo time.Time
}

// retentionLedgerWindow 返回"清理某个到期月关系之前必须补算的账本窗口",并在
// 同一次 catalog 探测里给出该关系的**形态判定**(R5-A-9,审计 2026-09-23)。
//
//   - 形态就绪(叶子分区、挂 usage 下、边界覆盖期望北京月)→ 窗口 = 该月;
//   - 形态异常(错界 / 读不懂 / 二级分区 / 同名孤儿)→ 窗口 = 该月 ∪ 分区**实际
//     边界**覆盖的北京日。理由:错界分区持有的行可能跨到相邻的北京月(典型是
//     UTC 自然月边界与北京月差 8 小时),只补名义月会让滑到相邻月的那部分行在
//     DROP 时丢掉账;边界读不懂时退回名义月(判据不建立在对边界的猜测上)。
//   - shapeErr 非 nil **不是**中止理由(只用于点名记日志):清理的判据是"该月
//     明细能否被聚合",而聚合读父表,与分区边界无关。
//   - exact=false 同样不是中止理由,但它要求调用方在 DROP 之前做"相邻月并入"
//     (见 foldAdjacentMonthsIntoUsage):边界不是名义月的分区可能持有相邻月的
//     行,补账只让账本有数,聚合仍会从相邻月的明细段里少掉它们(§1.5-B)。
func retentionLedgerWindow(db *sql.DB, rel string, m time.Time) retentionWindow {
	win := retentionWindow{from: m, to: m.AddDate(0, 1, -1)}
	// R10-D-02：探测带等锁上界（见 probeUsagePartitionBudget）—— 前半轮不得无界挂住。
	probe, perr := probeUsagePartitionBudget(db, rel, usageMonthPartitionSpec(m).parent, usageReclaimLockTimeoutMS)
	if perr != nil {
		// 探测失败 ≠ 形态异常:读不到 catalog 时不做任何猜测,按名义月补账并要求
		// 调用方在日志里看见(perr 会作为形态信息被打印)。exact 保持 false ⇒
		// 调用方仍会按**行**核对相邻月明细(不依赖边界)。
		win.shapeErr = perr
		return win
	}
	if !probe.Exists {
		win.exact = true // 并发下已被别人清掉:仍是"可以继续 DROP"的状态
		return win
	}
	// R11A-01：声明边界窗口先记下来（它是"补账窗口的上界"，账本关系按它预建）。
	// 与下面"窗口 = 该月 ∪ 声明边界"的扩窗**不是**同一件事：那一步只在形态不
	// 就绪时发生，而这一步无论形态是否就绪都要有值。
	if boundFrom, boundTo, ok := splitRangeBound(probe.Bound); ok {
		if _, at, okF := parsePartitionBoundLiteral(boundFrom); okF {
			win.boundFrom = BeijingDay(at)
		}
		if _, at, okT := parsePartitionBoundLiteral(boundTo); okT {
			// 上界是开区间:退 1ns 落到最后一个被覆盖的瞬时所在的北京日。
			win.boundTo = BeijingDay(at.Add(-time.Nanosecond))
		}
	}
	// exact 只在**叶子分区**且边界恰等于名义北京月时为真：二级分区（relkind='p'）
	// 的覆盖范围无法由父分区的边界一次证明 —— PG 允许子分区的区间超出父分区
	// （实测：`CREATE TABLE child PARTITION OF parent FOR VALUES FROM (…) TO (…)`
	// 不校验包含关系），所以"父分区边界正确"推不出"子树里没有别的月的行"。
	// 这类关系必须按**行**核对（与孤儿同一口径）。
	win.exact = probe.RelKind == 'r' && partitionBoundIsExactMonth(probe.Bound, m)
	if serr := partitionReadyErr(usageMonthPartitionSpec(m), probe); serr == nil {
		return win
	} else {
		win.shapeErr = serr
	}
	if boundFrom, boundTo, ok := splitRangeBound(probe.Bound); ok {
		if _, at, okF := parsePartitionBoundLiteral(boundFrom); okF {
			if d := BeijingDay(at); d.Before(win.from) {
				win.from = d
			}
		}
		if _, at, okT := parsePartitionBoundLiteral(boundTo); okT {
			// 上界是开区间:退 1ns 落到最后一个被覆盖的瞬时所在的北京日。
			if d := BeijingDay(at.Add(-time.Nanosecond)); d.After(win.to) {
				win.to = d
			}
		}
	}
	return win
}

// partitionBoundIsExactMonth 报告分区边界原文是否**恰好**是某个北京月窗口
// （可解析 + 逐值相等）。读不懂 / DEFAULT / MINVALUE..MAXVALUE 一律 false ——
// 判据不建立在对边界的猜测上，"不是确切的北京月"就要按行核对相邻月明细。
func partitionBoundIsExactMonth(bound string, m time.Time) bool {
	from, to, ok := splitRangeBound(bound)
	if !ok {
		return false
	}
	_, atFrom, okF := parsePartitionBoundLiteral(from)
	_, atTo, okT := parsePartitionBoundLiteral(to)
	if !okF || !okT {
		return false
	}
	wantFrom := BeijingDayInstant(dayKey(m))
	wantTo := BeijingDayInstant(dayKey(m).AddDate(0, 1, 0))
	return atFrom.Equal(wantFrom) && atTo.Equal(wantTo)
}

// retentionBackfill 是清理路径的补账入口:**唯一实现**（"先备关系、再聚合"两段）。
//
//   - 先备好 usage_daily 年分区(账本**自己的**关系,缺了聚合结果写不进去 =
//     真失败),再做**纯聚合** —— 全程不碰 usage 明细月分区,因此"该月分区形态
//     异常"不会阻止清理(R5-A-9)。
//   - extraSources 是**不在 usage 分区树里**的明细来源（表形态孤儿）：它们的行对
//     `SELECT … FROM usage` 不可见，只 DROP 就是金额永久丢失（§1.5-A）。它们由
//     rebuildUsageLedgerRowsFrom 与 usage 放进**同一次**聚合 —— 分两次 UPSERT
//     会让同一 (user,model,day) 的两份金额互相覆盖成其中一份。
//     **资格判据是"不在 usage 之下"**（不是"名字像月分区但直接父不是 usage"）：
//     挂 usage 之下的关系（含多级布局的孙辈叶子）必须走 extraSources=nil 的普通
//     路径，否则同一行被算两遍（R7-A，P1，见 ledgerDetailSource 的注释）。
//
// 清理路径**不用**这个入口进临界区：它把两段拆开（关系准备在临界区外、聚合在
// 持锁事务里），见 CleanupUsageRetention / reclaimUsagePartitionAtomically
// （R10-D-01）。本函数保留给"不需要锁"的调用点（相邻月并入失败时的兜底补账）。
func retentionBackfill(db *sql.DB, from, to time.Time, extraSources []string) error {
	if err := ensureRetentionLedgerRelations(db, from, to); err != nil {
		return err
	}
	return rebuildUsageLedgerRowsOnPool(db, from, to, extraSources)
}

// retentionBackfillBudget 是**清理路径**的补账入口：与 retentionBackfill 同一份
// 实现（先备关系、再聚合），只是聚合跑在"带 lock_timeout + 计划期裁剪"的事务里
// （R10-D-02：清理被管理端**同步**调用，任一处等锁都必须有界）。
func retentionBackfillBudget(db *sql.DB, from, to time.Time, extraSources []string) error {
	if err := ensureRetentionLedgerRelations(db, from, to); err != nil {
		return err
	}
	return withUsageLockBudget(db, usageReclaimLockTimeoutMS, func(tx *sql.Tx) error {
		return rebuildUsageLedgerRowsFrom(tx, from, to, extraSources)
	})
}

// ensureRetentionLedgerRelations 备好补账窗口内每个月的 usage_daily 年分区
// （账本**自己的**关系；缺了聚合结果写不进去 = 真失败）。
//
// R10-D-01（P1）：这一步必须在**进入临界区之前**完成 —— 临界区持有 usage 的
// ACCESS EXCLUSIVE，而 ensureUsageDailyPartition 可能真的建表（DDL 走连接池，
// 池上限可能被配成 1：PICOAI_DB_MAX_OPEN_CONNS / 测试里的 SetMaxOpenConns(1)，
// 持有事务连接时再向池里要第二条连接会自锁）。临界区里因此只允许**事务句柄上的
// 纯 DML**（聚合 + 两条 UPSERT）。
func ensureRetentionLedgerRelations(db *sql.DB, from, to time.Time) error {
	from, to = normalizeDayRange(from, to)
	if from.IsZero() || to.IsZero() || from.After(to) {
		return nil
	}
	for m := dayKey(from); !m.After(dayKey(to)); m = m.AddDate(0, 1, 0) {
		if err := ensureUsageDailyPartition(db, m); err != nil {
			return err
		}
	}
	return nil
}

// rebuildLedgerForRetention 是清理路径补账的**无额外来源**入口(挂在 usage 下的
// 分区:它们的行本来就在父表查询里)。
func rebuildLedgerForRetention(db *sql.DB, from, to time.Time) error {
	return retentionBackfill(db, from, to, nil)
}

// CleanupUsageRetention DROP 过期月份分区(先校验该月日账已生成,防丢账)。
// 保留 N 个月 = 删除 created_at 早于"当前北京月 - N 个月"的整分区。
//
// R4-C-8(审计 2026-09-23,P3):判据从"逐月回溯、遇到缺表即 break"改成
// **枚举实际存在的关系**。旧实现把"某月没有表"当成"已到边界",而月分区是写时
// 惰性创建的 —— 零用量月本来就没有分区,那个洞会让更早的分区**永久**不被清理
// (该月已过去 ⇒ 分区不会被重建 ⇒ 洞永久)。现在既不 break、也不会漏月,并且把
// 区间里缺席的月份**显式记录**下来(运维可据此核对"保留期是否真的覆盖到边界")。
//
// R6-A-1(审计 2026-09-23,P1):清理**逐关系错误隔离**。单条关系失败(DROP 视图
// 形态发错动词、被别的对象依赖 2BP01、锁超时、补账失败)只记日志+原因码并继续,
// 末尾把本轮失败聚合成一个错误返回 ⇒ 保留策略不再被一条坏关系永久拖停摆,同时
// 仍 fail-loud(调用方/调度器能看到非 nil 并重试)。形态判定的降级语义(R5-A-9)
// 不变;每轮**无条件**打一行 `usage retention: round summary …`(清了几条/失败
// 几条),失败另有逐条的 `usage retention: FAILED <rel> op=… sqlstate=…`。
//
// R8-A-2/R8-A-3/R8-A-4(审计 2026-09-24,P2×3):
//   - "关系已被另一个并发轮次回收"（42P01 / 探测到关系不存在）归为**良性**，
//     与 retentionLedgerWindow 的 `!probe.Exists` 同口径 —— 否则管理端保存保留期
//     会偶发 500「保留清理失败」（配置其实已提交并已审计），调度器每轮告警;
//   - "没有回收"的关系按**原因**分类计数（skip_reasons），并连同关系名一起写进
//     进程内状态（UsageRetentionStatus，由 /readyz 下发）—— 此前深后代永不回收
//     这件事只有一行日志，readyz/管理端/指标面全都看不见;
//   - 非叶子关系（父表/带子关系）在 DETACH+DROP 之前先看**子树里还有没有保留期内
//     的行**：有 ⇒ 保留但不回收（拆树会删掉保留期内的明细分区），原因可观测。
func CleanupUsageRetention(db *sql.DB) (err error) {
	// R8-A-3：无论成功、失败还是早退，都要留下**过程事实**（轮数/时间/原因计数/
	// 未回收关系清单）。状态是"调度器自己记账、装配层只读"的形态（先例：
	// serverstore.AuditWriteStats / AuditChainStatus）。
	round := usageRetentionRound{}
	// R9C-4：`last_round_at` 的语义是"最近一轮何时**跑完**"（与 rounds/failed_rounds
	// 一起回答"调度器还活着吗"）。时刻在 defer 里取，取的是结束时刻 —— 此前取的是
	// 开始时刻而文档写"结束"，读数与语义不一致。
	defer func() {
		round.EndedAt = time.Now()
		recordUsageRetentionRound(round, err)
	}()

	n, err := EffectiveRetentionMonths(db)
	if err != nil {
		return err
	}
	round.ConfiguredMonths = n
	// R9-D R9D-05:读到过生效保留期才算**观测值**(把"还没跑过一轮"的零值与
	// "保留期已关(=0=永不删除)"分开)。
	round.ConfiguredMonthsKnown = true
	if n == 0 {
		return nil // 永不删除
	}
	// 保留 N 个月 = 删除 created_at 早于"当前北京月 - N 个月"的整分区。
	// 北京月界(不依赖进程 TZ:UTC 容器在每月 1 日 00:00-08:00 会把 cutoff
	// 算到上一个月,导致多删一个月的明细)。
	cutoffMonth := BeijingMonth(time.Now()).AddDate(0, -n, 0)
	round.CutoffMonth = monthKey(cutoffMonth)
	tables, err := scanUsageMonthTables(db)
	if err != nil {
		return err
	}
	// R10-H3（W3-3）：从这一行起，本轮**真的观测过**回收面（保留期读到 + catalog
	// 扫描成功）。它对两条 liveness 判据（连续延后 streak / 最早未回收月）是"证据"
	// 的分界：早退轮（保留期=0、读配置失败、扫描失败）不得清零 streak、也不得前移
	// "最早未回收月"（"没观测" ≠ "已回收"）。
	round.Scanned = true
	// F11(审计 2026-09-11):孤儿关系(DETACH 成功但 DROP 失败留下的表、或被换成
	// VIEW 的异常形态)先清掉 —— 它们没有分区身份，留着会让该月的新写入撞同名关系
	// 而失败。
	//
	// R6-A-1(审计 2026-09-23,P1):这里与下面的分区循环都改成**逐关系错误隔离**。
	// 旧实现一条失败即 `return derr`,而 Orphans 在分区循环之前 ⇒ 任意一条关系
	// DROP 失败(视图占名 42809、被别的对象依赖 2BP01、锁超时…)就让**该轮全部到期
	// 月份**留在盘上,且下一轮在同一处再中止 ⇒ 保留策略永久停摆(管理端仍显示
	// "生效中",磁盘按经过的月份单调增长)。现在:单条失败只记日志(带原因码)并
	// 继续处理其余关系,函数末尾把本轮失败**聚合成一个错误**返回 —— 仍然 fail-loud
	// (调用方/调度器能看到非 nil 并重试),但不再阻断与故障无关的月份。
	// 第五轮 R5-A-9 的语义(形态异常只降级为日志、不阻断清理)保持不变。
	var failures []string
	failed := 0
	failedRels := make([]string, 0, 1)

	clearedDetached := 0
	skipped := 0
	// R11A-04：本轮**真的把关系删掉**的集合 —— `existing` 是"扫描时刻存在"的事实，
	// 而写入面条目的"已解决"判据要用"本轮结束时还存在"（两者只差本轮删掉的那些）。
	// 必须在**两个桶**（孤儿桶在前、attached 桶在后）之前声明。
	reclaimedRel := make(map[string]bool)
	// R10-D-02（P2）：`usage` 的 ACCESS EXCLUSIVE 是**所有**关系共同的锁点
	// （临界区的第一把锁）。一旦某一处等它超时，本轮其余关系的临界区都会同样
	// 各等一个 5s ⇒ 整轮时长随关系数线性增长，而管理端是**同步**调用。第一处
	// 超时已经证明"父表被占"，所以其余的按同一条原因直接延后：整轮的上界与
	// 关系数无关（可读性不变：每条关系仍然逐个进 unreclaimed/skipped_by_reason）。
	usageLockContended := false
	round.Relations = len(tables.Orphans) + len(tables.Partitions) + len(tables.AttachedNonLeaf)
	// skipReasons 是"没有回收"的**按原因计数**（R8-A-3 的可判定面）：日志里逐条，
	// 状态里逐类 —— 深后代永不回收这件事从此在 /readyz 上可读。
	//
	// 日志保留既有的可 grep 前缀（`SKIP descendant partition <rel>` /
	// `SKIP detached relation <rel>`，既有用例断言它们），并在其后追加
	// `reason=<封闭取值>:` —— 判据与"按原因计数"（R8-A-3）同时成立，不必二选一。
	skipReasons := map[string]int{}
	unreclaimed := make([]string, 0, 4)
	// R10-G3（N2② / N3）：本轮**按超时延后**的关系（去重）。它是"连续延后"这条
	// liveness 判据的输入（见 usage_retention_status.go 的 DeferredStreak）：
	// 每轮被覆写的 skipped_by_reason 只能说明"这一轮为什么没回收"，回答不了
	// "同一条关系已经连续多少轮没被回收"（复审 N3 的实测：3 轮 × 6 关系全
	// lock-timeout 而 failed_rounds=0、unreclaimed 每轮被覆写）。
	deferredRels := make([]string, 0, 2)
	deferredSeen := map[string]bool{}
	noteSkip := func(kind, rel, reason, msg string) {
		skipped++
		skipReasons[reason]++
		unreclaimed = append(unreclaimed, rel+"("+reason+")")
		if (reason == usageSkipLockTimeout || reason == usageSkipStatementTimeout ||
			reason == usageSkipSettleBudgetTimeout) && !deferredSeen[rel] {
			deferredSeen[rel] = true
			deferredRels = append(deferredRels, rel)
		}
		log.Printf("usage retention: SKIP %s %s reason=%s: %s", kind, rel, reason, msg)
	}
	noteFailure := func(rel, op string, err error) {
		// R9C-2（审计 2026-09-24，P2）：良性竞态必须走**同一个出口**。
		// R8-A-2/R8-D-1 的"关系已被并发轮次回收 ⇒ 良性"只补了 5 个窗口里的 2 个
		// （W3 detailMonthsOutside / W4 retentionBackfill / W5 DETACH 过渡态仍会把
		// 42P01 记成失败）—— 4 路并发清理实测"一轮里 4/4 路返回非 nil"，管理端
		// 保存保留期仍会偶发 500「保留清理失败」，正是那次修复声称消灭的症状。
		// 逐窗口补丁会持续漏（每加一个"先探测再动手"的窗口就多一个），所以判据
		// 收在这里：**只要该关系此刻确实已不存在，本轮对它的任何工作都失去了
		// 对象**（谁清掉的、以什么错误失败都一样）⇒ 恶性失败只在"关系还在"时记录。
		// R10-A-03（P2）：**锁等待/语句超时**与真失败必须可区分。顺序也重要：
		// 这个判据必须**先于**下面的良性竞态探测 —— 那个探测本身要读 catalog
		// （probeUsagePartition 会打开关系），在"月分区被 ACCESS EXCLUSIVE 锁住"
		// 的场景里它自己也会等锁 5s ⇒ 一条关系白白多花 5s（R10-D-02 的"有界"之外
		// 还要"够快"：管理端是同步调用）。超时结论不依赖"关系是否已消失"。
		//
		// R10-A-03（P2）：**锁等待/语句超时**与真失败必须可区分。
		//
		// 缺陷形态：任何持有 `usage`（或任一月分区）ACCESS SHARE 超过
		// usageReclaimLockTimeoutMS 的**读**事务，都会让该关系记一次失败 ⇒ 整轮非
		// nil ⇒ 管理端 `PUT /api/server/admin/…` 回 500「保留清理失败」（配置其实
		// 已提交并已审计）+ `/readyz` 的 failed_rounds 增长。危害是**信号质量**：
		// 一次锁竞争被读成故障。判据是结构化的 SQLSTATE（55P03/57014），不是
		// "看起来像超时"—— 任何其它错误仍然是真失败、仍然 fail-loud。
		//
		// 超时走"本轮延后"的 skip 分类：计数进 skipped_by_reason、关系名进
		// unreclaimed、日志留一行（数据一行未动，下一轮自动重试）。
		if reason, ok := usageFailureTimeoutReason(err); ok {
			noteSkip("deferred relation", rel, reason, fmt.Sprintf("op=%s: %v（等锁/语句超时，"+
				"本轮整体回滚、一行数据未动；下一轮自动重试。R10-A-03：超时是延后，不是失败）", op, err))
			return
		}
		if usageFailureIsBenignRace(db, rel, err) {
			return
		}
		failed++
		failedRels = append(failedRels, rel)
		code, ok := pgErrorCode(err)
		if !ok {
			code = "unknown"
		}
		log.Printf("usage retention: FAILED %s op=%s sqlstate=%s err=%v;"+
			" 继续清理其余到期关系(R6-A-1:单条失败不得让整轮停摆,下一轮会重试它)",
			rel, op, code, err)
		failures = append(failures, fmt.Sprintf("%s (%s, sqlstate=%s): %v", rel, op, code, err))
	}
	// noteReclaimOutcome 记一次临界区结果，并维护"父表锁被占"的轮级判定。
	noteReclaimOutcome := func(rel, op string, err error) {
		if op == "lock-usage" && err != nil {
			if _, timedOut := usageFailureTimeoutReason(err); timedOut {
				usageLockContended = true
			}
		}
		noteFailure(rel, op, err)
	}
	for _, rel := range tables.Orphans {
		m, ok := usageMonthRelationOf(rel)
		if !ok {
			continue
		}
		if !m.Before(cutoffMonth) {
			// R9-D R9D-07(P2):保留期内的同名孤儿**不能删**(它的明细还在保留期内),
			// 但它占着当月分区名 —— 写路径要么把它领回(adopt 自愈)、要么该月写入
			// 永久失败。旧实现直接 continue(零计数),于是"有一条关系在挡着当月写入"
			// 与"没有可回收的关系"在 skip_reasons 上逐字同形。
			//
			// 这里只**点名**(不回收):判据与"哪些关系没有回收"同构,处置由写路径的
			// adopt 自愈 + 人工负责(见 /readyz 的 write_blocked_*)。
			noteSkip("detached relation", rel, usageSkipOrphanRetained,
				"该关系不在 usage 分区树里、而名字的那个月仍在保留期内:保留期内不能删它的明细;"+
					"写入路径会尝试把它领回 usage 下(自愈),领不回则该月写入会以 503 METERING_FAILED 失败"+
					"(见 /readyz 的 write_blocked_*)")
			continue
		}
		shape := tables.Shapes[rel]
		// R7-A（P1）双保险：**落进 Orphans 桶的每一条关系**在动手之前都按 catalog
		// 事实复检一次"它不是 usage 的后代"。孤儿补账走 `usage ∪ 孤儿` 的 UNION
		// ALL，只有两边**不相交**时"同一行算两遍"才不成立；判据一旦回归（例如
		// 退回"只看直接父"），必须在这里 fail-loud（记失败 + **不 DROP**），而不是
		// 静默把金额写成两倍、再把一株活分区删掉。
		//
		// R10-A-02（P2）：复检命中**有两种语义完全不同**的来源，必须分开 ——
		//  ① 轮首快照（shape.AttachedUsage，来自 scanUsageMonthTables 的同一份 SQL
		//     事实，落桶判据 attachedToUsage() 就是它的投影）说它**当时确实不在**
		//     usage 树下 ⇒ 落桶是对的，而此刻它已在树里 ⇒ **归属在动手之前变了**
		//     （并发轮次的 adopt，或**本轮自己**的 foldAdjacentMonthsIntoUsage 的
		//     领回）。这是**良性 deferred**：与 attached 路径的
		//     usageReclaimNotAttached 逐字同构 —— 一行不动、不记失败，留给下一轮的
		//     普通分区路径（它的行已经能被聚合读到）。旧实现在这里 noteFailure ⇒
		//     "本轮自愈成功"被记成"判据回归"，整轮非 nil ⇒ 管理端保存保留期
		//     500「保留清理失败」，而失败主体正是自愈成功的证据。
		//  ② 快照说它**本来就在** usage 树下 ⇒ 落桶判据与 catalog 事实不一致
		//     （分类回归）⇒ fail-loud。这是"账本翻倍 + 删活分区"这两件静默事故的
		//     唯一守卫，不允许被 ① 的良性分支吞掉。
		//
		// R10-G3（N4）：复检的**三态**必须分开 ——
		//   ③ 复检**自身失败**（读不到 catalog / 语句超时）既不是①也不是②：
		//      它是"判据没跑成"。旧实现用 `err != nil` 把③和①合并 ⇒ 一次真的读
		//      失败被当成"归属已变 ⇒ 良性 deferred、本轮自愈"，整轮
		//      `err=nil / failures=0`，日志还断言"它已回到 usage 分区树里"
		//      （与事实相反）。现在③一律 noteFailure（fail-loud）。
		own := usageOwnershipOf(db, rel)
		switch {
		case own.state == usageOwnershipUnknown:
			noteFailure(rel, "orphan-ownership", own.probeErr)
			continue
		case own.attached():
			if shape.AttachedUsage {
				noteFailure(rel, "orphan-ownership", own.guardErr())
			} else {
				log.Printf("usage retention: %s 在落桶之后已回到 usage 分区树里(并发轮次或本轮自己的 adopt 领回);"+
					"本轮不动它,下一轮由分区路径按普通口径处理 —— 与 attached 路径的 usageReclaimNotAttached 同一语义"+
					"(R10-A-02:自愈不是失败)", rel)
			}
			continue
		}
		if shape.tableLike() {
			// R6-A-1 复审 V1 §1.5-A（P1，已实证）：表形态孤儿可能**持有明细**
			// 且不在 usage 之下（聚合与账本都读不到它的行）⇒ 只 DROP 等于金额
			// 永久丢失。顺序固定为"先并入相邻月 + 持锁补账（与正常分区同一条
			// 路径），再决定 DROP"。
			plan, perr := planDetachedCleanup(db, rel, m)
			if perr != nil {
				noteFailure(rel, "backfill-detached", perr)
				continue
			}
			if !relationExistsForCleanup(db, rel) {
				// R8-A-2：并发轮次已经把它回收掉了（补账也无对象可补）—— 良性。
				log.Printf("usage retention: %s 已被并发轮次回收(planDetachedCleanup 返回前消失);按良性处理", rel)
				continue
			}
			// 账本**自己的**关系（usage_daily 年分区）必须在进入临界区之前备好：
			// 临界区持有 usage 的 ACCESS EXCLUSIVE，池上的第二条连接可能自锁
			// （见 ensureRetentionLedgerRelations 的注释）。备不齐 ⇒ 账算不出来
			// ⇒ 不 DROP、也不补账（fail-loud）。
			if err := ensureRetentionLedgerRelations(db, plan.winFrom, plan.winTo); err != nil {
				noteFailure(rel, "rebuild-ledger", fmt.Errorf("rebuild ledger before dropping: %w", err))
				continue
			}
			if !shape.leafTable() {
				// 父表 / 带子关系：DROP TABLE 会连子关系一起删（relkind='p' 的
				// 声明式分区）或被 PG 拒绝（2BP01），而清单里只有别的名字的
				// 关系 —— 服务端不替管理员决定删一整棵子树。补账照做（金额不会
				// 丢），关系留给人工处置。
				//
				// 读数面按**实际结果**分流（不允许把"归属已变/已被回收"写成
				// "需人工处置"）：只有真的"补账完成、关系原样留着"才计 skip。
				switch res := dropDetachedOrphanAtomically(db, rel, shape.Kind, plan, ""); res.outcome {
				case usageReclaimFailed:
					noteFailure(rel, res.op, res.err)
				case usageReclaimGone:
					log.Printf("usage retention: %s 已被并发轮次回收(%s 时关系已不存在);按良性处理", rel, res.op)
				case usageReclaimNotAttached:
					log.Printf("usage retention: %s 在临界区复检时已回到 usage 分区树里;本轮不动它(良性 deferred)", rel)
				default: // usageReclaimBackfilled：补账已提交、关系保留（无人可自动处置）
					noteSkip("detached relation", rel, usageSkipDetachedNonLeaf, fmt.Sprintf("relkind=%q children=%d:"+
						"父表/带子关系需人工处置(账本已按它实际持有的明细补齐,金额不会丢;"+
						"DROP TABLE 会连子关系一起删,服务端不替管理员做这个决定)", shape.Kind, shape.Children))
				}
				continue
			}
			// 相邻月并入失败 ⇒ 本轮只补账、不 DROP（那些行还在 rel 里）。
			dropStmt, _ := dropDDLForRelKind(rel, shape.Kind)
			if plan.foldErr != nil {
				dropStmt = ""
			}
			res := dropDetachedOrphanAtomically(db, rel, shape.Kind, plan, dropStmt)
			switch res.outcome {
			case usageReclaimDropped:
				clearedDetached++
				reclaimedRel[rel] = true
				log.Printf("usage retention: dropped detached relation %s (relkind=%s, not a partition of usage;"+
					"其明细已并入相邻月并补进永久账本)", rel, shape.Kind)
			case usageReclaimBackfilled:
				// 补账已在持锁事务里提交，关系保留（相邻月明细还在里面）。
				// R12-N2（P1-04）：同 attached 路径 —— 记 skip（需人工处置），不记
				// failure：明细一行未删、账已补齐，把它算成"整轮失败"只会让管理端
				// 每轮 500 并让 reclaim_stalled 永久为真。
				noteSkip("detached relation", rel, usageSkipFoldMisbounded,
					fmt.Sprintf("相邻月并入失败 ⇒ 本轮只补账、不 DROP（该月明细一行未删，金额不会丢）；"+
						"需人工处置相邻月的分区边界（PG 禁止分区区间重叠，服务端不替管理员改写边界/搬行）：%v", plan.foldErr))
			case usageReclaimGone:
				log.Printf("usage retention: %s 已被并发轮次回收(%s 时关系已不存在);按良性处理", rel, res.op)
			case usageReclaimNotAttached:
				// 良性且**不动数据**：临界区复检发现它已回到 usage 树下（另一轮或
				// 本轮的 adopt 领回）—— 它的行已经能被聚合读到，本轮 DROP 就是删
				// 活分区（R10-A-01 的 H2）。留给下一轮的普通分区路径。
				log.Printf("usage retention: %s 在临界区复检时已回到 usage 分区树里;"+
					"本轮不动它(良性 deferred,与 attached 路径的 usageReclaimNotAttached 同义)", rel)
			default:
				noteReclaimOutcome(rel, res.op, res.err)
			}
			continue
		}
		stmt, droppable := dropStatementForViewLike(rel, shape.Kind)
		if !droppable {
			noteSkip("detached relation", rel, usageSkipNonTable, fmt.Sprintf("relkind=%q:只清理表/视图/物化视图,"+
				"其余形态需人工处置(服务端不替管理员决定删非表对象)", shape.Kind))
			continue
		}
		// 视图/物化视图不持有明细行 ⇒ 不需要补账（窗口零值），但**同样**走临界区
		// （锁 → 持锁复检归属 → DROP → COMMIT）：判据与动作之间不留窗口。
		res := dropDetachedOrphanAtomically(db, rel, shape.Kind, detachedCleanupPlan{}, stmt)
		switch res.outcome {
		case usageReclaimDropped:
			clearedDetached++
			reclaimedRel[rel] = true
			log.Printf("usage retention: dropped detached relation %s (relkind=%s, not a partition of usage)",
				rel, shape.Kind)
		case usageReclaimGone:
			log.Printf("usage retention: %s 已被并发轮次回收(%s 时关系已不存在);按良性处理", rel, res.op)
		case usageReclaimNotAttached:
			log.Printf("usage retention: %s 在临界区复检时已回到 usage 分区树里;本轮不动它(良性 deferred)", rel)
		default:
			noteReclaimOutcome(rel, res.op, res.err)
		}
	}
	// 到期关系集合 = 叶子分区 + 二级分区（两者都是**传递地**挂在 usage 下的，
	// 见 usageMonthTables.Partitions / AttachedNonLeaf）。
	// R6-A-1（复审 V1 §1.5-A）：二级分区同样是 usage 的明细来源（父表查询会读到
	// 子分区里的行），旧实现把它归进 Orphans 并直接 DROP TABLE —— 而 DROP TABLE
	// 会连子分区一起删，那些明细既没进账本、也没被聚合读到 ⇒ 金额永久丢失。
	// 现在它与叶子分区走**完全同一条**路径（补账 + 相邻月并入，再 DETACH+DROP）。
	// R7-A（P1）：多级布局里的深层后代叶子也在这两个桶里（判据是传递祖先），
	// 但它在 DETACH 那一步被跳过（只有 usage 的**直接**子分区能摘）。
	attached := make([]string, 0, len(tables.Partitions)+len(tables.AttachedNonLeaf))
	attached = append(attached, tables.Partitions...)
	attached = append(attached, tables.AttachedNonLeaf...)
	// R12-N2（P2-02）：**写入面的"已解决"判据必须包含孤儿桶**。
	//
	// 缺陷形态（R12-A P2-02）：`round.ExistingMonths` 原先只由 **attached 桶**
	// （`tables.Partitions` + `tables.AttachedNonLeaf`）拼出，而"有一条 `usage_<M>`
	// 挡着该月写入"（写路径 503 METERING_FAILED，写失败面记进
	// `write_blocked_other_months`）的形态恰恰是**孤儿桶**（`tables.Orphans`：
	// 关系在、但不在 usage 分区树里）—— 于是 R11A-04 的自愈逻辑在**同一轮**里
	// 把它当成"关系已不在"清掉：清理自己刚报了 `skip=orphan-retained:1`
	// （证明它知道关系还在、还在挡写入），条目却没了 ⇒ 告警反向漏报，比修复前
	// 更少（R11A-04 立项要消灭的是"单向棘轮"，实测换来了"反向漏报"）。
	//
	// 判据（事实，不是投影）：条目描述的对象是 `usage_<YYYYMM>`；**只要该名字的
	// 关系此刻还存在**（无论它挂在 usage 树下、还是孤儿桶里），"该月写不进去"
	// 这条观测就仍然成立。所以"仍然存在的月关系" = attached ∪ orphans − 本轮删掉的。
	// gaps 日志仍用**只看 attached** 的 `existing`（它问的是"有没有该月的**明细分区**"，
	// 孤儿不是明细分区），两张集合因此显式分开、不互相污染语义。
	existing := make(map[string]bool, len(attached))
	existingRelations := make(map[string]bool, len(attached)+len(tables.Orphans))
	var oldest time.Time
	for _, rel := range attached {
		m, ok := usageMonthRelationOf(rel)
		if !ok {
			continue
		}
		existing[monthKey(m)] = true
		existingRelations[monthKey(m)] = true
		if oldest.IsZero() || m.Before(oldest) {
			oldest = m
		}
	}
	// 孤儿桶也进"关系仍然存在"的集合（R12-N2 P2-02）：它们名字合法、此刻确实
	// 占着 `usage_<YYYYMM>`，只是不在 usage 分区树下 —— 写入路径正是被它们挡住的。
	for _, rel := range tables.Orphans {
		if m, ok := usageMonthRelationOf(rel); ok {
			existingRelations[monthKey(m)] = true
		}
	}
	dropped := 0
	for _, rel := range attached {
		m, ok := usageMonthRelationOf(rel)
		if !ok {
			continue
		}
		if !m.Before(cutoffMonth) {
			continue // 保留期内(名字合法但没到期)
		}
		shape := tables.Shapes[rel]
		var foldErr error
		// R5-A-9(审计 2026-09-23,P1):补账**不得要求"该月分区形态就绪"**。
		// 旧实现在 DROP 前调 RebuildUsageLedger(内部无条件 ensureUsagePartition),
		// 于是一个错界/读不懂/二级分区的老分区(按设计只允许人工处置、不会自愈)
		// 让整轮清理 `return err` —— 与它无关的、本该被清掉的月份一起留在盘上,
		// 每次重试都重新判定 ⇒ 保留策略永久停摆,只能人工 DROP。
		//
		// 判据同构:清理要素是"该月明细能否被聚合",而聚合读的是 usage **父表**,
		// 与分区边界无关 ⇒ 形态异常只影响"该月能否接收新写入",不阻止清理。
		// 形态异常仍**点名**(关系名 + 期望窗口 + 实际边界原文,都在 shapeErr 里),
		// 让人知道该月的新写入需要人工处置 —— 清理本身照常进行。
		win := retentionLedgerWindow(db, rel, m)
		if win.shapeErr != nil {
			// R10-D-02：**等锁超时**要立刻延后这一条关系，而不是继续往下走
			// （形态探测 → 相邻月扫描 → 临界区里两把锁，每处各自再有 5s 上界 ⇒
			// 一条关系能把一轮拖成十几个有界等待之和）。管理端是**同步**调用，
			// 所以"有界"之外还要"够快"：第一处等锁超时即按 timeout 分类延后。
			if _, timedOut := usageFailureTimeoutReason(win.shapeErr); timedOut {
				noteFailure(rel, "scan-window", win.shapeErr)
				continue
			}
			log.Printf("usage retention: %s 的形态判定未通过(或无法判定):%v;"+
				"重建其明细账本(窗口 %s..%s,按它实际持有的行)后再决定 DETACH+DROP"+
				"(R5-A-9:分区形态只影响该月新写入,不得让整轮保留清理停摆;"+
				"R7-A:不是 usage 直接子分区的深层后代只补账、不 DETACH)",
				rel, win.shapeErr, win.from.Format(dateFmt), win.to.Format(dateFmt))
		}
		// R8-A-4(审计 2026-09-24,P2)：**非叶子**关系（父表 / 带子关系）不能只看它
		// 自己的名义月 —— 子树里可能还挂着**保留期内**的月份分区（DBA 手写的
		// `usage_<m1>[p]` 覆盖 [m1, m2)，子分区 `usage_<m2>` 尚未到期）。DETACH +
		// `DROP TABLE` 会**连子关系一起删**，那个保留期内月份的明细分区就被删了
		// （金额虽已进账本，但用量中心的逐笔请求明细会凭空消失）。
		//
		// 判据取**行事实**（该子树里有没有 Beijing day >= cutoff 的行），不是名字也
		// 不是边界形态：名字型判据会把合法的日粒度子分区（usage_20260601）误判成
		// "活着的月份"，边界型判据会漏掉"父分区边界正确、子分区越界"的布局。
		// 有保留期内的行 ⇒ **保留但不回收**（可观测，见 skipReasons），下一轮再看；
		// 没有 ⇒ 整株子树都已到期，照常 DETACH+DROP。
		// R9-A-1（审计 2026-09-24，P1）：这一次判定只是**前置筛**（命中即跳过，
		// 省掉一次重锁），**不是**删动作的依据 —— 判定与 `DROP TABLE` 之间还隔着
		// 相邻月扫描与整窗口账本补算（多轮 SQL 往返，同机秒级），并发写入完全
		// 可能在这段窗口里提交。权威判定在 reclaimUsagePartitionAtomically 的
		// 临界区里（持锁后、DETACH/DROP 之前），两处判据同源（同一个函数）。
		if !shape.leafTable() {
			// R10-D-02：前置筛也带等锁上界（谓词与临界区里的权威复检同源）。
			holds, herr := usageSubtreeHoldsRetainedRowsBudget(db, rel, cutoffMonth)
			if herr != nil {
				if usageRelationGone(db, rel) {
					continue // 并发轮次已回收 ⇒ 良性
				}
				noteFailure(rel, "scan-subtree-retention", herr)
				continue
			}
			if holds {
				noteSkip("attached relation", rel, usageSkipSubtreeRetained, fmt.Sprintf("relkind=%q children=%d:"+
					"子树里还有保留期内的明细行(拆树会连它一起删);账本已按实际明细补齐,金额不会丢,"+
					"等子树内最后一个到期月被回收后本轮自动继续", shape.Kind, shape.Children))
				continue
			}
		}
		if !win.exact {
			// R6-A-1 复审 V1 §1.5-B（P1，已实证）：边界不是名义北京月的分区可能
			// 持有**相邻月**的明细（UTC 自然月边界与北京月差 8 小时）。补账只让
			// 账本有数，聚合仍从相邻月的**明细段**少掉它们（实测 7 月聚合
			// 11.00 → 1.00）。所以先把这些行**并入** usage 的对应月份分区，并把
			// 补账窗口扩到这些相邻月的**整月**（聚合读明细 ⇒ 账本必须与它一致）。
			// 并入失败（相邻月的分区覆盖不到那些瞬时、或同名关系被外来对象
			// 占用）⇒ **不 DROP**：此时那些行还在 rel 里，DROP 就是丢账；
			// 但补账照做（窗口已扩到整月）⇒ 聚合与账本仍然一致、都不丢。
			months, merr := detailMonthsOutside(db, rel, dayKey(m), dayKey(m).AddDate(0, 1, -1))
			if merr != nil {
				if usageRelationGone(db, rel) {
					// R8-A-2：并发轮次已经把它回收掉了（42P01）⇒ 良性，不是失败。
					log.Printf("usage retention: %s 已被并发轮次回收(扫描相邻月时关系已不存在);按良性处理", rel)
					continue
				}
				noteFailure(rel, "scan-adjacent", merr)
				continue
			}
			if len(months) > 0 {
				if months[0].Before(win.from) {
					win.from = months[0]
				}
				if last := months[len(months)-1].AddDate(0, 1, -1); last.After(win.to) {
					win.to = last
				}
				if _, ferr := foldAdjacentMonthsIntoUsage(db, rel, m, months); ferr != nil {
					foldErr = ferr
				}
			}
		}
		// 补账的**关系准备**（usage_daily 年分区）必须在进入临界区之前完成：临界区
		// 持有 usage 的 ACCESS EXCLUSIVE，池上的第二条连接可能自锁（见
		// ensureRetentionLedgerRelations 的注释）。备不齐 ⇒ 账算不出来 ⇒ 不 DROP
		// （R6-A-1 同一条纪律：账没算出来就不 DROP，否则明细被删而账本没补上）。
		//
		// R10-D-01（P1）：**聚合本身**移进临界区（持锁后、DETACH/DROP 之前）——
		// 旧顺序 [池上补账, DROP] 之间提交的行会被 DROP 级联删除且没进账本（真 PG
		// 3 轮实测 SILENT_LOSS=5.00/6.00/4.00，而 failures=0/skipped=0）。
		if foldErr != nil {
			// 相邻月明细还在 rel 里 ⇒ 这一步**不能** DROP（DROP 就是让相邻月的
			// 明细段永久少计）；补账照做（窗口已扩到整月 ⇒ 聚合与账本一致、都不丢），
			// 人工处置相邻月分区形态后下一轮再清。
			if berr := retentionBackfillBudget(db, win.from, win.to, nil); berr != nil {
				noteFailure(rel, "rebuild-ledger", fmt.Errorf("rebuild ledger before dropping: %w", berr))
				continue
			}
			// R12-N2（P1-04）：这一条**不再记 failure**，而是"按设计：需人工处置"的
			// skip（分类理由与判据见 usageSkipFoldMisbounded 的注释）。
			//
			// 为什么不是 fail-loud：**金额不在这里丢**。走到这一步时
			//   ① 补账已按扩到整月的窗口提交（上面那次 retentionBackfillBudget），
			//   ② DROP 没做（本轮直接 continue）⇒ rel 的明细一行未删。
			// 旧实现把它记成 failure 的唯一后果是「整轮非 nil」：管理端保存保留期
			// 每轮 500 + failed_rounds 单调增长 + reclaim_stalled 永久为真，而与它
			// 无关的月份照样被清 —— 与 R5-A-9 写在代码里的承诺（"分区形态只影响该月
			// 新写入,不得让整轮保留清理停摆"）直接冲突（R12-A P1-04 实测两轮
			// `FAILED op=fold-adjacent sqlstate=42P17`）。真正需要人做的是**修那棵
			// 错界分区树**（PG 禁止分区区间重叠 ⇒ 只能人工改边界/搬行），所以它进
			// skipped_by_reason + needs_manual_months 两个长期观测面。
			noteSkip("attached relation", rel, usageSkipFoldMisbounded,
				fmt.Sprintf("相邻月并入失败 ⇒ 本轮只补账、不 DROP（该月明细一行未删，金额不会丢）；"+
					"需人工处置相邻月的分区边界（PG 禁止分区区间重叠，服务端不替管理员改写边界/搬行）：%v", foldErr))
			continue
		}
		if usageLockContended {
			noteSkip("deferred relation", rel, usageSkipLockTimeout,
				"op=lock-usage: 本轮已判定 usage 的 ACCESS EXCLUSIVE 被占（父表是共同的锁点），"+
					"其余到期关系同样延后到下一轮（R10-D-02：整轮上界与关系数无关）")
			continue
		}
		// 补账窗口随形态一起交给临界区（零值 ⇒ 名义月的兼容分支）。
		shape.ReclaimWindow = win
		if !shape.directChildOfUsage() {
			// R7-A（审计 2026-09-24，P1）：多级布局 `usage → usage_<YYYY> →
			// usage_<YYYYMM>` 里的**深层**后代叶子走到这里。它既不是孤儿（它的
			// 行对 `SELECT … FROM usage` 可见，所以补账走的是**不带**
			// extraSources 的普通路径 —— 不重复计），也不该按孤儿 DROP；
			// 而 `ALTER TABLE usage DETACH PARTITION` 只对 usage 的**直接**
			// 子分区有效 —— 摘一株深层子分区等于替管理员拆分区树（同一棵子树里
			// 可能还有别的月份，且它自己的父表还挂在 usage 上）。
			//
			// 取舍（与"独立二级分区父表"同一条纪律：服务端不替管理员决定拆
			// 分区树）：**只补账、不 DETACH/DROP**，日志点名并计入 skipped
			// （沿用 R4-C-8 的"洞要看得见"口径：该月磁盘不会被本轮回收）。
			// 金额侧没有代价：明细仍在 usage 子树里 ⇒ 聚合读得到，账本也已补齐，
			// 两个口径一致（见 r7a 判据里的 ledger == aggregate == 清理前的值）。
			//
			// R10-D-01：这一步的补账走**池上**入口（它不 DROP，所以不存在
			// [补账, DROP] 窗口）；失败保持 fail-loud。
			if berr := retentionBackfillBudget(db, win.from, win.to, nil); berr != nil {
				noteFailure(rel, "rebuild-ledger", fmt.Errorf("rebuild ledger before dropping: %w", berr))
				continue
			}
			noteSkip("descendant partition", rel, usageSkipDescendant, fmt.Sprintf("parent=%s, 传递根=usage:"+
				"明细已按普通分区路径补进永久账本(不重复计、也不隐藏),但 DETACH 只对 usage 的直接子分区有效"+
				"⇒ 不替管理员拆分区树(多级布局需人工处置;该月磁盘本轮不回收)", shape.Parent))
			continue
		}
		// R9-A-1（审计 2026-09-24，P1）：DETACH + DROP 必须在**持有子树 ACCESS
		// EXCLUSIVE 的同一个事务**里做，且判据要在持锁**之后**再复检一遍 ——
		// 见 reclaimUsagePartitionAtomically。拿不到锁/任一步失败 ⇒ 回滚且不动
		// 数据（本轮的失败计数与返回错误是运维可见入口）。
		res := reclaimUsagePartitionAtomically(db, rel, shape, cutoffMonth)
		switch res.outcome {
		case usageReclaimDropped:
			dropped++
			reclaimedRel[rel] = true
		case usageReclaimSkippedRetained:
			noteSkip("attached relation", rel, usageSkipSubtreeRetained, fmt.Sprintf("relkind=%q children=%d:"+
				"持锁复检命中(R9-A-1):子树里还有保留期内的明细行(拆树会连它一起删);账本已按实际明细补齐,"+
				"金额不会丢,等子树内最后一个到期月被回收后本轮自动继续", shape.Kind, shape.Children))
		case usageReclaimGone:
			log.Printf("usage retention: %s 已被并发轮次回收(%s 时关系已不存在);按良性处理", rel, res.op)
		case usageReclaimNotAttached:
			// 良性且**不动数据**：它的行没进本轮补账（不在 usage 树里 ⇒ 聚合读不到），
			// 本轮 DROP 就是金额丢失。留给下一轮的孤儿路径（补账 + DROP）。
			log.Printf("usage retention: %s 已不再直接挂在 usage 下(并发轮次已摘或人工改挂);"+
				"本轮不动它,下一轮由孤儿路径把它的明细并入账本后再回收", rel)
		default:
			noteReclaimOutcome(rel, res.op, res.err)
		}
	}
	// 显式记录"跳过的月份"(R4-C-8):保留区间里没有被清掉的空缺月份 —— 该月零用量
	// (写路径惰性建分区)或早已被清过。日志让"洞"可被运维看见,而不是靠读代码推。
	if !oldest.IsZero() {
		var gaps []string
		for m := oldest; m.Before(cutoffMonth); m = m.AddDate(0, 1, 0) {
			if key := monthKey(m); !existing[key] {
				gaps = append(gaps, key)
			}
		}
		if len(gaps) > 0 {
			log.Printf("usage retention: %d month(s) in the cleanup range have no detail partition (zero-usage months or already cleaned): %s",
				len(gaps), strings.Join(gaps, ","))
		}
	}
	// R6-A-1 的可观测口径:每轮**无条件**打一行"清了几条 / 失败几条 / 原因码"，
	// 失败明细另有上面逐条的 `usage retention: FAILED <rel> op=… sqlstate=…` 行。
	// 旧实现只在"本轮有清理动作"时打日志，停摆的轮次完全静默。
	//
	// R8-A-3：`skipped` 必须按**原因**可见（深后代永不回收 / 子树仍在保留期 /
	// 非表对象 / DETACH 后的父表）—— 此前只有一行汇总数字，运维看不出"哪一类
	// 关系永远不会被回收"。同一份计数同时进 UsageRetentionStatus（/readyz）。
	// R11A-04：`existing` 是**扫描时刻**的事实；写入面条目要判的是"这一轮结束时
	// 这个月的分区关系还在不在" ⇒ 折算掉本轮已经删掉的那些（reclaimedRel）。
	// R12-N2（P2-02）：这一份集合取 `existingRelations`（attached ∪ orphans）——
	// 见它上面那段注释：孤儿关系"存在"这件事同样让"该月写不进去"成立。
	round.ExistingMonths = make([]string, 0, len(existingRelations))
	for key := range existingRelations {
		if reclaimedRel["usage_"+key] {
			continue
		}
		round.ExistingMonths = append(round.ExistingMonths, key)
	}
	sort.Strings(round.ExistingMonths)
	round.ClearedPartitions = dropped
	round.ClearedDetached = clearedDetached
	round.Skipped = skipped
	round.Failures = failed
	round.SkippedByReason = skipReasons
	round.Unreclaimed = unreclaimed
	// R10-A-05（P3）：**失败关系**也进机器可读面（此前它们只出现在 last_error 的
	// 自由文本里，`unreclaimed` 只收 skipped ⇒ "哪条关系真的失败了"在 /readyz 上
	// 不可判定）。
	round.FailedRelations = failedRels
	// R10-G3（N2②/N3）：延后关系的**累积**面 —— "连续 N 轮延后"由
	// recordUsageRetentionRound 按这份清单推进、按"本轮没延后就清零"收敛。
	round.DeferredRelations = deferredRels
	log.Printf("usage retention: round summary cleared_partitions=%d cleared_detached=%d skipped=%d failures=%d cutoff=%s retention_months=%d skip_reasons=%s",
		dropped, clearedDetached, skipped, failed, monthKey(cutoffMonth), n, formatSkipReasons(skipReasons))
	if len(failures) > 0 {
		return fmt.Errorf("usage retention: %d relation(s) could not be cleaned this round (其余到期关系已清理,下一轮会重试;失败关系:%s): %s",
			failed, strings.Join(failedRels, ","), strings.Join(failures, " | "))
	}
	return nil
}

// usageQuerier 是 *sql.DB 与 *sql.Tx 的共同读面。
//
// 保留期判据（usageSubtreeHoldsRetainedRows / usagePartitionRoot / assertDetachedFromUsage）
// 的每一处调用点都有两种句柄：清理主循环里的**前置筛/前置复检**走连接池（*sql.DB），
// 临界区里的**权威复检**必须走**同一个事务**（*sql.Tx，见
// reclaimUsagePartitionAtomically / dropDetachedOrphanAtomically）。判据只能有一份实现
// （§3.2 禁止复制粘贴），用最小接口把两种句柄统一起来 —— R10-A-01 的根因正是
// "判定一处、动作用另一份谓词"，所以持锁复检与落桶判据必须共用同一份 SQL。
type usageQuerier interface {
	QueryRow(query string, args ...any) *sql.Row
}

// usageExecer 是 *sql.DB 与 *sql.Tx 的共同写面。
//
// 账本补账（rebuildUsageLedgerRowsFrom 的两条 UPSERT）必须能在**临界区的事务**里跑
// （R10-D-01：补账与 DROP 同一个持锁事务），也必须能在池上跑（启动补算/自愈路径）。
type usageExecer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

// usageReclaimLockTimeoutMS 是"回收到期关系"临界区里等待锁的上限（毫秒）。
//
// 取值权衡：复检谓词是**可索引 + 可按分区边界裁剪**的（见
// usageSubtreeHoldsRetainedRows 的注释：20 万行规模的子树实测 33.8ms → 0.6ms）。
// 5s 足够覆盖"等一个正在提交的计量写入事务结束"，又不会让清理线程在长事务后面
// 无限期挂住。
//
// R10-A-03（P2）：锁等待超时（55P03）与**真失败**必须是**可区分的结果** ——
// 见 usageFailureTimeoutReason 与 noteFailure：超时走"本轮延后、下一轮重试"的
// skip 分类（reason=lock-timeout），不把管理端的 `PUT /api/server/admin/…`
// （同步调用 CleanupUsageRetention，见 internal/llmgateway/admin.go）变成一次
// 500「保留清理失败」，也不让 `/readyz` 的 failed_rounds 把锁竞争记成故障。
// 判据是 SQLSTATE（结构化事实），不是"看起来像超时"的猜测。
const usageReclaimLockTimeoutMS = 5000

// usageReclaimStatementBudgetMS 是**冻结段**（父表 ACCESS EXCLUSIVE 那段）里单条
// 语句的时长上限（毫秒）。
//
// R10-G3（N1）之后，临界区被拆成两段：
//
//	冻结段（父表 AEX，必须短）：`LOCK ONLY usage AEX` → `LOCK rel AEX` → 复检 →
//	  （非叶子）子树闸门 → `DETACH PARTITION` → COMMIT。已实测的正常路径总时长
//	  ≈ 77ms（2M 行月分区：锁 0.18+0.60ms、复检 8.9ms、DETACH 4.1ms、COMMIT 63ms）
//	  —— 补账（2493ms~18900ms）**不在**这一段里。
//	结算段（只锁 rel，可以长）：聚合 + DROP，预算见 usageReclaimSettleBudgetMS。
//
// 取值推导（为什么还是 20s）：这一段里每个**有界等待**各自 ≤ usageReclaimLockTimeoutMS
// （5s）：`LOCK ONLY usage` 等锁、`LOCK rel` 等锁、`DETACH PARTITION` 自身要等的锁、
// 以及 COMMIT 前的收尾；4 个上界之和 = 20s。它**不是**"我们持父表锁多久"的上界
// （那是复审 N1 指出的旧注释错误），持锁时长由"这一段里只有 DDL/复检、没有聚合"
// 保证。超时 ⇒ 整事务回滚（一行没动）、按 timeout 分类延后到下一轮。
const usageReclaimStatementBudgetMS = 20000

// 结算段（聚合 + DROP）的预算：**与工作量（该关系的行数）成正比**（R10-G3 · N2①）。
//
// 复审 N2 的量化事实：2M 行月分区的整窗口聚合在 PG 侧实测 2493ms（空载）/ 18866ms
// （同机重载），即 ≈1.25µs/行 ~ 9.4µs/行；而旧的"每语句 20s"对最重的合法形态只剩
// 6% 余量（18866/20000 = 94%）—— 再大一点的月份必然撞上它，而超时被分类成"延后"
// ⇒ 该月**永远**不回收且没有任何面能看出来。
//
// 推导：预算 = base + rows × perRow，rows 取 pg_class.reltuples（廉价、无锁；
// 从未 ANALYZE 过时 reltuples<=0 ⇒ 只吃 base）：
//
//	perRow = 20µs = 重载实测（9.4µs/行）的 2.1 倍；
//	base   = 15s   = 聚合之外的部分（两条 UPSERT 的收尾、DROP、COMMIT、计划时间）。
//
// 2M 行 ⇒ 15s + 40s = 55s（重载实测 18.9s 的 2.9 倍）；下限 30s（小表也要留出
// 连接建立/计划/提交的余量）、上限 180s（防止一条卡住的语句把 rel 的锁持成小时级）。
// 上限之外的情形不是"静默延后"：同一关系连续 usageRetentionDeferredStallRounds
// 轮延后即升级为 /readyz 的 deferred_stalled（见 usage_retention_status.go）。
const (
	usageReclaimSettleBaseMS   = 15000
	usageReclaimSettlePerRowUS = 20
	usageReclaimSettleFloorMS  = 30000
	usageReclaimSettleCeilMS   = 180000
)

// usageReclaimSettleBudgetMS 把"这个关系有多少行"换算成结算段的预算（毫秒）。
func usageReclaimSettleBudgetMS(rows int64) int {
	if rows < 0 {
		rows = 0
	}
	ms := int64(usageReclaimSettleBaseMS) + rows*usageReclaimSettlePerRowUS/1000
	if ms < usageReclaimSettleFloorMS {
		ms = usageReclaimSettleFloorMS
	}
	if ms > usageReclaimSettleCeilMS {
		ms = usageReclaimSettleCeilMS
	}
	return int(ms)
}

// usageReclaimRowBytesEstimate 是"从表大小反推行数"时的每行字节估计（只喂预算，
// 不是判据）。
//
// 方向勘误（R11-D-05，P3）：本注释此前写"取 128 略偏小 ⇒ 反推的行数略偏**大**
// （预算偏宽）"，方向与实测相反 —— 反推行数 ≈ 表字节 ÷ 本估计，估计取**大**了
// 反推行数才偏小。本机 20 万行样本实测 **126.0 B/行**
// （`TestR11DT3BudgetDerivationExtremes`），而 128 > 126.0 ⇒ 反推行数 ≈ **0.98×**
// 真值 ⇒ 预算方向是**略偏紧**，不是偏宽。实际余量仍然充足：反推口径给到
// `20µs × 126.0/128 = 19.7µs/行`，对比 R10-G3 记录的重载实测 `9.4µs/行` ⇒ **2.09×**。
const usageReclaimRowBytesEstimate = 128

// usageReclaimEstimatedRows 给出"这个关系大概有多少行"（**只喂预算**，不是判据）。
//
// 两个**廉价**估计取较大者：
//
//	reltuples         —— ANALYZE 的产物；**刚批量灌过数据、还没 ANALYZE 的表它是
//	                     -1/0**（复审的量化夹具就是这种形态：2M 行、reltuples=-1；
//	                     任何"批量回填/迁移后立刻回收"的库同样是）。只用它 ⇒ 把
//	                     2M 行当成 0 行 ⇒ 预算退回下限 30s ⇒ 大月份**每轮超时**、
//	                     被分类成"延后"、永远不回收 —— 正是 N2 要消灭的形态
//	                     （本泳道实测：2M 行 + reltuples=-1 时 3 轮里 2 轮
//	                     statement-timeout）。
//	pg_relation_size  —— 文件大小（stat，微秒级），除以每行字节估计。
//
// 估小了的后果是"延后"（可观测、可重试、且连续 5 轮会升级为告警），估大了的后果是
// "多等一会儿才超时" —— 两个方向都不会让金额出错。
func usageReclaimEstimatedRows(db *sql.DB, rel string) int64 {
	var rows int64
	if err := db.QueryRow(`SELECT GREATEST(c.reltuples, 0)::bigint
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = $1 AND n.nspname = 'public'`, rel).Scan(&rows); err != nil {
		return 0
	}
	// 表大小用 pg_partition_tree 求和：**声明式分区父表自身没有存储**
	// （pg_relation_size = 0），而回收一个非叶子关系时聚合覆盖的是整株子树
	// （叶子 + 孙辈叶子）⇒ 必须按叶子求和，否则多级布局下又退回下限。
	var size int64
	if err := db.QueryRow(`SELECT COALESCE(sum(pg_relation_size(t.relid)), 0)
FROM pg_partition_tree(to_regclass('public.' || $1)) AS t`, rel).Scan(&size); err != nil {
		size = 0
	}
	if bySize := size / usageReclaimRowBytesEstimate; bySize > rows {
		rows = bySize
	}
	return rows
}

// usageReclaimBudgetForRelation 把关系大小换算成结算段的预算（毫秒）。
func usageReclaimBudgetForRelation(db *sql.DB, rel string) int {
	return usageReclaimSettleBudgetMS(usageReclaimEstimatedRows(db, rel))
}

// withUsageSettleBudget 在**带 lock_timeout + statement_timeout + 总预算**的事务里
// 跑 fn（R10-G3：结算段必须有跨语句的总上界，而不只是"每语句"上界）。
//
// 三层上界各回答一个问题：
//
//	lock_timeout    —— 等锁（父表 AS / rel AEX）不得无界（R10-D-02 的同一条纪律）；
//	statement_timeout —— 单条语句（聚合/DROP）不得无界；
//	ctx deadline    —— **整段（含 COMMIT）**不得无界（N2②：旧实现只有"每语句"
//	                   上界，多语句相加可以远超它，复审实测到 22.02s > 20s）。
//
// R11A-03 的边界（如实登记）：本函数仍用 `*sql.Tx`（理由见 settleUsageReclaim 里
// 关于 `usageOwnershipProbeHook` 的说明）⇒ 这里的 ctx 只罩**语句**，不罩 COMMIT。
// 真正持父表 ACCESS EXCLUSIVE 的冻结段已改走 `usageBoundedTx`（ctx 罩住 COMMIT）。
func withUsageSettleBudget(db *sql.DB, rel string, fn func(*sql.Tx) error) error {
	budget := usageReclaimBudgetForRelation(db, rel)
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(budget)*time.Millisecond)
	defer cancel()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return usageBudgetError(ctx, err)
	}
	defer tx.Rollback() //nolint:errcheck // 提交成功后回滚是 no-op
	if err := applyUsageRetentionBudget(tx, usageReclaimLockTimeoutMS, budget); err != nil {
		return usageBudgetError(ctx, err)
	}
	if err := fn(tx); err != nil {
		return usageBudgetError(ctx, err)
	}
	return usageBudgetError(ctx, tx.Commit())
}

// SQLSTATE：清理路径必须能把"等锁/语句超时"与真失败分开（R10-A-03）。
// 55P03 = lock_not_available（lock_timeout 到点）；57014 = query_canceled
// （statement_timeout 到点）。两者都表示"这一轮没做成、数据一行没动、下一轮再来"。
const (
	pgSQLStateLockNotAvailable = "55P03"
	pgSQLStateQueryCanceled    = "57014"
)

// errUsageSettleBudget 标记"结算段/预补账的**整段总预算**（ctx deadline，含 COMMIT）
// 到点"（R10-H3 · W3-1）。
//
// 为什么需要这个哨兵而不是直接认 `sql.ErrTxDone`：ctx 到点后 database/sql 会把
// 后续语句一律拒成 `sql: transaction has already been committed or rolled back`
// （W3 在真库上实测到的原文），而 `sql.ErrTxDone` **也可能**来自真正的编程错误
// （在已提交/回滚的事务上再用句柄）。判据必须只把"我们自己那层预算真的到点了"
// 算进延后，所以标记加在**知道 ctx 状态的地方**：见 usageBudgetError。
var errUsageSettleBudget = errors.New("usage retention: settle budget expired")

// usageBudgetError 在"这一段的总预算 ctx 已经到点"时给错误打上标记
// （R10-H3 · W3-1）。ctx 没到点时原样返回 ⇒ 真失败仍然是真失败（fail-loud）。
//
// 优先级（与 usageFailureTimeoutReason 的判据顺序配套）：SQLSTATE 55P03/57014 先判
// ——那是**语句级**事实；其余错误只要**本段预算真的到点**就按延后分类。理由：ctx 到点
// 之后这一段已经没有预算了，本轮注定做不成（不是"这一条语句失败"），下一轮重来才是
// 正确语义；若这种"每轮都到点"的状态持续，它会由 `oldest_unreclaimed_*` /
// `deferred_stalled` 两个面暴露成**停摆**（不是静默）。
func usageBudgetError(ctx context.Context, err error) error {
	if err == nil || ctx == nil || ctx.Err() == nil {
		return err
	}
	return fmt.Errorf("%w: %w", errUsageSettleBudget, err)
}

// usageFailureTimeoutReason 报告 err 是否只是"等锁/语句/整段预算到点"（R10-A-03；
// R10-H3 补第三类）。
//
// 判据是**结构化**的：SQLSTATE 优先走 pgErrorCode（errors.As 取 *pgconn.PgError），
// 只有 55P03/57014 才算超时；整段总预算（ctx deadline）**没有 SQLSTATE**，走哨兵
// errUsageSettleBudget / context.DeadlineExceeded / context.Canceled。任何其它错误
// （含 42P01「关系不存在」之外的 DDL/连接失败）仍然是真失败，必须 fail-loud。
// 返回的 reason 是写进 `skipped_by_reason`/`unreclaimed` 的封闭取值（与
// usage_retention_status.go 的同名）。
//
// W3-1（P2，本波引入的分类回归）：`settle-budget-timeout` 与 55P03/57014 **同类**
// —— 一行数据没动、下一轮重试；若把它记成真失败，则"预算不够"会让管理端保存保留期
// 回 500、failed_rounds 增长，而且预算不会自愈 ⇒ **每轮都失败**（同段里的
// statement_timeout 却被记成延后，同一件事两种分类）。
func usageFailureTimeoutReason(err error) (string, bool) {
	if code, ok := pgErrorCode(err); ok {
		switch code {
		case pgSQLStateLockNotAvailable:
			return usageSkipLockTimeout, true
		case pgSQLStateQueryCanceled:
			return usageSkipStatementTimeout, true
		}
	}
	if errors.Is(err, errUsageSettleBudget) || errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, context.Canceled) {
		return usageSkipSettleBudgetTimeout, true
	}
	return "", false
}

// withUsageLockBudget 在**带 lock_timeout 的事务**里跑 fn（清理路径的前半轮专用）。
//
// R10-D-02（P2）：任意会话对任意月分区持 ACCESS EXCLUSIVE 时，前半轮的读
// （probeUsagePartition 的 pg_get_expr 要打开关系、retentionBackfill 读父表）
// 此前**既无 lock_timeout 也无 context** ⇒ 整轮无界挂住，而
// `PUT /api/server/admin/…` 是**同步**调用 ⇒ 管理端请求一起挂到 HTTP 写超时。
// 判据必须与危害同构：把"等锁"变成有界 + 结构化（55P03 ⇒ timeout 分类），
// 而不是让调用方无限等待。
//
// R11A-03（同族第四条，点名）：这条路径上的事务同样以 `COMMIT` 收尾，而
// `db.Begin()` + `tx.Commit()` 的终点没有任何上界（`lock_timeout` 只管等锁、
// `statement_timeout` 不覆盖提交期）。清理路径（`ms > 0`）因此给它一个**结构性**
// 上界：等锁预算 + `usageReclaimStatementBudgetMS`（这一段的工作量上限：单条探测 /
// 单条 DDL / 一次窗口扫描），并走 `usageBoundedTx` ⇒ ctx 真的罩住 COMMIT。
//
// **`ms == 0` 时故意不加上界**：那是计量写入路径（`ensureRangePartition` 的热路径
// 传 0），它的契约是"**等**锁"而不是"超时失败" —— 把等待改成失败就是把"慢"变成
// "全站 503 METERING_FAILED"（见 ensureRangePartitionBudget 的注释）。
//
// **本函数仍然用 `*sql.Tx`**（理由见 settleUsageReclaim 里关于
// `usageOwnershipProbeHook` 的说明）：ctx 只罩**语句**，不罩 COMMIT；且
// `ms == 0`（热路径）时连 ctx 都不给（保持"等锁"契约）。`search_path` 的钉死
// （R11A-02）与 `ms` 无关，两条路径都生效。
func withUsageLockBudget(db *sql.DB, ms int, fn func(*sql.Tx) error) error {
	ctx := context.Background()
	cancel := func() {}
	if ms > 0 {
		ctx, cancel = context.WithTimeout(context.Background(),
			time.Duration(int64(ms)+usageReclaimStatementBudgetMS)*time.Millisecond)
	}
	defer cancel()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // 提交成功后回滚是 no-op
	if err := applyUsageRetentionBudget(tx, ms, 0); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// applyUsageRetentionBudget 给清理路径的事务装上**有界语义 + 计划期裁剪**。
//
//   - lock_timeout：等锁上界（R10-D-02）；
//   - statement_timeout：单语句时长上界（只在临界区给，见 usageReclaimStatementBudgetMS）；
//   - `plan_cache_mode = force_custom_plan`：**计划期分区裁剪**（R10-D-02 的纵深）。
//     补账的聚合是参数化语句（窗口边界是 $n）；PG 在**通用计划**下把裁剪推迟到
//     执行期，而执行期裁剪必须**锁住全部分区**（ACCESS SHARE）—— 于是任一月分区上
//     的一把无关锁（另一个清理轮次的临界区、管理员 ALTER/VACUUM）都会挡住本次
//     聚合，把"某一月被锁"放大成"所有月份的补账都被挡"。实测：同一语句第 6 次
//     执行（PG 从第 6 次起可能选通用计划）真的会被一个无关分区的 ACCESS EXCLUSIVE
//     卡住（2s lock_timeout 命中）。强制自定义计划 ⇒ 用真实窗口值在**计划期**裁剪，
//     只锁窗口内的分区（代价是每次重规划这条聚合，微秒级）。
func applyUsageRetentionBudget(tx usageExecer, lockTimeoutMS, statementTimeoutMS int) error {
	if lockTimeoutMS > 0 {
		if _, err := tx.Exec(fmt.Sprintf("SET LOCAL lock_timeout = '%dms'", lockTimeoutMS)); err != nil {
			return err
		}
	}
	if statementTimeoutMS > 0 {
		if _, err := tx.Exec(fmt.Sprintf("SET LOCAL statement_timeout = '%dms'", statementTimeoutMS)); err != nil {
			return err
		}
	}
	if _, err := tx.Exec("SET LOCAL plan_cache_mode = force_custom_plan"); err != nil {
		return err
	}
	// R11A-02（P2）：**判据与动作必须看到同一个对象**。
	//
	// 缺陷形态：catalog 判据一律硬钉 `public.`（`n.nspname = 'public'` +
	// `to_regclass('public.'||…)`），而动作（`LOCK TABLE ONLY usage`、
	// `ALTER TABLE usage DETACH PARTITION …`、`DROP TABLE IF EXISTS "usage_<M>"`、
	// 补账聚合的 `FROM usage`、`CREATE TABLE … PARTITION OF "usage"`）全是
	// **未限定名** ⇒ 会话/角色/库级 `search_path` 前置了一个同名 shadow schema 时，
	// 判据看的是 public 的真关系、动作作用在 shadow 上。真 PG 实测（同名 shadow
	// 分区树在场）：真关系**一行未动**、整轮 `err=nil/cleared=0/skipped=0/
	// failures=0`（保留策略静默停摆、/readyz 全绿），而永久账本被 shadow 的
	// **虚构金额**覆盖成 999.00（真实明细 12.50 未进账本）。
	//
	// 口径选择（为什么统一 search_path 而不是逐个限定名）：本函数是清理路径
	// **每一个事务**（形态探测 / 读窗口 / 关系 DDL / 冻结段 / 结算段 / 预补账）
	// 的唯一公共入口，一句 `SET LOCAL` 覆盖**本事务内所有**关系引用 —— 包括辅助
	// 函数里拼出来的语句（`ledgerDetailSource`、`quoteRelationIdent` 的每个调用点、
	// `DROP`/`DETACH` 的目标名），不需要逐点枚举，也就不会漏。`pg_catalog` 放在
	// 最前还顺带封掉**同名函数/操作符/类型**的遮蔽（逐名限定做不到这一半：
	// `bjWallExpr` 的 `to_char`/`date_trunc`、`beijing.go` 的时区渲染同样可被
	// shadow schema 顶掉）。`SET LOCAL` 随事务结束自动还原，不污染连接池的其它
	// 使用者，代价为零。
	//
	// 另外两个入口各自钉了同一句（同一判据不允许有第二份实现，这里是**同一句
	// 字面量**的三个调用点）：计量写入事务（usage.go 的 recordUsageTx）与账本
	// 关系的池上准备（usage_ledger.go 的 withUsageLockBudget，它本身就调用本函数）。
	return pinUsageSearchPath(tx)
}

// usageSearchPathPin 是"判据与动作看到同一个对象"的**唯一字面量**（R11A-02 /
// R12-N2 P1-02）：整个计量—结算—清理—余额链路的事务都执行这一句。写成常量是为了让
// "同一份语义只有一处字面量"可被机械核对（两处各写一遍会再次分叉）。
//
// R12-N2（P1-02）：**唯一实现**是下面这一对函数（`pinUsageSearchPath` 给已有事务、
// `withUsageSearchPath` 给池上入口）—— 调用点**只允许**通过它们钉，不允许再把
// 这句字面量抄到别处（抄一份就多一个"只钉了 3 个调用点"的机会，R12-A P1-02 实测
// 计量/结算/清理链路上还有 4 条同族面没钉）。完整清单与分类见
// `audit_r12_n2_searchpath_test.go`（机械守卫：新增触碰本族关系的函数必须登记）。
// **为什么只写 `public` 而不写 `pg_catalog, public`**（R12-N2 P1-02 的实测发现）：
// PostgreSQL 的规则是"`pg_catalog` 若**未显式命名**，则隐式排在 search_path 的**最前**"
// —— 所以只写 `public` 时，函数/操作符/类型的解析顺序仍然是 `pg_catalog` 优先（R11A-02
// 想封的遮蔽照样封住），而**未限定的 `CREATE TABLE` 目标变成 `public`**。
// 反过来，把 `pg_catalog` 写进 path 会有一个致命副作用：`CREATE TABLE <未限定名>`
// 会把新表建到 **path 的第一段**（= `pg_catalog`）⇒ 真 PG 实测
// `ERROR: permission denied to create "pg_catalog.usage_202610" (SQLSTATE 42501)`。
// 这条在写路径上尤其致命（`ensureUsagePartition` 的建分区 DDL 一旦进了已钉事务就会撞上），
// 而且它只在"该月分区还不存在"时才出现 —— 正是月初第一次写入。
const usageSearchPathPin = "SET LOCAL search_path = public"

// pinUsageSearchPath 在**已有事务**上钉住 search_path（唯一实现之一）。
func pinUsageSearchPath(tx usageExecer) error {
	_, err := tx.Exec(usageSearchPathPin)
	return err
}

// withUsageSearchPath 是**池上入口**的唯一实现：开一个事务 → 钉 search_path →
// 跑 fn → 提交。
//
// 为什么池上的单条语句也必须开事务：`SET LOCAL` 只在事务块里有意义（事务外是
// no-op + WARNING），而"判据硬钉 public、动作走未限定名"这条缺陷的受害者正是
// `db.Exec`/`db.QueryRow` 这些池上入口（R12-A P1-02：流式结算把 shadow 行改成
// 900/300、`SetUsageProvider` 改 shadow、`DeleteUsage`/`CleanupPendingUsage`
// 只删 shadow ⇒ 真实 pending 永不结算/永不清理，而 `err=nil`）。
// 代价是一次 BEGIN/COMMIT 往返；本族关系的池上入口都是每条请求几次的量级，
// 与"金额写错对象且没有任何错误面"相比这是可忽略的代价。
func withUsageSearchPath(db *sql.DB, fn func(*sql.Tx) error) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // 提交成功后回滚是 no-op
	if err := pinUsageSearchPath(tx); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// setUsageRetentionStatementBudget 给清理的**临界区**事务装上有界语义
// （等锁上界 + 单语句时长上界 + 计划期裁剪 + search_path 与判据同源）。
func setUsageRetentionStatementBudget(tx usageExecer) error {
	return applyUsageRetentionBudget(tx, usageReclaimLockTimeoutMS, usageReclaimFreezeBudgetMS)
}

// usageReclaimRollbackBudgetMS 是"回滚一条清理事务"的时长上界（毫秒）。
// 回滚是空语句级的工作，给 5s 只是为了让"连接已经坏了"这件事尽快有结论。
const usageReclaimRollbackBudgetMS = 5000

// usageReclaimFreezeBudgetMS 是**冻结段整段（含 COMMIT）**的总上界（毫秒）。
//
// 取值与 usageReclaimStatementBudgetMS 同值（20s = 4 个 5s 有界等待之和），但它
// 约束的是**另一件事**：`statement_timeout` 只罩"每一条语句"，而 COMMIT 属于
// **提交期**处理 —— 真 PG 实测（`SET LOCAL statement_timeout='1000ms'` + 提交期
// 执行 5s 的 DEFERRABLE 约束触发器）⇒ `Time: 5012/5463/5008 ms`、`rows_committed=1`。
// 也就是说 20s 的"每语句上界"根本不是"这一段持锁时长的上界"（R11A-03）。现在它
// 同时是 `usageBoundedTx` 的 ctx deadline ⇒ 到点连 COMMIT 一起中止。
//
// 可变（var）**只为测试**：判据要能在真 PG 上把"COMMIT 挂起"注入进来才咬得到，
// 而真 PG 里可靠、可控、不牵动整个集群的注入点（事件触发器把一次冻结段 DDL 接进
// 提交期的 DEFERRABLE 约束触发器）要求判据能把这段预算缩到注入时长之下。
// 生产装配从不写它；唯一写入点是本包测试的 t.Cleanup（与本文件既有的
// `usageOwnershipProbeHook` / `cleanupDetachedStepHook` 同一约定）。
var usageReclaimFreezeBudgetMS = usageReclaimStatementBudgetMS

// usageBoundedTx 是清理临界区的**带 ctx 上界**的事务句柄（R11A-03）。
//
// 为什么不能直接用 `database/sql` 的 `*sql.Tx`：`Tx.Commit()` **没有 ctx 参数**，
// 而 `database/sql` 的 `awaitDone` 兜底在 `Commit()` 已经置位 done 之后是 no-op
// ⇒ `BeginTx(ctx)` 的 deadline 到点**不会**中止正在进行的 COMMIT。真 PG 实测
// （temp/r11/fix-I4 的探针 4，注入点见 usageReclaimFreezeBudgetMS 的注释）：
//
//	`statement_timeout='20000ms'` + `BeginTx(ctx=800ms)` + `tx.Commit()`
//	  ⇒ COMMIT **2.173s** 后 `err=nil`（提交**成功**，DETACH 生效）；
//	同一个注入 + `ExecContext(ctx, "COMMIT")`
//	  ⇒ COMMIT **792ms** 后 `context deadline exceeded`，事务回滚、DETACH 未生效。
//
// 所以本类型的 `commit()` 把 COMMIT 当**语句**执行（走驱动层的 ctx 通道：pgx 在
// deadline 到点发 cancel request）—— 这同时满足"ctx + 对 COMMIT 的有效约束"与
// "能在超时后可靠中止的形态"两条要求。
//
// 三条纪律：
//   - `*sql.Conn` 只有 `*Context` 版方法（没有 `Exec`/`QueryRow`），所以这里显式
//     适配清理路径既有的两个最小句柄接口（usageExecer / usageQuerier）—— 判定与
//     动作仍然共用同一份实现，不复制谓词；
//   - 提交失败后**不猜连接状态**：直接弃用这条连接（`driver.ErrBadConn`），既不
//     发第二条语句（那会产生 `there is no transaction in progress` 的 WARNING，
//     而 serverstore 的 OnNotice 会把 WARNING 打进日志），也不会把状态未知的
//     连接放回池；
//   - `rollback()` **同时把连接放回池** —— 清理路径的纪律是"先回滚再问 catalog"
//     （池上限可能被配成 1，持事务连接时再向池要第二条会自锁）。
type usageBoundedTx struct {
	conn *sql.Conn
	ctx  context.Context
	done bool
}

// beginUsageBoundedTx 独占一条连接并开启事务（BEGIN 也走 ctx）。
func beginUsageBoundedTx(ctx context.Context, db *sql.DB) (*usageBoundedTx, error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := conn.ExecContext(ctx, "BEGIN"); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return &usageBoundedTx{conn: conn, ctx: ctx}, nil
}

func (t *usageBoundedTx) Exec(query string, args ...any) (sql.Result, error) {
	return t.conn.ExecContext(t.ctx, query, args...)
}

func (t *usageBoundedTx) QueryRow(query string, args ...any) *sql.Row {
	return t.conn.QueryRowContext(t.ctx, query, args...)
}

func (t *usageBoundedTx) Query(query string, args ...any) (*sql.Rows, error) {
	return t.conn.QueryContext(t.ctx, query, args...)
}

// rollback 回滚事务并**把连接放回池**（幂等；提交成功后是 no-op）。
func (t *usageBoundedTx) rollback() {
	if t == nil || t.done {
		return
	}
	t.done = true
	rctx, cancel := context.WithTimeout(context.Background(), usageReclaimRollbackBudgetMS*time.Millisecond)
	defer cancel()
	if _, err := t.conn.ExecContext(rctx, "ROLLBACK"); err != nil {
		usageDiscardConn(t.conn)
		return
	}
	_ = t.conn.Close()
}

// commit 用**带 ctx** 的形态提交（见类型注释）。失败 ⇒ 弃用连接（状态未知）。
func (t *usageBoundedTx) commit() error {
	if t == nil || t.done {
		return nil
	}
	t.done = true
	if _, err := t.conn.ExecContext(t.ctx, "COMMIT"); err != nil {
		usageDiscardConn(t.conn)
		return err
	}
	_ = t.conn.Close()
	return nil
}

// release 只把连接交回池（幂等；正常路径由 commit/rollback 收尾，这里兜住
// "提前返回"的每条出口，形态与旧代码的 `defer tx.Rollback()` 逐字等价）。
func (t *usageBoundedTx) release() { t.rollback() }

// usageDiscardConn 关闭一条**状态未知**的连接：不发任何语句（`driver.ErrBadConn`
// 让 database/sql 丢弃这条连接而不是放回池，见 `sql.Conn.Raw` 的 release 路径）。
func usageDiscardConn(conn *sql.Conn) {
	if conn == nil {
		return
	}
	_ = conn.Raw(func(any) error { return driver.ErrBadConn })
	_ = conn.Close()
}

// usageRelationExistsTx 报告 public.<rel> 此刻是否存在（可在事务里读；与
// usagePartitionRoot 同源——都用 catalog 事实，不靠名字猜）。
func usageRelationExistsTx(q usageQuerier, rel string) (bool, error) {
	var exists bool
	if err := q.QueryRow(`SELECT to_regclass('public.' || ?) IS NOT NULL`, rel).Scan(&exists); err != nil {
		return false, fmt.Errorf("核对 %s 是否仍存在: %w", rel, err)
	}
	return exists, nil
}

// usageReclaimLockFailure 处理"临界区里没拿到锁"：等锁超时（55P03/57014）直接按
// 失败/延后返回 —— 分类由调用方的 noteFailure 做（timeout ⇒ 延后、不记失败），
// 而"关系是否已被并发轮次回收"的良性探测在超时情形下**故意不做**：那会再加一次
// 5s 的有界等待，而两种结论的对外后果相同（都不记失败、下一轮重试）。R10-D-02。
//
// R11A-03：探测函数由调用方传入（`relationGone`）—— 调用方必须**先结束事务、
// 把连接放回池**再调本函数，否则池上限被配成 1 时会自锁（原实现把 `*sql.DB`
// 传进来，隐含"已经回滚"这条纪律，却没有任何判据钉住它；改成传探测函数后，
// "先释放再探测"成为调用点的显式顺序）。
func usageReclaimLockFailure(relationGone func() bool, op string, err error) usageReclaimResult {
	if _, timedOut := usageFailureTimeoutReason(err); timedOut {
		return usageReclaimResult{outcome: usageReclaimFailed, op: op, err: err}
	}
	if relationGone != nil && relationGone() {
		return usageReclaimResult{outcome: usageReclaimGone, op: op}
	}
	return usageReclaimResult{outcome: usageReclaimFailed, op: op, err: err}
}

// usageReclaimOutcome 是 reclaimUsagePartitionAtomically 的结果分类（封闭取值）。
type usageReclaimOutcome int

const (
	// usageReclaimDropped：复检通过，DETACH + DROP 已提交。
	usageReclaimDropped usageReclaimOutcome = iota
	// usageReclaimSkippedRetained：持锁复检发现子树里仍有保留期内的行 ⇒ 整株保留。
	usageReclaimSkippedRetained
	// usageReclaimGone：关系已被并发轮次回收（拿锁时已不存在）⇒ 良性竞态。
	usageReclaimGone
	// usageReclaimNotAttached：复检时它已不是 usage 的**直接**子分区（并发轮次
	// 已摘/人工改挂）⇒ 良性，本轮不动它（它的行没进这次补账，交给下一轮的
	// 孤儿路径补账后回收）。孤儿路径上同名的良性分支是
	// dropDetachedOrphanAtomically 的"归属已变"出口（R10-A-02）。
	usageReclaimNotAttached
	// usageReclaimBackfilled：**只补账、不 DROP**（孤儿路径专用：相邻月并入失败、
	// 或调用方明确要求本轮不动这条关系）⇒ 补账已在持锁事务里提交，关系留给
	// 人工处置/下一轮（R6-A-1 §1.5-B 的既有语义）。
	usageReclaimBackfilled
	// usageReclaimFailed：拿不到锁 / 任一步 SQL 失败 ⇒ 已回滚，数据未动，下一轮重试。
	// （注意：55P03/57014 会被调用方按 timeout 分类成"延后"而不是失败，见
	// usageFailureTimeoutReason —— 结果类别本身不加区分，分类只发生在记账处。）
	usageReclaimFailed
)

type usageReclaimResult struct {
	outcome usageReclaimOutcome
	op      string
	err     error
}

// reclaimUsagePartitionAtomically 回收一个**仍挂在 usage 下**的到期关系，是
// "子树仍持有保留期内行"这道闸门唯一的**决策点**。R10-G3（N1）之后它是三段式：
//
//	第 0 步 预补账（池上、无锁、可长）：usageReclaimPreBackfill —— "此刻可见的金额"
//	        先落进永久账本（后面任何一步失败都不会让金额失明）。
//	第 1 步 冻结段（持有父表 ACCESS EXCLUSIVE，必须短）：LOCK ONLY usage AEX →
//	        LOCK rel AEX → 复检仍是 usage 的直接子分区 →（非叶子）子树闸门 →
//	        `ALTER TABLE usage DETACH PARTITION` → COMMIT。
//	第 2 步 结算段（只锁 rel，可以长）：settleUsageReclaim —— 聚合（usage ∪ rel）
//	        + `DROP TABLE` **同一个事务**。
//
// 为什么必须把父表 AEX 收回去（复审 N1，P1）：补账的工作量 ∝ 该月明细行数，而旧
// 实现在**整段持父表 AEX** 的情况下做补账 ⇒ 真 PG 实测（2M 行月分区）`usage` 的
// AEX 窗口 10.93/18.95/22.02s，且**每一次并发计量写入被挡同样长**（`errs=0`：不是
// 503，是整段停顿）；把补账移出临界区（旧形态）实测只有 57ms。金额窗口不能再打开，
// 所以改成"**冻结**（DETACH）与**结算**（聚合+DROP）分开：
//
//   - 冻结点 = DETACH 的提交：这一刻起 `INSERT INTO usage` 的元组路由再也找不到
//     rel（23514），产品写路径要么失败重试、要么走 adopt 领回；
//   - adopt 领回需要 rel 的 ACCESS EXCLUSIVE（ATTACH 对被挂的表取 AEX，PG 18.6
//     实测）⇒ 被结算段的 rel AEX 挡住；
//   - 结算段的聚合与 DROP **同事务**：被挡住的写入者只能在 COMMIT 之后继续，而
//     那时表已经被 DROP（PG 重开关系失败）⇒ **不存在"插进已摘表、随后被 DROP 删掉"
//     的行**；反过来，凡是聚合快照看得到的行，都被计入了账本。
//     ⇒ `DROP` 删掉的行 == 结算段聚合写进账本的行。金额窗口仍然关闭。
//
// 父表 AEX 为什么只出现在冻结段：`ALTER TABLE usage DETACH PARTITION` 需要父表
// AEX（PG 语义），而聚合与 DROP 不需要 —— 对**已经摘下来**的表 DROP 只取它自己的
// AEX（真 PG 实测；对仍挂在父表下的分区 DROP 才会取父表 AEX，所以本函数必须先
// DETACH，不能直接把 DROP 当"冻结+删除"用）。冻结段的实测总时长 ≈ 77ms。
//
// 锁序（为什么冻结段先 usage 后 rel、结算段先 usage 的 AS 再 rel 的 AEX）：
// 计量写入的加锁顺序是 `usage`（RowExclusive）→（元组路由经过的每一级分区）；
// `ALTER TABLE usage DETACH PARTITION` 自身也要 usage 的 AEX；`ATTACH` 对父表取
// SHARE UPDATE EXCLUSIVE、对被挂的表取 AEX。任何"先 rel 后 usage"的顺序都会与
// "已拿到 usage、正卡在 rel 上"的写入者构成环 ⇒ PG 死锁检测随机杀掉一方。所以：
//   - 冻结段：`LOCK ONLY usage AEX`（与写入者得到的 usage 锁、与 DETACH 自身同序）
//     → `LOCK rel AEX`；
//   - 结算段：`LOCK ONLY usage ACCESS SHARE`（**锁序锚点**：先占住 usage，之后就
//     再也不会为了 usage 等锁；AS 与 RowExclusive 相容 ⇒ 不挡任何计量写入）
//     → `LOCK rel AEX`。
//
// 回滚语义：每个事务各自原子 —— 冻结段失败 ⇒ 关系原样挂着；结算段失败 ⇒ 回滚
// （一行没删、账本不动），此前的预补账仍在（金额可见），下一轮自愈。
//
// 窗口来源：`shape.ReclaimWindow`（调用方在临界区之前按"名义月 ∪ 实际持有的行 ∪
// 相邻月整月"算好）。零值 ⇒ 按关系名的名义月（只用 4 参的兼容调用点，例如
// audit_r9c2_benign_race_test.go 直接调本函数的用例）。
//
// 有界语义（R10-A-03/R10-D-02/R10-G3）：锁等待 5s；冻结段单条语句 20s
// （usageReclaimStatementBudgetMS）；结算段按行数推导的**总**预算
// （usageReclaimSettleBudgetMS + ctx deadline）。超时一律按 timeout 分类延后。
func reclaimUsagePartitionAtomically(db *sql.DB, rel string, shape usageRelationShape, cutoffMonth time.Time) usageReclaimResult {
	fail := func(op string, err error) usageReclaimResult {
		return usageReclaimResult{outcome: usageReclaimFailed, op: op, err: err}
	}
	win := shape.ReclaimWindow
	if win.from.IsZero() || win.to.IsZero() {
		// 兼容分支：旧调用点只给关系 + 截止月 ⇒ 窗口取名义月（与
		// retentionLedgerWindow 的缺省窗口同一口径）。
		m, ok := usageMonthRelationOf(rel)
		if !ok {
			return fail("reclaim-window", fmt.Errorf("无法从关系名 %q 推出补账窗口", rel))
		}
		win = retentionWindow{from: dayKey(m), to: dayKey(m).AddDate(0, 1, -1)}
	}
	// 第 0 步：预补账（池上、无锁、可长）—— N1 的保险丝，见 usageReclaimPreBackfill。
	if err := usageReclaimPreBackfill(db, rel, win.from, win.to); err != nil {
		return preBackfillFailure(rel, err)
	}
	// 账本**自己的**关系（usage_daily 年分区）必须在进入冻结段之前备好：冻结段持有
	// usage 的 ACCESS EXCLUSIVE，池上的第二条连接可能自锁（见
	// ensureRetentionLedgerRelations 的注释）。备不齐 ⇒ 账算不出来 ⇒ 不 DETACH。
	//
	// R11A-01（P1）：备关系的窗口取 **win ∪ 该关系的声明边界**。结算段的补账窗口
	// 现在是在持锁区间里按 rel 的**实际行**重算的（见 settleUsageReclaim 的
	// usageReclaimWindowUnderLock），而 PG 强制分区约束 ⇒ 实际行必然落在**声明
	// 边界**之内。按"实际行窗口的上界"备关系，才不会在结算段才发现"某个年度的
	// usage_daily 分区还没建"（那会把一次静默丢账换成一次多余的延后）。
	if err := ensureRetentionLedgerRelations(db, win.from, win.to); err != nil {
		return fail("rebuild-ledger", fmt.Errorf("rebuild ledger before dropping: %w", err))
	}
	if !win.boundFrom.IsZero() && !win.boundTo.IsZero() {
		if err := ensureRetentionLedgerRelations(db, win.boundFrom, win.boundTo); err != nil {
			return fail("rebuild-ledger", fmt.Errorf("rebuild ledger before dropping: %w", err))
		}
	}
	// R11A-03（P2）：冻结段事务**必须有有界终点**。旧实现是 `db.Begin()`（无 ctx）
	// + `lock_timeout=5s` + `statement_timeout=20s`，而 COMMIT 不在
	// `statement_timeout` 的覆盖面内（真 PG 实测 5012/5463/5008ms）⇒ 持有父表
	// ACCESS EXCLUSIVE（阻塞全部计量写入的那把锁）的那一段终点无界。
	// 现在整段（含 COMMIT）罩在 usageReclaimFreezeBudgetMS 的 ctx 里，且 COMMIT
	// 以**语句**形态执行（usageBoundedTx.commit）⇒ deadline 到点真的中止提交。
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(usageReclaimFreezeBudgetMS)*time.Millisecond)
	defer cancel()
	// W3-1 的同一条纪律（本段现在也有 ctx 了）：本段所有失败的出口都要过
	// usageBudgetError —— "预算到点"这件事**没有 SQLSTATE**，必须在知道 ctx 状态的
	// 地方打标记，否则它会被记成真失败（管理端 500 + failed_rounds++，且每轮都失败）。
	failBound := func(op string, err error) usageReclaimResult {
		return usageReclaimResult{outcome: usageReclaimFailed, op: op, err: usageBudgetError(ctx, err)}
	}
	tx, err := beginUsageBoundedTx(ctx, db)
	if err != nil {
		return failBound("begin-freeze", err)
	}
	// 提交成功后 release 是 no-op；每条提前返回的出口都先把连接放回池。
	defer tx.release()
	// 先回滚（= 结束事务 + 把连接放回池）再去问 catalog：`db` 是连接池，池上限
	// 可能被配成 1（PICOAI_DB_MAX_OPEN_CONNS / 测试里的 SetMaxOpenConns(1)），
	// 在持有事务连接时再向池里要第二条连接会自锁。
	rollback := func() { tx.rollback() }

	if err := setUsageRetentionStatementBudget(tx); err != nil {
		rollback()
		return failBound("set-lock-timeout", err)
	}
	if _, err := tx.Exec("LOCK TABLE ONLY " + quoteRelationIdent("usage") + " IN ACCESS EXCLUSIVE MODE"); err != nil {
		rollback()
		return usageReclaimLockFailure(func() bool { return usageRelationGone(db, rel) }, "lock-usage", err)
	}
	if _, err := tx.Exec("LOCK TABLE " + quoteRelationIdent(rel) + " IN ACCESS EXCLUSIVE MODE"); err != nil {
		rollback()
		return usageReclaimLockFailure(func() bool { return usageRelationGone(db, rel) }, "lock-subtree", err)
	}
	// 动作前再看一眼 catalog：并发轮次可能已经把它摘出分区树（另一轮的冻结段已提交）、
	// 或人工把它改挂到了别处。**这种情况下一律不在本轮 DETACH/DROP**：补账只覆盖
	// "经 `SELECT … FROM usage` 可见"的行，而它已经不在 usage 的分区树里 ⇒ 它的行
	// 根本没进这次补账，DROP 就是金额永久丢失（R6-A-1 的孤儿形态）。按**良性**留给
	// 下一轮：届时 catalog 扫描会把它落进孤儿桶，由 dropDetachedOrphanAtomically 把
	// 它的行与 usage 放进**同一次**聚合再回收。
	directChild, aerr := usageRelationIsDirectChildOfUsage(tx, rel)
	if aerr != nil {
		rollback()
		return failBound("verify-attached", aerr)
	}
	if !directChild {
		rollback()
		return usageReclaimResult{outcome: usageReclaimNotAttached, op: "verify-attached"}
	}
	// 权威复检（判据与前置筛同源，只是此刻行集合已冻结）。
	//
	// R10-D-01（P1）：**行集合的冻结由这两把锁负责**，而补账在**结算段**的同一个
	// 事务里（见 settleUsageReclaim）—— 这才是"叶子窗口"的修法：补账覆盖的行 =
	// DROP 会删掉的行。实测：把补账移出（任何）持锁事务，本用例的 SILENT_LOSS
	// 立刻从 0.00 变成 5.00/8.00/3.00（三轮回同形）。
	//
	// 为什么"子树里还有保留期内的行"这道闸门**只对非叶子**：叶子是**月名**关系
	// （`usage_<YYYYMM>`），
	//   - 它自己名义月的行 = 该月聚合的**明细分段来源**，到期就该删（账本已在同一
	//     事务里补齐）；
	//   - 它持有的**别的月**（更宽/错界布局）的行**不是**那些月的分段来源 ——
	//     `usageAggregateSegments` 只认**与月同名**的关系，那些月的聚合走永久账本，
	//     而账本刚在本事务里按它实际的窗口补齐了。
	// 所以"叶子还持有保留期内的行"不构成"删了会看不见"的理由；反过来把它当闸门
	// 会让**合法**的更宽分区（DBA 按季度预建，r7 srvbill-3 明确判为合法配置）永远
	// 不被回收 —— 这条取舍由既有回归 `TestUsageRetentionWiderPartitionLedgersEveryCoveredMonth`
	// 钉住（它要求更宽分区在补账之后**被清掉**，且被覆盖的每个月账本都有数）。
	// 非叶子则是另一回事：DROP 会**连子分区一起删**，而子分区通常是**与月同名**的
	// 月分区（那些月的明细分段来源）⇒ 必须按行事实拦住（R8-A-4）。
	//
	// R10-G3：这道闸门必须在**冻结（DETACH）之前**判定 —— 摘了再判会把不该摘的
	// 子树摘下来（白留一个孤儿 + 该月明细从读面上消失）。
	var holds bool
	var herr error
	if !shape.leafTable() {
		holds, herr = usageSubtreeHoldsRetainedRows(tx, rel, cutoffMonth)
	}
	if herr != nil {
		rollback()
		return failBound("recheck-subtree-retention", herr)
	}
	if holds {
		rollback()
		return usageReclaimResult{outcome: usageReclaimSkippedRetained, op: "recheck-subtree-retention"}
	}
	// 冻结：这一提交之后 rel 的行集合**不可能**再增加（见函数注释），父表 AEX
	// 随本事务结束立刻释放 —— 补账与 DROP 都在**只锁 rel** 的结算段里做。
	if _, err := tx.Exec("ALTER TABLE usage DETACH PARTITION " + quoteRelationIdent(rel)); err != nil {
		rollback()
		return failBound("detach-partition", err)
	}
	if err := tx.commit(); err != nil {
		return failBound("commit-freeze", err)
	}
	// 第 2 步：结算段（聚合 + DROP，同一个只锁 rel 的事务）。
	return settleUsageReclaim(db, usageSettleRequest{
		rel:      rel,
		from:     win.from,
		to:       win.to,
		dropStmt: "DROP TABLE IF EXISTS " + quoteRelationIdent(rel),
	})
}

// usageRelationIsDirectChildOfUsage 报告 rel 此刻是否仍是 usage 的**直接**子分区
// （临界区专用；与 scanUsageMonthTables 的 `directChildOfUsage` 同一判据面，
// 区别只是按**当下**的 catalog 事实读，并且能在事务里读）。
//
// R10-A-07（P3）：判据从 `p.relname = 'usage'` 改成 **oid** 比较
// （`p.oid = to_regclass('public.usage')`）—— 与 attachedToUsage 的口径统一：
// 另一个 schema 里同名 `usage` 下的 public.usage_<YYYYMM> 不是本表的直接子分区
// （旧判据会漏过它，让随后的 `ALTER TABLE usage DETACH PARTITION` 报 42809/42P01）。
//
// 关系不存在（并发轮次已回收）按"不是"返回 —— 调用方按良性处理。
func usageRelationIsDirectChildOfUsage(q usageQuerier, rel string) (bool, error) {
	var direct sql.NullBool
	err := q.QueryRow(`SELECT COALESCE(p.oid = to_regclass('public.usage'), false)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
LEFT JOIN pg_class p ON p.oid = i.inhparent
WHERE c.relname = ? AND n.nspname = 'public'`, rel).Scan(&direct)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("核对 %s 是否仍直接挂在 usage 下: %w", rel, err)
	}
	return direct.Valid && direct.Bool, nil
}

// formatSkipReasons 把"未回收原因 → 计数"渲染成稳定的日志字段（key 升序）。
func formatSkipReasons(reasons map[string]int) string {
	if len(reasons) == 0 {
		return "none"
	}
	keys := make([]string, 0, len(reasons))
	for k := range reasons {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s:%d", k, reasons[k]))
	}
	return strings.Join(parts, ",")
}

// usageSubtreeHoldsRetainedRows 报告 rel 的子树里是否还有**保留期内**的明细行
// （Beijing day >= cutoffMonth 的首日）。
//
// 判据取**行事实**而不是形态/名字（R8-A-4）：月名中间父表 `usage_<m1>[p]` 覆盖
// [m1, m2) 时它的边界看着"就是 m1 月"，子分区 `usage_<m2>` 却在保留期内；反过来
// 合法的日粒度子分区（`usage_20260601`）名字不是月，却整株都已到期。只有"这条
// 关系里真的还有没有保留期内的行"同时回答这两种形态。
//
// 代价有界：前置筛只对**非叶子**候选关系调用，临界区里的复检对**叶子也调用**
// （R10-D-01：叶子月分区是产品实际布局），且是 `LIMIT 1` 存在性检查（命中即返回）。
// 关系已不存在（并发轮次回收）由调用方按良性处理。
//
// R9-A-1（审计 2026-09-24，P1）：谓词从 `bjWallExpr(created_at)::date >= ?::date`
// 改写为**语义等价**的 `created_at >= ?::timestamptz`（BeijingDayInstant(cutoff)
// 就是"cutoff 首日的北京零点"这一瞬时）：
//
//	bjWallExpr(created_at)::date >= D  ⟺  created_at >= BeijingDayInstant(D)
//
// 旧写法给列套了表达式 ⇒ 既用不上 `usage_*_created_at_idx`，也无法按分区边界
// 裁剪：实测 20 万行、整株都已到期的子树，旧谓词要 Seq Scan 全表（33.8ms、
// 3077 buffers），新谓词 0.6ms（分区裁剪 + 索引；`max(created_at)` 早于 cutoff
// 的子分区被整块跳过）。复检要在**持有 ACCESS EXCLUSIVE 的临界区里**跑（见
// reclaimUsagePartitionAtomically），持锁时间是硬约束 ⇒ 这条等价改写是修复的
// 一部分，不是可选优化。语义等价由 audit_r9a_reclaim_race_test.go 的边界对拍用例钉死。
func usageSubtreeHoldsRetainedRows(q usageQuerier, rel string, cutoffMonth time.Time) (bool, error) {
	var one int
	err := q.QueryRow(fmt.Sprintf(`SELECT 1 FROM %s WHERE created_at >= ?::timestamptz LIMIT 1`,
		quoteRelationIdent(rel)),
		pgInstantArg(BeijingDayInstant(dayKey(cutoffMonth)))).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("探测 %s 的子树是否仍持有保留期内的明细: %w", rel, err)
	}
	return true, nil
}

// relationExistsForCleanup 报告 rel 此刻是否还存在（清理路径用；探测失败按"存在"
// 处理 —— 判据不建立在对失败的猜测上，后续 SQL 会给出真实错误）。
func relationExistsForCleanup(db *sql.DB, rel string) bool {
	gone := usageRelationGone(db, rel)
	return !gone
}

// usageSubtreeHoldsRetainedRowsBudget 是前置筛的"带等锁上界"版本（R10-D-02）：
// 谓词与临界区里的权威复检**同一个函数**，只多一条 lock_timeout —— 前半轮不得
// 被任一月分区的 ACCESS EXCLUSIVE 无界挂住。
func usageSubtreeHoldsRetainedRowsBudget(db *sql.DB, rel string, cutoffMonth time.Time) (bool, error) {
	var holds bool
	err := withUsageLockBudget(db, usageReclaimLockTimeoutMS, func(tx *sql.Tx) error {
		var herr error
		holds, herr = usageSubtreeHoldsRetainedRows(tx, rel, cutoffMonth)
		return herr
	})
	return holds, err
}
func UsageAggregateWithLedger(db *sql.DB, from, to time.Time, group string, opts ...UsageAggregateOption) ([]UsageAggregateRow, error) {
	if group == "dept" {
		rows, err := UsageAggregateWithLedger(db, from, to, "user", opts...)
		if err != nil {
			return nil, err
		}
		return RegroupByDept(db, rows)
	}
	if from.IsZero() {
		// 无起始边界:直接查账本(覆盖全部历史,明细窗口内已并入日账)
		return UsageAggregateFromLedger(db, from, to, group, opts...)
	}
	// from/to 归一到北京日期值(允许调用方传瞬时):分段边界与明细/账本
	// 两套口径都建立在同一套日口径上(2026-09-10 时区缺陷修复)。
	from, to = normalizeDayRange(from, to)
	// R4-C-4(审计 2026-09-23,P2):分段依据是"该月明细分区**是否还在**"(事实),
	// 不是配置的 retention(假设)。旧实现用一个 configured cutoffDay 把窗口切成
	// "账本段 + 明细段":一旦把保留期调大(6→24)或关掉(0=永久),早被旧保留期
	// DROP 掉的月份会被判成"在保留期内",于是只去查一个已经空了的明细表 ——
	// 报表给出 `rows=1, cost=0.00`(**不是空集**),而永久日账里还有金额
	// (CleanupUsageRetention 一定先 RebuildUsageLedger 再 DROP ⇒ 账本完整)。
	//
	// 为什么是**逐月分段**而不是两个大段:分区可能只在中段缺失(零用量月没有分区、
	// 或历史某月被清过而前后仍在)。两个大段的切分点无法表达"中间有个洞" ——
	// 洞所在月会被划进明细段,于是既读不到明细(分区没了)也读不到账本(没去读)。
	// 逐月判定 + 相邻同源合并后:每个"分区仍在"的月读明细,每个"分区不在"的月读
	// 账本,两侧都不会漏、也不会重复(段与段的天区间严格不相交)。
	segments, err := usageAggregateSegments(db, from, to)
	if err != nil {
		return nil, err
	}
	var merged []UsageAggregateRow
	for _, seg := range segments {
		var rows []UsageAggregateRow
		if seg.detail {
			rows, err = UsageAggregate(db, seg.from, seg.to, group, opts...)
		} else {
			rows, err = UsageAggregateFromLedger(db, seg.from, seg.to, group, opts...)
		}
		if err != nil {
			return nil, err
		}
		merged = mergeUsageRows(merged, rows)
	}
	return merged, nil
}

// usageAggregateSegment 是 [from, to] 里的一个同源日区间(detail=true 走明细,
// false 走永久账本)。段边界必定落在月首/月末(分区是月粒度的)。
type usageAggregateSegment struct {
	from, to time.Time
	detail   bool
}

// usageAggregateSegments 把闭区间 [from, to] 按"该月明细分区是否存在"切成
// **相邻同源合并**后的段序列(R4-C-4 的唯一判据实现)。
//
// 判据来源是 scanUsageMonthTables 的枚举结果(实际挂在 usage 下、**传递地**算作
// usage 子树的叶子月分区),不是配置值 —— R7-A(审计 2026-09-24,P2)之前这里拿到
// 的是"直接挂在 usage 下的叶子",于是多级布局的孙辈叶子所在月被判成"没有明细
// 分区":明细真实存在于 `SELECT … FROM usage` 可见的位置,该月聚合却回落账本
// (账本还没覆盖时读数就是 0),读数静默偏小。现在判据与 attachedToUsage 同源
// (传递根 = usage),明细在哪、聚合就读哪。相邻同源合并让常规布局(近 N 月 +
// 更早全无分区)只产生 2 段 —— 与旧实现同样数量的查询;只有中间真有洞时才会
// 多出几段。
func usageAggregateSegments(db *sql.DB, from, to time.Time) ([]usageAggregateSegment, error) {
	tables, err := scanUsageMonthTables(db)
	if err != nil {
		return nil, err
	}
	present := make(map[string]bool, len(tables.Partitions))
	for _, rel := range tables.Partitions {
		// Partitions 是"传递地挂在 usage 下的叶子月分区"(R7-A):多级布局的孙辈
		// 叶子同样在这里 ⇒ 它所在的月按**明细**读,与它实际持有的行一致。
		if m, ok := usageMonthRelationOf(rel); ok {
			present[monthKey(m)] = true
		}
	}
	segments := make([]usageAggregateSegment, 0, 2)
	for cur := from; !cur.After(to); {
		monthStart := dayKey(cur)
		nextMonth := monthStart.AddDate(0, 1, 0)
		segEnd := nextMonth.AddDate(0, 0, -1) // 当月最后一个北京日
		if segEnd.After(to) {
			segEnd = to
		}
		detail := present[monthKey(monthStart)]
		// R5-A-10 的纵深防御(审计 2026-09-23,P1):"分区存在" ≠ "该月有明细"。
		// 历史缺陷(或人工 DDL/旧版本遗留)建出的**空**分区与"仍有明细的分区"在
		// `present` 判据下同形 ⇒ 明细段读出 0,而永久账本里明明有金额(报告静默
		// 少计)。这里把判据补全为:分区存在 **且**(该月有明细行 **或** 该月账本
		// 无行)。两边都空时读哪边都一样,保持原判据(不多查一次)。
		//
		// 只在"分区为空"时才查账本 ⇒ 正常布局(分区非空)零额外查询、且仍以明细
		// 为事实源(不会因账本有旧数据而重复计数)。
		if detail {
			hasDetail, derr := usageMonthHasDetail(db, monthStart)
			if derr != nil {
				return nil, derr
			}
			if !hasDetail {
				hasLedger, lerr := ledgerMonthHasRows(db, monthStart)
				if lerr != nil {
					return nil, lerr
				}
				if hasLedger {
					detail = false
				}
			}
		}
		if n := len(segments); n > 0 && segments[n-1].detail == detail {
			segments[n-1].to = segEnd
		} else {
			segments = append(segments, usageAggregateSegment{from: cur, to: segEnd, detail: detail})
		}
		cur = nextMonth
	}
	return segments, nil
}

// ledgerMonthHasRows 报告该北京月在永久日账 usage_daily 里**是否至少有一行**
// (R5-A-10 纵深防御的配套探测;只做 LIMIT 1 存在性检查,走 idx_usage_daily_day)。
func ledgerMonthHasRows(db *sql.DB, month time.Time) (bool, error) {
	start := dayKey(BeijingMonth(month))
	end := start.AddDate(0, 1, 0)
	var one int
	err := db.QueryRow(`SELECT 1 FROM usage_daily WHERE day >= ?::date AND day < ?::date LIMIT 1`,
		start.Format(dateFmt), end.Format(dateFmt)).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ledgerWindowEmpty 探测日账表在 [from, to] 闭区间内**是否一行都没有**。
// 只做一次 LIMIT 1 的存在性检查(走 idx_usage_daily_day 索引),不解聚合。
// from/to 为零表示该侧无界(与本函数其余部分同一口径)。
func ledgerWindowEmpty(db *sql.DB, from, to time.Time) (bool, error) {
	q := "SELECT 1 FROM usage_daily WHERE 1=1"
	args := []any{}
	if !from.IsZero() {
		q += " AND day >= ?::date"
		args = append(args, from.Format(dateFmt))
	}
	if !to.IsZero() {
		q += " AND day <= ?::date"
		args = append(args, to.Format(dateFmt))
	}
	q += " LIMIT 1"
	var one int
	err := db.QueryRow(q, args...).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return false, nil
}

// UsageAggregateFromLedger 从永久日账 usage_daily 聚合(from/to 为闭区间日期,
// from 为零 = 无下界)。全部维度都由日账归并——P1-16:此前默认分支把 group=model
// 打成 month(所有模型合并成"每月一行")、group=week 退化成逐日,与明细口径不符。
func UsageAggregateFromLedger(db *sql.DB, from, to time.Time, group string, opts ...UsageAggregateOption) ([]UsageAggregateRow, error) {
	var q UsageAggregateQuery
	for _, o := range opts {
		o(&q)
	}
	// usage_daily.day 是 DATE 列(北京日期值),归一后与明细侧的日口径一致。
	from, to = normalizeDayRange(from, to)

	// FIX-11(审计 2026-09-12,P1):kind 在日账里**没有对应列**
	// (usage_daily 的主键是 user_id+model+day,0039),所以窗口跨保留边界时
	// 账本段无法按 chat|embedding|search 过滤。此前 q.Kind 在本函数里零命中
	// —— 过滤被静默忽略,账本段返回**全部** kind,与明细段相加后"统计徽标"
	// 比明细表偏大(审计实测 ledger WithKind(embedding) → rows=2)。
	//
	// 但"不支持"必须**只在真的会算错时**才报错:账本窗口里一行都没有
	// (尚未生成日账 / 该区间没有历史)时,不过滤与过滤的结果都是空集,
	// 没有数字会被放大。若无条件报错,一个合法的空查询就会变成 400,
	// 破坏调用方契约(G9 日志页:kind 过滤必须能给空结果 ——
	// serverauth admin_test 的 TestAdminUsageAggregateModelKindFilter)。
	//
	// 所以先探一次"账本窗口是否为空":非空 → 明确失败(给出修复指引);
	// 空 → 直接返回空集,与明细段合并后仍是正确结果。
	if q.Kind != "" {
		empty, eerr := ledgerWindowEmpty(db, from, to)
		if eerr != nil {
			return nil, eerr
		}
		if !empty {
			return nil, fmt.Errorf("%w: 按类型(kind=%s)过滤的统计在窗口跨越用量保留边界时不可用:"+
				"永久日账 usage_daily 没有 kind 列;请把区间收窄到保留期内,或去掉 kind 过滤",
				ErrUnsupportedFilter, q.Kind)
		}
		return []UsageAggregateRow{}, nil
	}

	// FIX-10(审计 2026-09-12,P1):参数顺序必须与占位符顺序**逐一对齐**。
	// 此前 `args = append(args, q.Username)` 写在函数开头,而占位符
	// usernameFilter 拼在最后 —— 于是 PG 把用户名喂给 `?::date`,跨保留边界
	// + 按用户必然 500(SQLSTATE 22007)。
	//
	// 修法不只是"把 append 挪个位置":这里改成**SQL 片段与它的参数紧挨着
	// 追加**,让顺序错误在结构上不可能再出现(每段自己负责自己的占位符)。
	args := []any{}

	// 部门过滤:子树成员集合,与预算 enforcement 同口径(2026-09 用量中心)。
	// P2-7:用子查询 + ANY(数组),避免成员数上万时拼 IN(?,?,…) 撞 PG 参数上限。
	var deptFilter string
	var deptGroupIDs []int64
	if q.Dept != "" {
		sub, err := deptSubtreeIDs(db, q.Dept)
		if err != nil {
			if err == ErrNotFound {
				return []UsageAggregateRow{}, nil // 部门不存在 = 空结果
			}
			return nil, err
		}
		if len(sub) == 0 {
			return []UsageAggregateRow{}, nil
		}
		deptFilter = " AND ue.user_id IN (SELECT user_id FROM user_groups WHERE group_id = ANY(?::bigint[]))"
		deptGroupIDs = sub
	}
	// FIX-11:model 过滤 —— usage_daily **有** model 列(0039:50,而且是主键
	// 的一部分),所以这条过滤必须真的下推,不能像 kind 那样退化成不过滤。
	var modelFilter string
	if q.Model != "" {
		modelFilter = " AND ue.model = ?"
	}
	// username 过滤(usernameFilter 与它的参数在这里成对定义)。
	usernameFilter := ""
	if q.Username != "" {
		usernameFilter = " AND ue.user_id = (SELECT id FROM users WHERE username = ?)"
	}
	var labelExpr, groupExpr string
	switch group {
	case "day":
		labelExpr, groupExpr = "to_char(ue.day, 'YYYY-MM-DD')", "ue.day"
	case "week":
		// 周一日期分桶:与 UsageAggregate 的 DateWeekExpr 同语义(不得逐日)
		labelExpr = "to_char(date_trunc('week', ue.day)::date, 'YYYY-MM-DD')"
		groupExpr = "date_trunc('week', ue.day)::date"
	case "model":
		labelExpr, groupExpr = "ue.model", "ue.model"
	case "user":
		labelExpr, groupExpr = "COALESCE(u.username, CAST(ue.user_id AS TEXT))", "u.username, ue.user_id"
	default: // month
		labelExpr = "to_char(date_trunc('month', ue.day)::date, 'YYYY-MM')"
		groupExpr = "date_trunc('month', ue.day)::date"
	}
	qstr := `SELECT ` + labelExpr + ` AS label,
		SUM(ue.prompt_tokens) AS pt, SUM(ue.completion_tokens) AS ct, SUM(ue.requests) AS req,
		SUM(ue.cache_prompt_tokens) AS ctk, SUM(ue.cost) AS cost
		FROM usage_daily ue`
	if group == "user" {
		qstr += " LEFT JOIN users u ON u.id = ue.user_id"
	}
	qstr += " WHERE 1=1"
	if !from.IsZero() {
		// day 是 DATE 列(无时区语义):?::date 参数与 PG 会话时区无关,安全。
		qstr += " AND ue.day >= ?::date"
		args = append(args, from.Format(dateFmt))
	}
	if !to.IsZero() {
		qstr += " AND ue.day <= ?::date"
		args = append(args, to.Format(dateFmt))
	}
	if q.Dept != "" {
		qstr += deptFilter
		args = append(args, pgInt64Array(deptGroupIDs))
	}
	// FIX-11:model 过滤(usage_daily 有该列)必须真的下推。
	if q.Model != "" {
		qstr += modelFilter
		args = append(args, q.Model)
	}
	// FIX-10:usernameFilter 的占位符就在这里追加,参数紧跟着追加 —— 与
	// 上面各段保持同一种「片段+参数成对」的写法,顺序天然对齐。
	if q.Username != "" {
		qstr += usernameFilter
		args = append(args, q.Username)
	}
	qstr += " GROUP BY " + groupExpr + " ORDER BY label"
	rows, err := db.Query(qstr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UsageAggregateRow{}
	for rows.Next() {
		var r UsageAggregateRow
		if err := rows.Scan(&r.Label, &r.PromptTokens, &r.CompletionTokens, &r.Requests, &r.CacheTokens, &r.Cost); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// mergeUsageRows 按 label 合并两批聚合行(账本段 + 明细段),各维度相加。
// 两段覆盖的"天"严格不相交(见 UsageAggregateWithLedger),相加即精确合计;
// 同一 label 出现两次只可能来自两段各自的贡献。
func mergeUsageRows(a, b []UsageAggregateRow) []UsageAggregateRow {
	byLabel := map[string]UsageAggregateRow{}
	order := make([]string, 0, len(a)+len(b))
	add := func(r UsageAggregateRow) {
		cur, ok := byLabel[r.Label]
		if !ok {
			byLabel[r.Label] = r
			order = append(order, r.Label)
			return
		}
		// 7 个可累加字段的唯一实现（原先是三处逐字节相同的副本之一）。
		addUsageRow(&cur, r)
		byLabel[r.Label] = cur
	}
	for _, r := range a {
		add(r)
	}
	for _, r := range b {
		add(r)
	}
	out := make([]UsageAggregateRow, 0, len(order))
	for _, label := range order {
		out = append(out, byLabel[label])
	}
	return out
}
