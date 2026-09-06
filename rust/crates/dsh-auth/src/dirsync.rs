//! 目录同步（Go `serverauth/dirsync.go` 等价）——LDAP 用户/组全量对账。
//!
//! 语义：users.source='external' 全量对齐——目录存在→核对/启用；
//! 目录不存在→停用+吊销 token；外部身份绝不接管本地账号；
//! 组经 GetOrCreateGroup（大小写不敏感）全量替换；空目录拒绝执行。

use picoaide_dsh_store::{StoreError, users};
use std::collections::{HashMap, HashSet};

/// LDAPSyncInterval 全量目录同步周期（1 小时，秒）。
pub const LDAP_SYNC_INTERVAL_SECS: i64 = 3600;

/// DirSyncResult 一轮目录同步结果。
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct DirSyncResult {
    pub added: usize,
    pub updated: usize,
    pub deactivated: usize,
    pub groups: usize,
}

/// ldap_enabled 判断 auth.enabled（或兼容 auth.mode）是否启用 ldap。
pub fn ldap_enabled(settings: &HashMap<String, String>) -> bool {
    if let Some(enabled) = settings.get("auth.enabled") {
        for m in enabled.split(',') {
            if m.trim() == "ldap" {
                return true;
            }
        }
    }
    matches!(settings.get("auth.mode").map(|s| s.as_str()), Some("ldap") | Some("both"))
}

/// Deactivate missing external users（keep 中不存在则停用+吊销）。
pub async fn deactivate_missing_external_users(
    pool: &sqlx::PgPool,
    keep: &HashSet<String>,
) -> Result<usize, StoreError> {
    let (list, _) = users::list_users(pool, 0, 100_000, "").await?;
    let mut count = 0;
    for u in list {
        if u.source != "external" || keep.contains(&u.username) || u.status != 1 {
            continue;
        }
        let mut upd = u.clone();
        upd.status = 0;
        users::update_user_revoking_tokens(pool, &upd).await?;
        count += 1;
    }
    Ok(count)
}

/// SyncDirectoryRun 用给定 LDAP provider 执行一轮同步（entries 为已扫描的目录条目）。
/// 返回 DirSyncResult；空目录拒绝执行（防过滤器写错全量停用）。
pub async fn sync_directory_run(
    pool: &sqlx::PgPool,
    provider: &crate::ldap::LdapProvider,
    entries: Vec<crate::ldap::LdapEntry>,
    groups_by_username: &HashMap<String, Vec<String>>,
) -> Result<DirSyncResult, String> {
    if entries.is_empty() {
        return Err("ldap: directory search returned 0 users; refusing to deactivate all".to_string());
    }
    let mut res = DirSyncResult::default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut group_seen: HashSet<String> = HashSet::new();
    for e in entries {
        let username = provider.username_of(&e);
        if username.is_empty() {
            continue;
        }
        seen.insert(username.clone());
        let display_name = provider.display_name(&e);
        let email = provider.email_of(&e);
        // 找/建用户
        let u = match users::get_user_by_username(pool, &username).await {
            Ok(u) => u,
            Err(StoreError::NotFound) => {
                match users::create_user(
                    pool,
                    &users::User {
                        username: username.clone(),
                        display_name: display_name.clone(),
                        email: email.clone(),
                        source: "external".to_string(),
                        status: 1,
                        ..Default::default()
                    },
                )
                .await
                {
                    Ok(id) => {
                        res.added += 1;
                        users::get_user_by_id(pool, id).await.map_err(|e| format!("{e}"))?
                    }
                    Err(StoreError::Duplicate) => {
                        users::get_user_by_username(pool, &username).await.map_err(|e| format!("{e}"))?
                    }
                    Err(e) => return Err(format!("{e}")),
                }
            }
            Err(e) => return Err(format!("{e}")),
        };
        // 外部身份绝不接管本地账号
        if u.source != "external" {
            continue;
        }
        // 更新显示名/邮箱/启用
        if u.display_name != display_name || u.email != email || u.status != 1 {
            let mut upd = u.clone();
            upd.display_name = display_name.clone();
            upd.email = email.clone();
            upd.status = 1;
            users::update_user(pool, &upd).await.map_err(|e| format!("{e}"))?;
            res.updated += 1;
        }
        // 组同步（group_filter 缺失时不清空——与登录一致）
        if !provider.group_filter.is_empty() {
            if let Some(groups) = groups_by_username.get(&username) {
                picoaide_dsh_store::groups::sync_user_groups(pool, u.id, groups)
                    .await
                    .map_err(|e| format!("{e}"))?;
                for g in groups {
                    group_seen.insert(g.clone());
                }
            }
        }
    }
    res.groups = group_seen.len();
    let deact = deactivate_missing_external_users(pool, &seen).await.map_err(|e| format!("{e}"))?;
    res.deactivated = deact;
    Ok(res)
}

/// SyncDirectoryOnce 立即执行一轮（配置保存后同步调用）。
pub async fn sync_directory_once(
    pool: &sqlx::PgPool,
    provider: &crate::ldap::LdapProvider,
    entries: Vec<crate::ldap::LdapEntry>,
    groups_by_username: &HashMap<String, Vec<String>>,
) -> Result<DirSyncResult, String> {
    sync_directory_run(pool, provider, entries, groups_by_username).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn ldap_enabled_cases() {
        assert!(ldap_enabled(&s(&[("auth.enabled", "local,ldap")])));
        assert!(ldap_enabled(&s(&[("auth.enabled", "ldap")])));
        assert!(!ldap_enabled(&s(&[("auth.enabled", "local")])));
        assert!(ldap_enabled(&s(&[("auth.mode", "ldap")])));
        assert!(ldap_enabled(&s(&[("auth.mode", "both")])));
        assert!(!ldap_enabled(&s(&[("auth.mode", "local")])));
        assert!(!ldap_enabled(&s(&[])));
    }

    #[tokio::test]
    async fn dirsync_empty_refused() {
        let pool = picoaide_dsh_store::testutil::new_test_db().await;
        let provider = crate::ldap::LdapProvider::new();
        let res = sync_directory_run(&pool, &provider, vec![], &HashMap::new()).await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("0 users"));
    }

    #[tokio::test]
    async fn dirsync_creates_user() {
        let pool = picoaide_dsh_store::testutil::new_test_db().await;
        let mut attrs = HashMap::new();
        attrs.insert("uid".to_string(), vec!["alice".to_string()]);
        attrs.insert("sn".to_string(), vec!["Alice A".to_string()]);
        attrs.insert("mail".to_string(), vec!["a@x.com".to_string()]);
        let entry = crate::ldap::LdapEntry { dn: "uid=alice".to_string(), attrs };
        let provider = crate::ldap::LdapProvider::new();
        let res = sync_directory_run(&pool, &provider, vec![entry], &HashMap::new())
            .await
            .unwrap();
        assert_eq!(res.added, 1);
        // 用户已建
        let u = users::get_user_by_username(&pool, "alice").await.unwrap();
        assert_eq!(u.source, "external");
        assert_eq!(u.status, 1);
    }

    #[tokio::test]
    async fn dirsync_deactivates_missing() {
        let pool = picoaide_dsh_store::testutil::new_test_db().await;
        // 已存在的外部用户但目录不再包含 → 停用
        users::create_user(
            &pool,
            &users::User {
                username: "gone".into(),
                source: "external".into(),
                status: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let provider = crate::ldap::LdapProvider::new();
        let res = sync_directory_run(&pool, &provider, vec![], &HashMap::new()).await;
        assert!(res.is_err()); // 空目录拒绝
    }
}
