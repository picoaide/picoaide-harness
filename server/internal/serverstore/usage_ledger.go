package serverstore

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
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
	if err := ensureLedgerRelations(db, from, to); err != nil {
		return err
	}
	return rebuildUsageLedgerRows(db, from, to)
}

// ensureLedgerRelations 为窗口内的月份准备关系:usage_daily 年分区**无条件**
// 建(账本写入目标),usage 明细月分区**按需**建(该月一行明细都没有就不建,
// 见 RebuildUsageLedger 的 R5-A-10 说明)。
func ensureLedgerRelations(db *sql.DB, from, to time.Time) error {
	for m := dayKey(from); !m.After(dayKey(to)); m = m.AddDate(0, 1, 0) {
		if err := ensureUsageDailyPartition(db, m); err != nil {
			return err
		}
		hasDetail, err := usageMonthHasDetail(db, m)
		if err != nil {
			return err
		}
		if !hasDetail {
			// 该月没有明细 ⇒ 不建空分区(建了会让聚合把该月判成"有明细"从而
			// 隐藏账本金额)。当月的新写入由写路径 RecordUsage 自己 ensure。
			continue
		}
		if err := ensureUsagePartition(db, m); err != nil {
			return err
		}
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
	return rebuildUsageLedgerRowsFrom(db, from, to, nil)
}

// ledgerDetailSource 构造"日账聚合的明细来源"：无额外来源时就是 `usage`
// （保持热路径/启动补算的 SQL 与执行计划逐字不变）；有额外来源时是
// `usage` 与它们的 UNION ALL **同一个子查询** —— 必须一次聚合，不能分两次
// UPSERT：同一个 (user_id, model, day) 在两边都有行时，两次 UPSERT 会让后一次
// 把前一次的金额**覆盖**成自己那一份（静默少计，正是 §1.5-A 要防的形状）。
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
func rebuildUsageLedgerRowsFrom(db *sql.DB, from, to time.Time, extraSources []string) error {
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
	// Partitions 是挂在 usage 下的**叶子**月分区（relispartition=true 且
	// relkind='r'），按关系名升序 —— 升序即时间升序（YYYYMM）。
	Partitions []string
	// AttachedNonLeaf 是挂在 usage 下、但**自身又是分区父表**的月关系
	// （relispartition=true 且 relkind='p'，二级分区）。
	//
	// R6-A-1（复审 V1 §1.5-A）：它们同样是 usage 的明细来源（`SELECT … FROM
	// usage` 会读到子分区里的行），所以清理必须与叶子分区走**同一条**路径
	// （先补账再 DETACH+DROP，见 CleanupUsageRetention）；单列一桶是为了不改变
	// Partitions 的语义 —— usageAggregateSegments 的"该月明细分区是否存在"
	// 判据一直只认叶子分区，本轮不顺手改聚合口径。
	AttachedNonLeaf []string
	// Orphans 是名为 usage_<YYYYMM> 但**不**挂在 usage 下的关系（F11 的 DETACH
	// 残留、被手工换成 VIEW 的异常形态、独立的二级分区父表…）。它们没有分区
	// 身份，但同样占着名字：留着会让该月的新写入撞同名关系而失败，所以清理
	// 必须一并处理。
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
	Kind      string // pg_class.relkind
	Parent    string // pg_inherits 的父关系名（'' = 无父表）
	Partition bool   // pg_class.relispartition
	Children  int    // pg_inherits 里以本关系为父的关系数
}

// attachedToUsage 报告该关系是不是 usage 的分区（叶子或二级）。
func (s usageRelationShape) attachedToUsage() bool { return s.Partition && s.Parent == "usage" }

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
// `ledger_rows_after=0` ↔ 真分区对照 `=1`）。表形态现在走
// cleanupDetachedUsageTable（先并入 + 补账，再决定 DROP）。
//
// 其余形态（索引、序列、外部表、复合类型…）→ **跳过**：同名的非表对象是人工
// 事故，服务端不替管理员决定删它（与 misboundedPartitionErr「不自动 DROP/改写
// 外来对象」同一条纪律），调用方记警告并计入 skipped。
func dropStatementForViewLike(rel, kind string) (stmt string, ok bool) {
	switch kind {
	case "v":
		return "DROP VIEW IF EXISTS " + quoteRelationIdent(rel), true
	case "m":
		return "DROP MATERIALIZED VIEW IF EXISTS " + quoteRelationIdent(rel), true
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
// 只读一次 catalog（pg_class + pg_inherits）：比旧实现逐月一条查询更省往返，
// 且判据是**事实**（枚举）而不是**假设**（名字连续）—— R4-C-8 的根因正是后者。
func scanUsageMonthTables(db *sql.DB) (usageMonthTables, error) {
	rows, err := db.Query(`SELECT c.relname, COALESCE(p.relname, ''), c.relispartition, c.relkind,
       (SELECT count(*) FROM pg_inherits ch WHERE ch.inhparent = c.oid)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
LEFT JOIN pg_class p ON p.oid = i.inhparent
WHERE n.nspname = 'public' AND c.relname LIKE 'usage\_%'
ORDER BY c.relname`)
	if err != nil {
		return usageMonthTables{}, err
	}
	defer rows.Close()
	out := usageMonthTables{Shapes: map[string]usageRelationShape{}}
	for rows.Next() {
		var rel, parent, kind string
		var isPartition sql.NullBool
		var children int
		if err := rows.Scan(&rel, &parent, &isPartition, &kind, &children); err != nil {
			return usageMonthTables{}, err
		}
		if _, ok := usageMonthRelationOf(rel); !ok {
			continue // usage_daily_2026 之类的兄弟关系
		}
		shape := usageRelationShape{
			Kind:      kind,
			Parent:    parent,
			Partition: isPartition.Valid && isPartition.Bool,
			Children:  children,
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
func detailMonthsOutside(db *sql.DB, rel string, start, end time.Time) ([]time.Time, error) {
	q := fmt.Sprintf(`SELECT DISTINCT %s AS m FROM %s WHERE NOT (%s) ORDER BY 1`,
		usageDetailMonthExpr("created_at"), quoteRelationIdent(rel), usageDayPredicate("created_at"))
	rows, err := db.Query(q, start.Format(dateFmt), end.Format(dateFmt))
	if err != nil {
		return nil, fmt.Errorf("scan detail months of %s: %w", rel, err)
	}
	defer rows.Close()
	var out []time.Time
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		m, perr := time.Parse("200601", key)
		if perr != nil {
			return nil, fmt.Errorf("scan detail months of %s: 无法解析月份标签 %q: %w", rel, key, perr)
		}
		out = append(out, m)
	}
	return out, rows.Err()
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
	res, err := db.Exec(stmt, args...)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	return n, nil
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

// cleanupDetachedUsageTable 处理"名为 usage_<YYYYMM> 的**表形态**孤儿"
// （relkind='r'/'p'，且不挂在 usage 之下）。
//
// 为什么不能直接 DROP（§1.5-A 实证）：孤儿不在 usage 之下 ⇒ `SELECT … FROM
// usage` 读不到它的行，聚合与永久账本双双失明；DROP 之后那些金额就再也没有
// 任何来源。所以清理顺序被固定成：
//
//  1. 相邻月明细并入（foldAdjacentMonthsIntoUsage）—— 与 B 同一修法；
//  2. 补账：把孤儿与 usage 放进**同一次**聚合（union），窗口 = 名义月 ∪
//     该关系实际持有的行所覆盖的北京日 ∪ 相邻月的**整月**；
//  3. 任何一步失败 ⇒ 返回错误，调用方**不 DROP**（补账已完成 ⇒ 金额仍在
//     永久账本里，只是这条关系留给人工处置）。
//
// 返回 nil 表示"明细已被永久账本覆盖，可以安全 DROP"。
func cleanupDetachedUsageTable(db *sql.DB, rel string, m time.Time) error {
	winFrom, winTo := dayKey(m), dayKey(m).AddDate(0, 1, -1)
	// 实际持有的行覆盖的北京日（空关系返回 NULL ⇒ 只有名义月窗口）。
	var lo, hi sql.NullTime
	if err := db.QueryRow(fmt.Sprintf(`SELECT min(created_at), max(created_at) FROM %s`,
		quoteRelationIdent(rel))).Scan(&lo, &hi); err != nil {
		return fmt.Errorf("探测 %s 持有的明细窗口: %w", rel, err)
	}
	if lo.Valid {
		if d := BeijingDay(lo.Time); d.Before(winFrom) {
			winFrom = d
		}
	}
	if hi.Valid {
		if d := BeijingDay(hi.Time); d.After(winTo) {
			winTo = d
		}
	}
	months, err := detailMonthsOutside(db, rel, dayKey(m), dayKey(m).AddDate(0, 1, -1))
	if err != nil {
		return err
	}
	if len(months) > 0 {
		// 账本窗口必须覆盖相邻月的**整月**：那些月的明细分区还在（聚合会读明细），
		// 账本必须与它一致（否则同一个月的两个口径给出两个数）。
		if months[0].Before(winFrom) {
			winFrom = months[0]
		}
		if last := months[len(months)-1].AddDate(0, 1, -1); last.After(winTo) {
			winTo = last
		}
	}
	_, foldErr := foldAdjacentMonthsIntoUsage(db, rel, m, months)
	// 孤儿的行对 usage 不可见 ⇒ 必须与 usage **同一次**聚合（union），
	// 否则同一 (user,model,day) 的两份金额会互相覆盖成其中一份。
	if err := retentionBackfill(db, winFrom, winTo, []string{rel}); err != nil {
		return err
	}
	if foldErr != nil {
		return foldErr // 补账已完成：不 DROP，等人工处置
	}
	return nil
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
	probe, perr := probeUsagePartition(db, rel)
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

// retentionBackfill 是清理路径的补账入口:**唯一实现**。
//
//   - 先备好 usage_daily 年分区(账本**自己的**关系,缺了聚合结果写不进去 =
//     真失败),再做**纯聚合** —— 全程不碰 usage 明细月分区,因此"该月分区形态
//     异常"不会阻止清理(R5-A-9)。
//   - extraSources 是**不在 usage 之下**的明细来源(表形态孤儿):它们的行对
//     `SELECT … FROM usage` 不可见,只 DROP 就是金额永久丢失(§1.5-A)。它们由
//     rebuildUsageLedgerRowsFrom 与 usage 放进**同一次**聚合 —— 分两次 UPSERT
//     会让同一 (user,model,day) 的两份金额互相覆盖成其中一份。
func retentionBackfill(db *sql.DB, from, to time.Time, extraSources []string) error {
	from, to = normalizeDayRange(from, to)
	if from.IsZero() || to.IsZero() || from.After(to) {
		return nil
	}
	for m := dayKey(from); !m.After(dayKey(to)); m = m.AddDate(0, 1, 0) {
		if err := ensureUsageDailyPartition(db, m); err != nil {
			return err
		}
	}
	return rebuildUsageLedgerRowsFrom(db, from, to, extraSources)
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
func CleanupUsageRetention(db *sql.DB) error {
	n, err := EffectiveRetentionMonths(db)
	if err != nil {
		return err
	}
	if n == 0 {
		return nil // 永不删除
	}
	// 保留 N 个月 = 删除 created_at 早于"当前北京月 - N 个月"的整分区。
	// 北京月界(不依赖进程 TZ:UTC 容器在每月 1 日 00:00-08:00 会把 cutoff
	// 算到上一个月,导致多删一个月的明细)。
	cutoffMonth := BeijingMonth(time.Now()).AddDate(0, -n, 0)
	tables, err := scanUsageMonthTables(db)
	if err != nil {
		return err
	}
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
	noteFailure := func(rel, op string, err error) {
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
	clearedDetached := 0
	skipped := 0
	for _, rel := range tables.Orphans {
		m, ok := usageMonthRelationOf(rel)
		if !ok || !m.Before(cutoffMonth) {
			continue
		}
		shape := tables.Shapes[rel]
		if shape.tableLike() {
			// R6-A-1 复审 V1 §1.5-A（P1，已实证）：表形态孤儿可能**持有明细**
			// 且不在 usage 之下（聚合与账本都读不到它的行）⇒ 只 DROP 等于金额
			// 永久丢失。顺序固定为"先并入相邻月 + 补账（与正常分区同一条路径），
			// 再决定 DROP"。
			if perr := cleanupDetachedUsageTable(db, rel, m); perr != nil {
				noteFailure(rel, "backfill-detached", perr)
				continue
			}
			if !shape.leafTable() {
				// 父表 / 带子关系：DROP TABLE 会连子关系一起删（relkind='p' 的
				// 声明式分区）或被 PG 拒绝（2BP01），而清单里只有别的名字的
				// 关系 —— 服务端不替管理员决定删一整棵子树。账本已按它实际
				// 持有的明细补齐 ⇒ 金额不会丢，这里**跳过并记录**。
				skipped++
				log.Printf("usage retention: SKIP detached relation %s (relkind=%q children=%d):"+
					"父表/带子关系需人工处置(账本已按它实际持有的明细补齐,金额不会丢;"+
					"DROP TABLE 会连子关系一起删,服务端不替管理员做这个决定)", rel, shape.Kind, shape.Children)
				continue
			}
			if _, derr := db.Exec("DROP TABLE IF EXISTS " + quoteRelationIdent(rel)); derr != nil {
				noteFailure(rel, "drop-detached", derr)
				continue
			}
			clearedDetached++
			log.Printf("usage retention: dropped detached relation %s (relkind=%s, not a partition of usage;"+
				"其明细已并入相邻月并补进永久账本)", rel, shape.Kind)
			continue
		}
		stmt, droppable := dropStatementForViewLike(rel, shape.Kind)
		if !droppable {
			skipped++
			log.Printf("usage retention: SKIP detached relation %s (relkind=%q):只清理表/视图/物化视图,"+
				"其余形态需人工处置(服务端不替管理员决定删非表对象)", rel, shape.Kind)
			continue
		}
		if _, derr := db.Exec(stmt); derr != nil {
			noteFailure(rel, "drop-detached", derr)
			continue
		}
		clearedDetached++
		log.Printf("usage retention: dropped detached relation %s (relkind=%s, not a partition of usage)",
			rel, shape.Kind)
	}
	// 到期关系集合 = 叶子分区 + 二级分区（relkind='p' 且挂在 usage 下）。
	// R6-A-1（复审 V1 §1.5-A）：二级分区同样是 usage 的明细来源（父表查询会读到
	// 子分区里的行），旧实现把它归进 Orphans 并直接 DROP TABLE —— 而 DROP TABLE
	// 会连子分区一起删，那些明细既没进账本、也没被聚合读到 ⇒ 金额永久丢失。
	// 现在它与叶子分区走**完全同一条**路径（补账 + 相邻月并入，再 DETACH+DROP）。
	attached := make([]string, 0, len(tables.Partitions)+len(tables.AttachedNonLeaf))
	attached = append(attached, tables.Partitions...)
	attached = append(attached, tables.AttachedNonLeaf...)
	existing := make(map[string]bool, len(attached))
	var oldest time.Time
	for _, rel := range attached {
		m, ok := usageMonthRelationOf(rel)
		if !ok {
			continue
		}
		existing[monthKey(m)] = true
		if oldest.IsZero() || m.Before(oldest) {
			oldest = m
		}
	}
	dropped := 0
	for _, rel := range attached {
		m, ok := usageMonthRelationOf(rel)
		if !ok || !m.Before(cutoffMonth) {
			continue // 保留期内(或名字不合法,前一步已排除)
		}
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
			log.Printf("usage retention: %s 的形态判定未通过(或无法判定):%v;"+
				"重建其明细账本(窗口 %s..%s,按它实际持有的行)后照常 DETACH+DROP"+
				"(R5-A-9:分区形态只影响该月新写入,不得让整轮保留清理停摆)",
				rel, win.shapeErr, win.from.Format(dateFmt), win.to.Format(dateFmt))
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
		// 补账(账本 UPSERT,幂等):失败**保持 fail-loud** —— 账没算出来就不 DROP,
		// 否则明细被删而账本没补上,金额永久丢失。但失败**只隔离到这一条关系**
		// (R6-A-1):其余到期月份照常清理,该月下一轮重试。
		if err := retentionBackfill(db, win.from, win.to, nil); err != nil {
			noteFailure(rel, "rebuild-ledger", fmt.Errorf("rebuild ledger before dropping: %w", err))
			continue
		}
		if foldErr != nil {
			// 相邻月明细还在 rel 里 ⇒ 这一步**不能** DROP（DROP 就是让相邻月的
			// 明细段永久少计）；账本已补齐，人工处置相邻月分区形态后下一轮再清。
			noteFailure(rel, "fold-adjacent", foldErr)
			continue
		}
		if _, derr := db.Exec("ALTER TABLE usage DETACH PARTITION " + quoteRelationIdent(rel)); derr != nil {
			// 复检:并发清理/重复执行时可能已经不是分区 → 继续 DROP;
			// 仍是分区说明 DETACH 真失败 → 记失败并跳过这一条(不再上抛阻断整轮)。
			var again sql.NullBool
			rerr := db.QueryRow(`SELECT c.relispartition FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = ? AND n.nspname = 'public'`, rel).Scan(&again)
			if rerr != nil || !again.Valid || again.Bool {
				noteFailure(rel, "detach-partition", derr)
				continue
			}
		}
		if _, derr := db.Exec("DROP TABLE IF EXISTS " + quoteRelationIdent(rel)); derr != nil {
			noteFailure(rel, "drop-partition", derr)
			continue
		}
		dropped++
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
	log.Printf("usage retention: round summary cleared_partitions=%d cleared_detached=%d skipped=%d failures=%d cutoff=%s retention_months=%d",
		dropped, clearedDetached, skipped, failed, monthKey(cutoffMonth), n)
	if len(failures) > 0 {
		return fmt.Errorf("usage retention: %d relation(s) could not be cleaned this round (其余到期关系已清理,下一轮会重试;失败关系:%s): %s",
			failed, strings.Join(failedRels, ","), strings.Join(failures, " | "))
	}
	return nil
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
// 判据来源是 scanUsageMonthTables 的枚举结果(实际挂在 usage 下的叶子月分区),
// 不是配置值。相邻同源合并让常规布局(近 N 月 + 更早全无分区)只产生 2 段 ——
// 与旧实现同样数量的查询;只有中间真有洞时才会多出几段。
func usageAggregateSegments(db *sql.DB, from, to time.Time) ([]usageAggregateSegment, error) {
	tables, err := scanUsageMonthTables(db)
	if err != nil {
		return nil, err
	}
	present := make(map[string]bool, len(tables.Partitions))
	for _, rel := range tables.Partitions {
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
