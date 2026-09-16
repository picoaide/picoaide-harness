package serverstore

import (
	"database/sql"
	"time"
)

// RecordConcurrencySample 记录某模型当前 in-flight 数的采样,更新当日
// 峰值(GREATEST 永不回退;peak_at 取首个触发峰值的时刻)。
// 幂等:同一模型+天重复调用安全。
func RecordConcurrencySample(db *sql.DB, model string, current int64, at time.Time) error {
	if model == "" || current <= 0 {
		return nil
	}
	day := at.UTC().Format("2006-01-02")
	_, err := db.Exec(`
INSERT INTO model_concurrency_stats (model, day, max_concurrency, peak_at)
VALUES (?, ?, ?, ?)
ON CONFLICT (model, day) DO UPDATE SET
  max_concurrency = GREATEST(model_concurrency_stats.max_concurrency, excluded.max_concurrency),
  peak_at = CASE
    WHEN excluded.max_concurrency > model_concurrency_stats.max_concurrency THEN excluded.peak_at
    ELSE model_concurrency_stats.peak_at
  END`,
		model, day, current, at.UTC())
	return err
}

// PeakConcurrencyByModel returns the max in-flight over the window per model
// (map model → peak), used by the server-info page.
func PeakConcurrencyByModel(db *sql.DB, since time.Time) (map[string]int64, error) {
	sinceStr := since.UTC().Format("2006-01-02")
	rows, err := db.Query(`SELECT model, MAX(max_concurrency) FROM model_concurrency_stats WHERE day >= ? GROUP BY model`, sinceStr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var model string
		var peak int64
		if err := rows.Scan(&model, &peak); err != nil {
			return nil, err
		}
		out[model] = peak
	}
	return out, rows.Err()
}
