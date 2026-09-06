//! 用户域（Go `serverstore/users.go` 等价）。

use crate::errors::StoreError;
use chrono::{DateTime, Utc};
use sqlx::postgres::PgPool;
use sqlx::Row;

pub const ROLE_SUPER_ADMIN: &str = "super_admin";
pub const ROLE_AUDITOR: &str = "auditor";
pub const ROLE_USER: &str = "user";

/// ValidRole 报告 role 是否为已知 RBAC 角色。
pub fn valid_role(role: &str) -> bool {
    role == ROLE_SUPER_ADMIN || role == ROLE_AUDITOR || role == ROLE_USER
}

/// IsAdminRole 报告角色是否可进入 webadmin 管理端（auditor 只读，user 不可）。
pub fn is_admin_role(role: &str) -> bool {
    role == ROLE_SUPER_ADMIN || role == ROLE_AUDITOR
}

/// User 对应 users 表行。
#[derive(Debug, Clone, Default)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub email: String,
    pub password_hash: String,
    pub source: String,
    pub role: String,
    pub is_admin: bool,
    pub status: i32,
    /// nil = 跟随全局默认，0 = 不限，>0 = 上限。
    pub quota_tokens: Option<i64>,
    pub quota_money: Option<f64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub password_changed_at: DateTime<Utc>,
    pub password_must_change: bool,
    pub totp_secret: String,
    pub totp_enabled: bool,
}

impl User {
    pub fn is_super_admin(&self) -> bool {
        self.role == ROLE_SUPER_ADMIN
    }
    pub fn has_management_access(&self) -> bool {
        is_admin_role(&self.role)
    }
}

/// user_cols 规范用户列清单（与 scan_user 保持同步）。
const USER_COLS: &str = "id, username, display_name, email, password_hash, source, is_admin, role, status, created_at, updated_at, quota_tokens, quota_money, password_changed_at, password_must_change, totp_secret, totp_enabled";

/// resolve_role 从写入侧派生 RBAC 角色：IsAdmin=true 恒为 super_admin；
/// 否则保留显式有效 Role，无效时回退 user。
pub fn resolve_role(role: &str, is_admin: bool) -> String {
    if is_admin {
        ROLE_SUPER_ADMIN.to_string()
    } else if valid_role(role) {
        role.to_string()
    } else {
        ROLE_USER.to_string()
    }
}

/// CreateUserWithPassword 创建本地用户并哈希明文密码。
pub async fn create_user_with_password(
    pool: &PgPool,
    username: &str,
    password: &str,
) -> Result<i64, StoreError> {
    let hash = picoaide_dsh_util::hash_password(password)
        .map_err(|e| anyhow::anyhow!("hash: {e}"))
        .map_err(|_| StoreError::Validation)?;
    create_user(
        pool,
        &User {
            username: username.to_string(),
            password_hash: hash,
            source: "local".to_string(),
            status: 1,
            ..Default::default()
        },
    )
    .await
}

/// CreateUser 插入用户行并返回 id。
pub async fn create_user(pool: &PgPool, u: &User) -> Result<i64, StoreError> {
    let role = resolve_role(&u.role, u.is_admin);
    let row: (i64,) = sqlx::query_as(
        r#"INSERT INTO users (username, display_name, email, password_hash, source, is_admin, role, status, quota_tokens, quota_money)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id"#,
    )
    .bind(&u.username)
    .bind(null_if_empty(&u.display_name))
    .bind(null_if_empty(&u.email))
    .bind(null_if_empty(&u.password_hash))
    .bind(&u.source)
    .bind(bool_int(u.is_admin))
    .bind(&role)
    .bind(u.status)
    .bind(u.quota_tokens)
    .bind(u.quota_money)
    .fetch_one(pool)
    .await
    .map_err(map_sqlx_err)?;
    Ok(row.0)
}

