package serverstore

import (
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// RetentionMonthsSetting 明细保留月数(settings 键):
//   缺省/非法 = 6 个月;>0 = 保留 N 个月;0 = 永不删除;最大值 120。
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
	if _, err := db.Exec(`
		INSERT INTO usage_monthly (user_id, model, month, prompt_tokens, completion_tokens, cache_prompt_tokens, requests, cost)
		SELECT user_id, model, date_trunc('month', day)::date AS month,
		       SUM(prompt_tokens), SUM(completion_tokens), SUM(cache_prompt_tokens),
		       SUM(requests), SUM(cost)
		FROM usage_daily
		WHERE day >= ?::date AND day <= ?::date
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
	n, err := parseRetention(v)
	if err != nil {
		return DefaultRetentionMonths, nil
	}
	return n, nil
}

func parseRetention(v string) (int, error) {
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
