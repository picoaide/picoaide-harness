//! 商城业务域 handlers（Go `server/internal/marketplace` 等价移植）。
//!
//! 本模块是 **业务逻辑核心层**：请求解析/HTTP 细节（axum 路由、认证中间件、
//! RBAC 权限申报）留给 router 集成阶段；这里只实现「请求参数 → 校验 →
//! dsh-store 调用 → DTO/JSON 响应」的纯服务方法。
//!
//! 语义基座（与 Go 完全一致）：
//! - **严格默认拒绝 / 授权制**：市场技能、智能体上架后，未授权用户一律不可见、
//!   不可下载（未授权与不存在/已下架返回同一 404，不泄露资源存在性）；授权对象
//!   = 用户或部门组（组名大小写不敏感）；admin（IsAdmin）恒全量，不落授权表。
//! - **双门制**：可见性 = 已上架（enabled=1）∧ 已授权 ∧ 展示版本 approved；
//!   AdminPublish 跳过锁定与待审配额，且发布即 approved。
//! - **统一发布内核**：版本不可复用 / 必须递增 / 内容未变更 / 跨渠道同名互斥 /
//!   包内即真相（校验与清单解析由调用方在发布前完成）。
//! - 授权变更与上下架必须留审计痕迹（audit_logs，哈希链）。

use picoaide_dsh_store::apps::{
    App, Release, APP_CHANNEL_MARKET, APP_CHANNEL_ORG, APP_KIND_AGENT, APP_KIND_SKILL,
    RELEASE_STATUS_APPROVED, RELEASE_STATUS_PENDING, RELEASE_STATUS_REJECTED, create_release,
    get_app, get_release, grant_app, increment_release_download, list_app_grants, list_apps,
    list_releases, list_releases_by_status, pending_release_count, revoke_app, set_app_enabled,
    set_release_quality, set_release_status, upsert_app,
};
use picoaide_dsh_store::errors::StoreError;
use picoaide_dsh_store::grants::{
    GranteeType, SHARED_PRESET_GRANT_TABLE, replace_shared_groups, replace_skill_group_grants,
};
use picoaide_dsh_store::skills::{current_market_release_for, list_skills};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// 稳定错误码（与 Go serverauth.WriteError / appstore / skillmanifest 一致）。
// ---------------------------------------------------------------------------

pub const ERR_NOT_FOUND: &str = "NOT_FOUND";
pub const ERR_VALIDATION: &str = "VALIDATION";
pub const ERR_CONFLICT: &str = "CONFLICT";
pub const ERR_INTERNAL: &str = "INTERNAL";
pub const ERR_ARCHIVE_INVALID: &str = "ARCHIVE_INVALID";
pub const CODE_VERSION_EXISTS: &str = "VERSION_EXISTS";
pub const CODE_VERSION_NOT_INCREASING: &str = "VERSION_NOT_INCREASING";
pub const CODE_CONTENT_UNCHANGED: &str = "CONTENT_UNCHANGED";
pub const CODE_APP_LOCKED: &str = "APP_LOCKED";
pub const CODE_OFFICIAL_LOCKED: &str = "OFFICIAL_LOCKED";
pub const CODE_NAME_TAKEN: &str = "NAME_TAKEN";
pub const CODE_PENDING_LIMIT: &str = "PENDING_LIMIT";

/// 归档/请求体上限（与 Go sharedskills/agentshare 常量一致）。
pub const MAX_ARCHIVE_BYTES: usize = 16 << 20;
pub const MAX_UNPACKED_BYTES: u64 = 64 << 20;
pub const MAX_ARCHIVE_ENTRIES: usize = 10000;
pub const MAX_BODY_BYTES: usize = 24 << 20;
pub const MAX_FILE_PREVIEW_BYTES: u64 = 1 << 20;
pub const MAX_DESCRIPTION_LEN: usize = 500;

/// 发布/审核失败的**结构化**错误：HTTP 状态 + 稳定错误码 + 面向用户的中文说明。
/// axum 集成阶段直接转 `{\"error\":{\"code\",\"message\"}}` 信封。
#[derive(Debug, Clone, thiserror::Error)]
#[error("{code}: {message}")]
pub struct MarketplaceError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl MarketplaceError {
    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        MarketplaceError {
            status,
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        MarketplaceError::new(500, ERR_INTERNAL, msg)
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        MarketplaceError::new(404, ERR_NOT_FOUND, msg)
    }

    pub fn validation(msg: impl Into<String>) -> Self {
        MarketplaceError::new(400, ERR_VALIDATION, msg)
    }
}

impl From<StoreError> for MarketplaceError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NotFound => MarketplaceError::not_found("资源不存在"),
            StoreError::Duplicate => MarketplaceError::new(409, CODE_VERSION_EXISTS, "版本已存在"),
            StoreError::Conflict => MarketplaceError::new(409, ERR_CONFLICT, "名称冲突"),
            StoreError::Validation => MarketplaceError::validation("参数不合法"),
            other => MarketplaceError::internal(other.to_string()),
        }
    }
}

impl From<ArchiveError> for MarketplaceError {
    fn from(e: ArchiveError) -> Self {
        MarketplaceError::new(422, ERR_ARCHIVE_INVALID, e.to_string())
    }
}

// ---------------------------------------------------------------------------
// 服务类型与 DTO
// ---------------------------------------------------------------------------

/// 商城业务服务（Go `marketplace.API` + admin.go handler 的核心层等价）。
#[derive(Debug, Clone)]
pub struct MarketplaceService {
    pool: sqlx::PgPool,
}

impl MarketplaceService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        MarketplaceService { pool }
    }
}

/// 单条授权对象。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GrantDto {
    pub grantee_type: String,
    pub grantee: String,
}

/// 可见性上下文：由认证中间件解析（直接用户 + 有效组 + 是否管理员）。
#[derive(Debug, Clone, Default)]
pub struct Viewer {
    pub username: String,
    pub groups: Vec<String>,
    pub is_admin: bool,
}

/// 一次发布请求（Go `appstore.PublishRequest` 等价）。
#[derive(Debug, Clone, Default)]
pub struct PublishRequest {
    pub kind: String,
    pub app_id: String,
    pub channel: String,
    pub archive: Vec<u8>,
    pub publisher: String,
    pub admin_publish: bool,
    pub pending_cap: i64,
    pub declared_version: String,
    pub manifest: ManifestDto,
    pub checksum: String,
}

/// 发布元数据（「包内即真相」：来自 SKILL.md / preset.yml 解析，调用方保证）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManifestDto {
    pub version: String,
    pub title: String,
    pub description: String,
    pub changelog: String,
    pub category: String,
    pub author: String,
    pub tags: Vec<String>,
}

/// 一次成功发布的结果。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PublishResult {
    pub version: String,
    pub status: String,
    pub checksum: String,
}

/// 归档下载响应。
#[derive(Debug, Clone)]
pub struct DownloadResult {
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub disposition: String,
    pub version: String,
    pub checksum: String,
}

/// 逐文件预览响应。
#[derive(Debug, Clone)]
pub struct FileContent {
    pub path: String,
    pub size: u64,
    pub binary: bool,
    pub too_large: bool,
    pub content: String,
}

// ---------------------------------------------------------------------------
// 客户端面：可见性（严格默认拒绝 + 授权制）
// ---------------------------------------------------------------------------

impl MarketplaceService {
    async fn is_accessible(&self, kind: &str, viewer: &Viewer, name: &str) -> Result<bool, MarketplaceError> {
        if viewer.is_admin {
            return Ok(true);
        }
        let names = picoaide_dsh_store::grants::accessible_app_ids(
            &self.pool, kind, &viewer.username, &viewer.groups,
        )
        .await?;
        Ok(names.iter().any(|n| n == name))
    }

    /// list_apps 员工可见且可用的市场资源清单（admin 恒全量）。
    pub async fn list_apps(&self, viewer: &Viewer, kind: &str) -> Result<Value, MarketplaceError> {
        let list = list_apps(&self.pool, kind, APP_CHANNEL_MARKET).await?;
        let mut out = Vec::new();
        for a in &list {
            if a.enabled != 1 && !viewer.is_admin {
                continue;
            }
            if !self.is_accessible(kind, viewer, &a.app_id).await? {
                continue;
            }
            let r = current_market_release_for(&self.pool, kind, &a.app_id, false).await?;
            out.push(app_json(a, r.as_ref()));
        }
        Ok(json!({ "apps": out }))
    }

    /// accessible_apps 调用者可用的资源投影（与 Go 可见性公式同语义）。
    pub async fn accessible_apps(&self, viewer: &Viewer, kind: &str) -> Result<Vec<Value>, MarketplaceError> {
        let list = list_apps(&self.pool, kind, "").await?;
        let mut out = Vec::new();
        for a in &list {
            if a.channel != APP_CHANNEL_MARKET {
                continue;
            }
            if a.enabled != 1 && !viewer.is_admin {
                continue;
            }
            if !self.is_accessible(kind, viewer, &a.app_id).await? {
                continue;
            }
            let r = current_market_release_for(&self.pool, kind, &a.app_id, false).await?;
            out.push(app_json(a, r.as_ref()));
        }
        Ok(out)
    }

    /// accessible_skill_names 返回调用者可访问的市场技能名（未授权不泄存在性）。
    pub async fn accessible_skill_names(&self, viewer: &Viewer) -> Result<Vec<String>, MarketplaceError> {
        if viewer.is_admin {
            let list = list_skills(&self.pool, true).await?;
            return Ok(list.into_iter().map(|s| s.name).collect());
        }
        Ok(picoaide_dsh_store::grants::accessible_skill_names(
            &self.pool,
            &viewer.username,
            &viewer.groups,
        )
        .await?)
    }

