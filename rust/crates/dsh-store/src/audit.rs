//! 审计域（Go `serverstore/audit.go` 等价）——0048 哈希链防篡改。

use crate::errors::{map_db_error, StoreError};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use sqlx::Row;

/// AuditLogEntry 一条审计日志行。
#[derive(Debug, Clone, Default)]
pub struct AuditLogEntry {
    pub id: i64,
    pub username: String,
    pub action: String,
    pub detail: String,
    pub prev_hash: String,
    pub hash: String,
    pub created_at: DateTime<Utc>,
}

/// audit_hash_payload 写入时的载荷（与 Go 一致）。
pub fn audit_hash_payload(prev_hash: &str, username: &str, action: &str, detail: &str, created_at: &str) -> String {
    format!("{prev_hash}|{username}|{action}|{detail}|{created_at}")
}

/// sha256_hex 十六进制摘要。
fn sha256_hex(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    hex::encode(hasher.finalize())
}

/// AuditLog 追加审计条目（哈希链：hash = sha256(prev|user|action|detail|created_at)）。
pub async fn audit_log(
    pool: &sqlx::PgPool,
    username: &str,
    action: &str,
    detail: &str,
) -> Result<(), StoreError> {
    let prev_hash: Option<String> = sqlx::query_scalar("SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1")
        .fetch_optional(pool)
        .await
        .map_err(map_db_error)?;
    let prev_hash = prev_hash.unwrap_or_default();
    let now = Utc::now();
    let now_str = now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let payload = audit_hash_payload(&prev_hash, username, action, detail, &now_str);
    let hash = sha256_hex(&payload);
    sqlx::query(
        "INSERT INTO audit_logs (username, action, detail, prev_hash, hash, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(username)
    .bind(action)
    .bind(detail)
    .bind(&prev_hash)
    .bind(&hash)
    .bind(now)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(())
}

/// VerifyAuditChain 从旧到新校验每条哈希链接，返回首个断裂条目 id（完整=0）。
pub async fn verify_audit_chain(pool: &sqlx::PgPool) -> Result<i64, StoreError> {
    let rows = sqlx::query(
        "SELECT id, username, action, detail, prev_hash, hash, created_at FROM audit_logs ORDER BY id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_error)?;
    let mut prev_hash = String::new();
    for r in rows {
        let id: i64 = r.get("id");
        let username: String = r.get("username");
        let action: String = r.get("action");
        let detail: String = r.get("detail");
        let row_prev: String = r.get("prev_hash");
        let row_hash: String = r.get("hash");
        let created: DateTime<Utc> = r.get("created_at");
        // 0048 之前的旧行 hash 为空：跳过链接检查
        if row_hash.is_empty() {
            continue;
        }
        if row_prev != prev_hash {
            return Ok(id);
        }
        let created_str = created.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let payload = audit_hash_payload(&row_prev, &username, &action, &detail, &created_str);
        if sha256_hex(&payload) != row_hash {
            return Ok(id);
        }
        prev_hash = row_hash;
    }
    Ok(0)
}

/// ListAuditLogs 返回最近审计条目（limit<=0: 50）。
pub async fn list_audit_logs(pool: &sqlx::PgPool, limit: i32) -> Result<Vec<AuditLogEntry>, StoreError> {
    let limit = if limit <= 0 { 50 } else { limit };
    let (logs, _) = list_audit_logs_paged(pool, 0, i64::from(limit)).await?;
    Ok(logs)
}

/// ListAuditLogsPaged 返回分页审计条目（最新在前）+ 总数。
pub async fn list_audit_logs_paged(
    pool: &sqlx::PgPool,
    offset: i64,
    limit: i64,
) -> Result<(Vec<AuditLogEntry>, i64), StoreError> {
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_logs")
        .fetch_one(pool)
        .await
        .map_err(map_db_error)?;
    let rows = sqlx::query(
        "SELECT id, username, action, detail, prev_hash, hash, created_at FROM audit_logs ORDER BY id DESC LIMIT $1 OFFSET $2",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
    .map_err(map_db_error)?;
    let out = rows.into_iter().map(scan_entry).collect();
    Ok((out, total))
}

/// ListAuditLogsPagedFiltered 分页 + action/username 过滤。
pub async fn list_audit_logs_paged_filtered(
    pool: &sqlx::PgPool,
    offset: i64,
    limit: i64,
    action: &str,
    username: &str,
) -> Result<(Vec<AuditLogEntry>, i64), StoreError> {
    let mut where_clause = String::new();
    if !action.is_empty() {
        where_clause.push_str(" AND action = $1");
    }
    if !username.is_empty() {
        where_clause.push_str(" AND username = $2");
    }
    let where_clause = where_clause.trim_start_matches(" AND ").to_string();
    let total: i64 = if where_clause.is_empty() {
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_logs")
            .fetch_one(pool)
            .await
            .map_err(map_db_error)?
    } else {
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM audit_logs WHERE {where_clause}"))
            .bind(if action.is_empty() { "" } else { action })
            .bind(if username.is_empty() { "" } else { username })
            .fetch_one(pool)
            .await
            .map_err(map_db_error)?
    };
    let q = if where_clause.is_empty() {
        format!("SELECT id, username, action, detail, prev_hash, hash, created_at FROM audit_logs ORDER BY id DESC LIMIT ${} OFFSET ${}", 1, 2)
    } else {
        format!("SELECT id, username, action, detail, prev_hash, hash, created_at FROM audit_logs WHERE {where_clause} ORDER BY id DESC LIMIT $3 OFFSET $4")
    };
    let mut query = sqlx::query(&q);
    if !where_clause.is_empty() {
        query = query.bind(action).bind(username).bind(limit).bind(offset);
    } else {
        query = query.bind(limit).bind(offset);
    }
    let rows = query.fetch_all(pool).await.map_err(map_db_error)?;
    let out = rows.into_iter().map(scan_entry).collect();
    Ok((out, total))
}

fn scan_entry(r: sqlx::postgres::PgRow) -> AuditLogEntry {
    AuditLogEntry {
        id: r.get("id"),
        username: r.get("username"),
        action: r.get("action"),
        detail: r.get("detail"),
        prev_hash: r.get("prev_hash"),
        hash: r.get("hash"),
        created_at: r.get("created_at"),
    }
}

/// PurgeOldAuditLogs 删除早于 cutoff 的审计条目。
pub async fn purge_old_audit_logs(pool: &sqlx::PgPool, cutoff: DateTime<Utc>) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM audit_logs WHERE created_at < $1")
        .bind(cutoff)
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
    async fn audit_hash_chain() {
        let pool = new_test_db().await;
        audit_log(&pool, "admin", "user_create", "alice").await.unwrap();
        audit_log(&pool, "admin", "user_update", "bob").await.unwrap();
        assert_eq!(verify_audit_chain(&pool).await.unwrap(), 0);
        // 篡改第一条 detail → 链断
        sqlx::query("UPDATE audit_logs SET detail = 'hacked' WHERE id = (SELECT MIN(id) FROM audit_logs)")
            .execute(&pool)
            .await
            .unwrap();
        let broken = verify_audit_chain(&pool).await.unwrap();
        assert!(broken > 0);
        // 分页
        let (logs, total) = list_audit_logs_paged(&pool, 0, 10).await.unwrap();
        assert_eq!(total, 2);
        assert_eq!(logs.len(), 2);
        // 过滤
        let (logs, total) = list_audit_logs_paged_filtered(&pool, 0, 10, "user_create", "").await.unwrap();
        assert_eq!(total, 1);
        assert_eq!(logs[0].action, "user_create");
    }
}
