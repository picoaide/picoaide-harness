//! 并发采样域（Go `serverstore/concurrency.go` 等价）——模型 in-flight 高峰。

use crate::errors::{map_db_error, StoreError};
use chrono::{DateTime, Utc};
use sqlx::Row;

/// RecordConcurrencySample 记录模型当前 in-flight 数，更新当日峰值（GREATEST 永不回退）。
pub async fn record_concurrency_sample(
    pool: &sqlx::PgPool,
    model: &str,
    current: i64,
    at: DateTime<Utc>,
) -> Result<(), StoreError> {
    if model.is_empty() || current <= 0 {
        return Ok(());
    }
    let day = at.format("%Y-%m-%d").to_string();
    sqlx::query(
        "INSERT INTO model_concurrency_stats (model, day, max_concurrency, peak_at) VALUES ($1, $2::date, $3, $4) ON CONFLICT (model, day) DO UPDATE SET max_concurrency = GREATEST(model_concurrency_stats.max_concurrency, excluded.max_concurrency), peak_at = CASE WHEN excluded.max_concurrency > model_concurrency_stats.max_concurrency THEN excluded.peak_at ELSE model_concurrency_stats.peak_at END",
    )
    .bind(model)
    .bind(day.as_str())
    .bind(current)
    .bind(at)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(())
}

/// ModelConcurrencyPeak 某模型某日峰值并发。
#[derive(Debug, Clone, Default)]
pub struct ModelConcurrencyPeak {
    pub model: String,
    pub day: String,
    pub peak: i64,
    pub peak_at: DateTime<Utc>,
    pub avg_peak: f64,
    pub peak_90day: i64,
}

/// ModelConcurrencyPeaks 近 90 天各模型高峰并发（按模型聚合，按 90 天峰值降序）。
pub async fn model_concurrency_peaks(
    pool: &sqlx::PgPool,
    since: DateTime<Utc>,
) -> Result<Vec<ModelConcurrencyPeak>, StoreError> {
    let since_str = since.format("%Y-%m-%d").to_string();
    let rows = sqlx::query(
        "SELECT model, MAX(max_concurrency) AS peak_90day, SUM(max_concurrency)::float / GREATEST(COUNT(*), 1) AS avg_peak FROM model_concurrency_stats WHERE day >= $1::date GROUP BY model ORDER BY peak_90day DESC",
    )
    .bind(since_str)
    .fetch_all(pool)
    .await
    .map_err(map_db_error)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(ModelConcurrencyPeak {
            model: r.get("model"),
            peak_90day: r.get::<i32, _>("peak_90day") as i64,
            avg_peak: r.get("avg_peak"),
            ..Default::default()
        });
    }
    Ok(out)
}

/// PeakConcurrencyByModel 返回窗口内各模型峰值（map model → peak）。
pub async fn peak_concurrency_by_model(
    pool: &sqlx::PgPool,
    since: DateTime<Utc>,
) -> Result<std::collections::HashMap<String, i64>, StoreError> {
    let since_str = since.format("%Y-%m-%d").to_string();
    let rows = sqlx::query("SELECT model, MAX(max_concurrency) FROM model_concurrency_stats WHERE day >= $1::date GROUP BY model")
        .bind(since_str)
        .fetch_all(pool)
        .await
        .map_err(map_db_error)?;
    let mut out = std::collections::HashMap::new();
    for r in rows {
        out.insert(r.get("model"), r.get::<i32, _>("max") as i64);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;

    #[tokio::test]
    async fn concurrency_samples() {
        let pool = new_test_db().await;
        let now = Utc::now();
        record_concurrency_sample(&pool, "m1", 5, now).await.unwrap();
        // 更大值增长
        record_concurrency_sample(&pool, "m1", 8, now).await.unwrap();
        // 更小值不回落
        record_concurrency_sample(&pool, "m1", 3, now).await.unwrap();
        let peaks = model_concurrency_peaks(&pool, now - chrono::Duration::days(90)).await.unwrap();
        assert_eq!(peaks.len(), 1);
        assert_eq!(peaks[0].model, "m1");
        assert_eq!(peaks[0].peak_90day, 8);
        let m = peak_concurrency_by_model(&pool, now - chrono::Duration::days(90)).await.unwrap();
        assert_eq!(m.get("m1"), Some(&8));
    }
}