    /// get_app 资源详情：授权先于下架（未授权与不存在/下架同 404，不泄存在性）。
    pub async fn get_app(&self, viewer: &Viewer, kind: &str, name: &str) -> Result<Value, MarketplaceError> {
        let a = get_app(&self.pool, kind, name)
            .await
            .map_err(|_| MarketplaceError::not_found("资源不存在"))?;
        if a.channel != APP_CHANNEL_MARKET {
            return Err(MarketplaceError::not_found("资源不存在"));
        }
        if !self.is_accessible(kind, viewer, name).await? {
            return Err(MarketplaceError::not_found("资源不存在"));
        }
        if a.enabled != 1 && !viewer.is_admin {
            return Err(MarketplaceError::not_found("资源已下架"));
        }
        let r = current_market_release_for(&self.pool, kind, name, false).await?;
        Ok(json!({ "app": app_json(&a, r.as_ref()) }))
    }

    /// download_archive 返回展示版本归档（zip 推荐 / tar.gz 兼容）+ 下载头。
    pub async fn download_archive(
        &self,
        viewer: &Viewer,
        kind: &str,
        name: &str,
    ) -> Result<DownloadResult, MarketplaceError> {
        let a = get_app(&self.pool, kind, name)
            .await
            .map_err(|_| MarketplaceError::not_found("资源不存在"))?;
        if a.channel != APP_CHANNEL_MARKET {
            return Err(MarketplaceError::not_found("资源不存在"));
        }
        if !self.is_accessible(kind, viewer, name).await? {
            return Err(MarketplaceError::not_found("资源不存在"));
        }
        if a.enabled != 1 && !viewer.is_admin {
            return Err(MarketplaceError::not_found("资源已下架"));
        }
        let r = current_market_release_for(&self.pool, kind, name, true)
            .await?
            .ok_or_else(|| MarketplaceError::not_found("资源尚未发布版本"))?;
        if r.archive.is_empty() {
            return Err(MarketplaceError::not_found("资源尚未上传归档"));
        }
        let checksum = if r.checksum.is_empty() {
            sha256_hex(&r.archive)
        } else {
            r.checksum.clone()
        };
        let format = archive_format(&r.archive);
        let disp_name = format!("{}-{}.{}", name, r.version, format);
        let content_type = if format == "zip" {
            "application/zip"
        } else {
            "application/gzip"
        };
        let _ = increment_release_download(&self.pool, kind, name, &r.version).await;
        Ok(DownloadResult {
            bytes: r.archive,
            content_type: content_type.to_string(),
            disposition: format!("attachment; filename=\"{}\"", disp_name),
            version: r.version,
            checksum,
        })
    }

    // -----------------------------------------------------------------------
    // 管理面：登记/元数据/上下架（技能与智能体同构）
    // -----------------------------------------------------------------------

    async fn require_market_app(&self, kind: &str, name: &str) -> Result<App, MarketplaceError> {
        let a = get_app(&self.pool, kind, name)
            .await
            .map_err(|_| MarketplaceError::not_found("资源不存在"))?;
        if a.channel != APP_CHANNEL_MARKET {
            return Err(MarketplaceError::not_found("资源不存在"));
        }
        Ok(a)
    }

    /// create_app 登记市场资源（内容与登记两步走；内容一律由 archive 上传）。
    pub async fn create_app(
        &self,
        kind: &str,
        name: &str,
        _version: &str,
        description: &str,
        author: &str,
        admin: &str,
    ) -> Result<Value, MarketplaceError> {
        if name.is_empty() {
            return Err(MarketplaceError::validation("名称必填"));
        }
        if !name_is_safe(name) {
            return Err(MarketplaceError::validation("名称不合法"));
        }
        // 跨渠道同名互斥（与 Go createSkillAdmin/createAgentAdmin 同语义）。
        match get_app(&self.pool, kind, name).await {
            Ok(existing) => {
                if existing.channel == APP_CHANNEL_ORG {
                    return Err(MarketplaceError::new(
                        409,
                        ERR_CONFLICT,
                        "名称与组织共享库资源冲突,请先在共享库处理同名资源",
                    ));
                }
                return Err(MarketplaceError::validation("资源已存在"));
            }
            Err(StoreError::NotFound) => {}
            Err(e) => return Err(e.into()),
        }
        let owner = if author.is_empty() { admin } else { author };
        upsert_app(
            &self.pool,
            &App {
                kind: kind.into(),
                app_id: name.into(),
                title: name.into(),
                description: description.into(),
                owner: owner.into(),
                channel: APP_CHANNEL_MARKET.into(),
                enabled: 1,
                ..Default::default()
            }
        )
        .await?;
        audit_log(&self.pool, admin, &format!("{}_create", kind), name).await?;
        Ok(json!({ "app": { "name": name, "author": owner } }))
    }

    /// update_app 更新元数据（不触碰版本与归档；技能版禁止经此改版本——
    /// 版本只能由「上传新版」随归档原子写入）。
    pub async fn update_app(
        &self,
        kind: &str,
        name: &str,
        new_name: &str,
        description: Option<&str>,
        author: Option<&str>,
        admin: &str,
        version: &str,
    ) -> Result<Value, MarketplaceError> {
        let a = get_app(&self.pool, kind, name)
            .await
            .map_err(|_| MarketplaceError::not_found("资源不存在"))?;
        if a.channel != APP_CHANNEL_MARKET {
            return Err(MarketplaceError::not_found("资源不存在"));
        }
        if !version.is_empty() {
            let cur = current_market_release_for(&self.pool, kind, name, false).await?;
            if cur.as_ref().map(|r| r.version.as_str()) != Some(version) {
                return Err(MarketplaceError::validation("请用「上传新版」随归档一起更改版本"));
            }
        }
        let title = if new_name.is_empty() {
            a.title.clone()
        } else {
            new_name.to_string()
        };
        let desc = description.unwrap_or(&a.description).to_string();
        let owner = author.unwrap_or(&a.owner).to_string();
        upsert_app(
            &self.pool,
            &App {
                kind: kind.into(),
                app_id: name.into(),
                title: title.clone(),
                description: desc,
                owner: owner.clone(),
                channel: APP_CHANNEL_MARKET.into(),
                enabled: a.enabled,
                ..Default::default()
            }
        )
        .await?;
        audit_log(&self.pool, admin, &format!("{}_update_meta", kind), name).await?;
        Ok(json!({ "ok": true, "app": { "name": name, "title": title, "author": owner } }))
    }

    /// delete_app 下架（置 enabled=0，不删行；可重新上架）。
    pub async fn delete_app(&self, kind: &str, name: &str, admin: &str) -> Result<Value, MarketplaceError> {
        self.require_market_app(kind, name).await?;
        set_app_enabled(&self.pool, kind, name, false).await?;
        audit_log(&self.pool, admin, &format!("{}_disable", kind), name).await?;
        Ok(json!({ "ok": true }))
    }

    /// enable_app 重新上架（恢复员工可见性）。
    pub async fn enable_app(&self, kind: &str, name: &str, admin: &str) -> Result<Value, MarketplaceError> {
        self.require_market_app(kind, name).await?;
        set_app_enabled(&self.pool, kind, name, true).await?;
        audit_log(&self.pool, admin, &format!("{}_enable", kind), name).await?;
        Ok(json!({ "ok": true }))
    }

    /// preview_app 展示版本归档的条目清单 + 主文件正文（审批前查看内容）。
    pub async fn preview_app(&self, kind: &str, name: &str) -> Result<Value, MarketplaceError> {
        let r = current_market_release_for(&self.pool, kind, name, true)
            .await?
            .ok_or_else(|| MarketplaceError::not_found("资源尚未发布版本"))?;
        let required = if kind == APP_KIND_AGENT {
            "agent.cordis.yml"
        } else {
            "SKILL.md"
        };
        let (entries, main) = list_archive_contents(&r.archive, required)?;
        let main_key = if kind == APP_KIND_AGENT { "composition" } else { "skill_md" };
        let mut out = json!({
            "files": entries,
            "name": name,
            "version": r.version,
            "checksum": r.checksum,
        });
        out[main_key] = json!(main);
        Ok(out)
    }

    /// file_content_app 按路径返回归档内文件内容（审批逐文件查看）。
    pub async fn file_content_app(
        &self,
        kind: &str,
        name: &str,
        path: &str,
    ) -> Result<FileContent, MarketplaceError> {
        let r = current_market_release_for(&self.pool, kind, name, true)
            .await?
            .ok_or_else(|| MarketplaceError::not_found("资源尚未发布版本"))?;
        if path.is_empty() {
            return Err(MarketplaceError::validation("缺少文件路径"));
        }
        let norm = normalize_path(path)
            .map_err(|_| MarketplaceError::validation("文件路径不合法"))?;
        if norm.is_empty() {
            return Err(MarketplaceError::validation("文件路径不合法"));
        }
        let (content, size, binary, too_large, found) =
            extract_file_content(&r.archive, &norm, MAX_FILE_PREVIEW_BYTES)
                .map_err(|_| MarketplaceError::new(422, ERR_ARCHIVE_INVALID, "归档解析失败"))?;
        let found =
            found || content.len() > 0 || binary || too_large || size > 0;
        if !found {
            return Err(MarketplaceError::not_found("归档中不存在该文件"));
        }
        Ok(FileContent {
            path: norm,
            size,
            binary,
            too_large,
            content,
        })
    }

    // -----------------------------------------------------------------------
    // 统一发布内核（版本语义/锁定/跨渠道互斥/包内即真相）
    // -----------------------------------------------------------------------

