//! 有效组解析（Go `serverstore/effective.go` 等价）——金字塔权限继承。

use crate::errors::{map_db_error, StoreError};
use crate::departments::EVERYONE_GROUP_NAME;

#[derive(Debug, Clone)]
struct GroupNode {
    id: i64,
    parent: i64,
    leader: i64,
    name: String,
}

/// load_group_tree 全表读取组织树（Rust 侧无缓存，与 Go TTL 缓存行为等价）。
async fn load_group_tree(pool: &sqlx::PgPool) -> Result<Vec<GroupNode>, StoreError> {
    let rows: Vec<(i64, String, i32, i32)> =
        sqlx::query_as("SELECT id, name, parent_id, leader_id FROM groups")
            .fetch_all(pool)
            .await
            .map_err(map_db_error)?;
    Ok(rows
        .into_iter()
        .map(|(id, name, parent, leader)| GroupNode {
            id,
            parent: parent as i64,
            leader: leader as i64,
            name,
        })
        .collect())
}

fn index_tree(nodes: &[GroupNode]) -> (std::collections::HashMap<i64, Vec<GroupNode>>, std::collections::HashMap<i64, GroupNode>) {
    let mut children: std::collections::HashMap<i64, Vec<GroupNode>> = std::collections::HashMap::new();
    let mut by_id: std::collections::HashMap<i64, GroupNode> = std::collections::HashMap::new();
    for n in nodes {
        by_id.insert(n.id, n.clone());
        children.entry(n.parent).or_default().push(n.clone());
    }
    (children, by_id)
}

/// ancestors_of 从 groupID 向上走到根（含自身）；环防护。
fn ancestors_of(by_id: &std::collections::HashMap<i64, GroupNode>, group_id: i64) -> Vec<i64> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut cur = group_id;
    while cur != 0 {
        if !seen.insert(cur) {
            break;
        }
        out.push(cur);
        match by_id.get(&cur) {
            Some(n) => cur = n.parent,
            None => break,
        }
    }
    out
}

/// subtree_of 收集 groupID 及其全部后代（DFS）；环防护。
fn subtree_of(children: &std::collections::HashMap<i64, Vec<GroupNode>>, root_id: i64) -> Vec<i64> {
    let mut out = vec![root_id];
    let mut stack = vec![root_id];
    let mut seen = std::collections::HashSet::new();
    seen.insert(root_id);
    while let Some(cur) = stack.pop() {
        if let Some(cs) = children.get(&cur) {
            for c in cs {
                if seen.insert(c.id) {
                    out.push(c.id);
                    stack.push(c.id);
                }
            }
        }
    }
    out
}

fn find_node_by_name(by_id: &std::collections::HashMap<i64, GroupNode>, name: &str) -> Option<GroupNode> {
    for n in by_id.values() {
        if n.name == name {
            return Some(n.clone());
        }
    }
    None
}

/// UserEffectiveGroups 返回用户权限解析的有效组名（继承扩展）。
/// 1. 归属部门 + 祖先链；2. 主管向上（该用户任主管的部门及其子树）；3. 隐式全员组。
pub async fn user_effective_groups(pool: &sqlx::PgPool, user_id: i64) -> Result<Vec<String>, StoreError> {
    let member = crate::groups::user_groups(pool, user_id).await?;
    let nodes = load_group_tree(pool).await?;
    let (children, by_id) = index_tree(&nodes);

    let mut effective: std::collections::HashSet<i64> = std::collections::HashSet::new();
    for name in &member {
        if let Some(n) = find_node_by_name(&by_id, name) {
            for a in ancestors_of(&by_id, n.id) {
                effective.insert(a);
            }
        }
    }
    for n in &nodes {
        if n.leader == user_id {
            for s in subtree_of(&children, n.id) {
                effective.insert(s);
            }
        }
    }
    // 隐式全员组
    if let Some(n) = find_node_by_name(&by_id, EVERYONE_GROUP_NAME) {
        effective.insert(n.id);
    }
    let mut out: Vec<String> = effective
        .iter()
        .filter_map(|id| by_id.get(id).map(|n| n.name.clone()))
        .collect();
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn effective_groups_inheritance() {
        let pool = crate::testutil::new_test_db().await;
        // 建用户
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
        // 建部门: 研发部(顶级) -> 前端组(子部门), 主管=alice
        let dev = crate::departments::create_department(&pool, "研发部", 0, 0, "").await.unwrap();
        let fe = crate::departments::create_department(&pool, "前端组", dev, uid, "").await.unwrap();
        // alice 挂前端组
        crate::groups::add_user_group(&pool, uid, fe).await.unwrap();
        let eff = user_effective_groups(&pool, uid).await.unwrap();
        // 主管向上: alice 是「前端组」主管 → 前端组+其祖先(研发部) 都在有效组
        assert!(eff.contains(&"前端组".to_string()), "eff={eff:?}");
        assert!(eff.contains(&"研发部".to_string()), "eff={eff:?}");
        // 无全员组时(未 seed)不含
    }
}
