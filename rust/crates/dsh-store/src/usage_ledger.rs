//! 用量账本域（Go `serverstore/usage_ledger.go` 等价）——0039 日账/月账降维缓存。

use crate::errors::map_db_error;
use crate::errors::StoreError;
use sqlx::Row;

pub const RETENTION_MONTHS_SETTING: &str = "usage.retention_months";
pub const DEFAULT_RETENTION_MONTHS: i32 = 6;
pub const MAX_RETENTION_MONTHS: i32 = 120;

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
