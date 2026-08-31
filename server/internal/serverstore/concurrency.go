package serverstore

import (
	"database/sql"
	"time"
)

// concurrencySampleInterval 是采样间隔(生产 15s;测试注入更短)。
var concurrencySampleInterval = 15 * time.Second

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

// ModelConcurrencyPeak 是某模型在某日的峰值并发。
type ModelConcurrencyPeak struct {
	Model     string    `json:"model"`
	Day       string    `json:"day"` // YYYY-MM-DD(UTC)
	Peak      int64     `json:"peak"`
	PeakAt    time.Time `json:"peak_at"`
	AvgPeak   float64   `json:"avg_peak"`   // 该模型 90 天平均峰值
	Peak90Day int64     `json:"peak_90day"` // 该模型 90 天历史峰值
}

// ModelConcurrencyPeaks 返回近 90 天各模型高峰并发(按模型聚合:
// 天内峰值 + 90 天峰值 + 90 天平均峰值),结果按 90 天峰值降序。
// 供服务器信息页展示([当前峰值/目标] 对照)。
func ModelConcurrencyPeaks(db *sql.DB, since time.Time) ([]ModelConcurrencyPeak, error) {
	sinceStr := since.UTC().Format("2006-01-02")
	rows, err := db.Query(`
SELECT
  model,
  MAX(max_concurrency) AS peak_90day,
  SUM(max_concurrency)::float / GREATEST(COUNT(*), 1) AS avg_peak
FROM model_concurrency_stats
WHERE day >= ?
GROUP BY model
ORDER BY peak_90day DESC`, sinceStr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// 二次查询:最近峰值日(诊断用)。
	var out []ModelConcurrencyPeak
	for rows.Next() {
		var p ModelConcurrencyPeak
		if err := rows.Scan(&p.Model, &p.Peak90Day, &p.AvgPeak); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
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