/// GetUserByUsername 返回用户或 ErrNotFound。
pub async fn get_user_by_username(pool: &PgPool, username: &str) -> Result<User, StoreError> {
    let row = sqlx::query(&format!("SELECT {USER_COLS} FROM users WHERE username = $1"))
        .bind(username)
        .fetch_optional(pool)
        .await
        .map_err(map_sqlx_err)?;
    row.map(scan_user).transpose()?.ok_or(StoreError::NotFound)
}

/// GetUserByID 返回用户或 ErrNotFound。
pub async fn get_user_by_id(pool: &PgPool, id: i64) -> Result<User, StoreError> {
    let row = sqlx::query(&format!("SELECT {USER_COLS} FROM users WHERE id = $1"))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(map_sqlx_err)?;
    row.map(scan_user).transpose()?.ok_or(StoreError::NotFound)
}

fn scan_user(row: sqlx::postgres::PgRow) -> Result<User, StoreError> {
    let id: i64 = row.get("id");
    let username: String = row.get("username");
    let display_name: Option<String> = row.get("display_name");
    let email: Option<String> = row.get("email");
    let password_hash: Option<String> = row.get("password_hash");
    let source: String = row.get("source");
    let is_admin: i32 = row.get("is_admin");
    let role: Option<String> = row.get("role");
    let status: i32 = row.get("status");
    let created_at: chrono::DateTime<Utc> = row.get("created_at");
    let updated_at: chrono::DateTime<Utc> = row.get("updated_at");
    let quota_tokens: Option<i64> = row.get("quota_tokens");
    let quota_money: Option<f64> = row.get("quota_money");
    let password_changed_at: Option<chrono::DateTime<Utc>> = row.get("password_changed_at");
    let password_must_change: i16 = row.get("password_must_change");
    let totp_secret: String = row.get("totp_secret");
    let totp_enabled: i16 = row.get("totp_enabled");
    let is_admin = is_admin != 0;

    let role = role.unwrap_or_default();
    let role = if role.is_empty() {
        // 迁移前创建的行：按旧标志派生
        if is_admin {
            ROLE_SUPER_ADMIN.to_string()
        } else {
            ROLE_USER.to_string()
        }
    } else {
        role
    };
    let is_admin_derived = role == ROLE_SUPER_ADMIN;
    Ok(User {
        id,
        username,
        display_name: display_name.unwrap_or_default(),
        email: email.unwrap_or_default(),
        password_hash: password_hash.unwrap_or_default(),
        source,
        role,
        is_admin: is_admin_derived, // 与 RBAC 角色保持同步（dump 兼容）
        status,
        quota_tokens,
        quota_money,
        created_at,
        updated_at,
        password_changed_at: password_changed_at.unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap()),
        password_must_change: password_must_change != 0,
        totp_secret,
        totp_enabled: totp_enabled != 0,
    })
}

