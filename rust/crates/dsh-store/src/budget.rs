//! 部门预算域（Go `serverstore/budget.go` 等价）——0024 部门月度金额预算。

use crate::errors::{map_db_error, StoreError};
use sqlx::Row;

/// DeptBudget 一条部门预算。
#[derive(Debug, Clone, Default)]
pub struct DeptBudget {
    pub group_id: i64,
    pub name: String,
    pub budget: f64,
}

/// SetDeptBudget 设置/清除部门预算（budget <= 0 = 清除）。
pub async fn set_dept_budget(pool: &sqlx::PgPool, group_id: i64, budget: f64) -> Result<(), StoreError> {
    crate::departments::group_by_id(pool, group_id).await?;
    if budget <= 0.0 {
        sqlx::query("UPDATE groups SET budget_money = NULL WHERE id = $1")
            .bind(group_id)
            .execute(pool)
            .await
            .map_err(map_db_error)?;
    } else {
        sqlx::query("UPDATE groups SET budget_money = $1 WHERE id = $2")
            .bind(budget)
            .bind(group_id)
            .execute(pool)
            .await
            .map_err(map_db_error)?;
    }
    Ok(())
}

/// GetDeptBudget 返回部门预算（0 = 未配置）。
pub async fn get_dept_budget(pool: &sqlx::PgPool, group_id: i64) -> Result<f64, StoreError> {
    let b: Option<Option<f64>> = sqlx::query_scalar("SELECT budget_money FROM groups WHERE id = $1")
        .bind(group_id)
        .fetch_optional(pool)
        .await
        .map_err(map_db_error)?;
    match b {
        Some(v) => Ok(v.unwrap_or(0.0)),
        None => Err(StoreError::NotFound),
    }
}

/// EffectiveDeptBudget 返回用户生效的部门预算链（归属部门 + 祖先链 + 全员组）。
/// 只返回配置了预算（>0）的部门，按祖先 → 自己排序。
pub async fn effective_dept_budget(pool: &sqlx::PgPool, user_id: i64) -> Result<Vec<DeptBudget>, StoreError> {
    let member = crate::groups::user_groups(pool, user_id).await?;
    // 装载组织树
    let nodes: Vec<(i64, String, i32, i32)> =
        sqlx::query_as("SELECT id, name, parent_id, leader_id FROM groups")
            .fetch_all(pool)
            .await
            .map_err(map_db_error)?;
    let mut by_id: std::collections::HashMap<i64, (String, i64)> = std::collections::HashMap::new();
    for (id, name, parent, _leader) in &nodes {
        by_id.insert(*id, (name.clone(), *parent as i64));
    }
    // 归属部门 id
    let mut member_ids = Vec::new();
    for name in &member {
        if let Some((id, _)) = by_id.iter().find(|(_, (n, _))| n == name) {
            member_ids.push(*id);
        }
    }
    // 预算链：全员组 + 祖先链（去重，反转成祖先在前）
    let mut seen = std::collections::HashSet::new();
    let mut chain = Vec::new();
    if let Some((id, _)) = by_id.iter().find(|(_, (n, _))| n == crate::departments::EVERYONE_GROUP_NAME) {
        if seen.insert(*id) {
            chain.push(*id);
        }
    }
    for mid in member_ids {
        let mut cur = mid;
        loop {
            if seen.insert(cur) {
                chain.push(cur);
            }
            match by_id.get(&cur) {
                Some((_, parent)) if *parent != 0 => cur = *parent,
                _ => break,
            }
        }
    }
    chain.reverse();
    // 读取预算
    let mut out = Vec::new();
    if chain.is_empty() {
        return Ok(out);
    }
    let mut sql = String::from("SELECT id, name, COALESCE(budget_money, 0) AS budget_money FROM groups WHERE id IN (");
    for (i, _) in chain.iter().enumerate() {
        if i > 0 {
            sql.push(',');
        }
        sql.push_str(&format!("${}", i + 1));
    }
    sql.push(')');
    let mut q = sqlx::query(&sql);
    for id in &chain {
        q = q.bind(*id);
    }
    let rows = q.fetch_all(pool).await.map_err(map_db_error)?;
    let mut by_id_val: std::collections::HashMap<i64, DeptBudget> = std::collections::HashMap::new();
    for r in rows {
        by_id_val.insert(
            r.get::<i64, _>("id"),
            DeptBudget {
                group_id: r.get::<i64, _>("id"),
                name: r.get("name"),
                budget: r.get("budget_money"),
            },
        );
    }
    for id in chain {
        if let Some(b) = by_id_val.get(&id) {
            if b.budget > 0.0 {
                out.push(b.clone());
            }
        }
    }
    Ok(out)
}