    /// publish 执行一次发布：锁定检查 → 版本语义 → 落库。
    /// 管理端（admin_publish=true）跳过锁定与待审配额，且发布即 approved。
    pub async fn publish(&self, req: &PublishRequest) -> Result<PublishResult, MarketplaceError> {
        if !crate::skillmanifest::is_app_id(&req.app_id) {
            return Err(MarketplaceError::new(
                400,
                crate::skillmanifest::CODE_INVALID_APP_ID,
                "名称不合法:必须是小写 kebab-case(如 my-skill)",
            ));
        }
        if req.manifest.version.is_empty() || !crate::skillmanifest::is_version(&req.manifest.version) {
            return Err(MarketplaceError::new(
                422,
                crate::skillmanifest::CODE_INVALID_VERSION,
                "版本号不合法:必须是 x.y.z",
            ));
        }
        if !req.declared_version.is_empty() && req.declared_version != req.manifest.version {
            return Err(MarketplaceError::new(
                422,
                crate::skillmanifest::CODE_MANIFEST_MISMATCH,
                format!(
                    "表单版本({})与包内 version({})不一致,请以包内版本为准",
                    req.declared_version, req.manifest.version
                ),
            ));
        }

        // 锁定：被锁定的能力名只能由管理员发布（员工命中明确拒绝并回显理由）。
        if !req.admin_publish {
            match picoaide_dsh_store::capability_locks::get_capability_lock(
                &self.pool, &req.kind, &req.app_id,
            )
            .await
            {
                Ok(lock) => {
                    let mut msg = "该能力已被管理员锁定,仅管理员可发布".to_string();
                    if !lock.reason.is_empty() {
                        msg.push(':');
                        msg.push_str(&lock.reason);
                    }
                    return Err(MarketplaceError::new(403, CODE_APP_LOCKED, msg));
                }
                Err(StoreError::NotFound) => {}
                Err(e) => return Err(e.into()),
            }
        }

        let existing = match get_app(&self.pool, &req.kind, &req.app_id).await {
            Ok(a) => Some(a),
            Err(StoreError::NotFound) => None,
            Err(e) => return Err(e.into()),
        };
        if let Some(a) = &existing {
            if a.channel != req.channel {
                return Err(MarketplaceError::new(
                    409,
                    CODE_NAME_TAKEN,
                    format!(
                        "名称已被{}占用,请换个名字或联系管理员",
                        channel_label(&a.channel)
                    ),
                ));
            }
            // 官方内容锁定（0059）：归属官方的内容仅管理员可发布新版。
            if a.official == 1 && !req.admin_publish {
                return Err(MarketplaceError::new(
                    403,
                    CODE_OFFICIAL_LOCKED,
                    format!("官方{}仅管理员可上传", kind_label(&req.kind)),
                ));
            }
            // 归属保护：他人的 App（任意状态）不允许被其他非管理员接管发布。
            if !req.admin_publish && a.owner != req.publisher {
                return Err(MarketplaceError::new(
                    409,
                    CODE_NAME_TAKEN,
                    "名称已被占用，无法上传：请更换名称或联系管理员",
                ));
            }
        }

        // 版本语义（决策 D1/D3）：被拒与软删版本同样占位。
        let history = list_releases(&self.pool, &req.kind, &req.app_id).await?;
        let mut newest = String::new();
        for h in &history {
            if h.version == req.manifest.version {
                return Err(MarketplaceError::new(
                    409,
                    CODE_VERSION_EXISTS,
                    format!(
                        "版本 {} 已存在(每个版本都是不可修改的快照),请升版本号后重试",
                        req.manifest.version
                    ),
                ));
            }
            if !h.checksum.is_empty()
                && h.checksum == req.checksum
                && h.publisher == req.publisher
            {
                return Err(MarketplaceError::new(
                    409,
                    CODE_CONTENT_UNCHANGED,
                    format!("内容与你已提交的 v{} 完全一致,无需重复上传", h.version),
                ));
            }
            if newest.is_empty() || crate::skillmanifest::compare_versions(&h.version, &newest) > 0 {
                newest = h.version.clone();
            }
        }
        if !newest.is_empty()
            && crate::skillmanifest::compare_versions(&req.manifest.version, &newest) <= 0
        {
            return Err(MarketplaceError::new(
                409,
                CODE_VERSION_NOT_INCREASING,
                format!(
                    "版本号必须大于当前最高版本 v{}(当前包内为 {})",
                    newest, req.manifest.version
                ),
            ));
        }
        // 非首个版本必须写更新说明（审核人与使用者据此判断该不该升级）。
        if !history.is_empty() && req.manifest.changelog.trim().is_empty() {
            return Err(MarketplaceError::new(
                422,
                crate::skillmanifest::CODE_MISSING_FIELD,
                "非首个版本必须填写 changelog(本版改了什么)",
            ));
        }

        // 待审配额（仅员工发布；管理端 AdminPublish=true 跳过）。
        if !req.admin_publish && req.pending_cap > 0 {
            let n = pending_release_count(&self.pool, &req.publisher).await?;
            if n >= req.pending_cap {
                return Err(MarketplaceError::new(
                    429,
                    CODE_PENDING_LIMIT,
                    format!("待审核数量已达上限({}),请等待审核", req.pending_cap),
                ));
            }
        }

        let owner = existing
            .as_ref()
            .map(|a| a.owner.clone())
            .filter(|o| !o.is_empty())
            .unwrap_or_else(|| req.publisher.clone());
        let enabled = existing.as_ref().map(|a| a.enabled).unwrap_or(1);
        upsert_app(
            &self.pool,
            &App {
                kind: req.kind.clone(),
                app_id: req.app_id.clone(),
                title: req.manifest.title.clone(),
                description: req.manifest.description.clone(),
                owner,
                channel: req.channel.clone(),
                enabled,
                ..Default::default()
            }
        )
        .await?;

        let status = if req.admin_publish {
            RELEASE_STATUS_APPROVED.to_string()
        } else {
            RELEASE_STATUS_PENDING.to_string()
        };
        create_release(
            &self.pool,
            &Release {
                kind: req.kind.clone(),
                app_id: req.app_id.clone(),
                version: req.manifest.version.clone(),
                title: req.manifest.title.clone(),
                description: req.manifest.description.clone(),
                changelog: req.manifest.changelog.clone(),
                category: req.manifest.category.clone(),
                tags: req.manifest.tags.clone(),
                author: req.manifest.author.clone(),
                publisher: req.publisher.clone(),
                checksum: req.checksum.clone(),
                size: req.archive.len() as i64,
                archive: req.archive.clone(),
                status: status.clone(),
                ..Default::default()
            }
        )
        .await
        .map_err(|e| match e {
            StoreError::Duplicate => MarketplaceError::new(
                409,
                CODE_VERSION_EXISTS,
                format!(
                    "版本 {} 已存在(每个版本都是不可修改的快照),请升版本号后重试",
                    req.manifest.version
                ),
            ),
            other => other.into(),
        })?;
        Ok(PublishResult {
            version: req.manifest.version.clone(),
            status,
            checksum: req.checksum.clone(),
        })
    }

    // -----------------------------------------------------------------------
    // 审核（approve/reject）+ 质量标记
    // -----------------------------------------------------------------------

    /// approve_release 审核通过一个版本（只改状态位，绝不触碰内容）。
    pub async fn approve_release(
        &self,
        kind: &str,
        name: &str,
        version: &str,
        admin: &str,
    ) -> Result<Value, MarketplaceError> {
        let r = get_release(&self.pool, kind, name, version)
            .await
            .map_err(|_| MarketplaceError::not_found("资源不存在"))?;
        if r.deleted_at.is_some() {
            return Err(MarketplaceError::not_found("资源不存在"));
        }
        set_release_status(&self.pool, kind, name, version, RELEASE_STATUS_APPROVED, "").await?;
        audit_log(
            &self.pool,
            admin,
            &format!("{}_approve", kind),
            &format!("{}@{}", name, version),
        )
        .await?;
        Ok(json!({ "ok": true }))
    }

    /// reject_release 拒绝一个版本：必须带理由（作者可见、重提交时清除）。
    pub async fn reject_release(
        &self,
        kind: &str,
        name: &str,
        version: &str,
        reason: &str,
        admin: &str,
    ) -> Result<Value, MarketplaceError> {
        let reason = reason.trim().to_string();
        if reason.chars().count() > MAX_DESCRIPTION_LEN {
            return Err(MarketplaceError::validation("拒绝理由过长(上限 500 字)"));
        }
        if reason.is_empty() {
            return Err(MarketplaceError::validation("请填写拒绝理由"));
        }
        let r = get_release(&self.pool, kind, name, version)
            .await
            .map_err(|_| MarketplaceError::not_found("资源不存在"))?;
        if r.deleted_at.is_some() {
            return Err(MarketplaceError::not_found("资源不存在"));
        }
        set_release_status(&self.pool, kind, name, version, RELEASE_STATUS_REJECTED, &reason).await?;
        audit_log(
            &self.pool,
            admin,
            &format!("{}_reject", kind),
            &format!("{}@{}", name, version),
        )
        .await?;
        Ok(json!({ "ok": true }))
    }

    /// set_quality 质量标记（仅 approved 版本可设置：official|featured）。
    pub async fn set_quality(
        &self,
        kind: &str,
        name: &str,
        version: &str,
        quality: &str,
        admin: &str,
    ) -> Result<Value, MarketplaceError> {
        set_release_quality(&self.pool, kind, name, version, quality).await?;
        audit_log(
            &self.pool,
            admin,
            &format!("{}_quality", kind),
            &format!("{}@{} {}", name, version, quality),
        )
        .await?;
        Ok(json!({ "ok": true }))
    }

    // -----------------------------------------------------------------------
    // 授权（严格默认拒绝 / 用户+组双主体 / 审计）
    // -----------------------------------------------------------------------

    /// parse_grant_subject 解析授权主体：username 或 group 二选一。
    pub fn parse_grant_subject(
        username: &str,
        group: &str,
    ) -> Result<(String, GranteeType), MarketplaceError> {
        if !username.is_empty() && group.is_empty() {
            return Ok((username.to_string(), GranteeType::User));
        }
        if !group.is_empty() && username.is_empty() {
            return Ok((group.to_string(), GranteeType::Group));
        }
        Err(MarketplaceError::validation("username 或 group 必填且只能二选一"))
    }

