//! 智能体预设域（Go `serverstore/agent_presets.go` 等价）。
//!
//! P2 适配层(迁移 0053/0054):智能体预设与技能共用 apps/app_releases
//! (kind=agent, channel=org),保留原有签名与语义。旧表 agent_presets 兼容期
//! 内只读保留,P5 下线。

use crate::apps::*;
use crate::errors::{map_db_error, StoreError};
use crate::skills::compare_version_strings;
use chrono::{DateTime, Utc};

/// AgentPresetStatus 是一个共享智能体预设的审核状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AgentPresetStatus {
    /// AgentPresetPending 等待管理员审核。
    #[default]
    Pending,
    /// AgentPresetApproved 全体员工可见可安装。
    Approved,
    /// AgentPresetRejected 除作者外任何人不可见,作者可重新提交同一 name+version
    /// (同一行被复用并重置为 pending)。
    Rejected,
}

impl AgentPresetStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentPresetStatus::Pending => "pending",
            AgentPresetStatus::Approved => "approved",
            AgentPresetStatus::Rejected => "rejected",
        }
    }
}

impl From<&str> for AgentPresetStatus {
    fn from(s: &str) -> Self {
        match s {
            "approved" => AgentPresetStatus::Approved,
            "rejected" => AgentPresetStatus::Rejected,
            _ => AgentPresetStatus::Pending,
        }
    }
}

