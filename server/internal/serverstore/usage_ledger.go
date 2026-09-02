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
func ensureUsagePartition(db *sql.DB, month time.Time) error {
	key := monthKey(month)
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

// UsageAggregateWithLedger 在保留窗口内查询 usage 明细(分区裁剪),
// 窗口外(早于保留期)回退到永久账本 usage_daily/usage_monthly——
// 保证"明细已删"的历史聚合仍可查(10 年数据不丢)。
// group: day|week|month|model|user|dept;opts 支持 WithUsername/WithDept。
// group=dept 是展示层归并:以 group=user 聚合行为基础,按部门树(归属+祖先链,
// 与预算 enforcement 同口径)在内存归并(树小,避免 N 个部门 N 条 SQL)。
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
	var cutoff time.Time
	if retention > 0 {
		cutoff = time.Now().AddDate(0, -retention, 0)
	}
	if retention == 0 || from.Before(cutoff) {
		// 窗口外:先查账本覆盖全部;再查明细覆盖窗口内并合并(避免重复)。
		rows, err := UsageAggregateFromLedger(db, from, to, group, opts...)
		if err != nil {
			return nil, err
		}
		detailFrom := from
		if !cutoff.IsZero() && detailFrom.Before(cutoff) {
			detailFrom = cutoff
		}
		if detailFrom.After(to) {
			return rows, nil
		}
		detailRows, err := UsageAggregate(db, detailFrom, to, group, opts...)
		if err != nil {
			return nil, err
		}
		return mergeUsageRows(rows, detailRows), nil
	}
	return UsageAggregate(db, from, to, group, opts...)
}

// UsageAggregateFromLedger 从 usage_daily/usage_monthly 聚合。
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
	// 部门过滤:子树成员集合,与预算 enforcement 同口径(2026-09 用量中心)
	var deptFilter string
	if q.Dept != "" {
		ids, err := DeptUserIDsByName(db, q.Dept)
		if err != nil {
			if err == ErrNotFound {
				return []UsageAggregateRow{}, nil // 部门不存在 = 空结果
			}
			return nil, err
		}
		if len(ids) == 0 {
			return []UsageAggregateRow{}, nil
		}
		ph := strings.Repeat("?,", len(ids))
		ph = ph[:len(ph)-1]
		deptFilter = " AND ue.user_id IN (" + ph + ")"
		for _, id := range ids {
			args = append(args, id)
		}
	}
	var table, col string
	switch group {
	case "day", "week":
		table, col = "usage_daily", "day"
	case "user":
		table, col = "usage_daily", "day"
	default: // month / model
		table, col = "usage_monthly", "month"
	}
	qstr := `SELECT `
	switch group {
	case "month":
		qstr += `to_char(` + col + `, 'YYYY-MM') AS label,`
	case "model":
		qstr += col + ` AS label,`
	case "user":
		qstr += `COALESCE(u.username, CAST(ue.user_id AS TEXT)) AS label,`
	default:
		qstr += `to_char(` + col + `, 'YYYY-MM-DD') AS label,`
	}
	qstr += ` SUM(ue.prompt_tokens) AS pt, SUM(ue.completion_tokens) AS ct, SUM(ue.requests) AS req,
		SUM(ue.cost) AS cost
		FROM ` + table + ` ue`
	if group == "user" {
		qstr += " LEFT JOIN users u ON u.id = ue.user_id"
	}
	qstr += " WHERE 1=1"
	if !from.IsZero() {
		qstr += " AND " + col + " >= ?::date"
		args = append(args, from.Format("2006-01-02"))
	}
	if !to.IsZero() {
		qstr += " AND " + col + " <= ?::date"
		args = append(args, to.Format("2006-01-02"))
	}
	qstr += usernameFilter
	qstr += deptFilter
	switch group {
	case "model":
		qstr += ` GROUP BY ` + col
	case "user":
		qstr += ` GROUP BY u.username, ue.user_id`
	case "month", "day", "week":
		qstr += ` GROUP BY 1`
	}
	qstr += " ORDER BY 1"
	rows, err := db.Query(qstr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UsageAggregateRow{}
	for rows.Next() {
		var r UsageAggregateRow
		if err := rows.Scan(&r.Label, &r.PromptTokens, &r.CompletionTokens, &r.Requests, &r.Cost); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// mergeUsageRows 按 label 合并两批聚合行(账本 + 明细,后者优先生效)。
func mergeUsageRows(a, b []UsageAggregateRow) []UsageAggregateRow {
	byLabel := map[string]UsageAggregateRow{}
	for _, r := range a {
		byLabel[r.Label] = r
	}
	for _, r := range b {
		byLabel[r.Label] = r
	}
	out := make([]UsageAggregateRow, 0, len(byLabel))
	for _, r := range byLabel {
		out = append(out, r)
	}
	return out
}
