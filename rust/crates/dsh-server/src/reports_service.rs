//! 报表服务层（Go `server/internal/reports` 等价）。
//!
//! 报表订阅管理：webhook 订阅 CRUD + 运行标记。

use picoaide_dsh_store::errors::StoreError;
use serde_json::{json, Value};
use sqlx::PgPool;

/// ReportsService 报表服务。
#[derive(Clone)]
pub struct ReportsService {
    pub pool: PgPool,
}

impl ReportsService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// list 报表订阅列表。
    pub async fn list(&self) -> Result<Value, StoreError> {
        let rows = picoaide_dsh_store::reports::list_report_subscriptions(&self.pool).await?;
        let items: Vec<Value> = rows
            .iter()
            .map(|r| json!({ "id": r.id, "name": r.name, "enabled": r.enabled, "hook_url": r.hook_url }))
            .collect();
        Ok(json!({ "subscriptions": items }))
    }

    /// create 创建订阅。
    pub async fn create(&self, name: &str, enabled: bool, hook_url: &str) -> Result<Value, StoreError> {
        if name.is_empty() || hook_url.is_empty() {
            return Err(StoreError::Validation);
        }
        picoaide_dsh_store::reports::create_report_subscription(&self.pool, name, hook_url, enabled).await?;
        Ok(json!({ "ok": true }))
    }

    /// update 更新订阅。
    pub async fn update(&self, id: i64, name: &str, enabled: bool, hook_url: &str) -> Result<Value, StoreError> {
        picoaide_dsh_store::reports::update_report_subscription(&self.pool, id, name, hook_url, enabled).await?;
        Ok(json!({ "ok": true }))
    }

    /// delete 删除订阅。
    pub async fn delete(&self, id: i64) -> Result<Value, StoreError> {
        picoaide_dsh_store::reports::delete_report_subscription(&self.pool, id).await?;
        Ok(json!({ "ok": true }))
    }

    /// mark_run 标记一次运行（成功/失败）。
    pub async fn mark_run(&self, id: i64, ok: bool, error: &str) -> Result<Value, StoreError> {
        picoaide_dsh_store::reports::mark_report_run(&self.pool, id, ok, error).await?;
        Ok(json!({ "ok": true }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use picoaide_dsh_store::testutil::new_test_db;

    #[tokio::test]
    async fn report_subscription_crud() {
        let pool = new_test_db().await;
        let svc = ReportsService::new(pool.clone());
        svc.create("日报", true, "https://hook/x").await.unwrap();
        let r = svc.list().await.unwrap();
        let subs = r["subscriptions"].as_array().unwrap();
        assert_eq!(subs.len(), 1);
        let id = subs[0]["id"].as_i64().unwrap();
        // 更新
        svc.update(id, "日报v2", false, "https://hook/y").await.unwrap();
        let r = svc.list().await.unwrap();
        let subs = r["subscriptions"].as_array().unwrap();
        assert_eq!(subs[0]["name"], "日报v2");
        assert_eq!(subs[0]["enabled"], false);
        // mark_run
        svc.mark_run(id, true, "").await.unwrap();
        // 删除
        svc.delete(id).await.unwrap();
        let r = svc.list().await.unwrap();
        assert_eq!(r["subscriptions"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn report_validation() {
        let pool = new_test_db().await;
        let svc = ReportsService::new(pool);
        assert!(svc.create("", true, "x").await.is_err());
    }
}
