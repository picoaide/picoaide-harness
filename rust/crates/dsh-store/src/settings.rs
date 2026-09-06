//! 设置域（Go `serverstore/settings.go` 等价）。

use crate::errors::{map_db_error, StoreError};
use sqlx::Row;

pub const AUTH_MIN_PASSWORD_LENGTH_SETTING: &str = "auth.min_password_length";
pub const DEFAULT_MIN_PASSWORD_LENGTH: i32 = 10;
pub const MIN_PASSWORD_LENGTH_LOWER: i32 = 8;
pub const MIN_PASSWORD_LENGTH_UPPER: i32 = 64;

pub const AUDIT_RETENTION_SETTING: &str = "audit.retention_days";
pub const DEFAULT_AUDIT_RETENTION_DAYS: i32 = 180;

/// AuthMinPasswordLength 读取密码最小长度：缺失/非法回落默认 10。
pub async fn auth_min_password_length(pool: &sqlx::PgPool) -> i32 {
    match get_setting(pool, AUTH_MIN_PASSWORD_LENGTH_SETTING).await {
        Ok((v, true)) if !v.is_empty() => {
            match v.parse::<i32>() {
                Ok(n) if (MIN_PASSWORD_LENGTH_LOWER..=MIN_PASSWORD_LENGTH_UPPER).contains(&n) => n,
                _ => DEFAULT_MIN_PASSWORD_LENGTH,
            }
        }
        _ => DEFAULT_MIN_PASSWORD_LENGTH,
    }
}

/// AuditRetentionDays 读取审计保留天数：缺失/非法回落默认 180。
pub async fn audit_retention_days(pool: &sqlx::PgPool) -> i32 {
    match get_setting(pool, AUDIT_RETENTION_SETTING).await {
        Ok((v, true)) if !v.is_empty() => {
            match v.parse::<i32>() {
                Ok(n) if n >= 1 => n,
                _ => DEFAULT_AUDIT_RETENTION_DAYS,
            }
        }
        _ => DEFAULT_AUDIT_RETENTION_DAYS,
    }
}

/// SetSetting upsert 设置键/值。
pub async fn set_setting(pool: &sqlx::PgPool, key: &str, value: &str) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(())
}

/// GetSetting 返回值及其是否存在。
pub async fn get_setting(pool: &sqlx::PgPool, key: &str) -> Result<(String, bool), StoreError> {
    let v: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(map_db_error)?;
    match v {
        Some(v) => Ok((v, true)),
        None => Ok((String::new(), false)),
    }
}

/// GetAllSettings 返回扁平键值 map。
pub async fn get_all_settings(pool: &sqlx::PgPool) -> Result<std::collections::HashMap<String, String>, StoreError> {
    let rows = sqlx::query("SELECT key, value FROM settings")
        .fetch_all(pool)
        .await
        .map_err(map_db_error)?;
    let mut out = std::collections::HashMap::new();
    for r in rows {
        out.insert(r.get::<String, _>("key"), r.get::<String, _>("value"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;

    #[tokio::test]
    async fn settings_roundtrip() {
        let pool = new_test_db().await;
        // 默认值
        assert_eq!(auth_min_password_length(&pool).await, 10);
        assert_eq!(audit_retention_days(&pool).await, 180);
        // 设置后读取
        set_setting(&pool, AUTH_MIN_PASSWORD_LENGTH_SETTING, "12").await.unwrap();
        assert_eq!(auth_min_password_length(&pool).await, 12);
        // 非法值回落默认
        set_setting(&pool, AUTH_MIN_PASSWORD_LENGTH_SETTING, "999").await.unwrap();
        assert_eq!(auth_min_password_length(&pool).await, 10);
        // 全量
        set_setting(&pool, "key1", "v1").await.unwrap();
        let all = get_all_settings(&pool).await.unwrap();
        assert_eq!(all.get("key1").map(|s| s.as_str()), Some("v1"));
    }
}