    /// ensure_subject_exists 主体存在性校验（拼错的用户名/部门名不得静默落库）。
    pub async fn ensure_subject_exists(
        &self,
        subject: &str,
        t: GranteeType,
    ) -> Result<(), MarketplaceError> {
        match t {
            GranteeType::User => {
                picoaide_dsh_store::users::get_user_by_username(&self.pool, subject)
                    .await
                    .map_err(|_| MarketplaceError::validation(format!("用户不存在: {}", subject)))?;
            }
            GranteeType::Group => {
                picoaide_dsh_store::groups::group_by_name(&self.pool, subject)
                    .await
                    .map_err(|_| MarketplaceError::validation(format!("部门不存在: {}", subject)))?;
            }
        }
        Ok(())
    }

    /// set_grant 单条授权或撤销（幂等；授权变更必审计）。
    pub async fn set_grant(
        &self,
        kind: &str,
        name: &str,
        subject: &str,
        t: GranteeType,
        grant: bool,
        admin: &str,
    ) -> Result<Value, MarketplaceError> {
        self.require_market_app(kind, name).await?;
        self.ensure_subject_exists(subject, t).await?;
        let action = if grant {
            format!("{}_grant", kind)
        } else {
            format!("{}_revoke", kind)
        };
        if grant {
            grant_app(&self.pool, kind, name, subject, t.as_str()).await?;
        } else {
            revoke_app(&self.pool, kind, name, subject, t.as_str()).await?;
        }
        audit_log(
            &self.pool,
            admin,
            &action,
            &format!("{}#{} {}:{}", kind, name, t.as_str(), subject),
        )
        .await?;
        Ok(json!({ "ok": true }))
    }

    /// list_grants 列出某 App 的全部授权对象。
    pub async fn list_grants(&self, kind: &str, name: &str) -> Result<Value, MarketplaceError> {
        self.require_market_app(kind, name).await?;
        let grants = list_app_grants(&self.pool, kind, name).await?;
        let out: Vec<GrantDto> = grants
            .into_iter()
            .map(|g| GrantDto {
                grantee_type: g.grantee_type,
                grantee: g.grantee,
            })
            .collect();
        Ok(json!({ "grants": out }))
    }

    /// replace_group_grants 整组替换部门授权（原子；用户授权保留）。
    pub async fn replace_group_grants(
        &self,
        kind: &str,
        name: &str,
        groups: &[String],
        admin: &str,
    ) -> Result<Value, MarketplaceError> {
        self.require_market_app(kind, name).await?;
        // 未知部门名 → 400（store 事务内校验，TOCTOU 安全）。
        let res = if kind == APP_KIND_SKILL {
            replace_skill_group_grants(&self.pool, name, groups).await
        } else {
            replace_shared_groups(&self.pool, SHARED_PRESET_GRANT_TABLE, name, groups).await
        };
        // Go 语义：存在不认识的部门名 → 400 VALIDATION。
        res.map_err(|e| match e {
            StoreError::NotFound => MarketplaceError::validation("存在不认识的部门名称"),
            StoreError::Validation => MarketplaceError::validation("授权对象不合法"),
            other => other.into(),
        })?;
        audit_log(
            &self.pool,
            admin,
            &format!("{}_grants_replace", kind),
            &format!("{} {}", name, groups.join(",")),
        )
        .await?;
        Ok(json!({ "ok": true }))
    }

    /// replace_grants 整组替换全部授权（用户 + 部门；未列入者全部撤销）。
    pub async fn replace_grants(
        &self,
        kind: &str,
        name: &str,
        groups: &[String],
        usernames: &[String],
        admin: &str,
    ) -> Result<Value, MarketplaceError> {
        self.require_market_app(kind, name).await?;
        let existing = list_app_grants(&self.pool, kind, name).await?;
        for g in existing {
            revoke_app(&self.pool, kind, name, &g.grantee, &g.grantee_type).await?;
        }
        for g in groups {
            if g.is_empty() {
                continue;
            }
            let g = g.strip_prefix('@').unwrap_or(g).to_string();
            grant_app(&self.pool, kind, name, &g, "group").await?;
        }
        for u in usernames {
            if u.is_empty() {
                continue;
            }
            grant_app(&self.pool, kind, name, u, "user").await?;
        }
        audit_log(
            &self.pool,
            admin,
            &format!("{}_grants", kind),
            &format!("{} replace", name),
        )
        .await?;
        Ok(json!({ "ok": true }))
    }

    // -----------------------------------------------------------------------
    // 能力锁定（允许对尚不存在的名字预锁定）
    // -----------------------------------------------------------------------

    /// lock_capability 锁定一个能力名（幂等；理由在员工被拒时原样回显）。
    pub async fn lock_capability(
        &self,
        kind: &str,
        name: &str,
        reason: &str,
        by: &str,
    ) -> Result<Value, MarketplaceError> {
        let reason = reason.trim().to_string();
        if reason.chars().count() > MAX_DESCRIPTION_LEN {
            return Err(MarketplaceError::validation("锁定理由过长(上限 500 字)"));
        }
        picoaide_dsh_store::capability_locks::lock_capability(&self.pool, kind, name, &reason, by)
            .await?;
        audit_log(
            &self.pool,
            by,
            "capability_lock",
            &format!("{}:{} {}", kind, name, reason),
        )
        .await?;
        Ok(json!({ "ok": true }))
    }

    /// unlock_capability 解除锁定（未锁定 → 404）。
    pub async fn unlock_capability(
        &self,
        kind: &str,
        name: &str,
        by: &str,
    ) -> Result<Value, MarketplaceError> {
        picoaide_dsh_store::capability_locks::unlock_capability(&self.pool, kind, name).await?;
        audit_log(&self.pool, by, "capability_unlock", &format!("{}:{}", kind, name)).await?;
        Ok(json!({ "ok": true }))
    }

    /// list_capability_locks 列出全部锁定记录（管理端视图）。
    pub async fn list_capability_locks(&self) -> Result<Value, MarketplaceError> {
        let locks = picoaide_dsh_store::capability_locks::list_capability_locks(&self.pool).await?;
        let out: Vec<Value> = locks
            .into_iter()
            .map(|l| {
                json!({
                    "kind": l.kind,
                    "name": l.name,
                    "reason": l.reason,
                    "locked_by": l.locked_by,
                    "created_at": l.created_at,
                })
            })
            .collect();
        Ok(json!({ "locks": out }))
    }

    /// list_releases 列出某 App 的全部版本（管理端审核队列）。status 空 = 全部。
    pub async fn list_releases(
        &self,
        kind: &str,
        name: &str,
        status: &str,
    ) -> Result<Value, MarketplaceError> {
        self.require_market_app(kind, name).await?;
        let all = list_releases(&self.pool, kind, name).await?;
        let releases: Vec<&Release> = if status.is_empty() {
            all.iter().collect()
        } else {
            all.iter().filter(|r| r.status == status).collect()
        };
        let out: Vec<Value> = releases.into_iter().map(release_json).collect();
        Ok(json!({ "releases": out }))
    }

    /// list_pending_releases 审核队列（全部资源的待审版本，管理端首页）。
    pub async fn list_pending_releases(&self, kind: &str) -> Result<Value, MarketplaceError> {
        let releases = list_releases_by_status(&self.pool, kind, RELEASE_STATUS_PENDING).await?;
        let out: Vec<Value> = releases.iter().map(release_json).collect();
        Ok(json!({ "releases": out }))
    }
}

// ---------------------------------------------------------------------------
// DTO 投影
// ---------------------------------------------------------------------------

fn channel_label(channel: &str) -> &'static str {
    if channel == APP_CHANNEL_MARKET {
        "市场"
    } else {
        "组织共享库"
    }
}

fn kind_label(kind: &str) -> &'static str {
    if kind == APP_KIND_AGENT {
        "智能体"
    } else {
        "技能"
    }
}

fn app_json(a: &App, r: Option<&Release>) -> Value {
    let mut out = json!({
        "name": a.app_id,
        "title": a.title,
        "description": a.description,
        "author": a.owner,
        "enabled": a.enabled == 1,
        "official": a.official == 1,
        "created_at": a.created_at,
        "updated_at": a.updated_at,
    });
    if let Some(r) = r {
        out["version"] = json!(r.version);
        out["quality"] = json!(r.quality);
        out["downloads"] = json!(r.downloads);
        out["changelog"] = json!(r.changelog);
        out["status"] = json!(r.status);
        out["checksum"] = json!(r.checksum);
    }
    out
}

fn release_json(r: &Release) -> Value {
    json!({
        "id": r.id,
        "kind": r.kind,
        "app_id": r.app_id,
        "version": r.version,
        "title": r.title,
        "description": r.description,
        "changelog": r.changelog,
        "category": r.category,
        "tags": r.tags,
        "author": r.author,
        "publisher": r.publisher,
        "checksum": r.checksum,
        "size": r.size,
        "status": r.status,
        "reason": r.reason,
        "quality": r.quality,
        "downloads": r.downloads,
        "calls": r.calls,
        "deleted_at": r.deleted_at,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
    })
}

/// audit_log 审计快捷写（哈希链追加）。
async fn audit_log(
    pool: &sqlx::PgPool,
    username: &str,
    action: &str,
    detail: &str,
) -> Result<(), MarketplaceError> {
    picoaide_dsh_store::audit::audit_log(pool, username, action, detail)
        .await
        .map_err(MarketplaceError::from)
}

// ---------------------------------------------------------------------------
// 归档工具（Go archiveutil + agentshare 等价精简版：zip/tar.gz、路径安全、
// 解压上限、必需文件、逐文件提取与预览）。
// ---------------------------------------------------------------------------

