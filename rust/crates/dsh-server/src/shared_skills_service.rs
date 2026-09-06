//! 组织共享技能业务服务层（Go `server/internal/sharedskills` 等价）。
//!
//! 语义基座（与 Go 一致）：
//! - **严格默认拒绝 / 授权制**：共享技能未授权用户不可见/不可下载（404 不泄存在性）；
//!   授权对象 = 用户或部门组（组名大小写不敏感）。
//! - **双门制**：publish 后 pending → admin approve → 可见。
//! - 部门内发布（org channel）复用 app 模型（kind=skill, channel=org）。

use picoaide_dsh_store::errors::StoreError;
use picoaide_dsh_store::grants::{GranteeType, SHARED_SKILL_GRANT_TABLE};
use serde_json::{json, Value};
use sqlx::PgPool;

/// SharedSkillError 结构化错误（status/code/message）。
#[derive(Debug, Clone, thiserror::Error)]
#[error("{code}: {message}")]
pub struct SharedSkillError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl SharedSkillError {
    pub fn not_found() -> Self {
        SharedSkillError { status: 404, code: "NOT_FOUND".into(), message: "资源不存在".into() }
    }
    pub fn validation(msg: &str) -> Self {
        SharedSkillError { status: 400, code: "VALIDATION".into(), message: msg.into() }
    }
    pub fn forbidden(msg: &str) -> Self {
        SharedSkillError { status: 403, code: "FORBIDDEN".into(), message: msg.into() }
    }
    pub fn internal(msg: &str) -> Self {
        SharedSkillError { status: 500, code: "INTERNAL".into(), message: msg.into() }
    }
}

impl From<StoreError> for SharedSkillError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NotFound => SharedSkillError::not_found(),
            StoreError::Duplicate => SharedSkillError::validation("资源已存在"),
            StoreError::Conflict => SharedSkillError::validation("名称冲突"),
            StoreError::TooManyPending => SharedSkillError::validation("待审数量已达上限"),
            other => SharedSkillError::internal(&other.to_string()),
        }
    }
}

/// SharedSkillsService 共享技能服务。
#[derive(Clone)]
pub struct SharedSkillsService {
    pub pool: PgPool,
}

