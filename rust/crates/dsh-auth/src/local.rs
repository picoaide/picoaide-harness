//! 本地密码 provider（Go `serverauth/local.go` 等价）。

use picoaide_dsh_store::users::{authenticate_local, get_user_by_id};
use picoaide_dsh_store::{StoreError, groups};

/// UserInfo 归一化身份（provider 返回值）。
#[derive(Debug, Clone, Default)]
pub struct UserInfo {
    pub username: String,
    pub display_name: String,
    pub email: String,
    pub groups: Vec<String>,
    /// "local" 本地表 | "external" ldap/oidc（provisionUser 拒绝外部身份采纳本地行）。
    pub source: String,
}

/// LocalProviderAuthenticate 本地表认证（错误统一 "invalid credentials"）。
pub async fn local_provider_authenticate(
    pool: &sqlx::PgPool,
    username: &str,
    password: &str,
) -> Result<UserInfo, anyhow::Error> {
    let u = match authenticate_local(pool, username, password).await {
        Ok(u) => u,
        Err(StoreError::NotFound) => anyhow::bail!("invalid credentials"),
        Err(e) => anyhow::bail!("{e}"),
    };
    let groups = groups::user_groups(pool, u.id).await.unwrap_or_default();
    Ok(UserInfo {
        username: u.username,
        display_name: u.display_name,
        email: u.email,
        groups,
        source: "local".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use picoaide_dsh_store::testutil::new_test_db;

    #[tokio::test]
    async fn local_provider_ok() {
        let pool = new_test_db().await;
        picoaide_dsh_store::users::create_user_with_password(&pool, "alice", "pw123456")
            .await
            .unwrap();
        let info = local_provider_authenticate(&pool, "alice", "pw123456")
            .await
            .unwrap();
        assert_eq!(info.username, "alice");
        assert_eq!(info.source, "local");
        // 错误密码
        assert!(local_provider_authenticate(&pool, "alice", "bad").await.is_err());
    }
}
