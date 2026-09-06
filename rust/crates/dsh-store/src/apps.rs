//! 统一应用模型 DAO（Go `serverstore/apps.go` 等价）——apps / app_releases / app_grants。
//!
//! 决策 docs/decisions/2026-09-01-skill-app-management.md P2：技能与智能体
//! 统一为 App(长期身份) + Release(不可变版本快照)。本文件是该模型的唯一
//! 数据访问层——旧的 skills/shared_skills/agent_presets DAO 在兼容期内保留
//! 只读,新写入一律走这里。

use crate::errors::{map_db_error, StoreError};
use crate::grants::Grant;
use chrono::{DateTime, Utc};
use sqlx::Row;

/// App 分发渠道与内容类型的合法取值。
pub const APP_CHANNEL_MARKET: &str = "market";
pub const APP_CHANNEL_ORG: &str = "org";
pub const APP_KIND_SKILL: &str = "skill";
pub const APP_KIND_AGENT: &str = "agent";

/// Release 审核状态(与旧三表一致,迁移不改变审核语义)。
pub const RELEASE_STATUS_PENDING: &str = "pending";
pub const RELEASE_STATUS_APPROVED: &str = "approved";
pub const RELEASE_STATUS_REJECTED: &str = "rejected";

/// App 是一个能力的长期身份:名字、归属、渠道、上下架状态与授权都挂在它上面。
#[derive(Debug, Clone, Default)]
pub struct App {
    pub kind: String,
    pub app_id: String,
    pub title: String,
    pub description: String,
    pub owner: String,
    pub channel: String,
    pub enabled: i32,
    /// Official 官方属性(0059, App 级): 1=归属官方(蓝标/仅管理员可上传),
    /// 此时 owner 为 ''(无个人归属)。
    pub official: i16,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Release 是一次不可变的版本快照。内容字段一经写入不再更新,只有审核状态、
/// 质量标记、下载计数与软删标记可变。
#[derive(Debug, Clone, Default)]
pub struct Release {
    pub id: i64,
    pub kind: String,
    pub app_id: String,
    pub version: String,
    pub title: String,
    pub description: String,
    pub changelog: String,
    pub category: String,
    /// tags 以 JSON 数组字符串存于 TEXT 列,读侧解析回 Vec。
    pub tags: Vec<String>,
    /// Author 包内署名;Publisher 发布账号(登录态,不可伪造)。
    pub author: String,
    pub publisher: String,
    pub checksum: String,
    pub size: i64,
    /// archive 归档字节(list 查询不加载,恒为空)。
    pub archive: Vec<u8>,
    pub status: String,
    pub reason: String,
    pub quality: String,
    pub downloads: i64,
    pub calls: i64,
    pub deleted_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const APP_COLUMNS: &str =
    "kind, app_id, title, description, owner, channel, enabled, official, created_at, updated_at";

/// releaseListColumns 不含 archive blob:清单查询绝不加载全部归档。
const RELEASE_LIST_COLUMNS: &str = "id, kind, app_id, version, title, description, changelog, category, tags, \
	author, publisher, checksum, size, status, reason, quality, downloads, calls, deleted_at, created_at, updated_at";

const RELEASE_FULL_COLUMNS: &str = "id, kind, app_id, version, title, description, changelog, category, tags, \
	author, publisher, checksum, size, status, reason, quality, downloads, calls, deleted_at, created_at, updated_at, archive";

fn scan_app(row: &sqlx::postgres::PgRow) -> App {
    App {
        kind: row.get("kind"),
        app_id: row.get("app_id"),
        title: row.get("title"),
        description: row.get("description"),
        owner: row.get("owner"),
        channel: row.get("channel"),
        enabled: row.get("enabled"),
        official: row.get("official"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn scan_release(row: &sqlx::postgres::PgRow, with_archive: bool) -> Release {
    Release {
        id: row.get("id"),
        kind: row.get("kind"),
        app_id: row.get("app_id"),
        version: row.get("version"),
        title: row.get("title"),
        description: row.get("description"),
        changelog: row.get("changelog"),
        category: row.get("category"),
        tags: parse_tags(&row.get::<String, _>("tags")),
        author: row.get("author"),
        publisher: row.get("publisher"),
        checksum: row.get("checksum"),
        size: row.get("size"),
        archive: if with_archive {
            row.get::<Option<Vec<u8>>, _>("archive").unwrap_or_default()
        } else {
            Vec::new()
        },
        status: row.get("status"),
        reason: row.get("reason"),
        quality: row.get("quality"),
        downloads: row.get("downloads"),
        calls: row.get("calls"),
        deleted_at: row.get("deleted_at"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

/// parse_tags 把 JSON 数组字符串解析回 tags;空串 = 无标签。
fn parse_tags(s: &str) -> Vec<String> {
    if s.is_empty() {
        return Vec::new();
    }
    serde_json::from_str(s).unwrap_or_default()
}

fn bool_int(b: bool) -> i32 {
    if b {
        1
    } else {
        0
    }
}

fn bool_int16(b: bool) -> i16 {
    if b {
        1
    } else {
        0
    }
}

/// UpsertApp 建立或更新一个 App 身份(幂等)。渠道一经确定不再变更——跨渠道
/// 迁移属于人工决策,不应由一次发布静默改写。
pub async fn upsert_app(pool: &sqlx::PgPool, a: &App) -> Result<(), StoreError> {
    if a.kind != APP_KIND_SKILL && a.kind != APP_KIND_AGENT {
        return Err(StoreError::Validation);
    }
    if a.channel != APP_CHANNEL_MARKET && a.channel != APP_CHANNEL_ORG {
        return Err(StoreError::Validation);
    }
    sqlx::query(
        r#"INSERT INTO apps (kind, app_id, title, description, owner, channel, enabled)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (kind, app_id) DO UPDATE SET
            title = excluded.title, description = excluded.description,
            owner = COALESCE(NULLIF(apps.owner, ''), excluded.owner),
            updated_at = now()"#,
    )
    .bind(&a.kind)
    .bind(&a.app_id)
    .bind(&a.title)
    .bind(&a.description)
    .bind(&a.owner)
    .bind(&a.channel)
    .bind(a.enabled)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(())
}

/// GetApp 按 (kind, app_id) 取 App;不存在返回 ErrNotFound。
pub async fn get_app(pool: &sqlx::PgPool, kind: &str, app_id: &str) -> Result<App, StoreError> {
    let row = sqlx::query(&format!(
        "SELECT {APP_COLUMNS} FROM apps WHERE kind = $1 AND app_id = $2"
    ))
    .bind(kind)
    .bind(app_id)
    .fetch_optional(pool)
    .await
    .map_err(map_db_error)?
    .ok_or(StoreError::NotFound)?;
    Ok(scan_app(&row))
}

/// ListApps 列出全部 App(管理端视图),可按 kind/channel 过滤(空 = 不过滤)。
pub async fn list_apps(
    pool: &sqlx::PgPool,
    kind: &str,
    channel: &str,
) -> Result<Vec<App>, StoreError> {
    let mut sql = String::from(&format!("SELECT {APP_COLUMNS} FROM apps WHERE 1=1"));
    let mut args: Vec<String> = Vec::new();
    if !kind.is_empty() {
        args.push(kind.to_string());
        sql.push_str(&format!(" AND kind = ${}", args.len()));
    }
    if !channel.is_empty() {
        args.push(channel.to_string());
        sql.push_str(&format!(" AND channel = ${}", args.len()));
    }
    sql.push_str(" ORDER BY kind, app_id");
    let mut q = sqlx::query(&sql);
    for a in &args {
        q = q.bind(a);
    }
    let rows = q.fetch_all(pool).await.map_err(map_db_error)?;
    Ok(rows.iter().map(scan_app).collect())
}

/// SetAppOfficial 设置 App 官方属性与归属(转官方=official=1+owner='';
/// 转用户=official=0+owner=<username>)。官方属性是 App 级唯一事实源,
/// 不经 UpsertApp 泄露(发布/元数据更新不触碰本列)。
pub async fn set_app_official(
    pool: &sqlx::PgPool,
    kind: &str,
    app_id: &str,
    official: bool,
    owner: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        "UPDATE apps SET official = $1, owner = $2, updated_at = now() WHERE kind = $3 AND app_id = $4",
    )
    .bind(bool_int16(official))
    .bind(owner)
    .bind(kind)
    .bind(app_id)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(())
}

/// AppOfficialMap 返回某 kind 全部 App 的官方属性(名→bool),聚合面/列表用。
pub async fn app_official_map(
    pool: &sqlx::PgPool,
    kind: &str,
) -> Result<std::collections::HashMap<String, bool>, StoreError> {
    let rows = sqlx::query("SELECT app_id, official FROM apps WHERE kind = $1")
        .bind(kind)
        .fetch_all(pool)
        .await
        .map_err(map_db_error)?;
    let mut out = std::collections::HashMap::new();
    for r in rows {
        let id: String = r.get("app_id");
        let off: i16 = r.get("official");
        out.insert(id, off == 1);
    }
    Ok(out)
}

/// SetAppOwner 归属转移(管理员指定,2026-09-02):apps.owner 是归属人的唯一
/// 真源——转移后旧归属者发布的后续版本请求一律 404,新归属者获得续传权。
pub async fn set_app_owner(
    pool: &sqlx::PgPool,
    kind: &str,
    app_id: &str,
    owner: &str,
) -> Result<(), StoreError> {
    let res = sqlx::query(
        "UPDATE apps SET owner = $1, updated_at = now() WHERE kind = $2 AND app_id = $3",
    )
    .bind(owner)
    .bind(kind)
    .bind(app_id)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// SetAppEnabled 上下架(保留数据)。
pub async fn set_app_enabled(
    pool: &sqlx::PgPool,
    kind: &str,
    app_id: &str,
    enabled: bool,
) -> Result<(), StoreError> {
    let res = sqlx::query(
        "UPDATE apps SET enabled = $1, updated_at = now() WHERE kind = $2 AND app_id = $3",
    )
    .bind(bool_int(enabled))
    .bind(kind)
    .bind(app_id)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// CreateRelease 写入一个新的版本快照。调用方必须已完成严格校验与版本语义
/// 判定(版本不可复用、必须递增、内容未变更等),本函数只负责落库。
/// (kind, app_id, version) 唯一约束兜底并发判重:竞争窗口内先落库者赢,
/// 后者返回 ErrDuplicate(B7,2026-09-01)。
pub async fn create_release(pool: &sqlx::PgPool, r: &Release) -> Result<i64, StoreError> {
    let tags = if r.tags.is_empty() {
        "[]".to_string()
    } else {
        serde_json::to_string(&r.tags).unwrap_or_else(|_| "[]".to_string())
    };
    let status = if r.status.is_empty() {
        RELEASE_STATUS_PENDING
    } else {
        &r.status
    };
    let row = sqlx::query(
        r#"INSERT INTO app_releases
        (kind, app_id, version, title, description, changelog, category, tags, author, publisher,
         checksum, size, archive, status, reason, quality)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING id"#,
    )
    .bind(&r.kind)
    .bind(&r.app_id)
    .bind(&r.version)
    .bind(&r.title)
    .bind(&r.description)
    .bind(&r.changelog)
    .bind(&r.category)
    .bind(&tags)
    .bind(&r.author)
    .bind(&r.publisher)
    .bind(&r.checksum)
    .bind(r.archive.len() as i64)
    .bind(&r.archive)
    .bind(status)
    .bind(&r.reason)
    .bind(&r.quality)
    .fetch_one(pool)
    .await
    .map_err(map_db_error)?;
    Ok(row.get("id"))
}

/// GetRelease 取一个版本(含归档);软删的版本同样返回,调用方据 DeletedAt 判断。
pub async fn get_release(
    pool: &sqlx::PgPool,
    kind: &str,
    app_id: &str,
    version: &str,
) -> Result<Release, StoreError> {
    let row = sqlx::query(&format!(
        "SELECT {RELEASE_FULL_COLUMNS} FROM app_releases WHERE kind = $1 AND app_id = $2 AND version = $3"
    ))
    .bind(kind)
    .bind(app_id)
    .bind(version)
    .fetch_optional(pool)
    .await
    .map_err(map_db_error)?
    .ok_or(StoreError::NotFound)?;
    Ok(scan_release(&row, true))
}

/// ListReleases 列出一个 App 的全部版本(不含归档),含被拒与软删——
/// 版本号一经使用即永久占位(决策 D3),判重必须看到全部历史。
pub async fn list_releases(
    pool: &sqlx::PgPool,
    kind: &str,
    app_id: &str,
) -> Result<Vec<Release>, StoreError> {
    let rows = sqlx::query(&format!(
        "SELECT {RELEASE_LIST_COLUMNS} FROM app_releases WHERE kind = $1 AND app_id = $2 ORDER BY created_at"
    ))
    .bind(kind)
    .bind(app_id)
    .fetch_all(pool)
    .await
    .map_err(map_db_error)?;
    Ok(rows.iter().map(|r| scan_release(r, false)).collect())
}

/// ListReleasesByStatus 列出全部 App 的版本(管理端审核队列),status 为空 = 全部。
pub async fn list_releases_by_status(
    pool: &sqlx::PgPool,
    kind: &str,
    status: &str,
) -> Result<Vec<Release>, StoreError> {
    let mut sql = String::from(&format!(
        "SELECT {RELEASE_LIST_COLUMNS} FROM app_releases WHERE deleted_at IS NULL"
    ));
    let mut args: Vec<String> = Vec::new();
    if !kind.is_empty() {
        args.push(kind.to_string());
        sql.push_str(&format!(" AND kind = ${}", args.len()));
    }
    if !status.is_empty() {
        args.push(status.to_string());
        sql.push_str(&format!(" AND status = ${}", args.len()));
    }
    sql.push_str(" ORDER BY created_at DESC");
    let mut q = sqlx::query(&sql);
    for a in &args {
        q = q.bind(a);
    }
    let rows = q.fetch_all(pool).await.map_err(map_db_error)?;
    Ok(rows.iter().map(|r| scan_release(r, false)).collect())
}

/// SetReleaseStatus 审核:approved/rejected(rejected 必须带理由,由调用方保证)。
/// 只改状态位,绝不触碰内容——这是「快照」与「审核」得以共存的关键。
pub async fn set_release_status(
    pool: &sqlx::PgPool,
    kind: &str,
    app_id: &str,
    version: &str,
    status: &str,
    reason: &str,
) -> Result<(), StoreError> {
    let res = sqlx::query(
        r#"UPDATE app_releases SET status = $1, reason = $2,
        quality = CASE WHEN $3 = 'approved' THEN quality ELSE '' END, updated_at = now()
        WHERE kind = $4 AND app_id = $5 AND version = $6"#,
    )
    .bind(status)
    .bind(reason)
    .bind(status)
    .bind(kind)
    .bind(app_id)
    .bind(version)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// SetReleaseQuality 质量标记('|official|featured),仅 approved 版本可设置。
pub async fn set_release_quality(
    pool: &sqlx::PgPool,
    kind: &str,
    app_id: &str,
    version: &str,
    quality: &str,
) -> Result<(), StoreError> {
    let res = sqlx::query(
        r#"UPDATE app_releases SET quality = $1, updated_at = now()
        WHERE kind = $2 AND app_id = $3 AND version = $4 AND status = 'approved'"#,
    )
    .bind(quality)
    .bind(kind)
    .bind(app_id)
    .bind(version)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// SoftDeleteRelease 软删一个版本:内容不再可用,但版本号永久占位不可复用。
pub async fn soft_delete_release(
    pool: &sqlx::PgPool,
    kind: &str,
    app_id: &str,
    version: &str,
) -> Result<(), StoreError> {
    let res = sqlx::query(
        r#"UPDATE app_releases SET deleted_at = now(), archive = NULL,
        updated_at = now() WHERE kind = $1 AND app_id = $2 AND version = $3 AND deleted_at IS NULL"#,
    )
    .bind(kind)
    .bind(app_id)
    .bind(version)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// IncrementReleaseDownload 下载计数(best effort)。
pub async fn increment_release_download(
    pool: &sqlx::PgPool,
    kind: &str,
    app_id: &str,
    version: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        "UPDATE app_releases SET downloads = downloads + 1 WHERE kind = $1 AND app_id = $2 AND version = $3",
    )
    .bind(kind)
    .bind(app_id)
    .bind(version)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(())
}

/// PendingReleaseCount 某发布者的待审数量(配额)。
pub async fn pending_release_count(
    pool: &sqlx::PgPool,
    publisher: &str,
) -> Result<i64, StoreError> {
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM app_releases WHERE publisher = $1 AND status = 'pending' AND deleted_at IS NULL",
    )
    .bind(publisher)
    .fetch_one(pool)
    .await
    .map_err(map_db_error)?;
    Ok(n)
}

/// GrantApp 授权给用户或部门组(幂等)。
pub async fn grant_app(
    pool: &sqlx::PgPool,
    kind: &str,
    app_id: &str,
    grantee: &str,
    grantee_type: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        r#"INSERT INTO app_grants (kind, app_id, grantee_type, grantee)
        VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING"#,
    )
    .bind(kind)
    .bind(app_id)
    .bind(grantee_type)
    .bind(grantee)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(())
}

/// RevokeApp 撤销一条授权。
pub async fn revoke_app(
    pool: &sqlx::PgPool,
    kind: &str,
    app_id: &str,
    grantee: &str,
    grantee_type: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        "DELETE FROM app_grants WHERE kind = $1 AND app_id = $2 AND grantee_type = $3 AND grantee = $4",
    )
    .bind(kind)
    .bind(app_id)
    .bind(grantee_type)
    .bind(grantee)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(())
}

/// ListAppGrants 列出一个 App 的授权对象。
pub async fn list_app_grants(
    pool: &sqlx::PgPool,
    kind: &str,
    app_id: &str,
) -> Result<Vec<Grant>, StoreError> {
    let rows = sqlx::query(
        "SELECT grantee_type, grantee FROM app_grants WHERE kind = $1 AND app_id = $2 ORDER BY grantee_type, grantee",
    )
    .bind(kind)
    .bind(app_id)
    .fetch_all(pool)
    .await
    .map_err(map_db_error)?;
    Ok(rows
        .into_iter()
        .map(|r| Grant {
            grantee_type: r.get("grantee_type"),
            grantee: r.get("grantee"),
        })
        .collect())
}

/// AccessibleAppIDs 返回某用户(含其部门组)有权访问的 App 名单。
/// 严格默认:未授权即不可见(与旧三域一致)。
pub async fn accessible_app_ids(
    pool: &sqlx::PgPool,
    kind: &str,
    username: &str,
    groups: &[String],
) -> Result<Vec<String>, StoreError> {
    let mut sql = String::from(
        "SELECT DISTINCT app_id FROM app_grants WHERE kind = $1 AND (grantee_type = 'user' AND grantee = $2",
    );
    if !groups.is_empty() {
        sql.push_str(" OR (grantee_type = 'group' AND lower(grantee) IN (");
        for i in 0..groups.len() {
            if i > 0 {
                sql.push(',');
            }
            sql.push_str(&format!("${}", i + 3));
        }
        sql.push_str("))");
    }
    sql.push(')');
    let mut q = sqlx::query(&sql).bind(kind).bind(username);
    for g in groups {
        q = q.bind(g.to_lowercase());
    }
    let rows = q.fetch_all(pool).await.map_err(map_db_error)?;
    Ok(rows.into_iter().map(|r| r.get("app_id")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;

    #[tokio::test]
    async fn app_release_lifecycle() {
        let pool = new_test_db().await;
        upsert_app(
            &pool,
            &App {
                kind: APP_KIND_SKILL.into(),
                app_id: "demo-skill".into(),
                title: "演示技能".into(),
                description: "描述".into(),
                owner: "alice".into(),
                channel: APP_CHANNEL_ORG.into(),
                enabled: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // 幂等:重复 upsert 更新展示元数据,但不改渠道与已有归属。
        upsert_app(
            &pool,
            &App {
                kind: APP_KIND_SKILL.into(),
                app_id: "demo-skill".into(),
                title: "新标题".into(),
                owner: "bob".into(),
                channel: APP_CHANNEL_ORG.into(),
                enabled: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let got = get_app(&pool, APP_KIND_SKILL, "demo-skill").await.unwrap();
        assert_eq!(got.title, "新标题");
        assert_eq!(got.owner, "alice", "owner 必须保持首个发布者");
        // kind 隔离:同名 agent 是另一个 App。
        assert_eq!(
            get_app(&pool, APP_KIND_AGENT, "demo-skill").await.unwrap_err(),
            StoreError::NotFound
        );

        let r1 = Release {
            kind: APP_KIND_SKILL.into(),
            app_id: "demo-skill".into(),
            version: "1.0.0".into(),
            title: "演示技能".into(),
            description: "描述".into(),
            author: "alice".into(),
            publisher: "alice".into(),
            checksum: "aa".into(),
            archive: b"zip-bytes".to_vec(),
            tags: vec!["hr".into(), "报销".into()],
            status: RELEASE_STATUS_PENDING.into(),
            ..Default::default()
        };
        let id = create_release(&pool, &r1).await.unwrap();
        assert!(id > 0);
        let full = get_release(&pool, APP_KIND_SKILL, "demo-skill", "1.0.0").await.unwrap();
        assert_eq!(full.archive, b"zip-bytes".to_vec());
        assert_eq!(full.size, 9);
        assert_eq!(full.tags, vec!["hr".to_string(), "报销".to_string()]);
        // 同版本号不可复用(唯一约束必须映射 ErrDuplicate)。
        assert_eq!(
            create_release(&pool, &r1).await.unwrap_err(),
            StoreError::Duplicate
        );

        // 审核:只改状态,不碰内容。
        set_release_status(&pool, APP_KIND_SKILL, "demo-skill", "1.0.0", RELEASE_STATUS_APPROVED, "")
            .await
            .unwrap();
        set_release_quality(&pool, APP_KIND_SKILL, "demo-skill", "1.0.0", "official")
            .await
            .unwrap();
        let full = get_release(&pool, APP_KIND_SKILL, "demo-skill", "1.0.0").await.unwrap();
        assert_eq!(full.status, RELEASE_STATUS_APPROVED);
        assert_eq!(full.quality, "official");
        assert_eq!(full.archive, b"zip-bytes".to_vec(), "审核不得改动内容");
        // 拒绝时清空质量标记。
        set_release_status(
            &pool,
            APP_KIND_SKILL,
            "demo-skill",
            "1.0.0",
            RELEASE_STATUS_REJECTED,
            "不合规",
        )
        .await
        .unwrap();
        let full = get_release(&pool, APP_KIND_SKILL, "demo-skill", "1.0.0").await.unwrap();
        assert_eq!(full.quality, "");
        assert_eq!(full.reason, "不合规");
        // 非 approved 版本不可设质量。
        assert_eq!(
            set_release_quality(&pool, APP_KIND_SKILL, "demo-skill", "1.0.0", "featured")
                .await
                .unwrap_err(),
            StoreError::NotFound
        );

        // 软删:归档清空,但版本号仍占位(列表可见 → 判重仍能看到)。
        soft_delete_release(&pool, APP_KIND_SKILL, "demo-skill", "1.0.0")
            .await
            .unwrap();
        let list = list_releases(&pool, APP_KIND_SKILL, "demo-skill").await.unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].deleted_at.is_some());
        assert_eq!(
            create_release(&pool, &r1).await.unwrap_err(),
            StoreError::Duplicate,
            "软删的版本号仍不可复用"
        );
    }

    #[tokio::test]
    async fn app_grants_visibility() {
        let pool = new_test_db().await;
        for id in ["granted", "ungranted"] {
            upsert_app(
                &pool,
                &App {
                    kind: APP_KIND_SKILL.into(),
                    app_id: id.into(),
                    channel: APP_CHANNEL_MARKET.into(),
                    enabled: 1,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        grant_app(&pool, APP_KIND_SKILL, "granted", "alice", "user")
            .await
            .unwrap();
        grant_app(&pool, APP_KIND_SKILL, "granted", "Eng", "group")
            .await
            .unwrap();
        // 严格默认:只返回被授权的。
        let names = accessible_app_ids(&pool, APP_KIND_SKILL, "alice", &[]).await.unwrap();
        assert_eq!(names, vec!["granted".to_string()]);
        // 部门组大小写不敏感(沿用旧语义)。
        let names = accessible_app_ids(&pool, APP_KIND_SKILL, "bob", &["eng".to_string()])
            .await
            .unwrap();
        assert_eq!(names, vec!["granted".to_string()]);
        let names = accessible_app_ids(&pool, APP_KIND_SKILL, "carol", &["other".to_string()])
            .await
            .unwrap();
        assert!(names.is_empty(), "未授权用户应看不到任何 App");
        let grants = list_app_grants(&pool, APP_KIND_SKILL, "granted").await.unwrap();
        assert_eq!(grants.len(), 2);
        revoke_app(&pool, APP_KIND_SKILL, "granted", "alice", "user")
            .await
            .unwrap();
        let names = accessible_app_ids(&pool, APP_KIND_SKILL, "alice", &[]).await.unwrap();
        assert!(names.is_empty(), "撤销后仍可见");
    }

    #[tokio::test]
    async fn app_official_and_pending_count() {
        let pool = new_test_db().await;
        upsert_app(
            &pool,
            &App {
                kind: APP_KIND_SKILL.into(),
                app_id: "mk".into(),
                title: "市场技能".into(),
                description: "d".into(),
                owner: "boss".into(),
                channel: APP_CHANNEL_MARKET.into(),
                enabled: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // 转官方:official=1 + owner=''。
        set_app_official(&pool, APP_KIND_SKILL, "mk", true, "").await.unwrap();
        let m = app_official_map(&pool, APP_KIND_SKILL).await.unwrap();
        assert_eq!(m.get("mk"), Some(&true));
        let a = get_app(&pool, APP_KIND_SKILL, "mk").await.unwrap();
        assert_eq!(a.official, 1);
        assert_eq!(a.owner, "");
        // 转回用户。
        set_app_official(&pool, APP_KIND_SKILL, "mk", false, "boss").await.unwrap();
        let a = get_app(&pool, APP_KIND_SKILL, "mk").await.unwrap();
        assert_eq!(a.official, 0);
        assert_eq!(a.owner, "boss");
        // 归属转移 + 上下架。
        set_app_owner(&pool, APP_KIND_SKILL, "mk", "carol").await.unwrap();
        assert_eq!(get_app(&pool, APP_KIND_SKILL, "mk").await.unwrap().owner, "carol");
        set_app_enabled(&pool, APP_KIND_SKILL, "mk", false).await.unwrap();
        assert_eq!(get_app(&pool, APP_KIND_SKILL, "mk").await.unwrap().enabled, 0);
        // 不存在 → NotFound。
        assert_eq!(
            set_app_owner(&pool, APP_KIND_SKILL, "nope", "x").await.unwrap_err(),
            StoreError::NotFound
        );
        assert_eq!(
            set_app_enabled(&pool, APP_KIND_AGENT, "nope", true).await.unwrap_err(),
            StoreError::NotFound
        );
        // ListApps 过滤。
        let all = list_apps(&pool, APP_KIND_SKILL, "").await.unwrap();
        assert_eq!(all.len(), 1);
        let none = list_apps(&pool, APP_KIND_AGENT, APP_CHANNEL_MARKET).await.unwrap();
        assert!(none.is_empty());
        // 待审配额计数。
        create_release(
            &pool,
            &Release {
                kind: APP_KIND_SKILL.into(),
                app_id: "mk".into(),
                version: "1.0.0".into(),
                publisher: "boss".into(),
                status: RELEASE_STATUS_PENDING.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(pending_release_count(&pool, "boss").await.unwrap(), 1);
        assert_eq!(pending_release_count(&pool, "other").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn release_status_filter() {
        let pool = new_test_db().await;
        upsert_app(
            &pool,
            &App {
                kind: APP_KIND_SKILL.into(),
                app_id: "s1".into(),
                channel: APP_CHANNEL_ORG.into(),
                enabled: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        create_release(
            &pool,
            &Release {
                kind: APP_KIND_SKILL.into(),
                app_id: "s1".into(),
                version: "1.0.0".into(),
                publisher: "p1".into(),
                status: RELEASE_STATUS_PENDING.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        create_release(
            &pool,
            &Release {
                kind: APP_KIND_SKILL.into(),
                app_id: "s1".into(),
                version: "2.0.0".into(),
                publisher: "p1".into(),
                status: RELEASE_STATUS_APPROVED.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let pending = list_releases_by_status(&pool, APP_KIND_SKILL, "pending").await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].version, "1.0.0");
        let all = list_releases_by_status(&pool, APP_KIND_SKILL, "").await.unwrap();
        assert_eq!(all.len(), 2);
        // 软删后不再出现在审核队列。
        soft_delete_release(&pool, APP_KIND_SKILL, "s1", "2.0.0").await.unwrap();
        let all = list_releases_by_status(&pool, APP_KIND_SKILL, "").await.unwrap();
        assert_eq!(all.len(), 1);
        // kind 隔离。
        let agents = list_releases_by_status(&pool, APP_KIND_AGENT, "").await.unwrap();
        assert!(agents.is_empty());
    }
}
