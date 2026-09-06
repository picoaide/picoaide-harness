//! 授权域（Go `serverstore/grants.go` 等价）——app_grants ACL。

use crate::errors::{map_db_error, StoreError};
use sqlx::Row;

/// GranteeType 区分用户直授与组授。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GranteeType {
    User,
    Group,
}

impl GranteeType {
    pub fn as_str(&self) -> &'static str {
        match self {
            GranteeType::User => "user",
            GranteeType::Group => "group",
        }
    }
}

/// Grant 一条 ACL 行：资源授权给用户或组。
#[derive(Debug, Clone, Default)]
pub struct Grant {
    pub grantee_type: String,
    pub grantee: String,
}

/// SharedGrantableTable 命名授权行作用域（编译期常量，无用户输入拼接）。
#[derive(Debug, Clone, Copy)]
pub struct SharedGrantableTable {
    pub kind: &'static str, // "skill" | "agent" | ""
}

pub const SHARED_SKILL_GRANT_TABLE: SharedGrantableTable = SharedGrantableTable { kind: "skill" };
pub const SHARED_PRESET_GRANT_TABLE: SharedGrantableTable = SharedGrantableTable { kind: "agent" };

/// valid_grantee 强制普通、无冲突主题名（无分隔符/路径字符；组名可带 @ 前缀剥离）。
fn valid_grantee(g: &str) -> Result<String, StoreError> {
    let g = g.strip_prefix('@').unwrap_or(g);
    if g.is_empty() || g.contains(['/', '\\', '\t', '\n']) {
        return Err(StoreError::Validation);
    }
    Ok(g.to_string())
}

/// GrantSkill 授予用户/组技能访问（幂等）。
pub async fn grant_skill(
    pool: &sqlx::PgPool,
    skill_name: &str,
    grantee: &str,
    t: GranteeType,
) -> Result<(), StoreError> {
    let g = valid_grantee(grantee)?;
    sqlx::query(
        "INSERT INTO app_grants (kind, app_id, grantee_type, grantee) VALUES ('skill', $1, $2, $3) ON CONFLICT DO NOTHING",
    )
    .bind(skill_name)
    .bind(t.as_str())
    .bind(&g)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(())
}

/// RevokeSkill 移除授权（幂等；缺失行非错误）。
pub async fn revoke_skill(
    pool: &sqlx::PgPool,
    skill_name: &str,
    grantee: &str,
    t: GranteeType,
) -> Result<(), StoreError> {
    let g = valid_grantee(grantee)?;
    sqlx::query("DELETE FROM app_grants WHERE kind = 'skill' AND app_id = $1 AND grantee_type = $2 AND grantee = $3")
        .bind(skill_name)
        .bind(t.as_str())
        .bind(&g)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    Ok(())
}

/// ListSkillGrants 返回技能的全部授权。
pub async fn list_skill_grants(pool: &sqlx::PgPool, skill_name: &str) -> Result<Vec<Grant>, StoreError> {
    let rows = sqlx::query(
        "SELECT grantee_type, grantee FROM app_grants WHERE kind = 'skill' AND app_id = $1 ORDER BY grantee_type, grantee",
    )
    .bind(skill_name)
    .fetch_all(pool)
    .await
    .map_err(map_db_error)?;
    Ok(rows.into_iter().map(scan_grant).collect())
}

fn scan_grant(r: sqlx::postgres::PgRow) -> Grant {
    Grant {
        grantee_type: r.get("grantee_type"),
        grantee: r.get("grantee"),
    }
}

/// AccessibleSkillNames 用户直授或经组授得到的技能名（严格默认：无授权不可见）。
pub async fn accessible_skill_names(
    pool: &sqlx::PgPool,
    username: &str,
    groups: &[String],
) -> Result<Vec<String>, StoreError> {
    accessible_app_ids(pool, "skill", username, groups).await
}