impl SharedSkillsService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// list_visible 员工可见的共享技能（approved + 授权制）。
    pub async fn list_visible(
        &self,
        username: &str,
        groups: &[String],
        is_admin: bool,
    ) -> Result<Value, SharedSkillError> {
        let rows = if is_admin {
            picoaide_dsh_store::shared_skills::list_shared_skills(&self.pool, "approved").await?
        } else {
            // 员工：先看授权名单，再取 approved
            let accessible =
                picoaide_dsh_store::grants::accessible_shared_resource_names(
                    &self.pool,
                    SHARED_SKILL_GRANT_TABLE,
                    username,
                    groups,
                )
                .await
                .unwrap_or_default();
            let all = picoaide_dsh_store::shared_skills::list_shared_skills(&self.pool, "approved").await?;
            all.into_iter()
                .filter(|s| accessible.contains(&s.name) && s.status.as_str() == "approved")
                .collect::<Vec<_>>()
        };
        let items: Vec<Value> = rows
            .iter()
            .map(|s| {
                json!({
                    "name": s.name,
                    "title": s.display_name,
                    "description": s.description,
                    "version": s.version,
                    "quality": s.quality,
                    "status": s.status.as_str(),
                    "author": s.author,
                    "created_at": s.created_at,
                })
            })
            .collect();
        Ok(json!({ "skills": items, "total": items.len() }))
    }

    /// get 员工详情（未授权 404 不泄存在性）。
    pub async fn get(
        &self,
        _username: &str,
        groups: &[String],
        is_admin: bool,
        name: &str,
        version: &str,
    ) -> Result<Value, SharedSkillError> {
        let s = picoaide_dsh_store::shared_skills::get_shared_skill(&self.pool, name, version)
            .await
            .map_err(|_| SharedSkillError::not_found())?;
        if !is_admin {
            let accessible = picoaide_dsh_store::grants::accessible_shared_resource_names(
                &self.pool,
                SHARED_SKILL_GRANT_TABLE,
                "",
                groups,
            )
            .await
            .unwrap_or_default();
            if !accessible.contains(&s.name) {
                return Err(SharedSkillError::not_found());
            }
        }
        Ok(json!({
            "skill": {
                "name": s.name,
                "title": s.display_name,
                "description": s.description,
                "version": s.version,
                "quality": s.quality,
                "status": s.status.as_str(),
                "author": s.author,
            }
        }))
    }

    /// set_status 审核状态迁移（approve/reject/pending）。
    pub async fn set_status(&self, name: &str, version: &str, status: &str) -> Result<Value, SharedSkillError> {
        let st = match status {
            "approved" => picoaide_dsh_store::shared_skills::SharedSkillStatus::Approved,
            "rejected" => picoaide_dsh_store::shared_skills::SharedSkillStatus::Rejected,
            "pending" => picoaide_dsh_store::shared_skills::SharedSkillStatus::Pending,
            _ => return Err(SharedSkillError::validation("状态不合法")),
        };
        picoaide_dsh_store::shared_skills::set_shared_skill_status(&self.pool, name, version, st, "")
            .await?;
        Ok(json!({ "ok": true, "status": status }))
    }

    /// set_quality 质量标记。
    pub async fn set_quality(&self, name: &str, version: &str, quality: &str) -> Result<Value, SharedSkillError> {
        picoaide_dsh_store::shared_skills::set_shared_skill_quality(&self.pool, name, version, quality)
            .await?;
        Ok(json!({ "ok": true, "quality": quality }))
    }

    /// list_grants 资源授权列表。
    pub async fn list_grants(&self, name: &str) -> Result<Value, SharedSkillError> {
        let grants = picoaide_dsh_store::grants::list_shared_resource_grants(
            &self.pool,
            SHARED_SKILL_GRANT_TABLE,
            name,
        )
        .await
        .map_err(|_| SharedSkillError::not_found())?;
        let items: Vec<Value> = grants
            .iter()
            .map(|g| json!({ "grantee_type": g.grantee_type, "grantee": g.grantee }))
            .collect();
        Ok(json!({ "grants": items }))
    }

    /// set_grant 授权/撤销。
    pub async fn set_grant(&self, name: &str, grantee: &str, grantee_type: &str, grant: bool) -> Result<Value, SharedSkillError> {
        let t = match grantee_type {
            "user" => GranteeType::User,
            "group" => GranteeType::Group,
            _ => return Err(SharedSkillError::validation("grantee_type 不合法")),
        };
        if grant {
            picoaide_dsh_store::grants::grant_shared_resource(&self.pool, SHARED_SKILL_GRANT_TABLE, name, grantee, t)
                .await
                .map_err(|e| SharedSkillError::validation(&e.to_string()))?;
        } else {
            picoaide_dsh_store::grants::revoke_shared_resource(&self.pool, SHARED_SKILL_GRANT_TABLE, name, grantee, t)
                .await
                .map_err(|e| SharedSkillError::validation(&e.to_string()))?;
        }
        Ok(json!({ "ok": true }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use picoaide_dsh_store::testutil::new_test_db;

    #[tokio::test]
    async fn shared_skill_visible_strict() {
        let pool = new_test_db().await;
        let svc = SharedSkillsService::new(pool.clone());
        // 建共享技能（approved）
        picoaide_dsh_store::shared_skills::create_shared_skill(
            &pool,
            &picoaide_dsh_store::shared_skills::SharedSkill {
                name: "org-skill".into(),
                display_name: "Org Skill".into(),
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
        .expect("create");
        picoaide_dsh_store::shared_skills::set_shared_skill_status(&pool, "org-skill", "1.0.0", picoaide_dsh_store::shared_skills::SharedSkillStatus::Approved, "")
            .await
            .unwrap();
        // 未授权用户列表为空（strict default）
        let r = svc.list_visible("bob", &[], false).await.unwrap();
        assert_eq!(r["total"], 0);
        // admin 全量
        let r = svc.list_visible("admin", &[], true).await.unwrap();
        assert_eq!(r["total"], 1);
    }

    #[tokio::test]
    async fn shared_skill_status_flow() {
        let pool = new_test_db().await;
        let svc = SharedSkillsService::new(pool.clone());
        picoaide_dsh_store::shared_skills::create_shared_skill(
            &pool,
            &picoaide_dsh_store::shared_skills::SharedSkill {
                name: "s2".into(),
                display_name: "S2".into(),
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
        // 默认 pending
        let s = picoaide_dsh_store::shared_skills::get_shared_skill(&pool, "s2", "1.0.0").await.unwrap();
        assert_eq!(s.status.as_str(), "pending");
        // approve
        svc.set_status("s2", "1.0.0", "approved").await.unwrap();
        let s = picoaide_dsh_store::shared_skills::get_shared_skill(&pool, "s2", "1.0.0").await.unwrap();
        assert_eq!(s.status.as_str(), "approved");
        // reject
        // quality (仅 approved 可设 → 先 approve)
        svc.set_status("s2", "1.0.0", "approved").await.unwrap();
        svc.set_quality("s2", "1.0.0", "featured").await.unwrap();
        let s = picoaide_dsh_store::shared_skills::get_shared_skill(&pool, "s2", "1.0.0").await.unwrap();
        assert_eq!(s.quality, "featured");
        // reject 后不可设 quality
        svc.set_status("s2", "1.0.0", "rejected").await.unwrap();
        assert!(svc.set_quality("s2", "1.0.0", "featured").await.is_err());
        // 非法状态拒绝
        assert!(svc.set_status("s2", "1.0.0", "bad").await.is_err());
    }

    #[tokio::test]
    async fn shared_skill_grants() {
        let pool = new_test_db().await;
        let svc = SharedSkillsService::new(pool.clone());
        picoaide_dsh_store::shared_skills::create_shared_skill(
            &pool,
            &picoaide_dsh_store::shared_skills::SharedSkill {
                name: "s3".into(),
                display_name: "S3".into(),
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
        // 授权给 alice
        svc.set_grant("s3", "alice", "user", true).await.unwrap();
        let r = svc.list_grants("s3").await.unwrap();
        assert_eq!(r["grants"].as_array().unwrap().len(), 1);
        // 撤销
        svc.set_grant("s3", "alice", "user", false).await.unwrap();
        let r = svc.list_grants("s3").await.unwrap();
        assert_eq!(r["grants"].as_array().unwrap().len(), 0);
    }
}