/// UpdateUser 更新 display_name/email/password_hash/is_admin/role/status 与 0057 账簿列。
pub async fn update_user(pool: &PgPool, u: &User) -> Result<(), StoreError> {
    let role = resolve_role(&u.role, u.is_admin);
    let res = sqlx::query(
        "UPDATE users SET display_name=$1, email=$2, password_hash=$3, is_admin=$4, role=$5, status=$6, quota_tokens=$7, quota_money=$8, password_changed_at=$9, password_must_change=$10, updated_at=now() WHERE id=$11",
    )
    .bind(null_if_empty(&u.display_name))
    .bind(null_if_empty(&u.email))
    .bind(null_if_empty(&u.password_hash))
    .bind(bool_int(u.is_admin))
    .bind(&role)
    .bind(u.status)
    .bind(u.quota_tokens)
    .bind(u.quota_money)
    .bind(nil_if_zero_time(u.password_changed_at))
    .bind(bool_int(u.password_must_change))
    .bind(u.id)
    .execute(pool)
    .await
    .map_err(map_sqlx_err)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// UpdateUserRevokingTokens 同事务内更新用户并吊销全部 token/session（改密/降权/禁用原子）。
pub async fn update_user_revoking_tokens(pool: &PgPool, u: &User) -> Result<(), StoreError> {
    let mut tx = pool.begin().await.map_err(map_sqlx_err)?;
    let role = resolve_role(&u.role, u.is_admin);
    let res = sqlx::query(
        "UPDATE users SET display_name=$1, email=$2, password_hash=$3, is_admin=$4, role=$5, status=$6, quota_tokens=$7, quota_money=$8, password_changed_at=$9, password_must_change=$10, updated_at=now() WHERE id=$11",
    )
    .bind(null_if_empty(&u.display_name))
    .bind(null_if_empty(&u.email))
    .bind(null_if_empty(&u.password_hash))
    .bind(bool_int(u.is_admin))
    .bind(&role)
    .bind(u.status)
    .bind(u.quota_tokens)
    .bind(u.quota_money)
    .bind(nil_if_zero_time(u.password_changed_at))
    .bind(bool_int(u.password_must_change))
    .bind(u.id)
    .execute(&mut *tx)
    .await
    .map_err(map_sqlx_err)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    for stmt in [
        "DELETE FROM api_tokens WHERE user_id = $1",
        "DELETE FROM admin_sessions WHERE user_id = $1",
    ] {
        sqlx::query(stmt).bind(u.id).execute(&mut *tx).await.map_err(map_sqlx_err)?;
    }
    tx.commit().await.map_err(map_sqlx_err)?;
    Ok(())
}

/// UpdateUserPassword 改密专用（0057）：更新 hash + 改密时间 + 强制改密标志，吊销全部会话。
pub async fn update_user_password(
    pool: &PgPool,
    user_id: i64,
    new_hash: &str,
    must_change: bool,
) -> Result<(), StoreError> {
    let mut tx = pool.begin().await.map_err(map_sqlx_err)?;
    let res = sqlx::query(
        "UPDATE users SET password_hash=$1, password_must_change=$2, password_changed_at=now(), updated_at=now() WHERE id=$3",
    )
    .bind(new_hash)
    .bind(bool_int(must_change))
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .map_err(map_sqlx_err)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    for stmt in [
        "DELETE FROM api_tokens WHERE user_id = $1",
        "DELETE FROM admin_sessions WHERE user_id = $1",
    ] {
        sqlx::query(stmt).bind(user_id).execute(&mut *tx).await.map_err(map_sqlx_err)?;
    }
    tx.commit().await.map_err(map_sqlx_err)?;
    Ok(())
}

/// SetUserMFA 保存/更新 TOTP 配置（secret 为 AES-GCM 密文；enabled=1 仅由 verify 成功后写）。
pub async fn set_user_mfa(
    pool: &PgPool,
    user_id: i64,
    totp_secret_cipher: &str,
    enabled: bool,
) -> Result<(), StoreError> {
    let res = sqlx::query("UPDATE users SET totp_secret=$1, totp_enabled=$2, updated_at=now() WHERE id=$3")
        .bind(totp_secret_cipher)
        .bind(bool_int(enabled))
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(map_sqlx_err)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// ClearUserMFA 关闭/重置 TOTP。
pub async fn clear_user_mfa(pool: &PgPool, user_id: i64) -> Result<(), StoreError> {
    let res = sqlx::query("UPDATE users SET totp_secret='', totp_enabled=0, updated_at=now() WHERE id=$1")
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(map_sqlx_err)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// RevokeAllUserSessions 吊销用户全部 api_tokens 与 admin_sessions（不改用户字段）。
pub async fn revoke_all_user_sessions(pool: &PgPool, user_id: i64) -> Result<(), StoreError> {
    let mut tx = pool.begin().await.map_err(map_sqlx_err)?;
    for stmt in [
        "DELETE FROM api_tokens WHERE user_id = $1",
        "DELETE FROM admin_sessions WHERE user_id = $1",
    ] {
        sqlx::query(stmt).bind(user_id).execute(&mut *tx).await.map_err(map_sqlx_err)?;
    }
    tx.commit().await.map_err(map_sqlx_err)?;
    Ok(())
}

/// ListUsers 返回一页用户与总数。q 按用户名子串过滤（大小写不敏感、无通配符语义）。
pub async fn list_users(
    pool: &PgPool,
    offset: i64,
    limit: i64,
    q: &str,
) -> Result<(Vec<User>, i64), StoreError> {
    let q = q.trim();
    let total: i64 = if q.is_empty() {
        sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(pool)
            .await
            .map_err(map_sqlx_err)?
    } else {
        sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE POSITION(lower($1) IN lower(username)) > 0")
            .bind(q)
            .fetch_one(pool)
            .await
            .map_err(map_sqlx_err)?
    };
    let rows = if q.is_empty() {
        sqlx::query(&format!("SELECT {USER_COLS} FROM users ORDER BY id LIMIT $1 OFFSET $2"))
            .bind(limit)
            .bind(offset)
            .fetch_all(pool)
            .await
            .map_err(map_sqlx_err)?
    } else {
        sqlx::query(&format!("SELECT {USER_COLS} FROM users WHERE POSITION(lower($1) IN lower(username)) > 0 ORDER BY id LIMIT $2 OFFSET $3"))
            .bind(q)
            .bind(limit)
            .bind(offset)
            .fetch_all(pool)
            .await
            .map_err(map_sqlx_err)?
    };
    let users = rows.into_iter().map(scan_user).collect::<Result<Vec<_>, _>>()?;
    Ok((users, total))
}

/// DeleteUser 事务内删除用户及全部 FK 引用行（api_tokens/usage/admin_sessions/user_groups/app_grants），
/// 清空部门主管身份，最后管理员保护。
pub async fn delete_user(pool: &PgPool, id: i64) -> Result<(), StoreError> {
    let mut tx = pool.begin().await.map_err(map_sqlx_err)?;
    let row = sqlx::query("SELECT username, role FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(map_sqlx_err)?
        .ok_or(StoreError::NotFound)?;
    let username: String = row.get("username");
    let role: String = row.get("role");
    let was_super_admin = role == ROLE_SUPER_ADMIN;
    if was_super_admin {
        // 对全部 super_admin 行加 FOR UPDATE 锁，串行化最后管理员检查
        sqlx::query("SELECT id FROM users WHERE role = $1 FOR UPDATE")
            .bind(ROLE_SUPER_ADMIN)
            .execute(&mut *tx)
            .await
            .map_err(map_sqlx_err)?;
    }
    for stmt in [
        "DELETE FROM api_tokens WHERE user_id = $1",
        "DELETE FROM usage WHERE user_id = $1",
        "DELETE FROM admin_sessions WHERE user_id = $1",
        "DELETE FROM user_groups WHERE user_id = $1",
    ] {
        sqlx::query(stmt).bind(id).execute(&mut *tx).await.map_err(map_sqlx_err)?;
    }
    // 同名用户重建不得继承旧授权
    sqlx::query("DELETE FROM app_grants WHERE grantee_type = 'user' AND grantee = $1")
        .bind(&username)
        .execute(&mut *tx)
        .await
        .map_err(map_sqlx_err)?;
    // 清空部门主管身份
    sqlx::query("UPDATE groups SET leader_id = 0 WHERE leader_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(map_sqlx_err)?;
    let res = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(map_sqlx_err)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    if was_super_admin {
        let admins: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE role = $1")
            .bind(ROLE_SUPER_ADMIN)
            .fetch_one(&mut *tx)
            .await
            .map_err(map_sqlx_err)?;
        if admins == 0 {
            return Err(StoreError::LastAdmin);
        }
    }
    tx.commit().await.map_err(map_sqlx_err)?;
    Ok(())
}

/// AuthenticateLocal 校验用户名/密码（未知用户/错误密码/非本地点均返回 ErrNotFound，
/// 并执行 dummy 哈希校验以恒定响应时间）。
pub async fn authenticate_local(
    pool: &PgPool,
    username: &str,
    password: &str,
) -> Result<User, StoreError> {
    match get_user_by_username(pool, username).await {
        Ok(u) => {
            if u.source != "local" || u.password_hash.is_empty() || u.status != 1 {
                let _ = picoaide_dsh_util::verify_password(&dummy_password_hash(), password);
                return Err(StoreError::NotFound);
            }
            if !picoaide_dsh_util::verify_password(&u.password_hash, password) {
                return Err(StoreError::NotFound);
            }
            Ok(u)
        }
        Err(StoreError::NotFound) => {
            let _ = picoaide_dsh_util::verify_password(&dummy_password_hash(), password);
            Err(StoreError::NotFound)
        }
        Err(e) => Err(e),
    }
}

/// dummy_password_hash 用于账户缺失/非本地/禁用时校验，避免响应时间泄露。
fn dummy_password_hash() -> String {
    static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DUMMY
        .get_or_init(|| {
            picoaide_dsh_util::hash_password("picoaide-dummy-constant")
                .expect("dummy hash")
        })
        .clone()
}

/// --- 公共 helper（对齐 Go serverstore helpers） ---

pub fn bool_int(b: bool) -> i32 {
    if b {
        1
    } else {
        0
    }
}

pub fn null_if_empty(s: &str) -> Option<&str> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

pub fn nil_if_zero_time(t: DateTime<Utc>) -> Option<DateTime<Utc>> {
    if t.timestamp() == 0 && t.timestamp_subsec_nanos() == 0 {
        None
    } else {
        Some(t)
    }
}

fn map_sqlx_err(e: sqlx::Error) -> StoreError {
    crate::errors::map_db_error(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;

    #[tokio::test]
    async fn users_crud() {
        let pool = new_test_db().await;
        let id = create_user(
            &pool,
            &User {
                username: "alice".into(),
                display_name: "Alice".into(),
                source: "local".into(),
                is_admin: true,
                status: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(id > 0);
        // duplicate
        let err = create_user(
            &pool,
            &User {
                username: "alice".into(),
                source: "local".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err, StoreError::Duplicate);
        // get
        let u = get_user_by_username(&pool, "alice").await.unwrap();
        assert_eq!(u.username, "alice");
        assert_eq!(u.display_name, "Alice");
        assert!(u.is_admin);
        assert_eq!(u.status, 1);
        assert_ne!(u.created_at.timestamp(), 0);
        // update
        let mut u2 = u.clone();
        u2.display_name = "Alice2".into();
        u2.status = 0;
        update_user(&pool, &u2).await.unwrap();
        let u2 = get_user_by_username(&pool, "alice").await.unwrap();
        assert_eq!(u2.display_name, "Alice2");
        assert_eq!(u2.status, 0);
        // not found
        let err = get_user_by_username(&pool, "nobody").await.unwrap_err();
        assert_eq!(err, StoreError::NotFound);
        // pagination
        for c in ['a', 'b', 'c', 'd', 'e'] {
            create_user(
                &pool,
                &User {
                    username: format!("u{c}"),
                    source: "local".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let (users, total) = list_users(&pool, 0, 3, "").await.unwrap();
        assert_eq!(users.len(), 3);
        assert_eq!(total, 6);
        // search
        let (users, total) = list_users(&pool, 0, 20, "ali").await.unwrap();
        assert_eq!(total, 1);
        assert_eq!(users[0].username, "alice");
    }

    #[tokio::test]
    async fn auth_local_roundtrip() {
        let pool = new_test_db().await;
        create_user_with_password(&pool, "bob", "pw123456").await.unwrap();
        let u = get_user_by_username(&pool, "bob").await.unwrap();
        assert!(!u.password_hash.is_empty());
        assert_ne!(u.password_hash, "pw123456");
        assert!(authenticate_local(&pool, "bob", "pw123456").await.is_ok());
        assert_eq!(
            authenticate_local(&pool, "bob", "bad").await.unwrap_err(),
            StoreError::NotFound
        );
        assert_eq!(
            authenticate_local(&pool, "nobody", "pw123456").await.unwrap_err(),
            StoreError::NotFound
        );
    }
}
