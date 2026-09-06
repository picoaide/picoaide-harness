//! 用量账本域（Go `serverstore/usage_ledger.go` 等价）——0039 日账/月账降维缓存。

use crate::errors::map_db_error;
use crate::errors::StoreError;
use chrono::Datelike;
use sqlx::Row;

pub const RETENTION_MONTHS_SETTING: &str = "usage.retention_months";
pub const DEFAULT_RETENTION_MONTHS: i32 = 6;
pub const MAX_RETENTION_MONTHS: i32 = 120;

/// RebuildUsageLedger 从 usage 明细 UPSERT 日账/月账（幂等，可重复执行）。
/// from/to 为闭区间日期。
pub async fn rebuild_usage_ledger(
    pool: &sqlx::PgPool,
    from: chrono::NaiveDate,
    to: chrono::NaiveDate,
) -> anyhow::Result<()> {
    if from > to {
        return Ok(());
    }
    // 建好涉及月份/年份的分区
    let mut m = from;
    while m <= to {
        let key = m.format("%Y%m").to_string();
        let start = m.format("%Y-%m-%d").to_string();
        let (ny, nm) = if m.month() == 12 { (m.year() + 1, 1) } else { (m.year(), m.month() + 1) };
        let end = format!("{ny}-{nm:02}-01");
        let sql = format!("CREATE TABLE IF NOT EXISTS usage_{key} PARTITION OF usage FOR VALUES FROM ('{start}') TO ('{end}')");
        sqlx::query(&sql).execute(pool).await?;
        let ykey = m.year().to_string();
        let dsql = format!(
            "CREATE TABLE IF NOT EXISTS usage_daily_{ykey} PARTITION OF usage_daily FOR VALUES FROM ('{ykey}-01-01') TO ('{}-01-01')",
            m.year() + 1
        );
        sqlx::query(&dsql).execute(pool).await?;
        m = if m.month() == 12 {
            chrono::NaiveDate::from_ymd_opt(m.year() + 1, 1, 1).unwrap()
        } else {
            chrono::NaiveDate::from_ymd_opt(m.year(), m.month() + 1, 1).unwrap()
        };
    }
    let from_str = from.format("%Y-%m-%d").to_string();
    let to_plus1_str = to.succ_opt().unwrap().format("%Y-%m-%d").to_string();
    let to_str = to.format("%Y-%m-%d").to_string();
    // 日账
    sqlx::query(
        "INSERT INTO usage_daily (user_id, model, day, prompt_tokens, completion_tokens, cache_prompt_tokens, requests, cost) \
         SELECT user_id, model, (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day, \
         SUM(prompt_tokens), SUM(completion_tokens), SUM(cache_prompt_tokens), COUNT(*), SUM(cost) \
         FROM usage \
         WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz \
         AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= $3::date \
         AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= $4::date \
         GROUP BY user_id, model, day \
         ON CONFLICT (user_id, model, day) DO UPDATE SET \
         prompt_tokens = EXCLUDED.prompt_tokens, completion_tokens = EXCLUDED.completion_tokens, \
         cache_prompt_tokens = EXCLUDED.cache_prompt_tokens, requests = EXCLUDED.requests, cost = EXCLUDED.cost",
    )
    .bind(&from_str)
    .bind(&to_plus1_str)
    .bind(&from_str)
    .bind(&to_str)
    .execute(pool)
    .await?;
    // 月账（边界月取整月）
    sqlx::query(
        "INSERT INTO usage_monthly (user_id, model, month, prompt_tokens, completion_tokens, cache_prompt_tokens, requests, cost) \
         SELECT user_id, model, date_trunc('month', day)::date AS month, \
         SUM(prompt_tokens), SUM(completion_tokens), SUM(cache_prompt_tokens), SUM(requests), SUM(cost) \
         FROM usage_daily \
         WHERE day >= (date_trunc('month', $1::date))::date \
         AND day < (date_trunc('month', $2::date) + interval '1 month')::date \
         GROUP BY user_id, model, month \
         ON CONFLICT (user_id, model, month) DO UPDATE SET \
         prompt_tokens = EXCLUDED.prompt_tokens, completion_tokens = EXCLUDED.completion_tokens, \
         cache_prompt_tokens = EXCLUDED.cache_prompt_tokens, requests = EXCLUDED.requests, cost = EXCLUDED.cost",
    )
    .bind(&from_str)
    .bind(&to_str)
    .execute(pool)
    .await?;
    Ok(())
}

