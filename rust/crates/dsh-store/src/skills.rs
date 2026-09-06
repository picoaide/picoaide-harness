//! 市场技能域（Go `serverstore/skills.go` 等价）。
//!
//! P2 适配层(迁移 0053/0054):市场技能保留原有签名,内部读写统一的
//! apps/app_releases(channel=market)。市场因此获得**多版本快照**能力——
//! 旧的单行原地覆盖模型是「无版本历史、不能回滚」的根因。
//! 旧表 skills 兼容期内只读保留,P5 下线。

use crate::apps::*;
use crate::errors::{map_db_error, StoreError};
use chrono::{DateTime, Utc};

/// Skill 市场技能投影 DTO(旧表语义,内部由 App + 展示版本推导)。
#[derive(Debug, Clone, Default)]
pub struct Skill {
    pub id: i64,
    pub name: String,
    /// DisplayName 是展示名(0051):来自包内 SKILL.md 的 frontmatter title,
    /// 空值时读侧回退 Name。
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub checksum: String,
    pub enabled: i32,
    /// Archive holds the uploaded archive bytes (归档上传是唯一入口)。
    pub archive: Vec<u8>,
    /// Downloads counts successful archive downloads.
    pub downloads: i64,
    /// Calls counts skill invocations reported by clients (telemetry).
    pub calls: i64,
    /// Official 官方属性(0059, App 级): 归属官方 = 蓝标 + 仅管理员可上传。
    pub official: i16,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// compare_version_strings 数值感知比较(与 skillmanifest.CompareVersions 同规则;
/// serverstore 不依赖上层包,故在此保留一份小实现)。
pub fn compare_version_strings(a: &str, b: &str) -> i32 {
    let as_: Vec<&str> = a.split('-').next().unwrap_or("").split('.').collect();
    let bs: Vec<&str> = b.split('-').next().unwrap_or("").split('.').collect();
    for i in 0..3 {
        let av: i64 = as_.get(i).and_then(|s| s.parse().ok()).unwrap_or(0);
        let bv: i64 = bs.get(i).and_then(|s| s.parse().ok()).unwrap_or(0);
        if av != bv {
            return (av - bv) as i32;
        }
    }
    a.cmp(b) as i32
}

/// current_release 取某 App 的展示版本:最高 approved 且未软删。
async fn current_release(
    pool: &sqlx::PgPool,
    kind: &str,
    app_id: &str,
    with_archive: bool,
) -> Result<Option<Release>, StoreError> {
    let list = list_releases(pool, kind, app_id).await?;
    let mut best: Option<&Release> = None;
    for r in &list {
        if r.deleted_at.is_some() || r.status != RELEASE_STATUS_APPROVED {
            continue;
        }
        if best.is_none() || compare_version_strings(&r.version, &best.unwrap().version) > 0 {
            best = Some(r);
        }
    }
    let Some(best) = best else {
        return Ok(None);
    };
    if with_archive {
        let r = get_release(pool, kind, app_id, &best.version).await?;
        Ok(Some(r))
    } else {
        Ok(Some(best.clone()))
    }
}

/// CurrentMarketReleaseFor 取任意 kind 的展示版本(G4 市场智能体复用同一语义)。
pub async fn current_market_release_for(
    pool: &sqlx::PgPool,
    kind: &str,
    app_id: &str,
    with_archive: bool,
) -> Result<Option<Release>, StoreError> {
    current_release(pool, kind, app_id, with_archive).await
}

/// current_market_release 取市场技能的展示版本:最高 approved 且未软删。
async fn current_market_release(
    pool: &sqlx::PgPool,
    app_id: &str,
    with_archive: bool,
) -> Result<Option<Release>, StoreError> {
    current_release(pool, APP_KIND_SKILL, app_id, with_archive).await
}

/// app_to_skill 把 App + 展示版本投影成旧 Skill DTO。
fn app_to_skill(a: &App, r: Option<&Release>) -> Skill {
    let mut out = Skill {
        name: a.app_id.clone(),
        display_name: a.title.clone(),
        description: a.description.clone(),
        author: a.owner.clone(),
        enabled: a.enabled,
        official: a.official,
        created_at: a.created_at,
        updated_at: a.updated_at,
        ..Default::default()
    };
    if let Some(r) = r {
        out.id = r.id;
        out.version = r.version.clone();
        out.checksum = r.checksum.clone();
        out.archive = r.archive.clone();
        out.downloads = r.downloads;
        out.calls = r.calls;
        // 描述以 App 层为准(管理端元数据编辑写在 App 上);App 为空才回退版本描述。
        if out.description.is_empty() {
            out.description = r.description.clone();
        }
    }
    out
}

/// SkillNameExists 市场命名占用检查。
pub async fn skill_name_exists(pool: &sqlx::PgPool, name: &str) -> Result<bool, StoreError> {
    match get_app(pool, APP_KIND_SKILL, name).await {
        Err(StoreError::NotFound) => Ok(false),
        Err(e) => Err(e),
        Ok(a) => Ok(a.channel == APP_CHANNEL_MARKET),
    }
}

/// AddSkill 登记一个市场 App(可带首个版本的归档)。跨渠道同名互斥。
pub async fn add_skill(pool: &sqlx::PgPool, s: &Skill) -> Result<i64, StoreError> {
    if let Ok(existing) = get_app(pool, APP_KIND_SKILL, &s.name).await {
        if existing.channel != APP_CHANNEL_MARKET {
            return Err(StoreError::Conflict);
        }
        return Err(StoreError::Duplicate);
    }
    let title = if s.display_name.is_empty() {
        s.name.clone()
    } else {
        s.display_name.clone()
    };
    upsert_app(
        pool,
        &App {
            kind: APP_KIND_SKILL.into(),
            app_id: s.name.clone(),
            title,
            description: s.description.clone(),
            owner: s.author.clone(),
            channel: APP_CHANNEL_MARKET.into(),
            enabled: s.enabled,
            ..Default::default()
        },
    )
    .await?;
    // 没有归档就只登记 App 身份:版本号必须随内容一起产生,
    // 否则「创建时填了版本 → 首次上传同版本」会撞版本唯一约束。
    if s.archive.is_empty() {
        return Ok(1);
    }
    let version = if s.version.is_empty() {
        "1.0.0"
    } else {
        &s.version
    };
    create_release(
        pool,
        &Release {
            kind: APP_KIND_SKILL.into(),
            app_id: s.name.clone(),
            version: version.into(),
            title: s.display_name.clone(),
            description: s.description.clone(),
            author: s.author.clone(),
            publisher: s.author.clone(),
            checksum: s.checksum.clone(),
            archive: s.archive.clone(),
            status: RELEASE_STATUS_APPROVED.into(),
            ..Default::default()
        },
    )
    .await
}

/// GetSkill 取市场技能(展示版本 + 归档)。
pub async fn get_skill(pool: &sqlx::PgPool, name: &str) -> Result<Skill, StoreError> {
    let a = get_app(pool, APP_KIND_SKILL, name).await?;
    if a.channel != APP_CHANNEL_MARKET {
        return Err(StoreError::NotFound);
    }
    let r = current_market_release(pool, name, true).await?;
    Ok(app_to_skill(&a, r.as_ref()))
}

/// UpdateSkill 更新元数据(不触碰版本与归档:内容一律由发布写入)。
pub async fn update_skill(pool: &sqlx::PgPool, s: &Skill) -> Result<(), StoreError> {
    let title = if s.display_name.is_empty() {
        s.name.clone()
    } else {
        s.display_name.clone()
    };
    let res = sqlx::query(
        r#"UPDATE apps SET title = $1, description = $2, owner = $3, enabled = $4,
        updated_at = now() WHERE kind = $5 AND app_id = $6"#,
    )
    .bind(title)
    .bind(&s.description)
    .bind(&s.author)
    .bind(s.enabled)
    .bind(APP_KIND_SKILL)
    .bind(&s.name)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// ReplaceSkillArchive 发布一个新版本(不再原地覆盖——版本即不可变快照)。
/// 同版本号已存在时返回 ErrDuplicate,由上层给出明确的 VERSION_EXISTS。
pub async fn replace_skill_archive(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
    checksum: &str,
    archive: &[u8],
) -> Result<(), StoreError> {
    let a = get_app(pool, APP_KIND_SKILL, name).await?;
    create_release(
        pool,
        &Release {
            kind: APP_KIND_SKILL.into(),
            app_id: name.into(),
            version: version.into(),
            title: a.title.clone(),
            description: a.description.clone(),
            author: a.owner.clone(),
            publisher: a.owner.clone(),
            checksum: checksum.into(),
            archive: archive.to_vec(),
            status: RELEASE_STATUS_APPROVED.into(),
            ..Default::default()
        },
    )
    .await
    .map(|_| ())
}

/// SetSkillEnabled 上下架(保留数据)。
pub async fn set_skill_enabled(
    pool: &sqlx::PgPool,
    name: &str,
    enabled: bool,
) -> Result<i64, StoreError> {
    set_app_enabled(pool, APP_KIND_SKILL, name, enabled).await?;
    Ok(1)
}

/// ListSkills 市场清单(enabled_only=true 只返回已上架)。
pub async fn list_skills(
    pool: &sqlx::PgPool,
    enabled_only: bool,
) -> Result<Vec<Skill>, StoreError> {
    let apps = list_apps(pool, APP_KIND_SKILL, APP_CHANNEL_MARKET).await?;
    let mut out = Vec::new();
    for a in &apps {
        if enabled_only && a.enabled != 1 {
            continue;
        }
        let r = current_market_release(pool, &a.app_id, false).await?;
        out.push(app_to_skill(a, r.as_ref()));
    }
    Ok(out)
}

/// IncrementSkillDownload 下载计数(记在展示版本上)。
pub async fn increment_skill_download(
    pool: &sqlx::PgPool,
    name: &str,
) -> Result<bool, StoreError> {
    let r = current_market_release(pool, name, false).await?;
    let Some(r) = r else {
        return Ok(false);
    };
    increment_release_download(pool, APP_KIND_SKILL, name, &r.version).await?;
    Ok(true)
}

/// IncrementSkillCall 调用计数(客户端遥测按 name+version 上报)。
pub async fn increment_skill_call(
    pool: &sqlx::PgPool,
    name: &str,
    version: &str,
) -> Result<bool, StoreError> {
    let version = if version.is_empty() {
        // 遥测可能只上报名字:落到展示版本上。
        let r = current_market_release(pool, name, false).await?;
        let Some(r) = r else {
            return Ok(false);
        };
        r.version.clone()
    } else {
        version.to_string()
    };
    let res = sqlx::query(
        "UPDATE app_releases SET calls = calls + 1 WHERE kind = $1 AND app_id = $2 AND version = $3",
    )
    .bind(APP_KIND_SKILL)
    .bind(name)
    .bind(&version)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(res.rows_affected() > 0)
}

/// SetSkillDisplayName 写入展示名(来自包内 title)。
pub async fn set_skill_display_name(
    pool: &sqlx::PgPool,
    name: &str,
    display_name: &str,
) -> Result<(), StoreError> {
    let res = sqlx::query(
        "UPDATE apps SET title = $1, updated_at = now() WHERE kind = $2 AND app_id = $3",
    )
    .bind(display_name)
    .bind(APP_KIND_SKILL)
    .bind(name)
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

    #[tokio::test]
    async fn skills_crud() {
        let pool = new_test_db().await;
        let id = add_skill(
            &pool,
            &Skill {
                name: "demo".into(),
                version: "1.0.0".into(),
                description: "demo skill".into(),
                author: "pico".into(),
                enabled: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(id, 1, "无归档只登记 App 身份,返回哨兵 1");
        assert_eq!(
            add_skill(
                &pool,
                &Skill {
                    name: "demo".into(),
                    version: "2.0.0".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err(),
            StoreError::Duplicate
        );

        let s = get_skill(&pool, "demo").await.unwrap();
        // P2:版本号随内容一起产生——只登记元数据的 App 没有版本(Version="")。
        assert_eq!(s.version, "");
        assert_eq!(s.enabled, 1);
        assert_eq!(s.description, "demo skill");

        // 0052:版本由「上传新版」随归档写入,元数据更新只改描述/作者。
        let mut s = s.clone();
        s.description = "demo skill v2".into();
        update_skill(&pool, &s).await.unwrap();
        let s = get_skill(&pool, "demo").await.unwrap();
        assert_eq!(s.description, "demo skill v2");

        add_skill(
            &pool,
            &Skill {
                name: "off".into(),
                version: "1.0.0".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        set_skill_enabled(&pool, "off", false).await.unwrap();
        let list = list_skills(&pool, true).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "demo");
        let all = list_skills(&pool, false).await.unwrap();
        assert_eq!(all.len(), 2);
    }

    #[tokio::test]
    async fn skill_upload_archive() {
        let pool = new_test_db().await;
        add_skill(
            &pool,
            &Skill {
                name: "up".into(),
                version: "0.1.0".into(),
                enabled: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let blob = b"fake-gzip-tar";
        replace_skill_archive(&pool, "up", "1.0.0", "abc123", blob)
            .await
            .unwrap();
        let s = get_skill(&pool, "up").await.unwrap();
        assert_eq!(s.archive, blob.to_vec());
        assert_eq!(s.checksum, "abc123");
        assert_eq!(s.version, "1.0.0");
        // ListSkills (list columns) must not load the blob.
        let list = list_skills(&pool, false).await.unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].archive.is_empty(), "blob must be excluded");
        // Download counter increments.
        assert!(increment_skill_download(&pool, "up").await.unwrap());
        let s = get_skill(&pool, "up").await.unwrap();
        assert_eq!(s.downloads, 1);
        // Call counter targets name only resolve to current release.
        assert!(increment_skill_call(&pool, "up", "").await.unwrap());
        let s = get_skill(&pool, "up").await.unwrap();
        assert_eq!(s.calls, 1);
        // Unknown name: no row matched, no error.
        assert!(!increment_skill_call(&pool, "nope", "").await.unwrap());
        // 同版本号已存在 → ErrDuplicate。
        assert_eq!(
            replace_skill_archive(&pool, "up", "1.0.0", "x", b"y")
                .await
                .unwrap_err(),
            StoreError::Duplicate
        );
    }

    #[tokio::test]
    async fn skill_update_keeps_archive() {
        let pool = new_test_db().await;
        add_skill(
            &pool,
            &Skill {
                name: "up2".into(),
                version: "0.1.0".into(),
                enabled: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let blob = b"data";
        replace_skill_archive(&pool, "up2", "1.0.0", "sum", blob)
            .await
            .unwrap();
        let mut s = get_skill(&pool, "up2").await.unwrap();
        s.description = "edited".into();
        update_skill(&pool, &s).await.unwrap();
        let s = get_skill(&pool, "up2").await.unwrap();
        assert_eq!(s.description, "edited");
        assert_eq!(s.archive, blob.to_vec());
    }

    #[tokio::test]
    async fn skill_name_exists_and_display_name() {
        let pool = new_test_db().await;
        add_skill(
            &pool,
            &Skill {
                name: "mk".into(),
                enabled: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(skill_name_exists(&pool, "mk").await.unwrap());
        assert!(!skill_name_exists(&pool, "nope").await.unwrap());
        set_skill_display_name(&pool, "mk", "市场技能").await.unwrap();
        let s = get_skill(&pool, "mk").await.unwrap();
        assert_eq!(s.display_name, "市场技能");
        assert_eq!(s.name, "mk", "display 缺省回退 name 逻辑在 add 时生效");
        assert_eq!(
            set_skill_display_name(&pool, "nope", "x").await.unwrap_err(),
            StoreError::NotFound
        );
    }

    #[tokio::test]
    async fn version_compare_numeric() {
        assert!(compare_version_strings("1.10.0", "1.9.0") > 0);
        assert!(compare_version_strings("2.0.0", "1.9.9") > 0);
        assert_eq!(compare_version_strings("1.0.0", "1.0.0"), 0);
        // 数值相同时回退字符串比较(与 Go strings.Compare 一致)。
        assert!(compare_version_strings("1.0.0", "1.0.0-beta") < 0);
        assert!(compare_version_strings("1.0.0-beta", "1.0.0") > 0);
    }
}
