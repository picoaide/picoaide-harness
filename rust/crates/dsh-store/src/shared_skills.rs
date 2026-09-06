//! 组织共享技能域（Go `serverstore/shared_skills.go` 等价）。
//!
//! P2 适配层(迁移 0053/0054):以下函数保留原有签名与语义,内部改为读写统一的
//! apps/app_releases。旧表 shared_skills 在兼容期内只读保留,P5 再下线。

use crate::apps::*;
use crate::errors::{map_db_error, StoreError};
use chrono::{DateTime, Utc};

/// SharedSkillStatus 是共享技能行的审核状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SharedSkillStatus {
    /// SharedSkillPending 等待管理员审核。
    #[default]
    Pending,
    /// SharedSkillApproved 全体员工可见可安装。
    Approved,
    /// SharedSkillRejected 除作者外任何人不可见,作者可重新提交同一 name+version
    /// (同一行被复用并重置为 pending)。
    Rejected,
}

impl SharedSkillStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SharedSkillStatus::Pending => "pending",
            SharedSkillStatus::Approved => "approved",
            SharedSkillStatus::Rejected => "rejected",
        }
    }
}

impl From<&str> for SharedSkillStatus {
    fn from(s: &str) -> Self {
        match s {
            "approved" => SharedSkillStatus::Approved,
            "rejected" => SharedSkillStatus::Rejected,
            _ => SharedSkillStatus::Pending,
        }
    }
}