/// EffectiveRetentionMonths 返回明细保留月数（settings；缺省/非法=6；0=永久）。
pub async fn effective_retention_months(pool: &sqlx::PgPool) -> Result<i32, StoreError> {
    let (v, ok) = crate::settings::get_setting(pool, RETENTION_MONTHS_SETTING).await?;
    if !ok || v.trim().is_empty() {
        return Ok(DEFAULT_RETENTION_MONTHS);
    }
    match v.trim().parse::<i32>() {
        Ok(n) if n >= 0 && n <= MAX_RETENTION_MONTHS => Ok(n),
        _ => Ok(DEFAULT_RETENTION_MONTHS),
    }
}

/// usage_monthly 清理：按保留月数 DROP 明细分区（用于 CleanupUsageRetention 的辅助）。
pub async fn drop_usage_monthly(pool: &sqlx::PgPool, month_key: &str) -> anyhow::Result<()> {
    let sql = format!("DROP TABLE IF EXISTS usage_{month_key}");
    sqlx::query(&sql).execute(pool).await?;
    Ok(())
}

/// CleanupUsageRetention 按保留月数清理过期 usage 明细分区（返回清理的分区数）。
pub async fn cleanup_usage_retention(pool: &sqlx::PgPool) -> Result<i32, StoreError> {
    let months = effective_retention_months(pool).await?;
    if months == 0 {
        return Ok(0); // 永久保留
    }
    let now = chrono::Utc::now();
    let cutoff = now - chrono::Months::new(months as u32);
    // 列出所有 usage_YYYYMM 分区
    let rows = sqlx::query(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname LIKE 'usage_2%' AND c.relkind = 'r'",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_error)?;
    let mut dropped = 0;
    for r in rows {
        let name: String = r.get("relname");
        let key = name.trim_start_matches("usage_");
        if key.len() == 6 {
            if let Ok(y) = key[..4].parse::<i32>() {
                if let Ok(m) = key[4..].parse::<i32>() {
                    let month_start = chrono::DateTime::from_timestamp(
                        chrono::NaiveDate::from_ymd_opt(y, m as u32, 1)
                            .unwrap()
                            .and_hms_opt(0, 0, 0)
                            .unwrap()
                            .and_utc()
                            .timestamp(),
                        0,
                    )
                    .unwrap();
                    if month_start < cutoff {
                        let _ = drop_usage_monthly(pool, key).await;
                        dropped += 1;
                    }
                }
            }
        }
    }
    Ok(dropped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;

    #[tokio::test]
    async fn retention_months() {
        let pool = new_test_db().await;
        // 默认
        assert_eq!(effective_retention_months(&pool).await.unwrap(), 6);
        // 设置
        crate::settings::set_setting(&pool, RETENTION_MONTHS_SETTING, "12").await.unwrap();
        assert_eq!(effective_retention_months(&pool).await.unwrap(), 12);
        // 非法回落
        crate::settings::set_setting(&pool, RETENTION_MONTHS_SETTING, "999").await.unwrap();
        assert_eq!(effective_retention_months(&pool).await.unwrap(), 6);
        // 0 = 永久
        crate::settings::set_setting(&pool, RETENTION_MONTHS_SETTING, "0").await.unwrap();
        assert_eq!(effective_retention_months(&pool).await.unwrap(), 0);
    }
}
