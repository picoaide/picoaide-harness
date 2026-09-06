//! 首次启动管理员初始化（Go `serverauth/bootstrap_admin.go` 等价）。

use picoaide_dsh_store::{users, StoreError};
use picoaide_dsh_store::settings;

/// EnsureBootstrapAdmin 无 admin 时用 --bootstrap-admin + PICOAI_ADMIN_PASSWORD 创建首个管理员。
pub async fn ensure_bootstrap_admin(pool: &sqlx::PgPool, username: &str) -> Result<(), anyhow::Error> {
    let (users, _) = users::list_users(pool, 0, 100_000, "").await?;
    for u in &users {
        if u.is_super_admin() {
            return Ok(()); // super_admin 已存在
        }
    }
    let password = std::env::var("PICOAI_ADMIN_PASSWORD").unwrap_or_default();
    if password.is_empty() {
        anyhow::bail!("PICOAI_ADMIN_PASSWORD environment variable is required to bootstrap admin {username:?}");
    }
    // C-16: 与管理员建用户同策略
    let min_len = settings::auth_min_password_length(pool).await;
    if password.chars().count() < min_len as usize {
        anyhow::bail!("PICOAI_ADMIN_PASSWORD must be at least {min_len} characters");
    }
    if let Ok(_u) = users::get_user_by_username(pool, username).await {
        anyhow::bail!("bootstrap admin username already exists but is not an admin");
    }
    let hash = picoaide_dsh_util::hash_password(&password).map_err(|e| anyhow::anyhow!("hash: {e}"))?;
    users::create_user(
        pool,
        &users::User {
            username: username.to_string(),
            password_hash: hash,
            source: "local".to_string(),
            status: 1,
            is_admin: true,
            ..Default::default()
        },
    )
    .await
    .map_err(|e| match e {
        StoreError::Duplicate => anyhow::anyhow!("bootstrap admin username already exists"),
        other => anyhow::anyhow!("{other}"),
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use picoaide_dsh_store::testutil::new_test_db;

    #[tokio::test]
    async fn bootstrap_admin_creates_super_admin() {
        let pool = new_test_db().await;
        unsafe { std::env::set_var("PICOAI_ADMIN_PASSWORD", "adminpass1234") };
        ensure_bootstrap_admin(&pool, "admin").await.unwrap();
        let u = users::get_user_by_username(&pool, "admin").await.unwrap();
        assert!(u.is_super_admin());
        // 再次调用幂等
        ensure_bootstrap_admin(&pool, "admin").await.unwrap();
        let (list, total) = users::list_users(&pool, 0, 10, "").await.unwrap();
        assert_eq!(total, 1);
        assert_eq!(list.len(), 1);
        unsafe { std::env::remove_var("PICOAI_ADMIN_PASSWORD") };
    }
}
