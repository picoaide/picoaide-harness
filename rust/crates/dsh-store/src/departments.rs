//! 部门域（Go `serverstore/departments.go` 等价）。

use crate::errors::{map_db_error, StoreError};
use sqlx::Row;

/// 隐式全员组名（所有用户隐式成员，授权给全员=授权给所有人）。
pub const EVERYONE_GROUP_NAME: &str = "全员";

/// Group 组织单元：部门（可选 parent 金字塔 + leader 主管）。
#[derive(Debug, Clone, Default)]
pub struct Group {
    pub id: i64,
    pub name: String,
    pub parent_id: i64,
    pub leader_id: i64,
    pub description: String,
}

/// DepartmentInfo 管理端视图的部门形状。
#[derive(Debug, Clone, Default)]
pub struct DepartmentInfo {
    pub id: i64,
    pub name: String,
    pub parent_id: i64,
    pub leader_id: i64,
    pub leader_name: String,
    pub description: String,
    pub member_count: i64,
    pub child_count: i64,
    pub granted_count: i64,
    pub budget_money: Option<f64>,
    pub monthly_cost: f64,
}

/// ListDepartments 返回全部部门（含管理端字段）。
pub async fn list_departments(pool: &sqlx::PgPool) -> Result<Vec<DepartmentInfo>, StoreError> {
    let rows = sqlx::query(
        r#"SELECT g.id::bigint, g.name, g.parent_id::bigint, g.leader_id::bigint, g.description,
        COALESCE(u.username, ''),
        (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id),
        (SELECT COUNT(*) FROM groups c WHERE c.parent_id = g.id),
        (SELECT COUNT(*) FROM app_grants sg WHERE sg.grantee_type = 'group' AND LOWER(sg.grantee) = LOWER(g.name)),
        g.budget_money
        FROM groups g LEFT JOIN users u ON u.id = g.leader_id
        ORDER BY g.id"#,
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_error)?;
    let mut out = Vec::new();
    for r in rows {
        let budget_money: Option<f64> = r.get("budget_money");
        let leader_id: i64 = r.get("leader_id");
        let leader_name: String = r.get("leader_name");
        out.push(DepartmentInfo {
            id: r.get("id"),
            name: r.get("name"),
            parent_id: r.get("parent_id"),
            leader_id,
            leader_name,
            description: r.get("description"),
            member_count: r.get("member_count"),
            child_count: r.get("child_count"),
            granted_count: r.get("granted_count"),
            budget_money,
            monthly_cost: 0.0, // 由调用方 DeptMonthlyCostBatch 批量填充
        });
    }
    Ok(out)
}

