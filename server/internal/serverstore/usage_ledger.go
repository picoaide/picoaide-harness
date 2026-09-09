package serverstore

import (
	"database/sql"
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
func ensureUsagePartition(db *sql.DB, month time.Time) error {
	key := monthKey(month)
	var existing sql.NullString
	if err := db.QueryRow(`SELECT to_regclass('usage_' || ?)::text`, key).Scan(&existing); err == nil && existing.Valid && existing.String != "" {
		return nil
	}
	start := dayKey(month)
	end := start.AddDate(0, 1, 0)
	stmt := fmt.Sprintf(`CREATE TABLE IF NOT EXISTS usage_%s PARTITION OF usage
		FOR VALUES FROM ('%s') TO ('%s')`, key, start.Format("2006-01-02"), end.Format("2006-01-02"))
	_, err := db.Exec(stmt)
	return err
}

func dayKey(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// ensureUsageDailyPartition 幂等创建某年的 usage_daily 分区(如 usage_daily_2026)。
func ensureUsageDailyPartition(db *sql.DB, year time.Time) error {
	key := yearKey(year)
	start := time.Date(year.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(1, 0, 0)
	stmt := fmt.Sprintf(`CREATE TABLE IF NOT EXISTS usage_daily_%s PARTITION OF usage_daily
		FOR VALUES FROM ('%s') TO ('%s')`, key, start.Format("2006-01-02"), end.Format("2006-01-02"))
	_, err := db.Exec(stmt)
	return err
}

// RebuildUsageLedger 从 usage 明细 UPSERT 日账/月账(幂等,可重复执行)。
// 明细是事实源,账本是降维缓存:崩溃/漏跑后可全窗口重算,永无洞。
// from/to 为闭区间日期;只处理窗口内 created_at 所属的"天",并按天聚合后
// 顺带更新所属月份。
func RebuildUsageLedger(db *sql.DB, from, to time.Time) error {
	if from.IsZero() || to.IsZero() || from.After(to) {
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
	if _, err := db.Exec(`
		INSERT INTO usage_daily (user_id, model, day, prompt_tokens, completion_tokens, cache_prompt_tokens, requests, cost)
		SELECT user_id, model, (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
		       SUM(prompt_tokens), SUM(completion_tokens), SUM(cache_prompt_tokens),
		       COUNT(*), SUM(cost)
		FROM usage
		WHERE created_at >= ?::timestamptz AND created_at < ?::timestamptz
		  AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= ?::date
		  AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= ?::date
		GROUP BY user_id, model, day
		ON CONFLICT (user_id, model, day) DO UPDATE SET
		  prompt_tokens = EXCLUDED.prompt_tokens,
		  completion_tokens = EXCLUDED.completion_tokens,
		  cache_prompt_tokens = EXCLUDED.cache_prompt_tokens,
		  requests = EXCLUDED.requests,
		  cost = EXCLUDED.cost`,
		from.Format("2006-01-02"), to.AddDate(0, 0, 1).Format("2006-01-02"),
		from.Format("2006-01-02"), to.Format("2006-01-02")); err != nil {
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
		from.Format("2006-01-02"), to.Format("2006-01-02")); err != nil {
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
// 保留 N 个月 = 删除 created_at 早于"当前月 - N 个月"的整分区。
func CleanupUsageRetention(db *sql.DB) error {
	n, err := EffectiveRetentionMonths(db)
	if err != nil {
		return err
	}
	if n == 0 {
		return nil // 永不删除
	}
	cutoff := time.Now().AddDate(0, -n, 0) // 该月及以后保留
	cutoffMonth := dayKey(cutoff)
	for m := cutoffMonth.AddDate(0, -1, 0); ; m = m.AddDate(0, -1, 0) {
		// 早于 cutoff 的分区(monthKey < cutoffKey)且其日账已存在才 DROP;
		// 若日账缺失则重建(幂等)后再删,避免删明细前丢账。
		key := monthKey(m)
		if key >= monthKey(cutoffMonth) {
			continue
		}
		// 确认该月分区存在
		var one int
		if err := db.QueryRow("SELECT COUNT(*) FROM pg_tables WHERE tablename = 'usage_' || $1", key).Scan(&one); err != nil || one == 0 {
			break // 更早月份无分区(DROP 已到边界)
		}
		// 重建该月日账/月账(幂等,防止明细删除后账本丢)
		monthStartT := m
		if err := RebuildUsageLedger(db, monthStartT, monthStartT.AddDate(0, 1, -1)); err != nil {
			return err
		}
		// DROP 分区(先 DETACH 解除主表绑定,再 DROP 整表秒删)
		if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION usage_" + key); err != nil {
			// 若该分区已被删过(幂等),忽略
			continue
		}
		if _, err := db.Exec("DROP TABLE IF EXISTS usage_" + key); err != nil {
			return err
		}
	}
	return nil
}

// beijingDay 返回 t 的北京时间当日 00:00(UTC+8 固定偏移,不依赖 tzdata;
// 返回值的日期分量即北京日期,与 SQL 侧的 Asia/Shanghai 日界口径一致)。
func beijingDay(t time.Time) time.Time {
	bj := t.UTC().Add(8 * time.Hour)
	return time.Date(bj.Year(), bj.Month(), bj.Day(), 0, 0, 0, 0, time.UTC)
}

// UsageAggregateWithLedger 在保留窗口内查询 usage 明细(分区裁剪),
// 窗口外(早于保留期)回退到永久账本 usage_daily——
// 保证"明细已删"的历史聚合仍可查(10 年数据不丢)。
// group: day|week|month|model|user|dept;opts 支持 WithUsername/WithDept。
// group=dept 是展示层归并:以 group=user 聚合行为基础,按部门树(归属+祖先链,
// 与预算 enforcement 同口径)在内存归并(树小,避免 N 个部门 N 条 SQL)。
//
// 跨保留边界(P1-10):账本负责 [from, cutoffDay) 的整日,明细负责
// [cutoffDay, to],两段按天严格不相交 → 按维度**相加**(而非旧实现的
// 按 label 覆盖,后者会丢掉早于 cutoff 的历史:实测 330 → 220)。
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
	retention, err := EffectiveRetentionMonths(db)
	if err != nil {
		return nil, err
	}
	if retention <= 0 {
		// 0 = 永久保留明细:明细即完整事实源(账本仅兜底),只查明细,
		// 避免与账本重复计数。
		return UsageAggregate(db, from, to, group, opts...)
	}
	cutoffDay := beijingDay(time.Now().AddDate(0, -retention, 0))
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

// UsageAggregateFromLedger 从永久日账 usage_daily 聚合(from/to 为闭区间日期,
// from 为零 = 无下界)。全部维度都由日账归并——P1-16:此前默认分支把 group=model
// 打成 month(所有模型合并成"每月一行")、group=week 退化成逐日,与明细口径不符。
func UsageAggregateFromLedger(db *sql.DB, from, to time.Time, group string, opts ...UsageAggregateOption) ([]UsageAggregateRow, error) {
	var q UsageAggregateQuery
	for _, o := range opts {
		o(&q)
	}
	usernameFilter := ""
	args := []any{}
	if q.Username != "" {
		usernameFilter = " AND ue.user_id = (SELECT id FROM users WHERE username = ?)"
		args = append(args, q.Username)
	}
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
		qstr += " AND ue.day >= ?::date"
		args = append(args, from.Format("2006-01-02"))
	}
	if !to.IsZero() {
		qstr += " AND ue.day <= ?::date"
		args = append(args, to.Format("2006-01-02"))
	}
	if q.Dept != "" {
		qstr += deptFilter
		args = append(args, pgInt64Array(deptGroupIDs))
	}
	qstr += usernameFilter + " GROUP BY " + groupExpr + " ORDER BY label"
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
