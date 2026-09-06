//! MFA 挑战 DAO（Go `serverauth/mfa.go` 的挑战生命周期等价，TOTP 算法由调用方用 totp-rs 实现）。
//!
//! - login:  两步登录，密码通过后签发，5 分钟有效，attempts>=5 作废，一次消费
//! - enable: 开启 MFA 的密钥暂存（明文密钥只经 enable 响应一次性下发前端，库中 AES-GCM 密文）

use picoaide_dsh_store::{StoreError, errors::map_db_error};
use rand::RngCore;
use sqlx::Row;

pub const MFA_TICKET_TTL_SECS: i64 = 5 * 60;
pub const MFA_CHALLENGE_MAX_FAILED: i32 = 5;
pub const MFA_ENABLE_TICKET_TTL_SECS: i64 = 60;

pub const MFA_TOTP_ISSUER: &str = "PicoAide";

/// MFaChallenge 一次性挑战行。
#[derive(Debug, Clone, Default)]
pub struct MfaChallenge {
    pub id: String,
    pub user_id: i64,
    pub kind: String, // "login" | "enable"
    pub secret: String, // kind=enable 的密钥密文；其余空
    pub attempts: i32,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    pub used_at: Option<chrono::DateTime<chrono::Utc>>,
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// CreateMFAChallenge 创建一次性挑战并清理过期/作废/已消费旧行（防表膨胀）。
pub async fn create_mfa_challenge(
    pool: &sqlx::PgPool,
    user_id: i64,
    kind: &str,
    secret_cipher: &str,
    ttl_secs: i64,
) -> Result<String, StoreError> {
    let id = random_hex(24);
    sqlx::query(
        "DELETE FROM admin_mfa_challenges WHERE expires_at < now() OR attempts >= $1 OR used_at IS NOT NULL",
    )
    .bind(MFA_CHALLENGE_MAX_FAILED)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    sqlx::query(
        "INSERT INTO admin_mfa_challenges (id, user_id, kind, secret, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))",
    )
    .bind(&id)
    .bind(user_id as i32)
    .bind(kind)
    .bind(secret_cipher)
    .bind(ttl_secs)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(id)
}

/// GetMFAChallenge 加载挑战。
pub async fn get_mfa_challenge(pool: &sqlx::PgPool, id: &str) -> Result<MfaChallenge, StoreError> {
    let row = sqlx::query(
        "SELECT id, user_id, kind, secret, attempts, expires_at, used_at FROM admin_mfa_challenges WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(map_db_error)?
    .ok_or(StoreError::NotFound)?;
    Ok(MfaChallenge {
        id: row.get("id"),
        user_id: row.get("user_id"),
        kind: row.get("kind"),
        secret: row.get("secret"),
        attempts: row.get("attempts"),
        expires_at: row.get("expires_at"),
        used_at: row.get("used_at"),
    })
}

/// BumpMFAChallengeAttempts 失败计数 +1。
pub async fn bump_mfa_challenge_attempts(pool: &sqlx::PgPool, id: &str) -> Result<(), StoreError> {
    sqlx::query("UPDATE admin_mfa_challenges SET attempts = attempts + 1 WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    Ok(())
}

/// ConsumeMFAChallenge 消费挑战（幂等：已消费/过期/作废返回 ErrNotFound）。
pub async fn consume_mfa_challenge(pool: &sqlx::PgPool, id: &str) -> Result<(), StoreError> {
    let res = sqlx::query(
        "UPDATE admin_mfa_challenges SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() AND attempts < $2",
    )
    .bind(id)
    .bind(MFA_CHALLENGE_MAX_FAILED)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use picoaide_dsh_store::testutil::new_test_db;

    #[tokio::test]
    async fn mfa_challenge_lifecycle() {
        let pool = new_test_db().await;
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
        let id = create_mfa_challenge(&pool, uid, "login", "", MFA_TICKET_TTL_SECS)
            .await
            .unwrap();
        let c = get_mfa_challenge(&pool, &id).await.unwrap();
        assert_eq!(c.kind, "login");
        assert_eq!(c.user_id, uid);
        // 消费
        consume_mfa_challenge(&pool, &id).await.unwrap();
        // 二次消费 → NotFound
        assert_eq!(consume_mfa_challenge(&pool, &id).await.unwrap_err(), StoreError::NotFound);
        // 失败计数
        let id2 = create_mfa_challenge(&pool, uid, "enable", "secret-cipher", MFA_ENABLE_TICKET_TTL_SECS)
            .await
            .unwrap();
        for _ in 0..5 {
            bump_mfa_challenge_attempts(&pool, &id2).await.unwrap();
        }
        let c2 = get_mfa_challenge(&pool, &id2).await.unwrap();
        assert!(c2.attempts >= 5);
        assert_eq!(consume_mfa_challenge(&pool, &id2).await.unwrap_err(), StoreError::NotFound);
    }
}
