//! 共享智能体业务服务层（Go `server/internal/agentshare` 等价）。
//!
//! 语义基座（与 Go 一致）：严格默认拒绝/授权制；双门制（pending→approve→可见）；
//! 质量仅 approved 可设；版本语义。

use picoaide_dsh_store::errors::StoreError;
use picoaide_dsh_store::grants::{GranteeType, SHARED_PRESET_GRANT_TABLE};
use serde_json::{json, Value};
use sqlx::PgPool;

/// AgentShareError 结构化错误。
#[derive(Debug, Clone, thiserror::Error)]
#[error("{code}: {message}")]
pub struct AgentShareError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl AgentShareError {
    pub fn not_found() -> Self {
        AgentShareError { status: 404, code: "NOT_FOUND".into(), message: "资源不存在".into() }
    }
    pub fn validation(msg: &str) -> Self {
        AgentShareError { status: 400, code: "VALIDATION".into(), message: msg.into() }
    }
    pub fn internal(msg: &str) -> Self {
        AgentShareError { status: 500, code: "INTERNAL".into(), message: msg.into() }
    }
}

impl From<StoreError> for AgentShareError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NotFound => AgentShareError::not_found(),
            StoreError::Duplicate => AgentShareError::validation("资源已存在"),
            StoreError::Conflict => AgentShareError::validation("名称冲突"),
            StoreError::TooManyPending => AgentShareError::validation("待审数量已达上限"),
            other => AgentShareError::internal(&other.to_string()),
        }
    }
}

/// AgentShareService 共享智能体服务。
#[derive(Clone)]
pub struct AgentShareService {
    pub pool: PgPool,
}

