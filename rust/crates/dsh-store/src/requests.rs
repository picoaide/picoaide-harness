//! 用量请求明细域（Go `serverstore/requests.go` 等价）。

use crate::errors::{map_db_error, StoreError};
use chrono::{DateTime, Utc};
use sqlx::Row;

/// UsageRequestRow 一条用量请求明细。
#[derive(Debug, Clone, Default)]
pub struct UsageRequestRow {
    pub id: i64,
    pub time: DateTime<Utc>,
    pub user_id: i64,
    pub model: String,
    pub kind: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_tokens: i64,
    pub cost: f64,
    pub username: String,
}

/// ListUsageRequests 分页查询用量请求明细（过滤：from/to/username/model/kind）。
pub async fn list_usage_requests(
    pool: &sqlx::PgPool,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
    username: &str,
    model: &str,
    kind: &str,
    page: i64,
    size: i64,
) -> Result<(Vec<UsageRequestRow>, i64), StoreError> {
    let page = if page < 1 { 1 } else { page };
    let size = if size < 1 || size > 100 { 20 } else { size };
    let mut where_clause = vec![];
    let mut binds: Vec<String> = vec![];
    let mut bind_idx = 1usize;
    if let Some(f) = from {
        where_clause.push(format!("u.created_at >= ${bind_idx}::timestamptz"));
        binds.push(f.to_rfc3339());
        bind_idx += 1;
    }
    if let Some(t) = to {
        where_clause.push(format!("u.created_at < ${bind_idx}::timestamptz"));
        binds.push(t.to_rfc3339());
        bind_idx += 1;
    }
    if !username.is_empty() {
        where_clause.push(format!("u.user_id = (SELECT id FROM users WHERE username = ${bind_idx})"));
        binds.push(username.to_string());
        bind_idx += 1;
    }
    if !model.is_empty() {
        where_clause.push(format!("u.model = ${bind_idx}"));
        binds.push(model.to_string());
        bind_idx += 1;
    }
    if !kind.is_empty() {
        where_clause.push(format!("u.kind = ${bind_idx}"));
        binds.push(kind.to_string());
        bind_idx += 1;
    }
    let cond = if where_clause.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", where_clause.join(" AND "))
    };

    let total_q = format!("SELECT COUNT(*) FROM usage u{cond}");
    let mut total_query = sqlx::query_scalar(&total_q);
    for b in &binds {
        total_query = total_query.bind(b.clone());
    }
    let total: i64 = total_query.fetch_one(pool).await.map_err(map_db_error)?;

    let offset = (page - 1) * size;
    let limit_idx = bind_idx;
    let offset_idx = bind_idx + 1;
    let q = format!(
        "SELECT u.id, u.created_at, u.user_id, u.model, u.kind, u.prompt_tokens, u.completion_tokens, u.cache_prompt_tokens, u.cost, COALESCE(us.username, '') AS username FROM usage u LEFT JOIN users us ON us.id = u.user_id{cond} ORDER BY u.id DESC LIMIT ${limit_idx} OFFSET ${offset_idx}",
    );
    let mut query = sqlx::query(&q);
    for b in &binds {
        query = query.bind(b.clone());
    }
    query = query.bind(size).bind(offset);
    let rows = query.fetch_all(pool).await.map_err(map_db_error)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(UsageRequestRow {
            id: r.get("id"),
            time: r.get("created_at"),
            user_id: r.get::<i32, _>("user_id") as i64,
            model: r.get("model"),
            kind: r.get("kind"),
            prompt_tokens: r.get("prompt_tokens"),
            completion_tokens: r.get("completion_tokens"),
            cache_tokens: r.get("cache_prompt_tokens"),
            cost: r.get("cost"),
            username: r.get("username"),
        });
    }
    Ok((out, total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;

    #[tokio::test]
    async fn list_requests_filter() {
        let pool = new_test_db().await;
        let uid = crate::users::create_user(
            &pool,
            &crate::users::User {
                username: "req".into(),
                source: "local".into(),
                status: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        crate::usage::record_usage(&pool, uid, "m1", 100, 50).await.unwrap();
        crate::usage::record_usage_kind(&pool, uid, "m1", 10, 0, "embedding").await.unwrap();
        let (rows, total) = list_usage_requests(&pool, None, None, "", "", "", 1, 20).await.unwrap();
        assert_eq!(total, 2);
        assert_eq!(rows.len(), 2);
        // 按 kind 过滤
        let (rows, total) = list_usage_requests(&pool, None, None, "", "", "embedding", 1, 20).await.unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows[0].kind, "embedding");
        // 分页
        let (rows, total) = list_usage_requests(&pool, None, None, "", "", "", 1, 1).await.unwrap();
        assert_eq!(total, 2);
        assert_eq!(rows.len(), 1);
    }
}
