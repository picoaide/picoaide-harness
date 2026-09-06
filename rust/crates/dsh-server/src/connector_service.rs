//! 连接器服务层（Go `server/internal/connectors` 等价）。
//!
//! 连接器目录管理：list/get/create/update/enable/delete + 验证。
//! 客户端连接器中心的唯一定义源（definition 内嵌）。

use picoaide_dsh_store::connectors::{Connector, create_connector, delete_connector, get_connector, list_connectors, list_enabled_connectors, set_connector_enabled, update_connector, validate_connector};
use picoaide_dsh_store::errors::StoreError;
use serde_json::{json, Value};
use sqlx::PgPool;

/// ConnectorService 连接器服务。
#[derive(Clone)]
pub struct ConnectorService {
    pub pool: PgPool,
}

impl ConnectorService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// list 全部连接器（admin）。
    pub async fn list(&self) -> Result<Value, StoreError> {
        let rows = list_connectors(&self.pool).await?;
        let items: Vec<Value> = rows.iter().map(connector_json).collect();
        Ok(json!({ "connectors": items }))
    }

    /// list_enabled 启用连接器（客户端）。
    pub async fn list_enabled(&self) -> Result<Value, StoreError> {
        let rows = list_enabled_connectors(&self.pool).await?;
        let items: Vec<Value> = rows.iter().map(connector_json).collect();
        Ok(json!({ "connectors": items }))
    }

    /// get 单个连接器。
    pub async fn get(&self, id: &str) -> Result<Value, StoreError> {
        let c = get_connector(&self.pool, id).await?;
        Ok(json!({ "connector": connector_json(&c) }))
    }

    /// create 创建连接器（validate_connector 校验）。
    pub async fn create(&self, c: &Connector) -> Result<Value, StoreError> {
        validate_connector(c)?;
        create_connector(&self.pool, c).await?;
        Ok(json!({ "ok": true, "id": c.id }))
    }

    /// update 更新连接器。
    pub async fn update(&self, c: &Connector) -> Result<Value, StoreError> {
        validate_connector(c)?;
        update_connector(&self.pool, c).await?;
        Ok(json!({ "ok": true }))
    }

    /// set_enabled 启用/禁用。
    pub async fn set_enabled(&self, id: &str, enabled: bool) -> Result<Value, StoreError> {
        set_connector_enabled(&self.pool, id, enabled).await?;
        Ok(json!({ "ok": true }))
    }

    /// delete 删除连接器。
    pub async fn delete(&self, id: &str) -> Result<Value, StoreError> {
        delete_connector(&self.pool, id).await?;
        Ok(json!({ "ok": true }))
    }
}

fn connector_json(c: &Connector) -> Value {
    json!({
        "id": c.id,
        "name": c.name,
        "description": c.description,
        "auth_mode": c.auth_mode,
        "definition": c.definition,
        "enabled": c.enabled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use picoaide_dsh_store::testutil::new_test_db;

    #[tokio::test]
    async fn connector_crud() {
        let pool = new_test_db().await;
        let svc = ConnectorService::new(pool.clone());
        // 创建
        svc.create(&Connector {
            id: "feishu".into(),
            name: "飞书".into(),
            description: "飞书连接器".into(),
            auth_mode: "oauth".into(),
            definition: r#"{"mcp":[{"serverName":"feishu"}]}"#.into(),
            enabled: false,
            ..Default::default()
        })
        .await
        .unwrap();
        let r = svc.list().await.unwrap();
        let items = r["connectors"].as_array().unwrap();
        assert!(items.iter().any(|c| c["id"] == "feishu"), "feishu 应在列表");
        // 启用
        svc.set_enabled("feishu", true).await.unwrap();
        let r = svc.list_enabled().await.unwrap();
        let items = r["connectors"].as_array().unwrap();
        assert!(items.iter().any(|c| c["id"] == "feishu"));
        // 删除
        svc.delete("feishu").await.unwrap();
        let r = svc.list().await.unwrap();
        let items = r["connectors"].as_array().unwrap();
        assert!(!items.iter().any(|c| c["id"] == "feishu"));
    }

    #[tokio::test]
    async fn connector_validation() {
        let pool = new_test_db().await;
        let svc = ConnectorService::new(pool);
        // 非法 id 拒绝
        assert!(svc.create(&Connector { id: "Bad_ID".into(), ..Default::default() }).await.is_err());
    }
}