/// ArchiveError 归档校验失败分类（对应 Go ErrNoRequired/ErrUnsafe/…）。
#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum ArchiveError {
    #[error("归档缺少必需文件")]
    NoRequired,
    #[error("存档内容不安全(路径越界或链接文件)")]
    Unsafe,
    #[error("归档条目过多")]
    TooMany,
    #[error("归档过大或结构非法")]
    Invalid,
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// archive_format 按魔数探测「zip」或「tar.gz」，其它返回 ""。
pub fn archive_format(data: &[u8]) -> &'static str {
    if data.len() >= 4
        && data[0] == b'P'
        && data[1] == b'K'
        && (data[2] == 3 || data[2] == 5 || data[2] == 7)
    {
        "zip"
    } else if data.len() >= 2 && data[0] == 0x1f && data[1] == 0x8b {
        "tar.gz"
    } else {
        ""
    }
}

/// validate_archive 列出归档（不解压），拒绝不安全条目并限界，要求顶层必需
/// 文件。返回归档 sha256 hex（与 Go ValidateSkillArchive 同语义）。
pub fn validate_archive(data: &[u8], required: &str) -> Result<String, ArchiveError> {
    if data.is_empty() || data.len() > MAX_ARCHIVE_BYTES {
        return Err(ArchiveError::Invalid);
    }
    let checksum = sha256_hex(data);
    match archive_format(data) {
        "zip" => validate_zip(data, required)?,
        "tar.gz" => validate_tar(data, required)?,
        _ => return Err(ArchiveError::Invalid),
    }
    Ok(checksum)
}

/// validate_skill_archive 技能归档校验（必需文件 SKILL.md）。
pub fn validate_skill_archive(data: &[u8]) -> Result<String, ArchiveError> {
    validate_archive(data, "SKILL.md")
}

/// validate_preset_archive 智能体归档校验（必需文件 agent.cordis.yml）。
pub fn validate_preset_archive(data: &[u8]) -> Result<String, ArchiveError> {
    validate_archive(data, "agent.cordis.yml")
}

/// list_archive_contents 列出非目录条目路径（排序去重）+ 顶层必需文件正文。
pub fn list_archive_contents(
    data: &[u8],
    required: &str,
) -> Result<(Vec<String>, String), ArchiveError> {
    match archive_format(data) {
        "zip" => zip_list(data, required),
        "tar.gz" => tar_list(data, required),
        _ => Err(ArchiveError::Invalid),
    }
}

/// extract_file_content 按归一化路径提取单个文件内容。
/// 返回 (content, size, binary, too_large, found)。
pub fn extract_file_content(
    data: &[u8],
    target: &str,
    max_preview: u64,
) -> Result<(String, u64, bool, bool, bool), ArchiveError> {
    match archive_format(data) {
        "zip" => zip_extract(data, target, max_preview),
        "tar.gz" => tar_extract(data, target, max_preview),
        _ => Err(ArchiveError::Invalid),
    }
}

/// normalize_path 归一化归档内文件路径（拒绝越界/绝对/盘符）。
pub fn normalize_path(raw: &str) -> Result<String, ArchiveError> {
    if raw.is_empty() {
        return Ok(String::new());
    }
    if raw.starts_with('/') || raw.starts_with('\\') {
        return Err(ArchiveError::Unsafe);
    }
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(ArchiveError::Unsafe);
    }
    let mut out: Vec<&str> = Vec::new();
    let normalized = raw.replace('\\', "/");
    for seg in normalized.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return Err(ArchiveError::Unsafe),
            s => out.push(s),
        }
    }
    Ok(out.join("/"))
}

fn check_zip_entry(name: &str) -> Result<(String, bool, bool), ArchiveError> {
    // (normalized, is_dir, is_symlink)
    let is_dir = name.ends_with('/');
    let norm = normalize_path(name)?;
    Ok((norm, is_dir, false))
}

fn validate_zip(data: &[u8], required: &str) -> Result<(), ArchiveError> {
    let cursor = std::io::Cursor::new(data);
    let mut zr = zip::ZipArchive::new(cursor).map_err(|_| ArchiveError::Invalid)?;
    if zr.len() > MAX_ARCHIVE_ENTRIES {
        return Err(ArchiveError::TooMany);
    }
    let mut total: u64 = 0;
    let mut has_required = false;
    for i in 0..zr.len() {
        let f = zr.by_index(i).map_err(|_| ArchiveError::Invalid)?;
        let (norm, is_dir, is_symlink) = check_zip_entry(f.name())?;
        if is_symlink {
            return Err(ArchiveError::Unsafe);
        }
        if norm.is_empty() {
            return Err(ArchiveError::Unsafe);
        }
        if is_dir {
            continue;
        }
        let size = f.size();
        if size > MAX_UNPACKED_BYTES || total + size > MAX_UNPACKED_BYTES {
            return Err(ArchiveError::Invalid);
        }
        total += size;
        if norm == required {
            has_required = true;
        }
    }
    if !has_required {
        return Err(ArchiveError::NoRequired);
    }
    Ok(())
}

fn zip_list(data: &[u8], required: &str) -> Result<(Vec<String>, String), ArchiveError> {
    use std::collections::BTreeSet;
    use std::io::Read;
    let cursor = std::io::Cursor::new(data);
    let mut zr = zip::ZipArchive::new(cursor).map_err(|_| ArchiveError::Invalid)?;
    if zr.len() > MAX_ARCHIVE_ENTRIES {
        return Err(ArchiveError::TooMany);
    }
    let mut set: BTreeSet<String> = BTreeSet::new();
    let mut required_content = String::new();
    for i in 0..zr.len() {
        let mut f = zr.by_index(i).map_err(|_| ArchiveError::Invalid)?;
        let (norm, is_dir, _) = check_zip_entry(f.name())?;
        if is_dir || norm.is_empty() {
            continue;
        }
        set.insert(norm.clone());
        if norm == required && required_content.is_empty() && f.size() <= MAX_FILE_PREVIEW_BYTES {
            let mut buf = Vec::new();
            let mut limited = (&mut f as &mut dyn Read).take(MAX_FILE_PREVIEW_BYTES + 1);
            limited.read_to_end(&mut buf).map_err(|_| ArchiveError::Invalid)?;
            if buf.len() as u64 <= MAX_FILE_PREVIEW_BYTES {
                required_content = String::from_utf8_lossy(&buf).to_string();
            }
        }
    }
    Ok((set.into_iter().collect(), required_content))
}

fn zip_extract(
    data: &[u8],
    target: &str,
    max_preview: u64,
) -> Result<(String, u64, bool, bool, bool), ArchiveError> {
    use std::io::Read;
    let cursor = std::io::Cursor::new(data);
    let mut zr = zip::ZipArchive::new(cursor).map_err(|_| ArchiveError::Invalid)?;
    for i in 0..zr.len() {
        let mut f = zr.by_index(i).map_err(|_| ArchiveError::Invalid)?;
        let (norm, is_dir, _) = check_zip_entry(f.name())?;
        if is_dir || norm != target {
            continue;
        }
        let size = f.size();
        let mut buf = Vec::new();
        let mut limited = (&mut f as &mut dyn Read).take(max_preview + 1);
        limited.read_to_end(&mut buf).map_err(|_| ArchiveError::Invalid)?;
        if buf.len() as u64 > max_preview {
            return Ok((String::new(), size, false, true, true));
        }
        if std::str::from_utf8(&buf).is_err() {
            return Ok((String::new(), size, true, false, true));
        }
        return Ok((String::from_utf8_lossy(&buf).to_string(), size, false, false, true));
    }
    Ok((String::new(), 0, false, false, false))
}

fn validate_tar(data: &[u8], required: &str) -> Result<(), ArchiveError> {
    let mut gz = flate2::read::GzDecoder::new(data);
    let mut ar = tar::Archive::new(&mut gz);
    let mut entries = 0usize;
    let mut total: u64 = 0;
    let mut has_required = false;
    for entry in ar.entries().map_err(|_| ArchiveError::Unsafe)? {
        entries += 1;
        if entries > MAX_ARCHIVE_ENTRIES {
            return Err(ArchiveError::TooMany);
        }
        let e = entry.map_err(|_| ArchiveError::Unsafe)?;
        let name = e.path().map_err(|_| ArchiveError::Unsafe)?;
        let name = name.to_string_lossy().to_string();
        let ty = e.header().entry_type();
        if ty.is_symlink() || ty.is_hard_link() {
            return Err(ArchiveError::Unsafe);
        }
        if ty.is_dir() {
            continue;
        }
        let norm = normalize_path(&name)?;
        if norm.is_empty() {
            return Err(ArchiveError::Unsafe);
        }
        total += e.size();
        if total > MAX_UNPACKED_BYTES {
            return Err(ArchiveError::Invalid);
        }
        if norm == required {
            has_required = true;
        }
    }
    if !has_required {
        return Err(ArchiveError::NoRequired);
    }
    Ok(())
}

fn tar_list(data: &[u8], required: &str) -> Result<(Vec<String>, String), ArchiveError> {
    use std::collections::BTreeSet;
    use std::io::Read;
    let mut gz = flate2::read::GzDecoder::new(data);
    let mut ar = tar::Archive::new(&mut gz);
    let mut set: BTreeSet<String> = BTreeSet::new();
    let mut required_content = String::new();
    let mut entries = 0usize;
    for entry in ar.entries().map_err(|_| ArchiveError::Unsafe)? {
        entries += 1;
        if entries > MAX_ARCHIVE_ENTRIES {
            return Err(ArchiveError::TooMany);
        }
        let mut e = entry.map_err(|_| ArchiveError::Unsafe)?;
        let name = e.path().map_err(|_| ArchiveError::Unsafe)?;
        let name = name.to_string_lossy().to_string();
        let ty = e.header().entry_type();
        if ty.is_symlink() || ty.is_hard_link() {
            return Err(ArchiveError::Unsafe);
        }
        if ty.is_dir() {
            continue;
        }
        let norm = normalize_path(&name)?;
        if norm.is_empty() {
            continue;
        }
        set.insert(norm.clone());
        if norm == required && required_content.is_empty() && e.size() <= MAX_FILE_PREVIEW_BYTES {
            let mut buf = Vec::new();
            let mut limited = (&mut e as &mut dyn Read).take(MAX_FILE_PREVIEW_BYTES + 1);
            limited.read_to_end(&mut buf).map_err(|_| ArchiveError::Invalid)?;
            if buf.len() as u64 <= MAX_FILE_PREVIEW_BYTES {
                required_content = String::from_utf8_lossy(&buf).to_string();
            }
        }
    }
    Ok((set.into_iter().collect(), required_content))
}

