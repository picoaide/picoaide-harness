//! 能力锁定域（Go `serverstore/capability_locks.go` 等价）。
//!
//! 决策 2026-09-01 D4:管理员把某个技能/智能体标记为锁定后,员工发布该名字
//! 一律被明确拒绝并回显 Reason。锁定与授权(可见性)、上下架、质量标记正交,
//! 且允许对尚不存在的名字预先锁定(占名),防止员工抢占官方命名。

use crate::errors::{map_db_error, StoreError};
use chrono::{DateTime, Utc};
use sqlx::Row;

/// CapabilityLock 是一条「仅管理员可发布」的锁定记录(迁移 0050)。
#[derive(Debug, Clone, Default)]
pub struct CapabilityLock {
    pub kind: String,
    pub name: String,
    pub reason: String,
    pub locked_by: String,
    pub created_at: DateTime<Utc>,
}

/// CapabilityKindSkill/Agent 是 capability_locks.kind 的合法取值。
pub const CAPABILITY_KIND_SKILL: &str = "skill";
pub const CAPABILITY_KIND_AGENT: &str = "agent";

/// ValidCapabilityKind reports whether kind is a supported lock target.
pub fn valid_capability_kind(kind: &str) -> bool {
    kind == CAPABILITY_KIND_SKILL || kind == CAPABILITY_KIND_AGENT
}

/// LockCapability marks one capability name as admin-only publishable
/// (idempotent upsert: 重复锁定只更新理由与操作人)。
pub async fn lock_capability(
    pool: &sqlx::PgPool,
    kind: &str,
    name: &str,
    reason: &str,
    by: &str,
) -> Result<(), StoreError> {
    if !valid_capability_kind(kind) {
        return Err(StoreError::Validation);
    }
    sqlx::query(
        r#"INSERT INTO capability_locks (kind, name, reason, locked_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(kind, name) DO UPDATE SET reason = excluded.reason, locked_by = excluded.locked_by"#,
    )
    .bind(kind)
    .bind(name.trim())
    .bind(reason.trim())
    .bind(by)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(())
}

/// UnlockCapability removes a lock; ErrNotFound when the name was not locked.
pub async fn unlock_capability(
    pool: &sqlx::PgPool,
    kind: &str,
    name: &str,
) -> Result<(), StoreError> {
    let res = sqlx::query("DELETE FROM capability_locks WHERE kind = $1 AND name = $2")
        .bind(kind)
        .bind(name)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

fn scan_lock(row: &sqlx::postgres::PgRow) -> CapabilityLock {
    CapabilityLock {
        kind: row.get("kind"),
        name: row.get("name"),
        reason: row.get("reason"),
        locked_by: row.get("locked_by"),
        created_at: row.get("created_at"),
    }
}

/// GetCapabilityLock returns the lock for one name, or ErrNotFound.
pub async fn get_capability_lock(
    pool: &sqlx::PgPool,
    kind: &str,
    name: &str,
) -> Result<CapabilityLock, StoreError> {
    let row = sqlx::query(
        "SELECT kind, name, reason, locked_by, created_at FROM capability_locks WHERE kind = $1 AND name = $2",
    )
    .bind(kind)
    .bind(name)
    .fetch_optional(pool)
    .await
    .map_err(map_db_error)?
    .ok_or(StoreError::NotFound)?;
    Ok(scan_lock(&row))
}

/// ListCapabilityLocks returns every lock (admin view), name-ordered.
pub async fn list_capability_locks(pool: &sqlx::PgPool) -> Result<Vec<CapabilityLock>, StoreError> {
    let rows = sqlx::query(
        "SELECT kind, name, reason, locked_by, created_at FROM capability_locks ORDER BY kind, name",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_error)?;
    Ok(rows.iter().map(scan_lock).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;

    #[tokio::test]
    async fn capability_lock_lifecycle() {
        let pool = new_test_db().await;
        // 预锁定一个尚不存在的名字(占名,防止员工抢占官方命名)。
        lock_capability(
            &pool,
            CAPABILITY_KIND_SKILL,
            "  org-official  ",
            "  官方技能,仅管理员维护  ",
            "admin",
        )
        .await
        .unwrap();
        let l = get_capability_lock(&pool, CAPABILITY_KIND_SKILL, "org-official")
            .await
            .unwrap();
        // 名称与理由均被 trim。
        assert_eq!(l.name, "org-official");
        assert_eq!(l.reason, "官方技能,仅管理员维护");
        assert_eq!(l.locked_by, "admin");
        // 幂等:重复锁定只更新理由与操作人。
        lock_capability(&pool, CAPABILITY_KIND_SKILL, "org-official", "改了理由", "boss")
            .await
            .unwrap();
        let l = get_capability_lock(&pool, CAPABILITY_KIND_SKILL, "org-official")
            .await
            .unwrap();
        assert_eq!(l.reason, "改了理由");
        assert_eq!(l.locked_by, "boss");
        // kind 隔离:同名的 agent 不受 skill 锁影响。
        assert_eq!(
            get_capability_lock(&pool, CAPABILITY_KIND_AGENT, "org-official")
                .await
                .unwrap_err(),
            StoreError::NotFound
        );
        let list = list_capability_locks(&pool).await.unwrap();
        assert_eq!(list.len(), 1);
        unlock_capability(&pool, CAPABILITY_KIND_SKILL, "org-official")
            .await
            .unwrap();
        assert_eq!(
            get_capability_lock(&pool, CAPABILITY_KIND_SKILL, "org-official")
                .await
                .unwrap_err(),
            StoreError::NotFound
        );
        // 重复解锁 = ErrNotFound。
        assert_eq!(
            unlock_capability(&pool, CAPABILITY_KIND_SKILL, "org-official")
                .await
                .unwrap_err(),
            StoreError::NotFound
        );
        // 非法 kind 必须拒绝。
        assert_eq!(
            lock_capability(&pool, "bogus", "x", "", "admin")
                .await
                .unwrap_err(),
            StoreError::Validation
        );
    }

    #[tokio::test]
    async fn capability_lock_list_orders() {
        let pool = new_test_db().await;
        lock_capability(&pool, CAPABILITY_KIND_AGENT, "a2", "r", "admin")
            .await
            .unwrap();
        lock_capability(&pool, CAPABILITY_KIND_SKILL, "s1", "r", "admin")
            .await
            .unwrap();
        lock_capability(&pool, CAPABILITY_KIND_SKILL, "s2", "r", "admin")
            .await
            .unwrap();
        let list = list_capability_locks(&pool).await.unwrap();
        let keys: Vec<(String, String)> = list.iter().map(|l| (l.kind.clone(), l.name.clone())).collect();
        assert_eq!(
            keys,
            vec![
                ("agent".to_string(), "a2".to_string()),
                ("skill".to_string(), "s1".to_string()),
                ("skill".to_string(), "s2".to_string()),
            ]
        );
    }
}
