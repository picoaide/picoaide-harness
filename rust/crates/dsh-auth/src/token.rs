//! 令牌签发/验证（Go `serverauth/token.go` 等价）。

use picoaide_dsh_store::users::get_user_by_id;
use picoaide_dsh_store::{StoreError, tokens};
use rand::RngCore;

/// TokenTTL 默认令牌寿命（90 天，秒）。
pub const TOKEN_TTL_SECS: i64 = 90 * 24 * 3600;

/// IssueToken 生成随机 32 字节令牌，存 SHA-256 哈希，返回原始令牌。
pub async fn issue_token(pool: &sqlx::PgPool, user_id: i64) -> Result<String, anyhow::Error> {
    let mut buf = vec![0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    let raw = base64_url_no_pad(&buf);
    let expires = chrono::Utc::now() + chrono::Duration::seconds(TOKEN_TTL_SECS);
    tokens::create_token(pool, user_id, &raw, expires)
        .await
        .map_err(|e| anyhow::anyhow!("create token: {e}"))?;
    Ok(raw)
}

/// VerifyToken 验证原始令牌并返回关联用户（存在/未吊销/未过期/用户启用）。
pub async fn verify_token(
    pool: &sqlx::PgPool,
    raw: &str,
) -> Result<picoaide_dsh_store::users::User, anyhow::Error> {
    if raw.is_empty() {
        anyhow::bail!("empty token");
    }
    let tok = tokens::get_token_by_hash(pool, &tokens::token_hash(raw))
        .await
        .map_err(|e| match e {
            StoreError::NotFound => anyhow::anyhow!("token not found"),
            other => anyhow::anyhow!("{other}"),
        })?;
    if tok.revoked != 0 {
        anyhow::bail!("token revoked");
    }
    if chrono::Utc::now() > tok.expires_at {
        anyhow::bail!("token expired");
    }
    let u = get_user_by_id(pool, tok.user_id)
        .await
        .map_err(|e| match e {
            StoreError::NotFound => anyhow::anyhow!("user not found"),
            other => anyhow::anyhow!("{other}"),
        })?;
    if u.status != 1 {
        anyhow::bail!("user disabled");
    }
    let _ = tokens::touch_token_last_used(pool, tok.id).await;
    Ok(u)
}

/// RevokeToken 吊销哈希与 raw 匹配的令牌。
pub async fn revoke_token(pool: &sqlx::PgPool, raw: &str) -> Result<(), StoreError> {
    tokens::revoke_token(pool, &tokens::token_hash(raw)).await
}

/// base64_url_no_pad 无填充的 URL-safe base64（与 Go RawURLEncoding 一致）。
fn base64_url_no_pad(buf: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use picoaide_dsh_store::testutil::new_test_db;

    #[tokio::test]
    async fn token_lifecycle() {
        let pool = new_test_db().await;
        let uid = picoaide_dsh_store::users::create_user(
            &pool,
            &picoaide_dsh_store::users::User {
                username: "tok".into(),
                source: "local".into(),
                status: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let raw = issue_token(&pool, uid).await.unwrap();
        assert!(!raw.is_empty());
        // 验证
        let u = verify_token(&pool, &raw).await.unwrap();
        assert_eq!(u.username, "tok");
        // 吊销后失败
        revoke_token(&pool, &raw).await.unwrap();
        assert!(verify_token(&pool, &raw).await.is_err());
    }
}