fn tar_extract(
    data: &[u8],
    target: &str,
    max_preview: u64,
) -> Result<(String, u64, bool, bool, bool), ArchiveError> {
    use std::io::Read;
    let mut gz = flate2::read::GzDecoder::new(data);
    let mut ar = tar::Archive::new(&mut gz);
    let mut entries = 0usize;
    for entry in ar.entries().map_err(|_| ArchiveError::Unsafe)? {
        entries += 1;
        if entries > MAX_ARCHIVE_ENTRIES {
            return Err(ArchiveError::TooMany);
        }
        let mut e = entry.map_err(|_| ArchiveError::Unsafe)?;
        let name = e.path().map_err(|_| ArchiveError::Unsafe)?;
        let name = name.to_string_lossy().to_string();
        let ty = e.header().entry_type();
        if ty.is_symlink() || ty.is_hard_link() {
            return Err(ArchiveError::Unsafe);
        }
        if ty.is_dir() {
            continue;
        }
        let norm = normalize_path(&name)?;
        if norm != target {
            continue;
        }
        let size = e.size();
        let mut buf = Vec::new();
        let mut limited = (&mut e as &mut dyn Read).take(max_preview + 1);
        limited.read_to_end(&mut buf).map_err(|_| ArchiveError::Invalid)?;
        if buf.len() as u64 > max_preview {
            return Ok((String::new(), size, false, true, true));
        }
        if std::str::from_utf8(&buf).is_err() {
            return Ok((String::new(), size, true, false, true));
        }
        return Ok((String::from_utf8_lossy(&buf).to_string(), size, false, false, true));
    }
    Ok((String::new(), 0, false, false, false))
}