/// accessible_app_ids 通用实现。
pub async fn accessible_app_ids(
    pool: &sqlx::PgPool,
    kind: &str,
    username: &str,
    groups: &[String],
) -> Result<Vec<String>, StoreError> {
    let mut sql = String::from(
        "SELECT DISTINCT app_id FROM app_grants WHERE kind = $1 AND (grantee_type = 'user' AND grantee = $2",
    );
    let mut idx = 3usize;
    if !groups.is_empty() {
        sql.push_str(" OR (grantee_type = 'group' AND (");
        for (i, _) in groups.iter().enumerate() {
            if i > 0 {
                sql.push_str(" OR ");
            }
            sql.push_str(&format!("LOWER(grantee) = LOWER(${idx})"));
            idx += 1;
        }
        sql.push_str("))");
    }
    sql.push_str(")");
    let mut q = sqlx::query(&sql).bind(kind).bind(username);
    for g in groups {
        q = q.bind(g);
    }
    let rows = q.fetch_all(pool).await.map_err(map_db_error)?;
    Ok(rows.into_iter().map(|r| r.get::<String, _>("app_id")).collect())
}

/// DeleteSkillGrants 清除技能全部授权（资源删除级联）。
pub async fn delete_skill_grants(pool: &sqlx::PgPool, skill_name: &str) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM app_grants WHERE kind = 'skill' AND app_id = $1")
        .bind(skill_name)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    Ok(())
}

/// GrantSharedResource 授予共享技能/智能体（幂等）。
pub async fn grant_shared_resource(
    pool: &sqlx::PgPool,
    table: SharedGrantableTable,
    resource_name: &str,
    grantee: &str,
    t: GranteeType,
) -> Result<(), StoreError> {
    let g = valid_grantee(grantee)?;
    sqlx::query("INSERT INTO app_grants (kind, app_id, grantee_type, grantee) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING")
        .bind(table.kind)
        .bind(resource_name)
        .bind(t.as_str())
        .bind(&g)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    Ok(())
}

/// RevokeSharedResource 移除共享资源授权（幂等）。
pub async fn revoke_shared_resource(
    pool: &sqlx::PgPool,
    table: SharedGrantableTable,
    resource_name: &str,
    grantee: &str,
    t: GranteeType,
) -> Result<(), StoreError> {
    let g = valid_grantee(grantee)?;
    sqlx::query("DELETE FROM app_grants WHERE app_id = $1 AND grantee_type = $2 AND grantee = $3 AND kind = $4")
        .bind(resource_name)
        .bind(t.as_str())
        .bind(&g)
        .bind(table.kind)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    Ok(())
}

/// ListSharedResourceGrants 返回共享技能/智能体的全部授权。
pub async fn list_shared_resource_grants(
    pool: &sqlx::PgPool,
    table: SharedGrantableTable,
    resource_name: &str,
) -> Result<Vec<Grant>, StoreError> {
    let rows = sqlx::query(
        "SELECT grantee_type, grantee FROM app_grants WHERE kind = $1 AND app_id = $2 ORDER BY grantee_type, grantee",
    )
    .bind(table.kind)
    .bind(resource_name)
    .fetch_all(pool)
    .await
    .map_err(map_db_error)?;
    Ok(rows.into_iter().map(scan_grant).collect())
}

/// DeleteSharedResourceGrants 清除共享资源全部授权。
pub async fn delete_shared_resource_grants(
    pool: &sqlx::PgPool,
    table: SharedGrantableTable,
    resource_name: &str,
) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM app_grants WHERE kind = $1 AND app_id = $2")
        .bind(table.kind)
        .bind(resource_name)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    Ok(())
}

/// AccessibleSharedResourceNames 用户直授或经组授得到的共享资源名。
pub async fn accessible_shared_resource_names(
    pool: &sqlx::PgPool,
    table: SharedGrantableTable,
    username: &str,
    groups: &[String],
) -> Result<Vec<String>, StoreError> {
    let mut sql = String::from(
        "SELECT DISTINCT app_id FROM app_grants WHERE kind = $1 AND (grantee_type = 'user' AND grantee = $2",
    );
    let mut idx = 3usize;
    if !groups.is_empty() {
        sql.push_str(" OR (grantee_type = 'group' AND (");
        for (i, _) in groups.iter().enumerate() {
            if i > 0 {
                sql.push_str(" OR ");
            }
            sql.push_str(&format!("LOWER(grantee) = LOWER(${idx})"));
            idx += 1;
        }
        sql.push_str("))");
    }
    sql.push_str(")");
    let mut q = sqlx::query(&sql).bind(table.kind).bind(username);
    for g in groups {
        q = q.bind(g);
    }
    let rows = q.fetch_all(pool).await.map_err(map_db_error)?;
    Ok(rows.into_iter().map(|r| r.get("app_id")).collect())
}

