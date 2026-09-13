package serverstore

import (
	"database/sql"
	"errors"
	"fmt"
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
	// 归一到北京月:写入路径传的是"真实瞬时"(2026-09-10 时区缺陷修复前按
	// 进程 TZ 取月,UTC 容器在北京每月 1 日 00:00-08:00 会去建/查上个月分区,
	// 当月分区缺失 → INSERT 报 "no partition of relation usage found for row")。
	month = BeijingMonth(month)
	key := monthKey(month)
	// F11(审计 2026-09-11):探测必须区分「真分区」与「同名孤儿表」。
	// 旧实现只看 to_regclass:若某月分区被 DETACH 成功但 DROP 失败,孤儿表
	// 仍在 catalog 中,探测会误判"已存在"而不再建分区,该月所有计量写入
	// 直接报 "no partition of relation usage found for row"。
	//
	// P1-3(审计 2026-09-12)/年分区同族(2026-09-13):探测→建表的竞态与
	// 42P07 兜底复检统一在 partitions.go 的 ensureRangePartition 里实现,
	// 年分区 ensureUsageDailyPartition 走同一个 helper。
	start := dayKey(month)
	end := start.AddDate(0, 1, 0)
	// 分区边界用**显式 UTC 偏移**的瞬时字面量:分区范围(timestamptz)不随 PG
	// 会话时区漂移(裸日期 '2026-09-01' 会被按会话时区解析,UTC 会话下建出的
	// 分区范围与北京月错开 8 小时)。
	return ensureRangePartition(db, partitionSpec{
		parent: "usage",
		key:    key,
		from:   pgInstantArg(BeijingDayInstant(start)),
		to:     pgInstantArg(BeijingDayInstant(end)),
	})
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
	// 建好涉及月份/年份的分区
	for m := dayKey(from); !m.After(dayKey(to)); m = m.AddDate(0, 1, 0) {
		if err := ensureUsagePartition(db, m); err != nil {
			return err
		}
		if err := ensureUsageDailyPartition(db, m); err != nil {
			return err
		}
	}
	// 日账:按 (user_id, model, day) 聚合明细;UPSERT 覆盖(幂等)。
	// PG 用 ON CONFLICT (user_id, model, day) DO UPDATE。
	// 日桶与边界都走固定 +8h(北京墙钟)与绝对瞬时(会话时区无关),见 beijing.go。
	if _, err := db.Exec(`
		INSERT INTO usage_daily (user_id, model, day, prompt_tokens, completion_tokens, cache_prompt_tokens, requests, cost)
		SELECT user_id, model, (`+bjWallExpr("created_at")+`)::date AS day,
		       SUM(prompt_tokens), SUM(completion_tokens), SUM(cache_prompt_tokens),
		       COUNT(*), SUM(cost)
		FROM usage
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

// CleanupUsageRetention DROP 过期月份分区(先校验该月日账已生成,防丢账)。
// 保留 N 个月 = 删除 created_at 早于"当前北京月 - N 个月"的整分区。
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
	for m := cutoffMonth.AddDate(0, -1, 0); ; m = m.AddDate(0, -1, 0) {
		key := monthKey(m)
		if key >= monthKey(cutoffMonth) {
			continue
		}
		// F11(审计 2026-09-11):
		//   - 用 pg_class.relispartition 区分「真分区」与「孤儿表」;
		//   - DETACH 失败不再静默 continue(旧实现把所有错误当"已删过",
		//     锁冲突/权限错误会被吞掉,分区清理永远停摆);
		//   - 上次 DETACH 成功但 DROP 失败留下的孤儿表直接清掉并继续,
		//     不再让它卡住后续月份(否则该表所在月的新写入会 500)。
		var isPartition sql.NullBool
		perr := db.QueryRow(`SELECT c.relispartition FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = ? AND n.nspname = 'public'`, "usage_"+key).Scan(&isPartition)
		if errors.Is(perr, sql.ErrNoRows) {
			break // 更早月份已没有表(DROP 已到边界)
		}
		if perr != nil {
			return perr
		}
		if isPartition.Valid && !isPartition.Bool {
			// 孤儿 detached 表:DROP 后继续清理更早月份。
			if _, derr := db.Exec("DROP TABLE IF EXISTS usage_" + key); derr != nil {
				return derr
			}
			continue
		}
		// 先重建该月日账/月账(幂等,防明细删除后账本丢)。
		monthStartT := m
		if err := RebuildUsageLedger(db, monthStartT, monthStartT.AddDate(0, 1, -1)); err != nil {
			return err
		}
		if _, derr := db.Exec("ALTER TABLE usage DETACH PARTITION usage_" + key); derr != nil {
			// 复检:并发清理/重复执行时可能已经不是分区 → 继续 DROP;
			// 仍是分区说明 DETACH 真失败 → 上抛,不静默跳过。
			var again sql.NullBool
			rerr := db.QueryRow(`SELECT c.relispartition FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = ? AND n.nspname = 'public'`, "usage_"+key).Scan(&again)
			if rerr != nil || !again.Valid || again.Bool {
				return fmt.Errorf("detach usage_%s: %w", key, derr)
			}
		}
		if _, derr := db.Exec("DROP TABLE IF EXISTS usage_" + key); derr != nil {
			return derr
		}
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
	// from/to 归一到北京日期值(允许调用方传瞬时):cutoff 比较与明细/账本
	// 分段都建立在同一套日口径上(2026-09-10 时区缺陷修复)。
	from, to = normalizeDayRange(from, to)
	retention, err := EffectiveRetentionMonths(db)
	if err != nil {
		return nil, err
	}
	if retention <= 0 {
		// 0 = 永久保留明细:明细即完整事实源(账本仅兜底),只查明细,
		// 避免与账本重复计数。
		return UsageAggregate(db, from, to, group, opts...)
	}
	// 保留边界 = 北京"今天"往前 N 个月的同一北京日(等价旧口径但不受进程 TZ
	// 影响:旧写法先对瞬时做 AddDate,UTC 容器下会差一天)。
	cutoffDay := BeijingDay(time.Now()).AddDate(0, -retention, 0)
	if !from.Before(cutoffDay) {
		// 窗口整体在保留期内:明细完整,无需账本
		return UsageAggregate(db, from, to, group, opts...)
	}
	// 账本段 = [from, min(cutoffDay-1, to)]:窗口整体早于保留边界时不得超过 to
	ledgerTo := cutoffDay.AddDate(0, 0, -1)
	if ledgerTo.After(to) {
		ledgerTo = to
	}
	ledger, err := UsageAggregateFromLedger(db, from, ledgerTo, group, opts...)
	if err != nil {
		return nil, err
	}
	if to.Before(cutoffDay) {
		// 明细段为空(窗口整体早于保留边界)
		return ledger, nil
	}
	detailRows, err := UsageAggregate(db, cutoffDay, to, group, opts...)
	if err != nil {
		return nil, err
	}
	return mergeUsageRows(ledger, detailRows), nil
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
		cur.PromptTokens += r.PromptTokens
		cur.CompletionTokens += r.CompletionTokens
		cur.Requests += r.Requests
		cur.EmbedRequests += r.EmbedRequests
		cur.EmbedTokens += r.EmbedTokens
		cur.CacheTokens += r.CacheTokens
		cur.Cost += r.Cost
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