/// DeptMemberIDs 返回部门树（含子部门）内成员 user_id 集合。
pub async fn dept_member_ids(pool: &sqlx::PgPool, group_id: i64) -> Result<Vec<i64>, StoreError> {
    let sub = crate::departments::subtree_group_ids(pool, group_id).await?;
    if sub.is_empty() {
        return Ok(Vec::new());
    }
    let mut sql = String::from("SELECT DISTINCT user_id FROM user_groups WHERE group_id IN (");
    for (i, _) in sub.iter().enumerate() {
        if i > 0 {
            sql.push(',');
        }
        sql.push_str(&format!("${}", i + 1));
    }
    sql.push(')');
    let mut q = sqlx::query(&sql);
    for id in &sub {
        q = q.bind(*id as i32);
    }
    let rows = q.fetch_all(pool).await.map_err(map_db_error)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.get::<i32, _>("user_id") as i64);
    }
    Ok(out)
}

/// DeptMonthlyCost 返回部门树（含子部门）当月累计费用 SUM(cost)。
pub async fn dept_monthly_cost(pool: &sqlx::PgPool, group_id: i64) -> Result<f64, StoreError> {
    let ids = dept_member_ids(pool, group_id).await?;
    if ids.is_empty() {
        return Ok(0.0);
    }
    let mut sql = String::from(
        "SELECT COALESCE(SUM(cost),0) FROM usage WHERE created_at >= date_trunc('month', now()) AND user_id IN (",
    );
    for (i, _) in ids.iter().enumerate() {
        if i > 0 {
            sql.push(',');
        }
        sql.push_str(&format!("${}", i + 1));
    }
    sql.push(')');
    let mut q = sqlx::query(&sql);
    for id in &ids {
        q = q.bind(*id as i32);
    }
    let total: f64 = q.fetch_one(pool).await.map(|r| r.get(0)).map_err(map_db_error)?;
    Ok(total)
}

/// DeptMonthlyCostBatch 批量部门费用（map groupID → 元）。
pub async fn dept_monthly_cost_batch(
    pool: &sqlx::PgPool,
    group_ids: &[i64],
) -> Result<std::collections::HashMap<i64, f64>, StoreError> {
    let mut out: std::collections::HashMap<i64, f64> = group_ids.iter().map(|id| (*id, 0.0)).collect();
    if group_ids.is_empty() {
        return Ok(out);
    }
    let mut members_by_dept: std::collections::HashMap<i64, Vec<i64>> = std::collections::HashMap::new();
    let mut all_ids = Vec::new();
    for id in group_ids {
        let ids = dept_member_ids(pool, *id).await?;
        members_by_dept.insert(*id, ids.clone());
        all_ids.extend(ids);
    }
    if all_ids.is_empty() {
        return Ok(out);
    }
    let mut sql = String::from(
        "SELECT user_id, COALESCE(SUM(cost),0) FROM usage WHERE created_at >= date_trunc('month', now()) AND user_id IN (",
    );
    for (i, _) in all_ids.iter().enumerate() {
        if i > 0 {
            sql.push(',');
        }
        sql.push_str(&format!("${}", i + 1));
    }
    sql.push_str(") GROUP BY user_id");
    let mut q = sqlx::query(&sql);
    for id in &all_ids {
        q = q.bind(*id as i32);
    }
    let rows = q.fetch_all(pool).await.map_err(map_db_error)?;
    let mut user_cost: std::collections::HashMap<i64, f64> = std::collections::HashMap::new();
    for r in rows {
        user_cost.insert(r.get::<i32, _>("user_id") as i64, r.get("cost"));
    }
    for (dept_id, list) in members_by_dept {
        let mut total = 0.0;
        for uid in list {
            if let Some(c) = user_cost.get(&uid) {
                total += c;
            }
        }
        out.insert(dept_id, total);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;

    #[tokio::test]
    async fn dept_budget_chain() {
        let pool = new_test_db().await;
        let uid = crate::users::create_user(
            &pool,
            &crate::users::User {
                username: "bob".into(),
                source: "local".into(),
                status: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let dept = crate::departments::create_department(&pool, "研发部", 0, 0, "").await.unwrap();
        crate::groups::add_user_group(&pool, uid, dept).await.unwrap();
        // 设置预算
        set_dept_budget(&pool, dept, 100.0).await.unwrap();
        assert_eq!(get_dept_budget(&pool, dept).await.unwrap(), 100.0);
        // 有效预算链包含研发部
        let chain = effective_dept_budget(&pool, uid).await.unwrap();
        assert!(chain.iter().any(|b| b.name == "研发部" && b.budget == 100.0));
        // 清除
        set_dept_budget(&pool, dept, 0.0).await.unwrap();
        assert_eq!(get_dept_budget(&pool, dept).await.unwrap(), 0.0);
        // 成员
        let members = dept_member_ids(&pool, dept).await.unwrap();
        assert!(members.contains(&uid));
    }
}
