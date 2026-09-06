//! API 令牌域（Go `serverstore/tokens.go` 等价）。

use crate::errors::{map_db_error, StoreError};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use sqlx::Row;

/// TokenHash 返回原始 token 的 SHA-256 十六进制摘要。
pub fn token_hash(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    hex::encode(hasher.finalize())
}

/// Token API 令牌行。
#[derive(Debug, Clone, Default)]
pub struct Token {
    pub id: i64,
    pub user_id: i64,
    pub token_hash: String,
    pub name: String,
    pub created_at: String,
    pub expires_at: DateTime<Utc>,
    pub last_used_at: DateTime<Utc>,
    pub revoked: i32,
}

/// CreateToken 存储哈希令牌（expiresAt UTC）并返回 id。
pub async fn create_token(
    pool: &sqlx::PgPool,
    user_id: i64,
    raw: &str,
    expires_at: DateTime<Utc>,
) -> Result<i64, StoreError> {
    let row = sqlx::query("INSERT INTO api_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id")
        .bind(user_id as i32)
        .bind(token_hash(raw))
        .bind(expires_at)
        .fetch_one(pool)
        .await
        .map_err(map_db_error)?;
    Ok(row.get("id"))
}

/// GetTokenByHash 按哈希值返回 token 行。
pub async fn get_token_by_hash(pool: &sqlx::PgPool, hash: &str) -> Result<Token, StoreError> {
    let row = sqlx::query(
        "SELECT id, user_id, token_hash, name, created_at, expires_at, last_used_at, revoked FROM api_tokens WHERE token_hash = $1",
    )
    .bind(hash)
    .fetch_optional(pool)
    .await
    .map_err(map_db_error)?
    .ok_or(StoreError::NotFound)?;
    Ok(scan_token(row))
}

fn scan_token(row: sqlx::postgres::PgRow) -> Token {
    Token {
        id: row.get("id"),
        user_id: row.get::<i32, _>("user_id") as i64,
        token_hash: row.get("token_hash"),
        name: row.get::<Option<String>, _>("name").unwrap_or_default(),
        created_at: format_time_string(row.get::<DateTime<Utc>, _>("created_at")),
        expires_at: row.get::<Option<DateTime<Utc>>, _>("expires_at").unwrap_or_else(|| DateTime::<Utc>::from_timestamp(0,0).unwrap()),
        last_used_at: row.get::<Option<DateTime<Utc>>, _>("last_used_at").unwrap_or_else(|| DateTime::<Utc>::from_timestamp(0,0).unwrap()),
        revoked: row.get::<i32, _>("revoked"),
    }
}

fn format_time_string(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// RevokeToken 按哈希吊销令牌。
pub async fn revoke_token(pool: &sqlx::PgPool, hash: &str) -> Result<(), StoreError> {
    let res = sqlx::query("UPDATE api_tokens SET revoked = 1 WHERE token_hash = $1")
        .bind(hash)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// RevokeTokenByID 按 id 吊销令牌（幂等：已吊销的再次吊销成功）。
pub async fn revoke_token_by_id(pool: &sqlx::PgPool, token_id: i64) -> Result<(), StoreError> {
    let res = sqlx::query("UPDATE api_tokens SET revoked = 1 WHERE id = $1")
        .bind(token_id)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// token_touch_interval 节流 last_used_at 重写（审计 5#3）。
const TOKEN_TOUCH_INTERVAL_SECS: i64 = 60;

/// TouchTokenLastUsed 记录最后成功验证时间，每 token 每 interval 至多一次。
pub async fn touch_token_last_used(pool: &sqlx::PgPool, token_id: i64) -> Result<(), StoreError> {
    let last_used: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT last_used_at FROM api_tokens WHERE id = $1")
            .bind(token_id)
            .fetch_optional(pool)
            .await
            .map_err(map_db_error)?;
    let Some(last_used) = last_used else {
        return Err(StoreError::NotFound);
    };
    if (Utc::now() - last_used).num_seconds() < TOKEN_TOUCH_INTERVAL_SECS {
        return Ok(()); // throttled
    }
    sqlx::query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1")
        .bind(token_id)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    Ok(())
}

/// ListTokensByUser 非敏感视图（永不暴露哈希）。
pub async fn list_tokens_by_user(pool: &sqlx::PgPool, user_id: i64) -> Result<Vec<Token>, StoreError> {
    let rows = sqlx::query(
        "SELECT id, user_id, token_hash, name, created_at, expires_at, last_used_at, revoked FROM api_tokens WHERE user_id = $1 ORDER BY id DESC",
    )
    .bind(user_id as i32)
    .fetch_all(pool)
    .await
    .map_err(map_db_error)?;
    let mut out: Vec<Token> = rows.into_iter().map(scan_token).collect();
    for t in &mut out {
        t.token_hash = String::new();
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;

    #[tokio::test]
    async fn tokens_crud() {
        let pool = new_test_db().await;
        let uid = crate::users::create_user(
            &pool,
            &crate::users::User {
                username: "tokuser".into(),
                source: "local".into(),
                status: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let id = create_token(&pool, uid, "raw-token-abc", Utc::now() + chrono::Duration::days(30))
            .await
            .unwrap();
        assert!(id > 0);
        let t = get_token_by_hash(&pool, &token_hash("raw-token-abc")).await.unwrap();
        assert_eq!(t.id, id);
        assert_eq!(t.user_id, uid);
        // 吊销
        revoke_token(&pool, &token_hash("raw-token-abc")).await.unwrap();
        let t = get_token_by_hash(&pool, &token_hash("raw-token-abc")).await.unwrap();
        assert_eq!(t.revoked, 1);
        // 列表不暴露哈希
        let list = list_tokens_by_user(&pool, uid).await.unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].token_hash.is_empty());
        // 吊销不存在 → NotFound
        assert_eq!(
            revoke_token(&pool, &token_hash("no-such")).await.unwrap_err(),
            StoreError::NotFound
        );
    }
}