/// GroupByID 返回单个部门。
pub async fn group_by_id(pool: &sqlx::PgPool, id: i64) -> Result<Group, StoreError> {
    let row = sqlx::query("SELECT id, name, parent_id, leader_id, description FROM groups WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(map_db_error)?
        .ok_or(StoreError::NotFound)?;
    Ok(Group {
        id: row.get::<i64, _>("id"),
        name: row.get("name"),
        parent_id: row.get::<i32, _>("parent_id") as i64,
        leader_id: row.get::<i32, _>("leader_id") as i64,
        description: row.get("description"),
    })
}

/// CreateDepartment 插入部门（parent_id 0 = 顶级）。
pub async fn create_department(
    pool: &sqlx::PgPool,
    name: &str,
    parent_id: i64,
    leader_id: i64,
    description: &str,
) -> Result<i64, StoreError> {
    if name == EVERYONE_GROUP_NAME || name.is_empty() {
        return Err(StoreError::Validation);
    }
    if parent_id != 0 {
        group_by_id(pool, parent_id).await?;
    }
    if leader_id != 0 {
        crate::users::get_user_by_id(pool, leader_id).await?;
    }
    let row = sqlx::query("INSERT INTO groups (name, parent_id, leader_id, description) VALUES ($1, $2, $3, $4) RETURNING id")
        .bind(name)
        .bind(parent_id)
        .bind(leader_id)
        .bind(description)
        .fetch_one(pool)
        .await
        .map_err(map_db_error)?;
    Ok(row.get("id"))
}

/// UpdateDepartment 改名/改上级/改主管。守卫：上级必须存在且非自身/后代（防环）、主管存在。
pub async fn update_department(
    pool: &sqlx::PgPool,
    id: i64,
    name: &str,
    parent_id: i64,
    leader_id: i64,
    description: &str,
) -> Result<(), StoreError> {
    update_department_with_budget_inner(pool, id, name, parent_id, leader_id, description, None).await
}

/// UpdateDepartmentWithBudget 同语义，额外同一事务内设置预算（nil 不变，0 清除，>0 设置）。
pub async fn update_department_with_budget(
    pool: &sqlx::PgPool,
    id: i64,
    name: &str,
    parent_id: i64,
    leader_id: i64,
    description: &str,
    budget: Option<f64>,
) -> Result<(), StoreError> {
    update_department_with_budget_inner(pool, id, name, parent_id, leader_id, description, budget).await
}

async fn update_department_with_budget_inner(
    pool: &sqlx::PgPool,
    id: i64,
    name: &str,
    parent_id: i64,
    leader_id: i64,
    description: &str,
    budget: Option<f64>,
) -> Result<(), StoreError> {
    let g = group_by_id(pool, id).await?;
    if parent_id != 0 {
        if parent_id == id {
            return Err(StoreError::Validation);
        }
        let sub = subtree_group_ids(pool, id).await?;
        if sub.contains(&parent_id) {
            return Err(StoreError::Validation);
        }
        group_by_id(pool, parent_id).await?;
    }
    if leader_id != 0 {
        crate::users::get_user_by_id(pool, leader_id).await?;
    }
    let mut tx = pool.begin().await.map_err(map_db_error)?;
    if g.name == EVERYONE_GROUP_NAME || name == EVERYONE_GROUP_NAME || name.is_empty() {
        return Err(StoreError::Validation);
    }
    if name != g.name {
        // 改名级联授权表（大小写不敏感）
        sqlx::query("UPDATE app_grants SET grantee = $1 WHERE grantee_type = 'group' AND LOWER(grantee) = LOWER($2)")
            .bind(name)
            .bind(&g.name)
            .execute(&mut *tx)
            .await
            .map_err(map_db_error)?;
    }
    let res = sqlx::query("UPDATE groups SET name = $1, parent_id = $2, leader_id = $3, description = $4 WHERE id = $5")
        .bind(name)
        .bind(parent_id)
        .bind(leader_id)
        .bind(description)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    if let Some(b) = budget {
        if b < 0.0 {
            return Err(StoreError::Validation);
        }
        if b == 0.0 {
            sqlx::query("UPDATE groups SET budget_money = NULL WHERE id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(map_db_error)?;
        } else {
            sqlx::query("UPDATE groups SET budget_money = $1 WHERE id = $2")
                .bind(b)
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(map_db_error)?;
        }
    }
    tx.commit().await.map_err(map_db_error)?;
    Ok(())
}

/// DeleteDepartment 删除部门。守卫：有成员/子部门/授权引用不可删（TOCTOU 内同事务计数）。
pub async fn delete_department(pool: &sqlx::PgPool, id: i64) -> Result<(), StoreError> {
    let mut tx = pool.begin().await.map_err(map_db_error)?;
    if let Ok(g) = crate::departments::group_by_id(pool, id).await {
        if g.name == EVERYONE_GROUP_NAME {
            return Err(StoreError::Validation);
        }
    } else {
        return Err(StoreError::NotFound);
    }
    let row = sqlx::query(
        "SELECT
        (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id),
        (SELECT COUNT(*) FROM groups c WHERE c.parent_id = g.id),
        (SELECT COUNT(*) FROM app_grants ag WHERE ag.grantee_type = 'group' AND LOWER(ag.grantee) = LOWER(g.name))
        FROM groups g WHERE g.id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(map_db_error)?
    .ok_or(StoreError::NotFound)?;
    let member_count: i64 = row.get(0);
    let child_count: i64 = row.get(1);
    let grant_count: i64 = row.get(2);
    if member_count > 0 || child_count > 0 || grant_count > 0 {
        return Err(StoreError::DepartmentInUse);
    }
    sqlx::query("DELETE FROM groups WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(map_db_error)?;
    tx.commit().await.map_err(map_db_error)?;
    Ok(())
}

/// subtree_group_ids 返回部门 id 及其全部后代 id（内存遍历，树很小）。
pub async fn subtree_group_ids(pool: &sqlx::PgPool, root_id: i64) -> Result<Vec<i64>, StoreError> {
    let nodes: Vec<(i64, i32)> = sqlx::query_as("SELECT id, parent_id FROM groups")
        .fetch_all(pool)
        .await
        .map_err(map_db_error)?;
    let mut children: std::collections::HashMap<i64, Vec<i64>> = std::collections::HashMap::new();
    for (id, parent) in nodes {
        children.entry(parent as i64).or_default().push(id);
    }
    let mut out = vec![root_id];
    let mut stack = vec![root_id];
    while let Some(cur) = stack.pop() {
        if let Some(cs) = children.get(&cur) {
            for c in cs {
                out.push(*c);
                stack.push(*c);
            }
        }
    }
    Ok(out)
}
