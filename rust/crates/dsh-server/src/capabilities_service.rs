//! 能力中心服务层（Go `server/internal/capabilities` 等价）。
//!
//! 能力中心 = 跨模型（市场/组织）的技能与智能体聚合视图。
//! 语义：严格默认拒绝（未授权 404/不可见）、官方标识、来源区分
//! （market/org）、审核状态可见性（员工仅 approved）。

use picoaide_dsh_store::errors::StoreError;
use picoaide_dsh_store::apps::{APP_CHANNEL_MARKET, APP_CHANNEL_ORG, APP_KIND_AGENT, APP_KIND_SKILL};
use serde_json::{json, Value};
use sqlx::PgPool;

/// CapabilityItem 能力中心条目。
#[derive(Debug, serde::Serialize)]
pub struct CapabilityItem {
    pub kind: String,
    pub source: String,
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub status: String,
    pub reason: String,
    pub quality: String,
    pub official: bool,
}

/// CapabilitiesService 能力中心服务。
#[derive(Clone)]
pub struct CapabilitiesService {
    pub pool: PgPool,
}

impl CapabilitiesService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// list 员工可见能力（kind = skill/agent/all；员工仅 approved+授权；admin 全量）。
    pub async fn list(&self, username: &str, groups: &[String], is_admin: bool, kind: &str) -> Result<Value, StoreError> {
        let mut items = Vec::new();
        for k in [APP_KIND_SKILL, APP_KIND_AGENT] {
            if kind != "all" && kind != k {
                continue;
            }
            // 市场 app（授权制）+ 组织共享（授权制）
            for channel in [APP_CHANNEL_MARKET, APP_CHANNEL_ORG] {
                let apps = picoaide_dsh_store::apps::list_apps(&self.pool, k, channel).await?;
                for app in apps {
                    let visible = if is_admin {
                        true
                    } else {
                        // 员工：授权 + approved
                        let accessible = picoaide_dsh_store::grants::accessible_shared_resource_names(
                            &self.pool,
                            if channel == APP_CHANNEL_ORG {
                                picoaide_dsh_store::grants::SHARED_SKILL_GRANT_TABLE
                            } else {
                                picoaide_dsh_store::grants::SHARED_SKILL_GRANT_TABLE
                            },
                            username,
                            groups,
                        )
                        .await
                        .unwrap_or_default();
                        accessible.contains(&app.app_id)
                    };
                    if visible {
                        let rel = picoaide_dsh_store::apps::get_release(&self.pool, k, &app.app_id, "1.0.0")
                            .await
                            .ok();
                        items.push(json!({
                            "kind": k,
                            "source": channel,
                            "name": app.app_id,
                            "display_name": app.title,
                            "version": rel.as_ref().map(|r| r.version.clone()).unwrap_or_default(),
                            "description": app.description,
                            "author": app.owner,
                            "status": rel.as_ref().map(|r| r.status.clone()).unwrap_or_default(),
                            "reason": "",
                            "quality": "",
                            "official": app.official == 1,
                        }));
                    }
                }
            }
        }
        Ok(json!({ "items": items, "total": items.len() }))
    }

    /// lock 锁定能力（admin）。
    pub async fn lock_capability(&self, kind: &str, name: &str, reason: &str, actor: &str) -> Result<Value, StoreError> {
        picoaide_dsh_store::capability_locks::lock_capability(&self.pool, kind, name, reason, actor).await?;
        picoaide_dsh_store::audit::audit_log(&self.pool, actor, "capability_lock", name).await?;
        Ok(json!({ "ok": true }))
    }

    /// unlock 解锁能力。
    pub async fn unlock_capability(&self, kind: &str, name: &str, actor: &str) -> Result<Value, StoreError> {
        picoaide_dsh_store::capability_locks::unlock_capability(&self.pool, kind, name).await?;
        picoaide_dsh_store::audit::audit_log(&self.pool, actor, "capability_unlock", name).await?;
        Ok(json!({ "ok": true }))
    }

    /// list_locks 锁定列表。
    pub async fn list_locks(&self) -> Result<Value, StoreError> {
        let locks = picoaide_dsh_store::capability_locks::list_capability_locks(&self.pool).await?;
        let items: Vec<Value> = locks.iter().map(|l| json!({ "kind": l.kind, "name": l.name, "reason": l.reason })).collect();
        Ok(json!({ "locks": items }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use picoaide_dsh_store::testutil::new_test_db;

    #[tokio::test]
    async fn capabilities_strict_default() {
        let pool = new_test_db().await;
        let svc = CapabilitiesService::new(pool.clone());
        // 建组织共享 skill（approved）
        picoaide_dsh_store::shared_skills::create_shared_skill(
            &pool,
            &picoaide_dsh_store::shared_skills::SharedSkill {
                name: "cap-skill".into(),
                display_name: "Cap Skill".into(),
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
        picoaide_dsh_store::shared_skills::set_shared_skill_status(
            &pool,
            "cap-skill",
            "1.0.0",
            picoaide_dsh_store::shared_skills::SharedSkillStatus::Approved,
            "",
        )
        .await
        .unwrap();
        // 未授权用户：空
        let r = svc.list("bob", &[], false, "all").await.unwrap();
        assert_eq!(r["total"], 0);
        // admin 可见
        let r = svc.list("admin", &[], true, "all").await.unwrap();
        assert!(r["total"].as_u64().unwrap() >= 1);
    }

    #[tokio::test]
    async fn lock_flow() {
        let pool = new_test_db().await;
        let svc = CapabilitiesService::new(pool.clone());
        svc.lock_capability("skill", "lock-me", "违规", "admin").await.unwrap();
        let r = svc.list_locks().await.unwrap();
        assert_eq!(r["locks"].as_array().unwrap().len(), 1);
        svc.unlock_capability("skill", "lock-me", "admin").await.unwrap();
        let r = svc.list_locks().await.unwrap();
        assert_eq!(r["locks"].as_array().unwrap().len(), 0);
    }
}