impl AgentShareService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// list_visible 员工可见共享智能体（approved + 授权制；admin 全量）。
    pub async fn list_visible(&self, username: &str, groups: &[String], is_admin: bool) -> Result<Value, AgentShareError> {
        let all = picoaide_dsh_store::agent_presets::list_visible_agent_presets(&self.pool, username, groups).await?;
        let accessible = if is_admin {
            picoaide_dsh_store::agent_presets::list_agent_presets(&self.pool, "approved").await?
        } else {
            let names = picoaide_dsh_store::grants::accessible_shared_resource_names(
                &self.pool,
                SHARED_PRESET_GRANT_TABLE,
                username,
                groups,
            )
            .await
            .unwrap_or_default();
            all.into_iter()
                .filter(|p| p.status.as_str() == "approved" && names.contains(&p.name))
                .collect::<Vec<_>>()
        };
        let rows = accessible;
        let items: Vec<Value> = rows
            .iter()
            .map(|p| {
                json!({
                    "name": p.name,
                    "title": p.display_name,
                    "description": p.description,
                    "version": p.version,
                    "quality": p.quality,
                    "status": p.status.as_str(),
                    "author": p.author,
                })
            })
            .collect();
        Ok(json!({ "agents": items, "total": items.len() }))
    }

    /// get 员工详情（未授权 404）。
    pub async fn get(&self, username: &str, groups: &[String], is_admin: bool, name: &str) -> Result<Value, AgentShareError> {
        let p = picoaide_dsh_store::agent_presets::get_agent_preset(&self.pool, name)
            .await
            .map_err(|_| AgentShareError::not_found())?;
        if !is_admin {
            let accessible = picoaide_dsh_store::grants::accessible_shared_resource_names(
                &self.pool,
                SHARED_PRESET_GRANT_TABLE,
                username,
                groups,
            )
            .await
            .unwrap_or_default();
            if !accessible.contains(&p.name) {
                return Err(AgentShareError::not_found());
            }
        }
        Ok(json!({
            "agent": {
                "name": p.name,
                "title": p.display_name,
                "description": p.description,
                "version": p.version,
                "quality": p.quality,
                "status": p.status.as_str(),
                "author": p.author,
            }
        }))
    }

    /// set_status 审核状态。
    pub async fn set_status(&self, name: &str, status: &str) -> Result<Value, AgentShareError> {
        let st = match status {
            "approved" => picoaide_dsh_store::agent_presets::AgentPresetStatus::Approved,
            "rejected" => picoaide_dsh_store::agent_presets::AgentPresetStatus::Rejected,
            "pending" => picoaide_dsh_store::agent_presets::AgentPresetStatus::Pending,
            _ => return Err(AgentShareError::validation("状态不合法")),
        };
        picoaide_dsh_store::agent_presets::set_agent_preset_status(&self.pool, name, st, "")
            .await?;
        Ok(json!({ "ok": true, "status": status }))
    }

    /// set_quality 质量标记（仅 approved）。
    pub async fn set_quality(&self, name: &str, version: &str, quality: &str) -> Result<Value, AgentShareError> {
        picoaide_dsh_store::agent_presets::set_agent_preset_quality(&self.pool, name, version, quality)
            .await?;
        Ok(json!({ "ok": true, "quality": quality }))
    }

    /// list_grants 授权列表。
    pub async fn list_grants(&self, name: &str) -> Result<Value, AgentShareError> {
        let grants = picoaide_dsh_store::grants::list_shared_resource_grants(
            &self.pool,
            SHARED_PRESET_GRANT_TABLE,
            name,
        )
        .await
        .map_err(|_| AgentShareError::not_found())?;
        let items: Vec<Value> = grants
            .iter()
            .map(|g| json!({ "grantee_type": g.grantee_type, "grantee": g.grantee }))
            .collect();
        Ok(json!({ "grants": items }))
    }

    /// set_grant 授权/撤销。
    pub async fn set_grant(&self, name: &str, grantee: &str, grantee_type: &str, grant: bool) -> Result<Value, AgentShareError> {
        let t = match grantee_type {
            "user" => GranteeType::User,
            "group" => GranteeType::Group,
            _ => return Err(AgentShareError::validation("grantee_type 不合法")),
        };
        if grant {
            picoaide_dsh_store::grants::grant_shared_resource(&self.pool, SHARED_PRESET_GRANT_TABLE, name, grantee, t)
                .await
                .map_err(|e| AgentShareError::validation(&e.to_string()))?;
        } else {
            picoaide_dsh_store::grants::revoke_shared_resource(&self.pool, SHARED_PRESET_GRANT_TABLE, name, grantee, t)
                .await
                .map_err(|e| AgentShareError::validation(&e.to_string()))?;
        }
        Ok(json!({ "ok": true }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use picoaide_dsh_store::testutil::new_test_db;

    #[tokio::test]
    async fn agent_visible_strict() {
        let pool = new_test_db().await;
        let svc = AgentShareService::new(pool.clone());
        picoaide_dsh_store::agent_presets::create_agent_preset(
            &pool,
            &picoaide_dsh_store::agent_presets::AgentPreset {
                name: "org-agent".into(),
                display_name: "Org Agent".into(),
                description: "desc content enough".into(),
                version: "1.0.0".into(),
                author: "alice".into(),
                checksum: "".into(),
                quality: "".into(),
                archive: vec![],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        picoaide_dsh_store::agent_presets::set_agent_preset_status(
            &pool,
            "org-agent",
            picoaide_dsh_store::agent_presets::AgentPresetStatus::Approved,
            "",
        )
        .await
        .unwrap();
        // 未授权用户空
        let r = svc.list_visible("bob", &[], false).await.unwrap();
        assert_eq!(r["total"], 0);
        // admin 全量
        let r = svc.list_visible("admin", &[], true).await.unwrap();
        assert_eq!(r["total"], 1);
    }

    #[tokio::test]
    async fn agent_grants() {
        let pool = new_test_db().await;
        let svc = AgentShareService::new(pool.clone());
        picoaide_dsh_store::agent_presets::create_agent_preset(
            &pool,
            &picoaide_dsh_store::agent_presets::AgentPreset {
                name: "org-agent2".into(),
                display_name: "Agent2".into(),
                description: "desc content enough".into(),
                version: "1.0.0".into(),
                author: "boss".into(),
                checksum: "".into(),
                quality: "".into(),
                archive: vec![],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        svc.set_grant("org-agent2", "alice", "user", true).await.unwrap();
        let r = svc.list_grants("org-agent2").await.unwrap();
        assert_eq!(r["grants"].as_array().unwrap().len(), 1);
        svc.set_grant("org-agent2", "alice", "user", false).await.unwrap();
        let r = svc.list_grants("org-agent2").await.unwrap();
        assert_eq!(r["grants"].as_array().unwrap().len(), 0);
    }
}
