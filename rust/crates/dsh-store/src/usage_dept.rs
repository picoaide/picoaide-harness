//! 部门维度用量聚合基础（Go `serverstore/usage_dept.go` 的核心函数等价）。

use crate::errors::{map_db_error, StoreError};
use sqlx::Row;

/// DeptUserIDsByName 部门名（含子树）的成员 user_id 集合——与 DeptMemberIDs 同语义。
pub async fn dept_user_ids_by_name(pool: &sqlx::PgPool, dept: &str) -> Result<Vec<i64>, StoreError> {
    let sub = dept_subtree_ids(pool, dept).await?;
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

/// dept_subtree_ids 返回部门名对应子树 group id 列表（含自身）；部门不存在 → ErrNotFound。
pub async fn dept_subtree_ids(pool: &sqlx::PgPool, dept: &str) -> Result<Vec<i64>, StoreError> {
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM groups WHERE name = $1")
        .bind(dept)
        .fetch_optional(pool)
        .await
        .map_err(map_db_error)?;
    let Some(id) = id else {
        return Err(StoreError::NotFound);
    };
    crate::departments::subtree_group_ids(pool, id).await
}

/// user_id_to_depts 用户 → 部门名集合（成员归属祖先链展开，去重）。
/// 返回 map[user_id] -> Vec<dept name>（按祖先顺序）。
pub async fn user_id_to_depts(
    pool: &sqlx::PgPool,
) -> Result<std::collections::HashMap<i64, Vec<String>>, StoreError> {
    // 组织树
    let nodes: Vec<(i64, String, i32)> = sqlx::query_as("SELECT id, name, parent_id FROM groups")
        .fetch_all(pool)
        .await
        .map_err(map_db_error)?;
    let mut by_id: std::collections::HashMap<i64, (String, i64)> = std::collections::HashMap::new();
    for (id, name, parent) in &nodes {
        by_id.insert(*id, (name.clone(), *parent as i64));
    }
    // 用户组关系
    let rows = sqlx::query("SELECT user_id, group_id FROM user_groups")
        .fetch_all(pool)
        .await
        .map_err(map_db_error)?;
    let mut out: std::collections::HashMap<i64, Vec<String>> = std::collections::HashMap::new();
    for r in rows {
        let uid = r.get::<i32, _>("user_id") as i64;
        let gid = r.get::<i32, _>("group_id") as i64;
        if !by_id.contains_key(&gid) {
            continue;
        }
        let mut seen = std::collections::HashSet::new();
        let mut cur = gid;
        loop {
            let (name, parent) = by_id.get(&cur).cloned().unwrap_or_default();
            if name.is_empty() {
                break;
            }
            if seen.insert(name.clone()) {
                out.entry(uid).or_default().push(name);
            }
            if parent == 0 {
                break;
            }
            cur = parent;
        }
    }
    Ok(out)
}

/// pre_order_nodes 树先序（根在前，子按 id 升序）。
#[derive(Debug, Clone)]
pub struct DeptNode {
    pub id: i64,
    pub name: String,
    pub parent: i64,
}

/// pre_order_nodes_from_pool 装载树并先序排序。
pub async fn pre_order_nodes(pool: &sqlx::PgPool) -> Result<Vec<DeptNode>, StoreError> {
    let nodes: Vec<(i64, String, i32)> = sqlx::query_as("SELECT id, name, parent_id FROM groups")
        .fetch_all(pool)
        .await
        .map_err(map_db_error)?;
    let mut by_id: std::collections::HashMap<i64, DeptNode> = std::collections::HashMap::new();
    let mut children: std::collections::HashMap<i64, Vec<i64>> = std::collections::HashMap::new();
    for (id, name, parent) in &nodes {
        by_id.insert(*id, DeptNode { id: *id, name: name.clone(), parent: *parent as i64 });
        children.entry(*parent as i64).or_default().push(*id);
        if !nodes.iter().any(|(_, _, p)| *p as i64 == *id) {
            // 无父引用 = 根（近似：处理孤立）
        }
    }
    // 根 = 无父的节点
    let mut roots = Vec::new();
    for (id, node) in &by_id {
        if node.parent == 0 || !by_id.contains_key(&node.parent) {
            roots.push(*id);
        }
    }
    roots.sort();
    let mut out = Vec::new();
    let mut stack = roots;
    while let Some(cur) = stack.pop() {
        if let Some(n) = by_id.get(&cur) {
            out.push(n.clone());
            if let Some(kids) = children.get(&cur) {
                let mut kids = kids.clone();
                kids.sort();
                for k in kids.into_iter().rev() {
                    stack.push(k);
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;

    #[tokio::test]
    async fn dept_users_by_name() {
        let pool = new_test_db().await;
        let uid = crate::users::create_user(
            &pool,
            &crate::users::User {
                username: "alice".into(),
                source: "local".into(),
                status: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let dept = crate::departments::create_department(&pool, "研发部", 0, 0, "").await.unwrap();
        crate::groups::add_user_group(&pool, uid, dept).await.unwrap();
        let ids = dept_user_ids_by_name(&pool, "研发部").await.unwrap();
        assert!(ids.contains(&uid));
        // 不存在 → ErrNotFound
        assert_eq!(
            dept_user_ids_by_name(&pool, "不存在").await.unwrap_err(),
            StoreError::NotFound
        );
    }

    #[tokio::test]
    async fn user_to_depts() {
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
        let parent = crate::departments::create_department(&pool, "公司", 0, 0, "").await.unwrap();
        let child = crate::departments::create_department(&pool, "研发", parent, 0, "").await.unwrap();
        crate::groups::add_user_group(&pool, uid, child).await.unwrap();
        let m = user_id_to_depts(&pool).await.unwrap();
        let depts = m.get(&uid).unwrap();
        assert!(depts.contains(&"公司".to_string()) && depts.contains(&"研发".to_string()));
    }
}