/// ReplaceSharedGroups 事务内整体替换共享资源的组授权集（用户授权不动）。
pub async fn replace_shared_groups(
    pool: &sqlx::PgPool,
    table: SharedGrantableTable,
    resource_name: &str,
    groups: &[String],
) -> Result<(), StoreError> {
    let mut tx = pool.begin().await.map_err(map_db_error)?;
    // 部门存在性校验放事务内（TOCTOU）
    let mut seen = std::collections::HashSet::new();
    for g in groups {
        if g.is_empty() || !seen.insert(g.to_string()) {
            return Err(StoreError::Validation);
        }
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM groups WHERE LOWER(name) = LOWER($1)")
            .bind(g)
            .fetch_one(&mut *tx)
            .await
            .map_err(map_db_error)?;
        if n == 0 {
            return Err(StoreError::NotFound);
        }
    }
    sqlx::query("DELETE FROM app_grants WHERE kind = $1 AND app_id = $2 AND grantee_type = 'group'")
        .bind(table.kind)
        .bind(resource_name)
        .execute(&mut *tx)
        .await
        .map_err(map_db_error)?;
    for g in groups {
        sqlx::query("INSERT INTO app_grants (kind, app_id, grantee_type, grantee) VALUES ($1, $2, 'group', $3)")
            .bind(table.kind)
            .bind(resource_name)
            .bind(g)
            .execute(&mut *tx)
            .await
            .map_err(map_db_error)?;
    }
    tx.commit().await.map_err(map_db_error)?;
    Ok(())
}

/// ReplaceSkillGroupGrants 整体替换技能的部门授权集。
pub async fn replace_skill_group_grants(
    pool: &sqlx::PgPool,
    skill_name: &str,
    groups: &[String],
) -> Result<(), StoreError> {
    replace_shared_groups(pool, SHARED_SKILL_GRANT_TABLE, skill_name, groups).await
}

/// DeleteAppGrants 清空某 App 全部授权（资源删除级联）。
pub async fn delete_app_grants(pool: &sqlx::PgPool, kind: &str, app_id: &str) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM app_grants WHERE kind = $1 AND app_id = $2")
        .bind(kind)
        .bind(app_id)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;

    #[tokio::test]
    async fn grants_skill() {
        let pool = new_test_db().await;
        // 建组
        let gid = crate::departments::create_department(&pool, "研发组", 0, 0, "").await.unwrap();
        grant_skill(&pool, "my-skill", "alice", GranteeType::User).await.unwrap();
        grant_skill(&pool, "my-skill", "研发组", GranteeType::Group).await.unwrap();
        let grants = list_skill_grants(&pool, "my-skill").await.unwrap();
        assert_eq!(grants.len(), 2);
        // accessible: 用户直授
        let names = accessible_skill_names(&pool, "alice", &[]).await.unwrap();
        assert!(names.contains(&"my-skill".to_string()));
        // 组授
        let names = accessible_skill_names(&pool, "bob", &["研发组".to_string()]).await.unwrap();
        assert!(names.contains(&"my-skill".to_string()));
        // 非法 grantee
        assert_eq!(
            grant_skill(&pool, "s", "a/b", GranteeType::User).await.unwrap_err(),
            StoreError::Validation
        );
        // 整组替换
        replace_skill_group_grants(&pool, "my-skill", &["研发组".to_string()]).await.unwrap();
        let grants = list_skill_grants(&pool, "my-skill").await.unwrap();
        assert_eq!(grants.len(), 2); // user 授权保留 + 组授权
    }
}