/// name_is_safe 市场资源名白名单（与 Go skillNameRe 同语义：[A-Za-z0-9._-]+）。
pub fn name_is_safe(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

// ---------------------------------------------------------------------------
// 测试（对应 Go admin_test.go / perm_test.go / skill_api_test.go 主要断言）
// ---------------------------------------------------------------------------


#[cfg(test)]
mod tests {
    use super::*;
    use picoaide_dsh_store::testutil::new_test_db;
    use std::io::Write as _;

    fn make_zip(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zw = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, content) in entries {
                zw.start_file(*name, opts).unwrap();
                zw.write_all(content.as_bytes()).unwrap();
            }
            zw.finish().unwrap();
        }
        buf.into_inner()
    }

    fn make_tar_gz(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut gz = flate2::write::GzEncoder::new(&mut buf, flate2::Compression::default());
            {
                let mut tw = tar::Builder::new(&mut gz);
                for (name, content) in entries {
                    let mut hdr = tar::Header::new_gnu();
                    hdr.set_size(content.len() as u64);
                    hdr.set_mode(0o644);
                    hdr.set_cksum();
                    tw.append_data(&mut hdr, *name, content.as_bytes()).unwrap();
                }
                tw.finish().unwrap();
            }
            gz.finish().unwrap();
        }
        buf
    }

    fn good_skill_md(name: &str, version: &str) -> String {
        format!(
            "---\nname: {name}\ntitle: {name} 技能\nversion: {version}\n\
             description: 用于集成测试的市场技能包,描述需要满足最短长度要求。\n\
             author: tester\ncategory: 测试\nchangelog: 测试夹具的更新说明。\n\
             ---\n\n# {name}\n\n本技能是服务端集成测试使用的夹具包,正文需要足够长才能通过空壳校验,因此这里补充了一段用于说明用途的文字。\n"
        )
    }

    async fn seed_user(pool: &sqlx::PgPool, username: &str, is_admin: bool) -> i64 {
        let uid = picoaide_dsh_store::users::create_user_with_password(pool, username, "pw123456")
            .await
            .unwrap();
        if is_admin {
            let mut u = picoaide_dsh_store::users::get_user_by_username(pool, username)
                .await
                .unwrap();
            u.is_admin = true;
            picoaide_dsh_store::users::update_user(pool, &u).await.unwrap();
        }
        uid
    }

    fn manifest_for(name: &str, version: &str, changelog: &str) -> ManifestDto {
        ManifestDto {
            version: version.into(),
            title: format!("{name} 技能"),
            description: "用于集成测试的市场技能包,描述需要满足最短长度要求。".into(),
            changelog: changelog.into(),
            category: "测试".into(),
            author: "tester".into(),
            tags: vec![],
        }
    }

    async fn seed_market_skill(pool: &sqlx::PgPool, name: &str, version: &str) -> String {
        let svc = MarketplaceService::new(pool.clone());
        svc.create_app(APP_KIND_SKILL, name, version, "demo", "test", "boss")
            .await
            .unwrap();
        let md = good_skill_md(name, version);
        let archive = make_zip(&[("SKILL.md", md.as_str())]);
        let checksum = validate_skill_archive(&archive).unwrap();
        svc.publish(&PublishRequest {
            kind: APP_KIND_SKILL.into(),
            app_id: name.into(),
            channel: APP_CHANNEL_MARKET.into(),
            archive,
            publisher: "boss".into(),
            admin_publish: true,
            declared_version: version.into(),
            manifest: manifest_for(name, version, "测试夹具的更新说明。"),
            checksum: checksum.clone(),
            ..Default::default()
        })
        .await
        .unwrap();
        checksum
    }

    async fn seed_market_agent(pool: &sqlx::PgPool, name: &str, version: &str) -> String {
        let svc = MarketplaceService::new(pool.clone());
        let preset = format!(
            "name: {name} 智能体\ntitle: {name} 智能体\nversion: {version}\n\
             description: 用于集成测试的市场智能体包,描述需要满足最短长度要求。\n\
             author: tester\ncategory: 测试\nchangelog: 测试夹具的更新说明。\n"
        );
        let archive = make_zip(&[
            ("agent.cordis.yml", "# composition\n"),
            ("preset.yml", preset.as_str()),
        ]);
        let checksum = validate_preset_archive(&archive).unwrap();
        let manifest = ManifestDto {
            version: version.into(),
            title: format!("{name} 智能体"),
            description: "用于集成测试的市场智能体包,描述需要满足最短长度要求。".into(),
            changelog: "测试夹具的更新说明。".into(),
            category: "测试".into(),
            author: "tester".into(),
            tags: vec![],
        };
        svc.publish(&PublishRequest {
            kind: APP_KIND_AGENT.into(),
            app_id: name.into(),
            channel: APP_CHANNEL_MARKET.into(),
            archive,
            publisher: "boss".into(),
            admin_publish: true,
            declared_version: version.into(),
            manifest,
            checksum: checksum.clone(),
            ..Default::default()
        })
        .await
        .unwrap();
        checksum
    }

    // ------------------------------------------------------------------
    // 授权可见性（strict default）
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn strict_default_hides_ungranted() {
        let pool = new_test_db().await;
        seed_market_skill(&pool, "data-extract", "1.0.0").await;
        seed_user(&pool, "alice", false).await;

        let svc = MarketplaceService::new(pool.clone());
        let viewer = Viewer {
            username: "alice".into(),
            groups: vec![],
            is_admin: false,
        };
        let list = svc.list_apps(&viewer, APP_KIND_SKILL).await.unwrap();
        assert_eq!(list["apps"].as_array().unwrap().len(), 0, "未授权列表必须为空");
        assert!(matches!(
            svc.get_app(&viewer, APP_KIND_SKILL, "data-extract").await,
            Err(MarketplaceError { status: 404, .. })
        ));
        assert!(matches!(
            svc.download_archive(&viewer, APP_KIND_SKILL, "data-extract").await,
            Err(MarketplaceError { status: 404, .. })
        ));
        // 未授权与不存在同响应。
        assert!(matches!(
            svc.get_app(&viewer, APP_KIND_SKILL, "nope").await,
            Err(MarketplaceError { status: 404, .. })
        ));
    }

    #[tokio::test]
    async fn user_grant_opens_visibility_revoke_closes() {
        let pool = new_test_db().await;
        seed_market_skill(&pool, "data-extract", "1.0.0").await;
        seed_user(&pool, "alice", false).await;

        let svc = MarketplaceService::new(pool.clone());
        grant_app(&pool, APP_KIND_SKILL, "data-extract", "alice", "user")
            .await
            .unwrap();
        let viewer = Viewer {
            username: "alice".into(),
            groups: vec![],
            is_admin: false,
        };
        let list = svc.list_apps(&viewer, APP_KIND_SKILL).await.unwrap();
        assert_eq!(list["apps"].as_array().unwrap().len(), 1);
        let detail = svc.get_app(&viewer, APP_KIND_SKILL, "data-extract").await.unwrap();
        assert_eq!(detail["app"]["version"], "1.0.0");
        let dl = svc
            .download_archive(&viewer, APP_KIND_SKILL, "data-extract")
            .await
            .unwrap();
        assert_eq!(dl.content_type, "application/zip");
        assert_eq!(dl.version, "1.0.0");
        revoke_app(&pool, APP_KIND_SKILL, "data-extract", "alice", "user")
            .await
            .unwrap();
        let list = svc.list_apps(&viewer, APP_KIND_SKILL).await.unwrap();
        assert_eq!(list["apps"].as_array().unwrap().len(), 0, "撤销后立即失效");
    }

    #[tokio::test]
    async fn group_grant_resolves_through_membership() {
        let pool = new_test_db().await;
        seed_market_skill(&pool, "data-extract", "1.0.0").await;
        let uid = seed_user(&pool, "alice", false).await;

        let svc = MarketplaceService::new(pool.clone());
        grant_app(&pool, APP_KIND_SKILL, "data-extract", "研发部", "group")
            .await
            .unwrap();
        picoaide_dsh_store::groups::sync_user_groups(&pool, uid, &["研发部".into()])
            .await
            .unwrap();
        let viewer = Viewer {
            username: "alice".into(),
            groups: vec!["研发部".into()],
            is_admin: false,
        };
        let list = svc.list_apps(&viewer, APP_KIND_SKILL).await.unwrap();
        assert_eq!(list["apps"].as_array().unwrap().len(), 1, "组授权应可见");
        // 组名大小写不敏感（store 层 LOWER 比较）。
        let names = picoaide_dsh_store::grants::accessible_skill_names(
            &pool,
            &viewer.username,
            &["研发部".to_lowercase()],
        )
        .await
        .unwrap();
        assert!(names.contains(&"data-extract".to_string()));
        // 离开组 → 不可见（viewer 的 groups 来自服务端缓存已更新）。
        picoaide_dsh_store::groups::sync_user_groups(&pool, uid, &[]).await.unwrap();
        let viewer_after = Viewer {
            username: "alice".into(),
            groups: vec![],
            is_admin: false,
        };
        let list = svc.list_apps(&viewer_after, APP_KIND_SKILL).await.unwrap();
        assert_eq!(list["apps"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn admin_sees_everything_without_grants() {
        let pool = new_test_db().await;
        seed_market_skill(&pool, "data-extract", "1.0.0").await;
        seed_user(&pool, "boss", true).await;
        let svc = MarketplaceService::new(pool.clone());
        let viewer = Viewer {
            username: "boss".into(),
            groups: vec![],
            is_admin: true,
        };
        let list = svc.list_apps(&viewer, APP_KIND_SKILL).await.unwrap();
        assert_eq!(list["apps"].as_array().unwrap().len(), 1, "admin 恒全量");
    }

    // ------------------------------------------------------------------
    // 管理 CRUD + 上下架 + 授权
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn admin_skill_crud_disable_enable_audit() {
        let pool = new_test_db().await;
        let svc = MarketplaceService::new(pool.clone());
        assert!(matches!(
            svc.create_app(APP_KIND_SKILL, "../evil", "1.0.0", "", "", "boss").await,
            Err(MarketplaceError { status: 400, .. })
        ));
        svc.create_app(APP_KIND_SKILL, "demo", "1.0.0", "demo skill", "pico", "boss")
            .await
            .unwrap();
        assert!(matches!(
            svc.create_app(APP_KIND_SKILL, "demo", "2.0.0", "", "", "boss").await,
            Err(MarketplaceError { status: 400, .. })
        ));
        svc.delete_app(APP_KIND_SKILL, "demo", "boss").await.unwrap();
        let a = get_app(&pool, APP_KIND_SKILL, "demo").await.unwrap();
        assert_eq!(a.enabled, 0);
        svc.enable_app(APP_KIND_SKILL, "demo", "boss").await.unwrap();
        let a = get_app(&pool, APP_KIND_SKILL, "demo").await.unwrap();
        assert_eq!(a.enabled, 1);
        assert!(matches!(
            svc.enable_app(APP_KIND_SKILL, "nope", "boss").await,
            Err(MarketplaceError { status: 404, .. })
        ));
        let logs = picoaide_dsh_store::audit::list_audit_logs(&pool, 50).await.unwrap();
        let actions: Vec<String> = logs.iter().map(|l| l.action.clone()).collect();
        assert!(actions.contains(&"skill_create".to_string()));
        assert!(actions.contains(&"skill_disable".to_string()));
        assert!(actions.contains(&"skill_enable".to_string()));
    }

    #[tokio::test]
    async fn admin_grant_list_revoke_with_audit() {
        let pool = new_test_db().await;
        let svc = MarketplaceService::new(pool.clone());
        svc.create_app(APP_KIND_SKILL, "data-extract", "1.0.0", "", "", "boss")
            .await
            .unwrap();
        seed_user(&pool, "alice", false).await;
        picoaide_dsh_store::departments::create_department(&pool, "研发部", 0, 0, "")
            .await
            .unwrap();
        svc.set_grant(APP_KIND_SKILL, "data-extract", "alice", GranteeType::User, true, "boss")
            .await
            .unwrap();
        svc.set_grant(APP_KIND_SKILL, "data-extract", "研发部", GranteeType::Group, true, "boss")
            .await
            .unwrap();
        let grants = svc.list_grants(APP_KIND_SKILL, "data-extract").await.unwrap();
        assert_eq!(grants["grants"].as_array().unwrap().len(), 2);
        assert!(matches!(
            MarketplaceService::parse_grant_subject("a", "b"),
            Err(MarketplaceError { status: 400, .. })
        ));
        svc.set_grant(APP_KIND_SKILL, "data-extract", "alice", GranteeType::User, false, "boss")
            .await
            .unwrap();
        let grants = svc.list_grants(APP_KIND_SKILL, "data-extract").await.unwrap();
        assert_eq!(grants["grants"].as_array().unwrap().len(), 1);
        let logs = picoaide_dsh_store::audit::list_audit_logs(&pool, 50).await.unwrap();
        let actions: Vec<String> = logs.iter().map(|l| l.action.clone()).collect();
        assert!(actions.contains(&"skill_grant".to_string()));
        assert!(actions.contains(&"skill_revoke".to_string()));
        // 未知资源 → 404。
        assert!(matches!(
            svc.set_grant(APP_KIND_SKILL, "nope", "alice", GranteeType::User, true, "boss").await,
            Err(MarketplaceError { status: 404, .. })
        ));
        // 用户/部门不存在 → 400（typos 不得静默落库）。
        assert!(matches!(
            svc.set_grant(APP_KIND_SKILL, "data-extract", "no-such-user", GranteeType::User, true, "boss").await,
            Err(MarketplaceError { status: 400, .. })
        ));
        assert!(matches!(
            svc.set_grant(APP_KIND_SKILL, "data-extract", "no-such-dept", GranteeType::Group, true, "boss").await,
            Err(MarketplaceError { status: 400, .. })
        ));
    }

    #[tokio::test]
    async fn replace_group_grants_and_unknown_dept_rejected() {
        let pool = new_test_db().await;
        let svc = MarketplaceService::new(pool.clone());
        svc.create_app(APP_KIND_SKILL, "data-extract", "1.0.0", "", "", "boss")
            .await
            .unwrap();
        picoaide_dsh_store::departments::create_department(&pool, "研发部", 0, 0, "")
            .await
            .unwrap();
        picoaide_dsh_store::departments::create_department(&pool, "人事部", 0, 0, "")
            .await
            .unwrap();
        svc.replace_group_grants(
            APP_KIND_SKILL,
            "data-extract",
            &["研发部".into(), "人事部".into()],
            "boss",
        )
        .await
        .unwrap();
        let grants = svc.list_grants(APP_KIND_SKILL, "data-extract").await.unwrap();
        assert_eq!(grants["grants"].as_array().unwrap().len(), 2);
        svc.replace_group_grants(APP_KIND_SKILL, "data-extract", &[], "boss")
            .await
            .unwrap();
        let grants = svc.list_grants(APP_KIND_SKILL, "data-extract").await.unwrap();
        assert_eq!(grants["grants"].as_array().unwrap().len(), 0);
        assert!(matches!(
            svc.replace_group_grants(APP_KIND_SKILL, "data-extract", &["不存在".into()], "boss").await,
            Err(MarketplaceError { status: 400, .. })
        ));
    }

    // ------------------------------------------------------------------
    // 发布内核：版本语义 / 双门制
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn publish_version_semantics() {
        let pool = new_test_db().await;
        let svc = MarketplaceService::new(pool.clone());
        svc.create_app(APP_KIND_SKILL, "demo", "1.0.0", "", "", "boss")
            .await
            .unwrap();

        let md1 = good_skill_md("demo", "1.0.0");
        let archive1 = make_zip(&[("SKILL.md", md1.as_str())]);
        let checksum1 = validate_skill_archive(&archive1).unwrap();
        let res = svc
            .publish(&PublishRequest {
                kind: APP_KIND_SKILL.into(),
                app_id: "demo".into(),
                channel: APP_CHANNEL_MARKET.into(),
                archive: archive1.clone(),
                publisher: "boss".into(),
                admin_publish: true,
                declared_version: "1.0.0".into(),
                manifest: manifest_for("demo", "1.0.0", "首个版本。"),
                checksum: checksum1.clone(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(res.status, "approved", "管理端发布即 approved");
        assert_eq!(res.version, "1.0.0");

        // 同版本号 → VERSION_EXISTS。
        let e = svc
            .publish(&PublishRequest {
                kind: APP_KIND_SKILL.into(),
                app_id: "demo".into(),
                channel: APP_CHANNEL_MARKET.into(),
                archive: archive1,
                publisher: "boss".into(),
                admin_publish: true,
                declared_version: "1.0.0".into(),
                manifest: manifest_for("demo", "1.0.0", "首个版本。"),
                checksum: checksum1.clone(),
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert_eq!(e.code, CODE_VERSION_EXISTS);
        assert_eq!(e.status, 409);

        // 升了版本但内容一致 → CONTENT_UNCHANGED。
        let md2 = good_skill_md("demo", "1.0.0");
        let archive2 = make_zip(&[("SKILL.md", md2.as_str())]);
        let e = svc
            .publish(&PublishRequest {
                kind: APP_KIND_SKILL.into(),
                app_id: "demo".into(),
                channel: APP_CHANNEL_MARKET.into(),
                archive: archive2,
                publisher: "boss".into(),
                admin_publish: true,
                declared_version: "1.0.1".into(),
                manifest: ManifestDto {
                    version: "1.0.1".into(),
                    ..manifest_for("demo", "1.0.0", "x.")
                },
                checksum: checksum1,
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert_eq!(e.code, CODE_CONTENT_UNCHANGED);

        // 非法 app id → 400 INVALID_APP_ID。
        let e = svc
            .publish(&PublishRequest {
                kind: APP_KIND_SKILL.into(),
                app_id: "Bad_Name".into(),
                channel: APP_CHANNEL_MARKET.into(),
                archive: Vec::new(),
                publisher: "boss".into(),
                admin_publish: true,
                declared_version: "1.0.0".into(),
                manifest: manifest_for("bad", "1.0.0", "x."),
                checksum: "c".into(),
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert_eq!(e.code, crate::skillmanifest::CODE_INVALID_APP_ID);
        assert_eq!(e.status, 400);

        // 合法新版本 → 成功。
        let md3 = good_skill_md("demo", "1.0.2");
        let archive3 = make_zip(&[("SKILL.md", md3.as_str())]);
        svc.publish(&PublishRequest {
            kind: APP_KIND_SKILL.into(),
            app_id: "demo".into(),
            channel: APP_CHANNEL_MARKET.into(),
            archive: archive3,
            publisher: "boss".into(),
            admin_publish: true,
            declared_version: "1.0.2".into(),
            manifest: ManifestDto {
                version: "1.0.2".into(),
                ..manifest_for("demo", "1.0.2", "第二个版本。")
            },
            checksum: "aaabbb".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn publish_manifest_mismatch_and_invalid_version() {
        let pool = new_test_db().await;
        let svc = MarketplaceService::new(pool.clone());
        svc.create_app(APP_KIND_SKILL, "demo", "1.0.0", "", "", "boss")
            .await
            .unwrap();

        let archive = make_zip(&[("SKILL.md", good_skill_md("demo", "2.0.0").as_str())]);
        let e = svc
            .publish(&PublishRequest {
                kind: APP_KIND_SKILL.into(),
                app_id: "demo".into(),
                channel: APP_CHANNEL_MARKET.into(),
                archive,
                publisher: "boss".into(),
                admin_publish: true,
                declared_version: "3.0.0".into(),
                manifest: manifest_for("demo", "2.0.0", "新版本。"),
                checksum: "c1".into(),
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert_eq!(e.code, crate::skillmanifest::CODE_MANIFEST_MISMATCH);
        assert_eq!(e.status, 422);

        let e = svc
            .publish(&PublishRequest {
                kind: APP_KIND_SKILL.into(),
                app_id: "demo".into(),
                channel: APP_CHANNEL_MARKET.into(),
                archive: Vec::new(),
                publisher: "boss".into(),
                admin_publish: true,
                declared_version: "2.0.0".into(),
                manifest: ManifestDto {
                    version: "v2".into(),
                    ..Default::default()
                },
                checksum: "c2".into(),
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert_eq!(e.code, crate::skillmanifest::CODE_INVALID_VERSION);
        assert_eq!(e.status, 422);
    }

    #[tokio::test]
    async fn approve_reject_state_machine_double_gate() {
        let pool = new_test_db().await;
        let svc = MarketplaceService::new(pool.clone());
        // owner 记为 alice，使员工（alice）发布能通过归属保护。
        svc.create_app(APP_KIND_SKILL, "demo", "1.0.0", "", "alice", "boss")
            .await
            .unwrap();
        seed_user(&pool, "alice", false).await;
        let archive = make_zip(&[("SKILL.md", good_skill_md("demo", "1.0.0").as_str())]);
        let checksum = validate_skill_archive(&archive).unwrap();
        let res = svc
            .publish(&PublishRequest {
                kind: APP_KIND_SKILL.into(),
                app_id: "demo".into(),
                channel: APP_CHANNEL_MARKET.into(),
                archive,
                publisher: "alice".into(),
                admin_publish: false,
                declared_version: "1.0.0".into(),
                manifest: manifest_for("demo", "1.0.0", "首个版本。"),
                checksum,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(res.status, "pending", "员工发布 → pending（双门制第一道门）");

        // 拒绝必须带理由。
        let e = svc
            .reject_release(APP_KIND_SKILL, "demo", "1.0.0", "", "boss")
            .await
            .unwrap_err();
        assert_eq!(e.status, 400);
        svc.reject_release(APP_KIND_SKILL, "demo", "1.0.0", "包内容不合规", "boss")
            .await
            .unwrap();
        let r = get_release(&pool, APP_KIND_SKILL, "demo", "1.0.0").await.unwrap();
        assert_eq!(r.status, "rejected");
        assert_eq!(r.reason, "包内容不合规");
        assert_eq!(r.quality, "", "拒绝时清空质量标记");

        // 未授权用户对 pending/rejected 版本不可见不可下载（不泄露）。
        seed_user(&pool, "bob", false).await;
        grant_app(&pool, APP_KIND_SKILL, "demo", "bob", "user").await.unwrap();
        let viewer = Viewer {
            username: "bob".into(),
            groups: vec![],
            is_admin: false,
        };
        assert!(matches!(
            svc.download_archive(&viewer, APP_KIND_SKILL, "demo").await,
            Err(MarketplaceError { status: 404, .. })
        ));

        // 重新提交复位 pending。
        set_release_status(&pool, APP_KIND_SKILL, "demo", "1.0.0", RELEASE_STATUS_PENDING, "")
            .await
            .unwrap();
        svc.approve_release(APP_KIND_SKILL, "demo", "1.0.0", "boss").await.unwrap();
        let r = get_release(&pool, APP_KIND_SKILL, "demo", "1.0.0").await.unwrap();
        assert_eq!(r.status, "approved");

        // 批准后（第二道门 approved）员工可见可下载。
        let list = svc.list_apps(&viewer, APP_KIND_SKILL).await.unwrap();
        assert_eq!(list["apps"].as_array().unwrap().len(), 1);
        let dl = svc
            .download_archive(&viewer, APP_KIND_SKILL, "demo")
            .await
            .unwrap();
        assert_eq!(dl.version, "1.0.0");

        let logs = picoaide_dsh_store::audit::list_audit_logs(&pool, 50).await.unwrap();
        let actions: Vec<String> = logs.iter().map(|l| l.action.clone()).collect();
        assert!(actions.contains(&"skill_reject".to_string()));
        assert!(actions.contains(&"skill_approve".to_string()));
    }

    #[tokio::test]
    async fn market_agent_crud_preview_publish() {
        let pool = new_test_db().await;
        let svc = MarketplaceService::new(pool.clone());
        svc.create_app(APP_KIND_AGENT, "demo-agent", "1.0.0", "demo", "test", "boss")
            .await
            .unwrap();
        // kind 隔离：agent 与 skill 允许同名。
        svc.create_app(APP_KIND_SKILL, "demo-agent", "1.0.0", "", "", "boss")
            .await
            .unwrap();
        seed_market_agent(&pool, "demo-agent", "1.0.0").await;
        let viewer = Viewer {
            username: "boss".into(),
            groups: vec![],
            is_admin: true,
        };
        let list = svc.list_apps(&viewer, APP_KIND_AGENT).await.unwrap();
        assert_eq!(list["apps"].as_array().unwrap().len(), 1);
        assert_eq!(list["apps"][0]["version"], "1.0.0");

        let preview = svc.preview_app(APP_KIND_AGENT, "demo-agent").await.unwrap();
        let files = preview["files"].as_array().unwrap();
        assert!(files.iter().any(|f| f == "agent.cordis.yml"));
        assert!(files.iter().any(|f| f == "preset.yml"));

        let fc = svc
            .file_content_app(APP_KIND_AGENT, "demo-agent", "preset.yml")
            .await
            .unwrap();
        assert!(fc.content.contains("demo-agent 智能体"));
        assert!(matches!(
            svc.file_content_app(APP_KIND_AGENT, "demo-agent", "../../etc/passwd").await,
            Err(MarketplaceError { status: 400, .. })
        ));

        svc.delete_app(APP_KIND_AGENT, "demo-agent", "boss").await.unwrap();
        assert_eq!(
            get_app(&pool, APP_KIND_AGENT, "demo-agent").await.unwrap().enabled,
            0
        );
        svc.enable_app(APP_KIND_AGENT, "demo-agent", "boss").await.unwrap();
        assert_eq!(
            get_app(&pool, APP_KIND_AGENT, "demo-agent").await.unwrap().enabled,
            1
        );
    }

    #[tokio::test]
    async fn archive_validation_zip_and_tar_gz() {
        let good = make_zip(&[("SKILL.md", "x")]);
        assert!(validate_skill_archive(&good).is_ok());
        let bad = make_zip(&[("readme.md", "x")]);
        assert_eq!(validate_skill_archive(&bad).unwrap_err(), ArchiveError::NoRequired);
        let targz = make_tar_gz(&[("SKILL.md", "x")]);
        assert_eq!(archive_format(&targz), "tar.gz");
        assert!(validate_skill_archive(&targz).is_ok());
        let preset = make_zip(&[("agent.cordis.yml", "x"), ("preset.yml", "y")]);
        assert!(validate_preset_archive(&preset).is_ok());
        let evil = make_zip(&[("SKILL.md", "x"), ("../evil.txt", "y")]);
        assert_eq!(validate_skill_archive(&evil).unwrap_err(), ArchiveError::Unsafe);
        assert_eq!(normalize_path("a/b/../c").unwrap_err(), ArchiveError::Unsafe);
        assert_eq!(normalize_path("/etc/passwd").unwrap_err(), ArchiveError::Unsafe);
        assert_eq!(
            normalize_path("references/notes.md").unwrap(),
            "references/notes.md"
        );
        let big = "x".repeat(80);
        let big_zip = make_zip(&[("SKILL.md", big.as_str())]);
        let (entries, main) = list_archive_contents(&big_zip, "SKILL.md").unwrap();
        assert!(entries.contains(&"SKILL.md".to_string()));
        assert_eq!(main, big);
        let (_, _, _, _, found) = extract_file_content(&big_zip, "nope.md", 1 << 20).unwrap();
        assert!(!found);
    }
}