/// SharedSkill 一条共享技能行(唯一 by name+version)。
#[derive(Debug, Clone, Default)]
pub struct SharedSkill {
    pub id: i64,
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub checksum: String,
    pub status: SharedSkillStatus,
    /// Reason 是管理员的拒绝理由;除非被拒,否则为空。
    pub reason: String,
    /// Quality 是组织库质量标记(0037):''|'featured' 互斥,仅对 approved 行有展示语义。
    pub quality: String,
    /// Archive 是上传的归档字节(0040: 归档直存 DB,不再落磁盘)。
    pub archive: Vec<u8>,
    /// Downloads 统计归档下载次数。
    pub downloads: i64,
    /// Calls 统计客户端上报的调用次数。
    pub calls: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// release_to_shared 把统一模型的 Release 投影成旧 DTO。
/// 注意 Author 语义:旧 DTO 的 Author 是**上传者**(全部归属/可见性判断都依赖它),
/// 对应统一模型的 Publisher;包内署名 Release.Author 不参与这些判断。
fn release_to_shared(r: &Release) -> SharedSkill {
    SharedSkill {
        id: r.id,
        name: r.app_id.clone(),
        display_name: r.title.clone(),
        version: r.version.clone(),
        description: r.description.clone(),
        author: r.publisher.clone(),
        checksum: r.checksum.clone(),
        status: SharedSkillStatus::from(r.status.as_str()),
        reason: r.reason.clone(),
        quality: r.quality.clone(),
        archive: r.archive.clone(),
        downloads: r.downloads,
        calls: r.calls,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

/// org_skill_releases 取组织渠道技能的全部版本(排除软删)。
async fn org_skill_releases(
    pool: &sqlx::PgPool,
    status: &str,
) -> Result<Vec<Release>, StoreError> {
    let all = list_releases_by_status(pool, APP_KIND_SKILL, status).await?;
    let apps = list_apps(pool, APP_KIND_SKILL, APP_CHANNEL_ORG).await?;
    let mut org: std::collections::HashSet<String> = std::collections::HashSet::new();
    for a in &apps {
        org.insert(a.app_id.clone());
    }
    Ok(all.into_iter().filter(|r| org.contains(&r.app_id)).collect())
}

/// GetSharedSkill 取一个版本(含归档)。
pub async fn get_shared_skill(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
) -> Result<SharedSkill, StoreError> {
    let r = get_release(pool, APP_KIND_SKILL, name, version).await?;
    if r.deleted_at.is_some() {
        return Err(StoreError::NotFound);
    }
    Ok(release_to_shared(&r))
}

/// ListSharedSkills 管理端清单(status 为空 = 全部)。
pub async fn list_shared_skills(
    pool: &sqlx::PgPool,
    status: &str,
) -> Result<Vec<SharedSkill>, StoreError> {
    let list = org_skill_releases(pool, status).await?;
    Ok(list.iter().map(release_to_shared).collect())
}

/// ListVisibleSharedSkills 员工可见清单:approved 且已授权 + 自己上传的全部状态。
pub async fn list_visible_shared_skills(
    pool: &sqlx::PgPool,
    author: &str,
    granted: &[String],
) -> Result<Vec<SharedSkill>, StoreError> {
    let list = org_skill_releases(pool, "").await?;
    let ok: std::collections::HashSet<&str> = granted.iter().map(|s| s.as_str()).collect();
    let mut out = Vec::new();
    for r in &list {
        if r.publisher == author || (r.status == RELEASE_STATUS_APPROVED && ok.contains(r.app_id.as_str())) {
            out.push(release_to_shared(r));
        }
    }
    Ok(out)
}

/// GetSharedSkillArchive 取归档字节。
pub async fn get_shared_skill_archive(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
) -> Result<Vec<u8>, StoreError> {
    let r = get_release(pool, APP_KIND_SKILL, name, version).await?;
    Ok(r.archive)
}

/// IncrementSharedSkillDownload 下载计数。
pub async fn increment_shared_skill_download(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
) -> Result<bool, StoreError> {
    increment_release_download(pool, APP_KIND_SKILL, name, version).await?;
    Ok(true)
}

/// SetSharedSkillStatus 审核(只改状态位,不碰内容)。
pub async fn set_shared_skill_status(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
    status: SharedSkillStatus,
    reason: &str,
) -> Result<(), StoreError> {
    set_release_status(pool, APP_KIND_SKILL, name, version, status.as_str(), reason).await
}

/// DeleteSharedSkill 删除一个版本 = 软删(版本号永久占位,不可复用)。
pub async fn delete_shared_skill(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
) -> Result<(), StoreError> {
    soft_delete_release(pool, APP_KIND_SKILL, name, version).await
}

/// DeleteSharedSkillArchive 清空某版本的归档字节(版本行与审核记录保留)。
pub async fn delete_shared_skill_archive(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        r#"UPDATE app_releases SET archive = NULL, size = 0, updated_at = now()
        WHERE kind = $1 AND app_id = $2 AND version = $3"#,
    )
    .bind(APP_KIND_SKILL)
    .bind(name)
    .bind(version)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(())
}

/// ValidSharedQuality 质量标记合法值。
pub fn valid_shared_quality(q: &str) -> bool {
    q.is_empty() || q == "featured"
}

/// SetSharedSkillQuality 质量标记(仅 approved 版本)。
pub async fn set_shared_skill_quality(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
    quality: &str,
) -> Result<(), StoreError> {
    if !valid_shared_quality(quality) {
        return Err(StoreError::Validation);
    }
    set_release_quality(pool, APP_KIND_SKILL, name, version, quality).await
}

/// CreateSharedSkill 新建一个组织渠道技能版本(App 身份 + Release 快照)。
/// 保留此签名供播种与测试使用;生产上传路径走 appstore.Publish(统一发布内核)。
pub async fn create_shared_skill(
    pool: &sqlx::PgPool,
    s: &SharedSkill,
) -> Result<i64, StoreError> {
    let app_title = if s.display_name.is_empty() {
        s.name.clone()
    } else {
        s.display_name.clone()
    };
    // 跨渠道同名互斥(旧 skills/shared_skills 双向阻断的等价约束)。
    match get_app(pool, APP_KIND_SKILL, &s.name).await {
        Ok(existing) if existing.channel != APP_CHANNEL_ORG => return Err(StoreError::Conflict),
        Ok(_) => {}
        Err(StoreError::NotFound) => {}
        Err(e) => return Err(e),
    }
    upsert_app(
        pool,
        &App {
            kind: APP_KIND_SKILL.into(),
            app_id: s.name.clone(),
            title: app_title,
            description: s.description.clone(),
            owner: s.author.clone(),
            channel: APP_CHANNEL_ORG.into(),
            enabled: 1,
            ..Default::default()
        },
    )
    .await?;
    // 状态为空均以 enum 缺省 Pending 表示,直接落库。
    let status = s.status.as_str();
    create_release(
        pool,
        &Release {
            // Release.Title 保留调用方给的展示名原值(可为空),DTO 往返一致。
            kind: APP_KIND_SKILL.into(),
            app_id: s.name.clone(),
            version: s.version.clone(),
            title: s.display_name.clone(),
            description: s.description.clone(),
            author: s.author.clone(),
            publisher: s.author.clone(),
            checksum: s.checksum.clone(),
            archive: s.archive.clone(),
            status: status.into(),
            reason: s.reason.clone(),
            quality: s.quality.clone(),
            ..Default::default()
        },
    )
    .await
}

/// CreateSharedSkillCapped 同上,附带每作者待审配额(超出返回 ErrTooManyPending)。
pub async fn create_shared_skill_capped(
    pool: &sqlx::PgPool,
    s: &SharedSkill,
    pending_cap: i64,
) -> Result<i64, StoreError> {
    if pending_cap > 0 {
        let n = pending_release_count(pool, &s.author).await?;
        if n >= pending_cap {
            return Err(StoreError::TooManyPending);
        }
    }
    create_shared_skill(pool, s).await
}

/// SetSharedSkillArchive 覆盖某版本的归档。
/// 注意:版本快照不可变(决策 D3),该函数仅供数据修复/测试播种使用,
/// 生产发布路径不会调用它。
pub async fn set_shared_skill_archive(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
    archive: &[u8],
) -> Result<(), StoreError> {
    let res = sqlx::query(
        r#"UPDATE app_releases SET archive = $1, size = $2, updated_at = now()
        WHERE kind = $3 AND app_id = $4 AND version = $5"#,
    )
    .bind(archive)
    .bind(archive.len() as i64)
    .bind(APP_KIND_SKILL)
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

    fn new_shared(name: &str, version: &str, author: &str) -> SharedSkill {
        SharedSkill {
            name: name.into(),
            version: version.into(),
            author: author.into(),
            status: SharedSkillStatus::Pending,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn shared_skill_crud() {
        let pool = new_test_db().await;
        let id = create_shared_skill(&pool, &new_shared("codeql-audit", "1.0.0", "alice"))
            .await
            .unwrap();
        assert!(id > 0);
        let s = get_shared_skill(&pool, "codeql-audit", "1.0.0").await.unwrap();
        assert_eq!(s.author, "alice");
        assert_eq!(s.status, SharedSkillStatus::Pending);
        assert_eq!(s.display_name, "");

        // 同名不同版本允许(多版本)。
        create_shared_skill(&pool, &new_shared("codeql-audit", "1.1.0", "alice"))
            .await
            .unwrap();
        // 同名同版本拒绝。
        assert_eq!(
            create_shared_skill(&pool, &new_shared("codeql-audit", "1.0.0", "bob"))
                .await
                .unwrap_err(),
            StoreError::Duplicate
        );

        set_shared_skill_status(
            &pool,
            "codeql-audit",
            "1.0.0",
            SharedSkillStatus::Approved,
            "",
        )
        .await
        .unwrap();
        let s = get_shared_skill(&pool, "codeql-audit", "1.0.0").await.unwrap();
        assert_eq!(s.status, SharedSkillStatus::Approved);
        // Reject 存储理由;approve 清空。
        set_shared_skill_status(
            &pool,
            "codeql-audit",
            "1.1.0",
            SharedSkillStatus::Rejected,
            "缺 SKILL.md",
        )
        .await
        .unwrap();
        let s = get_shared_skill(&pool, "codeql-audit", "1.1.0").await.unwrap();
        assert_eq!(s.status, SharedSkillStatus::Rejected);
        assert_eq!(s.reason, "缺 SKILL.md");

        delete_shared_skill(&pool, "codeql-audit", "1.0.0").await.unwrap();
        assert_eq!(
            get_shared_skill(&pool, "codeql-audit", "1.0.0")
                .await
                .unwrap_err(),
            StoreError::NotFound
        );
        // 1.1.0 仍在(多版本独立)。
        get_shared_skill(&pool, "codeql-audit", "1.1.0").await.unwrap();
    }

    #[tokio::test]
    async fn shared_skill_visible_filter() {
        let pool = new_test_db().await;
        async fn must_create(
            pool: &sqlx::PgPool,
            name: &str,
            author: &str,
            status: SharedSkillStatus,
        ) {
            let mut s = new_shared(name, "1.0.0", author);
            s.status = status;
            create_shared_skill(pool, &s).await.unwrap();
        }
        must_create(&pool, "approve-a", "alice", SharedSkillStatus::Approved)
            .await;
        must_create(&pool, "pending-alice", "alice", SharedSkillStatus::Pending)
            .await;
        must_create(&pool, "pending-bob", "bob", SharedSkillStatus::Pending).await;
        must_create(&pool, "rejected-alice", "alice", SharedSkillStatus::Rejected)
            .await;

        // 授权制:approved 需授权才可见,但作者始终可见自己的;未授权者只见自己的。
        let vis = list_visible_shared_skills(&pool, "alice", &[]).await.unwrap();
        let names: std::collections::HashSet<&str> =
            vis.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains("approve-a"));
        assert!(names.contains("pending-alice"));
        assert!(names.contains("rejected-alice"));
        assert_eq!(names.len(), 3, "alice 不应看到 bob 的 pending");

        // 授权 approve-a 后 alice 仍可见(作者+授权不冲突)。
        let vis = list_visible_shared_skills(&pool, "bob", &["approve-a".to_string()])
            .await
            .unwrap();
        let mut seen_approved = false;
        for s in &vis {
            if s.name == "approve-a" && s.status == SharedSkillStatus::Approved {
                seen_approved = true;
            }
        }
        assert!(seen_approved, "granted bob does not see approve-a");

        let all = list_shared_skills(&pool, "").await.unwrap();
        assert_eq!(all.len(), 4);
        let pending = list_shared_skills(&pool, "pending").await.unwrap();
        assert_eq!(pending.len(), 2);
    }

    #[tokio::test]
    async fn shared_skill_capped_atomically() {
        let pool = new_test_db().await;
        for i in 0..2 {
            create_shared_skill_capped(&pool, &new_shared(&format!("cap-{i}"), "1.0.0", "alice"), 2)
                .await
                .unwrap();
        }
        let err = create_shared_skill_capped(
            &pool,
            &new_shared("cap-over", "1.0.0", "alice"),
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(err, StoreError::TooManyPending);
        // 同名新版本同样被配额拦截(同一作者,行键不同)。
        let err = create_shared_skill_capped(
            &pool,
            &new_shared("cap-over", "1.1.0", "alice"),
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(err, StoreError::TooManyPending);
        // 另一作者不受影响。
        create_shared_skill_capped(&pool, &new_shared("bob-one", "1.0.0", "bob"), 2)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn shared_skill_quality() {
        let pool = new_test_db().await;
        create_shared_skill(&pool, &new_shared("qual", "1.0.0", "alice"))
            .await
            .unwrap();
        // pending 行设置 quality -> ErrNotFound(仅 approved 可标记)。
        assert_eq!(
            set_shared_skill_quality(&pool, "qual", "1.0.0", "featured")
                .await
                .unwrap_err(),
            StoreError::NotFound
        );
        set_shared_skill_status(
            &pool,
            "qual",
            "1.0.0",
            SharedSkillStatus::Approved,
            "",
        )
        .await
        .unwrap();
        set_shared_skill_quality(&pool, "qual", "1.0.0", "featured")
            .await
            .unwrap();
        // 非法 quality -> ErrValidation。
        assert_eq!(
            set_shared_skill_quality(&pool, "qual", "1.0.0", "pro")
                .await
                .unwrap_err(),
            StoreError::Validation
        );
        let got = get_shared_skill(&pool, "qual", "1.0.0").await.unwrap();
        assert_eq!(got.quality, "featured");
        set_shared_skill_quality(&pool, "qual", "1.0.0", "").await.unwrap();
        let got = get_shared_skill(&pool, "qual", "1.0.0").await.unwrap();
        assert_eq!(got.quality, "");
        // 不存在版本 -> ErrNotFound。
        assert_eq!(
            set_shared_skill_quality(&pool, "nope", "1.0.0", "featured")
                .await
                .unwrap_err(),
            StoreError::NotFound
        );
    }

    #[tokio::test]
    async fn cross_source_skill_name_conflict() {
        let pool = new_test_db().await;
        // 1) 市场已有同名技能 -> shared_skills 上传阻断。
        crate::skills::add_skill(
            &pool,
            &crate::skills::Skill {
                name: "codeql-audit".into(),
                version: "2.0.0".into(),
                enabled: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            create_shared_skill(&pool, &new_shared("codeql-audit", "1.0.0", "alice"))
                .await
                .unwrap_err(),
            StoreError::Conflict
        );
        assert_eq!(
            create_shared_skill_capped(
                &pool,
                &new_shared("codeql-audit", "1.0.0", "alice"),
                10
            )
            .await
            .unwrap_err(),
            StoreError::Conflict
        );

        // 2) 共享库已有同名技能 -> marketplace 上架阻断。
        create_shared_skill(&pool, &new_shared("org-only-x", "1.0.0", "bob"))
            .await
            .unwrap();
        assert_eq!(
            crate::skills::add_skill(
                &pool,
                &crate::skills::Skill {
                    name: "org-only-x".into(),
                    version: "1.0.0".into(),
                    enabled: 1,
                    ..Default::default()
                },
            )
            .await
            .unwrap_err(),
            StoreError::Conflict
        );

        // 3) 无冲突(不同名)正常。
        create_shared_skill(&pool, &new_shared("fresh-org", "1.0.0", "carol"))
            .await
            .unwrap();
        crate::skills::add_skill(
            &pool,
            &crate::skills::Skill {
                name: "fresh-market".into(),
                version: "1.0.0".into(),
                enabled: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();

        // 4) 共享库同 name 多版本不跨源——但 market 同名仍阻断(名称互斥不看版本)。
        assert_eq!(
            crate::skills::add_skill(
                &pool,
                &crate::skills::Skill {
                    name: "fresh-org".into(),
                    version: "9.9.9".into(),
                    enabled: 1,
                    ..Default::default()
                },
            )
            .await
            .unwrap_err(),
            StoreError::Conflict
        );
    }

    #[tokio::test]
    async fn shared_skill_archive_db() {
        let pool = new_test_db().await;
        let blob = b"gz-tar-bytes";
        let mut s = new_shared("arch", "1.0.0", "alice");
        s.archive = blob.to_vec();
        s.checksum = "sum1".into();
        create_shared_skill(&pool, &s).await.unwrap();
        let got = get_shared_skill_archive(&pool, "arch", "1.0.0").await.unwrap();
        assert_eq!(got, blob.to_vec());
        // List must exclude the blob.
        let all = list_shared_skills(&pool, "").await.unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].archive.is_empty(), "blob must be excluded");
        // Download counter.
        assert!(increment_shared_skill_download(&pool, "arch", "1.0.0")
            .await
            .unwrap());
        let row = get_shared_skill(&pool, "arch", "1.0.0").await.unwrap();
        assert_eq!(row.downloads, 1);
        assert_eq!(row.calls, 0);
        // 覆盖归档(重提路径)。
        set_shared_skill_archive(&pool, "arch", "1.0.0", b"v2").await.unwrap();
        let got = get_shared_skill_archive(&pool, "arch", "1.0.0").await.unwrap();
        assert_eq!(got, b"v2".to_vec());
        // Call counter by name+version。
        assert!(crate::skills::increment_skill_call(&pool, "arch", "1.0.0")
            .await
            .unwrap());
        let row = get_shared_skill(&pool, "arch", "1.0.0").await.unwrap();
        assert_eq!(row.calls, 1);
        // Delete clears the blob.
        delete_shared_skill_archive(&pool, "arch", "1.0.0").await.unwrap();
        let got = get_shared_skill_archive(&pool, "arch", "1.0.0").await.unwrap();
        assert!(got.is_empty());
    }
}
