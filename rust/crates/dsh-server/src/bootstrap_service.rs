//! 客户端 bootstrap 服务（Go `server/internal/bootstrap` 等价）。
//!
//! GET /api/client/v2/config/bootstrap 的核心聚合：模型全局、技能按授权过滤
//! （admin 全量）、连接器目录。

use picoaide_dsh_store::errors::StoreError;
use serde_json::{json, Value};
use sqlx::PgPool;

/// BootstrapService 客户端启动配置服务。
#[derive(Clone)]
pub struct BootstrapService {
    pub pool: PgPool,
}

impl BootstrapService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// build 组装客户端 bootstrap（models/skills/web/connectors）。
    pub async fn build(&self, username: &str, is_admin: bool) -> Result<Value, StoreError> {
        // 模型（全局，enabled providers 的启用模型）
        let models = picoaide_dsh_store::gateway::list_admin_models(&self.pool).await?;
        let model_items: Vec<Value> = models
            .iter()
            .filter(|m| m.provider_enabled)
            .map(|m| {
                json!({
                    "id": m.name,
                    "name": m.display_name,
                    "provider": m.provider_name,
                })
            })
            .collect();
        // 默认模型
        let default_model = picoaide_dsh_store::settings::get_setting(&self.pool, "gateway.default_model")
            .await
            .map(|(v, _)| v)
            .unwrap_or_default();
        // 技能（授权过滤：admin 全量）
        let skills = if is_admin {
            picoaide_dsh_store::skills::list_skills(&self.pool, true).await?
        } else {
            let names = picoaide_dsh_store::grants::accessible_skill_names(&self.pool, username, &[])
                .await
                .unwrap_or_default();
            picoaide_dsh_store::skills::list_skills(&self.pool, true)
                .await?
                .into_iter()
                .filter(|s| names.contains(&s.name))
                .collect::<Vec<_>>()
        };
        let skill_items: Vec<Value> = skills
            .iter()
            .map(|s| json!({ "name": s.name, "version": s.version, "description": s.description }))
            .collect();
        // 连接器
        let connectors = picoaide_dsh_store::connectors::list_enabled_connectors(&self.pool).await?;
        let connector_items: Vec<Value> = connectors
            .iter()
            .map(|c| {
                json!({
                    "id": c.id,
                    "name": c.name,
                    "description": c.description,
                    "auth_mode": c.auth_mode,
                    "definition": c.definition,
                })
            })
            .collect();
        Ok(json!({
            "default_model": default_model,
            "models": model_items,
            "skills": skill_items,
            "web": { "enable_registration": true, "brand_url": "" },
            "connectors": connector_items,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use picoaide_dsh_store::testutil::new_test_db;

    #[tokio::test]
    async fn bootstrap_build_empty() {
        let pool = new_test_db().await;
        let svc = BootstrapService::new(pool.clone());
        let r = svc.build("alice", false).await.unwrap();
        assert!(r["models"].is_array());
        assert!(r["skills"].is_array());
        assert!(r["connectors"].is_array());
    }
}
