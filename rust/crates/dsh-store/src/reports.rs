//! 报表订阅域（Go `serverstore/reports.go` 等价）。
//!
//! 报表订阅(2026-09 P1):每月生成上月用量汇总推送 webhook 的订阅配置。

use crate::errors::{map_db_error, StoreError};
use chrono::{DateTime, Utc};
use sqlx::Row;

/// ReportSubscription 一条订阅配置。
#[derive(Debug, Clone, Default)]
pub struct ReportSubscription {
    pub id: i64,
    pub name: String,
    pub enabled: bool,
    pub hook_url: String,
    pub last_run_at: Option<DateTime<Utc>>,
    pub last_error: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// ListReportSubscriptions 全量列表(按 id)。
pub async fn list_report_subscriptions(
    pool: &sqlx::PgPool,
) -> Result<Vec<ReportSubscription>, StoreError> {
    let rows = sqlx::query(
        r#"SELECT id, name, enabled, hook_url, last_run_at, last_error, created_at, updated_at
        FROM report_subscriptions ORDER BY id"#,
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_error)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(ReportSubscription {
            id: r.get("id"),
            name: r.get("name"),
            enabled: r.get::<i32, _>("enabled") != 0,
            hook_url: r.get("hook_url"),
            last_run_at: r.get("last_run_at"),
            last_error: r.get("last_error"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
        });
    }
    Ok(out)
}

/// CreateReportSubscription 新建订阅。
pub async fn create_report_subscription(
    pool: &sqlx::PgPool,
    name: &str,
    hook_url: &str,
    enabled: bool,
) -> Result<i64, StoreError> {
    let row = sqlx::query(
        r#"INSERT INTO report_subscriptions (name, enabled, hook_url) VALUES ($1, $2, $3) RETURNING id"#,
    )
    .bind(name)
    .bind(if enabled { 1 } else { 0 })
    .bind(hook_url)
    .fetch_one(pool)
    .await
    .map_err(map_db_error)?;
    Ok(row.get("id"))
}

/// UpdateReportSubscription 更新订阅(name/enabled/hook_url)。
pub async fn update_report_subscription(
    pool: &sqlx::PgPool,
    id: i64,
    name: &str,
    hook_url: &str,
    enabled: bool,
) -> Result<(), StoreError> {
    let res = sqlx::query(
        r#"UPDATE report_subscriptions SET name = $1, enabled = $2, hook_url = $3, updated_at = now() WHERE id = $4"#,
    )
    .bind(name)
    .bind(if enabled { 1 } else { 0 })
    .bind(hook_url)
    .bind(id)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// DeleteReportSubscription 删除订阅。
pub async fn delete_report_subscription(
    pool: &sqlx::PgPool,
    id: i64,
) -> Result<(), StoreError> {
    let res = sqlx::query("DELETE FROM report_subscriptions WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// MarkReportRun 记录一次推送结果(成功=last_run_at;失败=last_error)。
pub async fn mark_report_run(
    pool: &sqlx::PgPool,
    id: i64,
    ok: bool,
    err_msg: &str,
) -> Result<(), StoreError> {
    if ok {
        sqlx::query(
            r#"UPDATE report_subscriptions SET last_run_at = now(), last_error = '', updated_at = now() WHERE id = $1"#,
        )
        .bind(id)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    } else {
        sqlx::query(
            r#"UPDATE report_subscriptions SET last_error = $1, updated_at = now() WHERE id = $2"#,
        )
        .bind(err_msg)
        .bind(id)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;

    #[tokio::test]
    async fn report_subscription_lifecycle() {
        let pool = new_test_db().await;
        let id = create_report_subscription(&pool, "钉钉推送", "https://example.com/hook", true)
            .await
            .unwrap();
        assert!(id > 0);

        let list = list_report_subscriptions(&pool).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "钉钉推送");
        assert!(list[0].enabled);
        assert!(list[0].last_run_at.is_none());

        // 更新(禁用)。
        update_report_subscription(&pool, id, "钉钉推送", "https://example.com/hook2", false)
            .await
            .unwrap();
        let list = list_report_subscriptions(&pool).await.unwrap();
        assert!(!list[0].enabled);
        assert_eq!(list[0].hook_url, "https://example.com/hook2");

        // MarkReportRun 成功路径:last_run_at 置位、last_error 清空。
        mark_report_run(&pool, id, true, "").await.unwrap();
        let list = list_report_subscriptions(&pool).await.unwrap();
        assert!(list[0].last_run_at.is_some());
        assert_eq!(list[0].last_error, "");

        // MarkReportRun 失败路径:last_error 记录,last_run_at 不变。
        let before = list[0].last_run_at;
        mark_report_run(&pool, id, false, "webhook 500").await.unwrap();
        let list = list_report_subscriptions(&pool).await.unwrap();
        assert_eq!(list[0].last_error, "webhook 500");
        assert_eq!(list[0].last_run_at, before);

        // 删除 + 不存在。
        delete_report_subscription(&pool, id).await.unwrap();
        assert!(list_report_subscriptions(&pool).await.unwrap().is_empty());
        assert_eq!(
            delete_report_subscription(&pool, id).await.unwrap_err(),
            StoreError::NotFound
        );
        // 更新不存在 → NotFound。
        assert_eq!(
            update_report_subscription(&pool, id, "x", "y", true)
                .await
                .unwrap_err(),
            StoreError::NotFound
        );
        // MarkReportRun 对不存在行不报错(与 Go 一致:无行匹配即视为完成)。
        mark_report_run(&pool, id, true, "").await.unwrap();
    }
}
