//! 组域（Go `serverstore/groups.go` 等价）。

use crate::errors::{map_db_error, StoreError};
use crate::users::User;
use sqlx::postgres::PgPool;
use sqlx::Row;

/// GroupByName 按名（大小写不敏感）返回组 id 或 ErrNotFound（池版）。
pub async fn group_by_name(pool: &PgPool, name: &str) -> Result<i64, StoreError> {
    let id: i64 = sqlx::query_scalar("SELECT id FROM groups WHERE LOWER(name) = LOWER($1)")
        .bind(name)
        .fetch_optional(pool)
        .await
        .map_err(map_db_error)?
        .ok_or(StoreError::NotFound)?;
    Ok(id)
}

/// GroupByNameTx 事务版。
pub async fn group_by_name_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    name: &str,
) -> Result<i64, StoreError> {
    let id: i64 = sqlx::query_scalar("SELECT id FROM groups WHERE LOWER(name) = LOWER($1)")
        .bind(name)
        .fetch_optional(&mut **tx)
        .await
        .map_err(map_db_error)?
        .ok_or(StoreError::NotFound)?;
    Ok(id)
}

/// GetOrCreateGroup 返回组 id，缺失则创建（池版）。
pub async fn get_or_create_group(pool: &PgPool, name: &str) -> Result<i64, StoreError> {
    if name == crate::departments::EVERYONE_GROUP_NAME {
        return Err(StoreError::Validation);
    }
    if let Ok(id) = group_by_name(pool, name).await {
        return Ok(id);
    }
    let row = sqlx::query("INSERT INTO groups (name) VALUES ($1) RETURNING id")
        .bind(name)
        .fetch_optional(pool)
        .await
        .map_err(map_db_error)?;
    match row {
        Some(r) => Ok(r.get::<i64, _>("id")),
        None => group_by_name(pool, name).await,
    }
}

/// GetOrCreateGroupTx 事务版。
pub async fn get_or_create_group_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    name: &str,
) -> Result<i64, StoreError> {
    if name == crate::departments::EVERYONE_GROUP_NAME {
        return Err(StoreError::Validation);
    }
    if let Ok(id) = group_by_name_tx(tx, name).await {
        return Ok(id);
    }
    let row = sqlx::query("INSERT INTO groups (name) VALUES ($1) RETURNING id")
        .bind(name)
        .fetch_optional(&mut **tx)
        .await
        .map_err(map_db_error)?;
    match row {
        Some(r) => Ok(r.get::<i64, _>("id")),
        None => group_by_name_tx(tx, name).await,
    }
}

/// UserGroups 返回用户所属组名（升序）。
pub async fn user_groups(pool: &PgPool, user_id: i64) -> Result<Vec<String>, StoreError> {
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT g.name FROM groups g JOIN user_groups ug ON ug.group_id = g.id WHERE ug.user_id = $1 ORDER BY g.name",
    )
    .bind(user_id as i32)
    .fetch_all(pool)
    .await
    .map_err(map_db_error)?;
    Ok(rows)
}

/// UserGroupsBatch 一次查询返回 用户id → 组名（管理端用户列表，避免 N+1）。
pub async fn user_groups_batch(
    pool: &PgPool,
    users: &[User],
) -> Result<std::collections::HashMap<i64, Vec<String>>, StoreError> {
    let mut out: std::collections::HashMap<i64, Vec<String>> =
        users.iter().map(|u| (u.id, Vec::new())).collect();
    if users.is_empty() {
        return Ok(out);
    }
    let ids: Vec<i64> = users.iter().map(|u| u.id).collect();
    let mut query = String::from(
        "SELECT ug.user_id, g.name FROM user_groups ug JOIN groups g ON g.id = ug.group_id WHERE ug.user_id IN (",
    );
    for (i, _) in ids.iter().enumerate() {
        if i > 0 {
            query.push(',');
        }
        query.push_str(&format!("${}", i + 1));
    }
    query.push_str(") ORDER BY g.name");
    let mut q = sqlx::query(&query);
    for id in &ids {
        q = q.bind(*id as i32);
    }
    let rows = q.fetch_all(pool).await.map_err(map_db_error)?;
    for r in rows {
        let uid: i32 = r.get("user_id");
        let name: String = r.get("name");
        out.entry(uid as i64).or_default().push(name);
    }
    Ok(out)
}

/// SyncUserGroups 事务内替换用户组归属。
pub async fn sync_user_groups(pool: &PgPool, user_id: i64, names: &[String]) -> Result<(), StoreError> {
    let mut tx = pool.begin().await.map_err(map_db_error)?;
    sqlx::query("DELETE FROM user_groups WHERE user_id = $1")
        .bind(user_id as i32)
        .execute(&mut *tx)
        .await
        .map_err(map_db_error)?;
    for n in names {
        let gid = get_or_create_group_tx(&mut tx, n).await?;
        sqlx::query("INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(user_id as i32)
            .bind(gid as i32)
            .execute(&mut *tx)
            .await
            .map_err(map_db_error)?;
    }
    tx.commit().await.map_err(map_db_error)?;
    Ok(())
}

/// AddUserGroup 添加单个组归属（保留现有归属；测试与预算链设置用）。
pub async fn add_user_group(pool: &PgPool, user_id: i64, group_id: i64) -> Result<(), StoreError> {
    crate::departments::group_by_id(pool, group_id).await?;
    sqlx::query("INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(user_id as i32)
        .bind(group_id as i32)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    Ok(())
}