/// AgentPreset 一条共享智能体预设行(唯一 by name+version)。
#[derive(Debug, Clone, Default)]
pub struct AgentPreset {
    pub id: i64,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub author: String,
    pub checksum: String,
    pub status: AgentPresetStatus,
    /// Reason 是管理员的拒绝理由;除非被拒,否则为空。仅作者与管理员可见。
    pub reason: String,
    /// Quality 是组织库质量标记(0037, 0059 起仅 ''|featured)。
    pub quality: String,
    /// Archive 是上传的归档字节(0041: 归档直存 DB,不再落磁盘)。
    pub archive: Vec<u8>,
    /// Downloads 统计归档下载次数(0041)。
    pub downloads: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// release_to_preset 把统一模型的 Release 投影成旧 DTO。
/// 注意 Author 语义:旧 DTO 的 Author 是**上传者**(归属判断依赖它),对应 Publisher。
fn release_to_preset(r: &Release) -> AgentPreset {
    AgentPreset {
        id: r.id,
        name: r.app_id.clone(),
        display_name: r.title.clone(),
        description: r.description.clone(),
        version: r.version.clone(),
        author: r.publisher.clone(),
        checksum: r.checksum.clone(),
        status: AgentPresetStatus::from(r.status.as_str()),
        reason: r.reason.clone(),
        quality: r.quality.clone(),
        archive: r.archive.clone(),
        downloads: r.downloads,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

/// latest_preset_release 取一个预设的展示版本:最高 approved;没有则取最新一条。
async fn latest_preset_release(
    pool: &sqlx::PgPool,
    name: &str,
) -> Result<Release, StoreError> {
    let list = list_releases(pool, APP_KIND_AGENT, name).await?;
    let mut best: Option<&Release> = None;
    let mut newest: Option<&Release> = None;
    for r in &list {
        if r.deleted_at.is_some() {
            continue;
        }
        if newest.is_none() || r.created_at > newest.unwrap().created_at {
            newest = Some(r);
        }
        if r.status != RELEASE_STATUS_APPROVED {
            continue;
        }
        if best.is_none() || compare_version_strings(&r.version, &best.unwrap().version) > 0 {
            best = Some(r);
        }
    }
    let best = best.or(newest).ok_or(StoreError::NotFound)?;
    get_release(pool, APP_KIND_AGENT, name, &best.version).await
}

/// CreateAgentPreset 新建一个预设版本(App 身份 + Release 快照)。
pub async fn create_agent_preset(
    pool: &sqlx::PgPool,
    p: &AgentPreset,
) -> Result<i64, StoreError> {
    let app_title = if p.display_name.is_empty() {
        p.name.clone()
    } else {
        p.display_name.clone()
    };
    upsert_app(
        pool,
        &App {
            kind: APP_KIND_AGENT.into(),
            app_id: p.name.clone(),
            title: app_title,
            description: p.description.clone(),
            owner: p.author.clone(),
            channel: APP_CHANNEL_ORG.into(),
            enabled: 1,
            ..Default::default()
        },
    )
    .await?;
    let status = p.status.as_str();
    let version = if p.version.is_empty() { "1.0.0" } else { &p.version };
    create_release(
        pool,
        &Release {
            kind: APP_KIND_AGENT.into(),
            app_id: p.name.clone(),
            version: version.into(),
            title: p.display_name.clone(),
            description: p.description.clone(),
            author: p.author.clone(),
            publisher: p.author.clone(),
            checksum: p.checksum.clone(),
            archive: p.archive.clone(),
            status: status.into(),
            reason: p.reason.clone(),
            quality: p.quality.clone(),
            ..Default::default()
        },
    )
    .await
}

/// CreateAgentPresetCapped 同上,附带每作者待审配额。
pub async fn create_agent_preset_capped(
    pool: &sqlx::PgPool,
    p: &AgentPreset,
    pending_cap: i64,
) -> Result<i64, StoreError> {
    if pending_cap > 0 {
        let n = pending_release_count(pool, &p.author).await?;
        if n >= pending_cap {
            return Err(StoreError::TooManyPending);
        }
    }
    create_agent_preset(pool, p).await
}

/// GetAgentPreset 取展示版本(含归档)。
pub async fn get_agent_preset(pool: &sqlx::PgPool, name: &str) -> Result<AgentPreset, StoreError> {
    let r = latest_preset_release(pool, name).await?;
    Ok(release_to_preset(&r))
}

/// GetAgentPresetByVersion 取指定版本(含归档)。
pub async fn get_agent_preset_by_version(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
) -> Result<AgentPreset, StoreError> {
    let r = get_release(pool, APP_KIND_AGENT, name, version).await?;
    if r.deleted_at.is_some() {
        return Err(StoreError::NotFound);
    }
    Ok(release_to_preset(&r))
}

/// ListAgentPresets 管理端清单(status 为空 = 全部)。
pub async fn list_agent_presets(
    pool: &sqlx::PgPool,
    status: &str,
) -> Result<Vec<AgentPreset>, StoreError> {
    let list = list_releases_by_status(pool, APP_KIND_AGENT, status).await?;
    Ok(list.iter().map(release_to_preset).collect())
}

/// ListVisibleAgentPresets 员工可见清单:approved 且已授权 + 自己上传的全部状态。
pub async fn list_visible_agent_presets(
    pool: &sqlx::PgPool,
    author: &str,
    granted: &[String],
) -> Result<Vec<AgentPreset>, StoreError> {
    let list = list_releases_by_status(pool, APP_KIND_AGENT, "").await?;
    let ok: std::collections::HashSet<&str> = granted.iter().map(|s| s.as_str()).collect();
    let mut out = Vec::new();
    for r in &list {
        if r.publisher == author
            || (r.status == RELEASE_STATUS_APPROVED && ok.contains(r.app_id.as_str()))
        {
            out.push(release_to_preset(r));
        }
    }
    Ok(out)
}

/// SetAgentPresetStatus 审核展示版本。
pub async fn set_agent_preset_status(
    pool: &sqlx::PgPool,
    name: &str,
    status: AgentPresetStatus,
    reason: &str,
) -> Result<(), StoreError> {
    let r = latest_preset_release(pool, name).await?;
    set_release_status(pool, APP_KIND_AGENT, name, &r.version, status.as_str(), reason).await
}

/// SetAgentPresetStatusByVersion 审核指定版本。
pub async fn set_agent_preset_status_by_version(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
    status: AgentPresetStatus,
    reason: &str,
) -> Result<(), StoreError> {
    set_release_status(pool, APP_KIND_AGENT, name, version, status.as_str(), reason).await
}

/// DeleteAgentPreset 删除展示版本(软删:版本号永久占位)。
pub async fn delete_agent_preset(pool: &sqlx::PgPool, name: &str) -> Result<(), StoreError> {
    let r = latest_preset_release(pool, name).await?;
    soft_delete_release(pool, APP_KIND_AGENT, name, &r.version).await
}

/// DeleteAgentPresetByVersion 删除指定版本(软删)。
pub async fn delete_agent_preset_by_version(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
) -> Result<(), StoreError> {
    soft_delete_release(pool, APP_KIND_AGENT, name, version).await
}

/// ValidAgentQuality 质量标记合法值。
pub fn valid_agent_quality(q: &str) -> bool {
    q.is_empty() || q == "featured"
}

/// SetAgentPresetQuality 质量标记(仅 approved 版本)。
pub async fn set_agent_preset_quality(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
    quality: &str,
) -> Result<(), StoreError> {
    if !valid_agent_quality(quality) {
        return Err(StoreError::Validation);
    }
    set_release_quality(pool, APP_KIND_AGENT, name, version, quality).await
}

/// SetAgentPresetArchive 覆盖某版本归档(数据修复/测试播种用;发布路径不调用)。
pub async fn set_agent_preset_archive(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
    archive: &[u8],
) -> Result<(), StoreError> {
    sqlx::query(
        r#"UPDATE app_releases SET archive = $1, size = $2, updated_at = now()
        WHERE kind = $3 AND app_id = $4 AND version = $5"#,
    )
    .bind(archive)
    .bind(archive.len() as i64)
    .bind(APP_KIND_AGENT)
    .bind(name)
    .bind(version)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(())
}

/// GetAgentPresetArchive 取归档字节。
pub async fn get_agent_preset_archive(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
) -> Result<Vec<u8>, StoreError> {
    let r = get_release(pool, APP_KIND_AGENT, name, version).await?;
    Ok(r.archive)
}

/// ClearAgentPresetArchive 清空归档字节。
pub async fn clear_agent_preset_archive(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        r#"UPDATE app_releases SET archive = NULL, size = 0, updated_at = now()
        WHERE kind = $1 AND app_id = $2 AND version = $3"#,
    )
    .bind(APP_KIND_AGENT)
    .bind(name)
    .bind(version)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(())
}

/// IncrementAgentPresetDownload 下载计数。
pub async fn increment_agent_preset_download(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
) -> Result<bool, StoreError> {
    increment_release_download(pool, APP_KIND_AGENT, name, version).await?;
    Ok(true)
}

/// UpdateAgentPresetResubmit 兼容旧签名:覆盖展示版本的元数据并回到 pending。
/// 版本快照原则下生产不再走覆盖重提(必须升版本号),此函数仅供数据修复与测试。
pub async fn update_agent_preset_resubmit(
    pool: &sqlx::PgPool,
    name: &str,
    display_name: &str,
    description: &str,
    checksum: &str,
) -> Result<(), StoreError> {
    let r = latest_preset_release(pool, name).await?;
    update_agent_preset_resubmit_by_version(
        pool,
        name,
        &r.version,
        display_name,
        description,
        checksum,
        &r.publisher,
    )
    .await
}

/// UpdateAgentPresetResubmitByVersion 覆盖指定版本的元数据并回到 pending。
pub async fn update_agent_preset_resubmit_by_version(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
    display_name: &str,
    description: &str,
    checksum: &str,
    author: &str,
) -> Result<(), StoreError> {
    let res = sqlx::query(
        r#"UPDATE app_releases SET title = $1, description = $2, checksum = $3,
        publisher = $4, status = 'pending', reason = '', quality = '', updated_at = now()
        WHERE kind = $5 AND app_id = $6 AND version = $7"#,
    )
    .bind(display_name)
    .bind(description)
    .bind(checksum)
    .bind(author)
    .bind(APP_KIND_AGENT)
    .bind(name)
    .bind(version)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// UpdateAgentPresetResubmitByVersionWithArchive 同上并覆盖归档。
pub async fn update_agent_preset_resubmit_by_version_with_archive(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
    display_name: &str,
    description: &str,
    checksum: &str,
    author: &str,
    archive: &[u8],
) -> Result<(), StoreError> {
    let res = sqlx::query(
        r#"UPDATE app_releases SET title = $1, description = $2, checksum = $3,
        publisher = $4, archive = $5, size = $6, status = 'pending', reason = '', quality = '',
        updated_at = now() WHERE kind = $7 AND app_id = $8 AND version = $9"#,
    )
    .bind(display_name)
    .bind(description)
    .bind(checksum)
    .bind(author)
    .bind(archive)
    .bind(archive.len() as i64)
    .bind(APP_KIND_AGENT)
    .bind(name)
    .bind(version)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;

    fn new_preset(name: &str, author: &str) -> AgentPreset {
        AgentPreset {
            name: name.into(),
            author: author.into(),
            status: AgentPresetStatus::Pending,
            version: "1.0.0".into(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn agent_preset_crud() {
        let pool = new_test_db().await;
        let id = create_agent_preset(&pool, &new_preset("coding-agent", "alice"))
            .await
            .unwrap();
        assert!(id > 0);
        let p = get_agent_preset(&pool, "coding-agent").await.unwrap();
        assert_eq!(p.author, "alice");
        assert_eq!(p.status, AgentPresetStatus::Pending);
        assert_eq!(p.display_name, "");

        assert_eq!(
            create_agent_preset(&pool, &new_preset("coding-agent", "bob"))
                .await
                .unwrap_err(),
            StoreError::Duplicate
        );

        set_agent_preset_status(&pool, "coding-agent", AgentPresetStatus::Approved, "")
            .await
            .unwrap();
        let p = get_agent_preset(&pool, "coding-agent").await.unwrap();
        assert_eq!(p.status, AgentPresetStatus::Approved);
        // Rejection stores the admin's reason; approving clears it.
        set_agent_preset_status(
            &pool,
            "coding-agent",
            AgentPresetStatus::Rejected,
            "缺少 skills/",
        )
        .await
        .unwrap();
        let p = get_agent_preset(&pool, "coding-agent").await.unwrap();
        assert_eq!(p.status, AgentPresetStatus::Rejected);
        assert_eq!(p.reason, "缺少 skills/");
        set_agent_preset_status(&pool, "coding-agent", AgentPresetStatus::Approved, "")
            .await
            .unwrap();
        let p = get_agent_preset(&pool, "coding-agent").await.unwrap();
        assert_eq!(p.reason, "", "reason not cleared on approve");

        delete_agent_preset(&pool, "coding-agent").await.unwrap();
        assert_eq!(
            get_agent_preset(&pool, "coding-agent").await.unwrap_err(),
            StoreError::NotFound
        );
        assert_eq!(
            delete_agent_preset(&pool, "coding-agent").await.unwrap_err(),
            StoreError::NotFound
        );
    }

    #[tokio::test]
    async fn agent_preset_resubmit() {
        let pool = new_test_db().await;
        create_agent_preset(&pool, &new_preset("resubmit-me", "alice"))
            .await
            .unwrap();
        set_agent_preset_status(
            &pool,
            "resubmit-me",
            AgentPresetStatus::Rejected,
            "测试拒绝",
        )
        .await
        .unwrap();
        update_agent_preset_resubmit(&pool, "resubmit-me", "新标题", "新描述", "abc123")
            .await
            .unwrap();
        let got = get_agent_preset(&pool, "resubmit-me").await.unwrap();
        assert_eq!(got.status, AgentPresetStatus::Pending);
        assert_eq!(got.description, "新描述");
        assert_eq!(got.checksum, "abc123");
        assert_eq!(got.display_name, "新标题");
        assert_eq!(got.reason, "");
        // 非 rejected 行不满足 resubmit 条件:0 行受影响但不报错
        // (Go 侧 RowsAffected==0 直接返回 ErrNotFound,此处语义一致)。
    }

    #[tokio::test]
    async fn agent_preset_visible_filter() {
        let pool = new_test_db().await;
        async fn must_create(
            pool: &sqlx::PgPool,
            name: &str,
            author: &str,
            status: AgentPresetStatus,
        ) {
            let mut p = new_preset(name, author);
            p.status = status;
            create_agent_preset(pool, &p).await.unwrap();
        }
        must_create(&pool, "approved-a", "alice", AgentPresetStatus::Approved)
            .await;
        must_create(&pool, "approved-b", "bob", AgentPresetStatus::Approved).await;
        must_create(&pool, "pending-alice", "alice", AgentPresetStatus::Pending)
            .await;
        must_create(&pool, "pending-bob", "bob", AgentPresetStatus::Pending).await;
        must_create(&pool, "rejected-alice", "alice", AgentPresetStatus::Rejected)
            .await;
        must_create(&pool, "rejected-bob", "bob", AgentPresetStatus::Rejected).await;

        // 授权制:approved 需授权才可见,但作者始终可见自己的;未授权者只见自己的。
        let vis = list_visible_agent_presets(&pool, "alice", &[]).await.unwrap();
        let names: std::collections::HashSet<&str> =
            vis.iter().map(|p| p.name.as_str()).collect();
        for want in ["approved-a", "pending-alice", "rejected-alice"] {
            assert!(names.contains(want), "alice should see {want}");
        }
        assert_eq!(names.len(), 3, "alice 不应看到 bob 的上传");
        // bob 未授权:看不见别人的 approved-a;自己上传的 approved-b 应可见。
        let vis_bob = list_visible_agent_presets(&pool, "bob", &[]).await.unwrap();
        let mut saw_own = false;
        for p in &vis_bob {
            assert!(
                p.name != "approved-a" && p.name != "pending-alice",
                "bob sees {} (not granted)",
                p.name
            );
            if p.name == "approved-b" {
                saw_own = true;
            }
        }
        assert!(saw_own, "bob does not see own approved-b");
        // alice 被授予 approved-a:可见。
        let vis_granted = list_visible_agent_presets(&pool, "alice", &["approved-a".to_string()])
            .await
            .unwrap();
        let mut seen_approved = false;
        for p in &vis_granted {
            if p.name == "approved-a" && p.status == AgentPresetStatus::Approved {
                seen_approved = true;
            }
        }
        assert!(seen_approved, "granted alice does not see approved-a");

        let all = list_agent_presets(&pool, "").await.unwrap();
        assert_eq!(all.len(), 6);
        let pending = list_agent_presets(&pool, "pending").await.unwrap();
        assert_eq!(pending.len(), 2);
    }

    #[tokio::test]
    async fn agent_preset_capped_atomically() {
        let pool = new_test_db().await;
        for i in 0..2 {
            create_agent_preset_capped(&pool, &new_preset(&format!("cap-{i}"), "alice"), 2)
                .await
                .unwrap();
        }
        // At cap: refuse without erroring.
        assert_eq!(
            create_agent_preset_capped(&pool, &new_preset("cap-over", "alice"), 2)
                .await
                .unwrap_err(),
            StoreError::TooManyPending
        );
        // Another author is unaffected.
        create_agent_preset_capped(&pool, &new_preset("bob-one", "bob"), 2)
            .await
            .unwrap();
        // Duplicate name surfaces as ErrDuplicate.
        assert_eq!(
            create_agent_preset_capped(&pool, &new_preset("cap-0", "bob"), 2)
                .await
                .unwrap_err(),
            StoreError::Duplicate
        );
    }

    #[tokio::test]
    async fn agent_preset_quality() {
        let pool = new_test_db().await;
        create_agent_preset(&pool, &new_preset("qual", "alice")).await.unwrap();
        assert_eq!(
            set_agent_preset_quality(&pool, "qual", "1.0.0", "featured")
                .await
                .unwrap_err(),
            StoreError::NotFound,
            "quality on pending"
        );
        set_agent_preset_status_by_version(&pool, "qual", "1.0.0", AgentPresetStatus::Approved, "")
            .await
            .unwrap();
        set_agent_preset_quality(&pool, "qual", "1.0.0", "featured")
            .await
            .unwrap();
        assert_eq!(
            set_agent_preset_quality(&pool, "qual", "1.0.0", "pro")
                .await
                .unwrap_err(),
            StoreError::Validation
        );
        let got = get_agent_preset_by_version(&pool, "qual", "1.0.0").await.unwrap();
        assert_eq!(got.quality, "featured");
        set_agent_preset_quality(&pool, "qual", "1.0.0", "").await.unwrap();
        let got = get_agent_preset_by_version(&pool, "qual", "1.0.0").await.unwrap();
        assert_eq!(got.quality, "");
        assert_eq!(
            set_agent_preset_quality(&pool, "nope", "1.0.0", "featured")
                .await
                .unwrap_err(),
            StoreError::NotFound
        );
    }

    #[tokio::test]
    async fn agent_preset_archive_db() {
        let pool = new_test_db().await;
        let blob = b"gz-tar-preset";
        let mut p = new_preset("arch", "alice");
        p.archive = blob.to_vec();
        p.checksum = "sum1".into();
        create_agent_preset_capped(&pool, &p, 10).await.unwrap();
        let got = get_agent_preset_archive(&pool, "arch", "1.0.0").await.unwrap();
        assert_eq!(got, blob.to_vec());
        // 单行读带 Archive;列表读不带 blob。
        let row = get_agent_preset_by_version(&pool, "arch", "1.0.0").await.unwrap();
        assert_eq!(row.archive, blob.to_vec());
        let all = list_agent_presets(&pool, "").await.unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].archive.is_empty(), "list must exclude blob");
        // 下载计数。
        assert!(increment_agent_preset_download(&pool, "arch", "1.0.0")
            .await
            .unwrap());
        let row = get_agent_preset_by_version(&pool, "arch", "1.0.0").await.unwrap();
        assert_eq!(row.downloads, 1);
        // 覆盖归档(重提路径)。
        set_agent_preset_archive(&pool, "arch", "1.0.0", b"v2").await.unwrap();
        let got = get_agent_preset_archive(&pool, "arch", "1.0.0").await.unwrap();
        assert_eq!(got, b"v2".to_vec());
        // 清除归档(删除路径)。
        clear_agent_preset_archive(&pool, "arch", "1.0.0").await.unwrap();
        let got = get_agent_preset_archive(&pool, "arch", "1.0.0").await.unwrap();
        assert!(got.is_empty());
    }
}
