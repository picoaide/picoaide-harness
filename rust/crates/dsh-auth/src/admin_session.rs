//! 管理会话 + CSRF（Go `serverauth/admin_session.go` 等价）。

use hmac::{Hmac, Mac};
use picoaide_dsh_store::{StoreError, users::get_user_by_id};
use rand::RngCore;
use sha2::Sha256;

/// AdminSessionTTL 管理会话硬寿命（12h，秒）。
pub const ADMIN_SESSION_TTL_SECS: i64 = 12 * 3600;
/// AdminIdleTimeout 滑动空闲超时（60min，秒）。
pub const ADMIN_IDLE_TIMEOUT_SECS: i64 = 60 * 60;
/// CSRF 窗口 1h；前一窗口的 token 仍有效。
const CSRF_WINDOW_SECS: i64 = 3600;

/// AdminSession 管理会话行。
#[derive(Debug, Clone, Default)]
pub struct AdminSession {
    pub id: String,
    pub user_id: i64,
    pub csrf_key: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    pub last_used_at: chrono::DateTime<chrono::Utc>,
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// CreateAdminSession 存储会话并返回 id + CSRF token。
pub async fn create_admin_session(
    pool: &sqlx::PgPool,
    user_id: i64,
) -> Result<(AdminSession, String), anyhow::Error> {
    let id = random_hex(24);
    let csrf_key = random_hex(24);
    let now = chrono::Utc::now();
    let s = AdminSession {
        id: id.clone(),
        user_id,
        csrf_key: csrf_key.clone(),
        expires_at: now + chrono::Duration::seconds(ADMIN_SESSION_TTL_SECS),
        last_used_at: now,
    };
    // C-15: 每次登录清扫过期会话
    sqlx::query("DELETE FROM admin_sessions WHERE expires_at < now()")
        .execute(pool)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    sqlx::query(
        "INSERT INTO admin_sessions (id, user_id, csrf_key, expires_at, last_used_at) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&s.id)
    .bind(user_id as i32)
    .bind(&s.csrf_key)
    .bind(s.expires_at)
    .bind(s.last_used_at)
    .execute(pool)
    .await
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    let csrf = issue_csrf(&csrf_key, now);
    Ok((s, csrf))
}

/// GetAdminSession 加载会话行。
pub async fn get_admin_session(
    pool: &sqlx::PgPool,
    id: &str,
) -> Result<AdminSession, StoreError> {
    use sqlx::Row;
    let row = sqlx::query(
        "SELECT id, user_id, csrf_key, expires_at, last_used_at FROM admin_sessions WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| match e {
        _ => StoreError::NotFound,
    })?;
    match row {
        Some(r) => Ok(AdminSession {
            id: r.get("id"),
            user_id: r.get::<i32, _>("user_id") as i64,
            csrf_key: r.get("csrf_key"),
            expires_at: r.get("expires_at"),
            last_used_at: r.get("last_used_at"),
        }),
        None => Err(StoreError::NotFound),
    }
}

/// DeleteAdminSession 删除会话。
pub async fn delete_admin_session(pool: &sqlx::PgPool, id: &str) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM admin_sessions WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|_| StoreError::NotFound)?;
    Ok(())
}

/// ValidateAdminSession 校验过期（硬 TTL + 空闲超时）与用户管理权限。
pub async fn validate_admin_session(
    pool: &sqlx::PgPool,
    id: &str,
) -> Result<picoaide_dsh_store::users::User, anyhow::Error> {
    let s = get_admin_session(pool, id).await.map_err(|_| anyhow::anyhow!("session not found"))?;
    if chrono::Utc::now() > s.expires_at {
        anyhow::bail!("session expired");
    }
    if (chrono::Utc::now() - s.last_used_at).num_seconds() > ADMIN_IDLE_TIMEOUT_SECS {
        anyhow::bail!("session idle expired");
    }
    let u = get_user_by_id(pool, s.user_id).await.map_err(|_| anyhow::anyhow!("user not found"))?;
    if !u.has_management_access() || u.status != 1 {
        anyhow::bail!("not an active admin");
    }
    // 滑动空闲窗口：每次校验刷新 last_used_at
    sqlx::query("UPDATE admin_sessions SET last_used_at = now() WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(u)
}

/// IssueCSRF 生成指定时间窗口的 HMAC-SHA256 token。
pub fn issue_csrf(key: &str, at: chrono::DateTime<chrono::Utc>) -> String {
    let window = at
        .timestamp()
        .checked_div(CSRF_WINDOW_SECS)
        .unwrap_or(0)
        .to_string();
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("hmac key");
    mac.update(window.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// VerifyCSRF 接受当前或前一窗口的 token。
pub fn verify_csrf(key: &str, token: &str, at: chrono::DateTime<chrono::Utc>) -> bool {
    if token.is_empty() {
        return false;
    }
    let windows = [at, at - chrono::Duration::seconds(CSRF_WINDOW_SECS)];
    windows.iter().any(|w| {
        let expected = issue_csrf(key, *w);
        let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("hmac key");
        mac.update(expected.as_bytes());
        let _ = mac;
        expected == token
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csrf_roundtrip() {
        let key = "test-key";
        let t = chrono::Utc::now();
        let token = issue_csrf(key, t);
        assert!(verify_csrf(key, &token, t));
        // 前一窗口仍有效
        let prev = t - chrono::Duration::seconds(CSRF_WINDOW_SECS * 2);
        let prev_token = issue_csrf(key, prev);
        assert!(verify_csrf(key, &prev_token, prev));
        // 错误 key 拒绝
        assert!(!verify_csrf("other", &token, t));
        assert!(!verify_csrf(key, "", t));
    }

    #[tokio::test]
    async fn session_lifecycle() {
        let pool = picoaide_dsh_store::testutil::new_test_db().await;
        let uid = picoaide_dsh_store::users::create_user(
            &pool,
            &picoaide_dsh_store::users::User {
                username: "admin".into(),
                source: "local".into(),
                is_admin: true,
                status: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let (s, csrf) = create_admin_session(&pool, uid).await.unwrap();
        assert!(!s.id.is_empty());
        assert!(!csrf.is_empty());
        // 校验
        let u = validate_admin_session(&pool, &s.id).await.unwrap();
        assert_eq!(u.username, "admin");
    }
}
