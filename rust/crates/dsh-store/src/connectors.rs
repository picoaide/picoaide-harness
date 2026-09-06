//! 连接器目录域（Go `serverstore/connectors.go` 等价）。
//!
//! connectors 表是唯一目录源（迁移 0042）：webadmin 图形化管理，客户端经
//! GET /api/config/bootstrap 下发（connectors[]）。

use crate::errors::{map_db_error, StoreError};
use chrono::{DateTime, Utc};
use sqlx::postgres::PgPool;
use sqlx::Row;

/// Connector 是服务端连接器目录的一行（定义 JSON 与客户端 ConnectorDef 对齐）。
#[derive(Debug, Clone, Default)]
pub struct Connector {
    pub id: String,
    pub name: String,
    pub description: String,
    pub auth_mode: String,
    pub definition: String,
    pub enabled: bool,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

/// connectorAuthModes 是合法的认证模式（与客户端 ConnectorAuthMode 对齐）。
const CONNECTOR_AUTH_MODES: [&str; 4] = ["oauth", "device", "token", "server-side"];

/// valid_connector_id 限小写字母数字连字符（Go connectorIDRe 的 `^[a-z0-9][a-z0-9-]{0,63}$` 等价）。
fn valid_connector_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 64 {
        return false;
    }
    let mut chars = id.chars();
    let first = chars.next().expect("non-empty");
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// validate_connector 校验连接器参数：id/名称/模式/定义 JSON，
/// 且定义必含 mcp 非空数组、每项必须含 serverName。
pub fn validate_connector(c: &Connector) -> Result<(), StoreError> {
    if !valid_connector_id(&c.id) {
        return Err(StoreError::Validation);
    }
    if c.name.trim().is_empty() {
        return Err(StoreError::Validation);
    }
    if !CONNECTOR_AUTH_MODES.contains(&c.auth_mode.as_str()) {
        return Err(StoreError::Validation);
    }
    if c.definition.trim().is_empty() {
        return Err(StoreError::Validation);
    }
    let probe: serde_json::Value =
        serde_json::from_str(&c.definition).map_err(|_| StoreError::Validation)?;
    // 必填结构：mcp 非空数组；每项必须含 serverName。
    let mcp = match probe.get("mcp").and_then(|v| v.as_array()) {
        Some(mcp) if !mcp.is_empty() => mcp,
        _ => return Err(StoreError::Validation),
    };
    for item in mcp {
        let name = item.get("serverName").and_then(|v| v.as_str()).unwrap_or("");
        if name.trim().is_empty() {
            return Err(StoreError::Validation);
        }
    }
    Ok(())
}

/// connector_cols 规范连接器列清单（与 scan_connector 保持同步）。
const CONNECTOR_COLS: &str = "id, name, description, auth_mode, definition, enabled, updated_at, created_at";

fn scan_connector(row: sqlx::postgres::PgRow) -> Connector {
    Connector {
        id: row.get("id"),
        name: row.get("name"),
        description: row.get("description"),
        auth_mode: row.get("auth_mode"),
        definition: row.get("definition"),
        enabled: row.get::<i32, _>("enabled") != 0,
        updated_at: row.get("updated_at"),
        created_at: row.get("created_at"),
    }
}

/// list_connectors 返回全部连接器（管理端，按 id 排序；definition 大字段一并返回）。
pub async fn list_connectors(pool: &PgPool) -> Result<Vec<Connector>, StoreError> {
    let rows = sqlx::query(&format!("SELECT {CONNECTOR_COLS} FROM connectors ORDER BY id"))
        .fetch_all(pool)
        .await
        .map_err(map_db_error)?;
    Ok(rows.into_iter().map(scan_connector).collect())
}

/// list_enabled_connectors 只返回启用连接器（bootstrap/下发），定义 JSON 直接可用。
pub async fn list_enabled_connectors(pool: &PgPool) -> Result<Vec<Connector>, StoreError> {
    let rows = sqlx::query(&format!(
        "SELECT {CONNECTOR_COLS} FROM connectors WHERE enabled = 1 ORDER BY id"
    ))
    .fetch_all(pool)
    .await
    .map_err(map_db_error)?;
    Ok(rows.into_iter().map(scan_connector).collect())
}

/// get_connector 按 id 返回一行，不存在返回 ErrNotFound。
pub async fn get_connector(pool: &PgPool, id: &str) -> Result<Connector, StoreError> {
    let row = sqlx::query(&format!("SELECT {CONNECTOR_COLS} FROM connectors WHERE id = $1"))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(map_db_error)?;
    row.map(scan_connector).ok_or(StoreError::NotFound)
}

/// create_connector 插入新连接器行（id 冲突 → ErrDuplicate）。
pub async fn create_connector(pool: &PgPool, c: &Connector) -> Result<(), StoreError> {
    validate_connector(c)?;
    // PG 兼容：先查存在性再插入（单用户管理端，无并发竞争）。
    match get_connector(pool, &c.id).await {
        Ok(_) => return Err(StoreError::Duplicate),
        Err(StoreError::NotFound) => {}
        Err(e) => return Err(e),
    }
    sqlx::query(
        "INSERT INTO connectors (id, name, description, auth_mode, definition, enabled)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&c.id)
    .bind(c.name.trim())
    .bind(&c.description)
    .bind(&c.auth_mode)
    .bind(&c.definition)
    .bind(bool_int(c.enabled))
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(())
}

/// update_connector 更新 name/description/auth_mode/definition/enabled。
pub async fn update_connector(pool: &PgPool, c: &Connector) -> Result<(), StoreError> {
    validate_connector(c)?;
    let res = sqlx::query(
        "UPDATE connectors SET name=$1, description=$2, auth_mode=$3, definition=$4, enabled=$5
         WHERE id=$6",
    )
    .bind(c.name.trim())
    .bind(&c.description)
    .bind(&c.auth_mode)
    .bind(&c.definition)
    .bind(bool_int(c.enabled))
    .bind(&c.id)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// set_connector_enabled 切换启用标志（bootstrap 下发开关）。
pub async fn set_connector_enabled(pool: &PgPool, id: &str, enabled: bool) -> Result<(), StoreError> {
    let res = sqlx::query("UPDATE connectors SET enabled = $1 WHERE id = $2")
        .bind(bool_int(enabled))
        .bind(id)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// delete_connector 删除一行（bootstrap 不再下发）。
pub async fn delete_connector(pool: &PgPool, id: &str) -> Result<(), StoreError> {
    let res = sqlx::query("DELETE FROM connectors WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// bool_int 把 bool 映射为 PG INTEGER（与 Go boolInt 等价）。
fn bool_int(b: bool) -> i32 {
    if b {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;

    fn feishu() -> Connector {
        Connector {
            id: "feishu".into(),
            name: "飞书".into(),
            description: "协作与文档".into(),
            auth_mode: "token".into(),
            definition: r#"{"tokenFields":[{"key":"TOKEN","label":"Token","type":"password","required":true}],"mcp":[{"serverName":"feishu","transport":"streamable-http","url":"https://mcp.example.com"}]}"#
                .into(),
            enabled: true,
            ..Default::default()
        }
    }

    // TestConnectorCRUD 等价：迁移后种子存在；创建/更新/启用开关/删除完整生命周期。
    #[tokio::test]
    async fn connector_crud() {
        let pool = new_test_db().await;

        // 种子：迁移 0042 插入 moka + glitchtip（0045 下架为 enabled=0）+ sales-easy。
        let list = list_connectors(&pool).await.unwrap();
        assert!(list.len() >= 3, "seed connectors = {}", list.len());
        let ids: std::collections::HashSet<String> = list.iter().map(|c| c.id.clone()).collect();
        for seed in ["moka", "glitchtip", "sales-easy"] {
            assert!(ids.contains(seed), "seed missing {seed}");
        }

        // 创建新连接器。
        create_connector(&pool, &feishu()).await.unwrap();
        let got = get_connector(&pool, "feishu").await.unwrap();
        assert_eq!(got.name, "飞书");
        assert!(got.enabled);
        assert!(!got.definition.is_empty());

        // 更新。
        let mut updated = got.clone();
        updated.name = "飞书协作".into();
        updated.description = "更新描述".into();
        update_connector(&pool, &updated).await.unwrap();
        let got2 = get_connector(&pool, "feishu").await.unwrap();
        assert_eq!(got2.name, "飞书协作");

        // 启用开关 → 下发列表过滤。
        set_connector_enabled(&pool, "feishu", false).await.unwrap();
        let enabled = list_enabled_connectors(&pool).await.unwrap();
        assert!(
            enabled.iter().all(|c| c.id != "feishu"),
            "disabled connector still in enabled list"
        );

        // 删除。
        delete_connector(&pool, "feishu").await.unwrap();
        assert_eq!(
            get_connector(&pool, "feishu").await.unwrap_err(),
            StoreError::NotFound
        );
    }

    // TestConnectorValidation 等价：非法 id/空名/坏 auth_mode/坏定义 JSON/无 MCP/无 serverName 全拒绝。
    #[tokio::test]
    async fn connector_validation() {
        let pool = new_test_db().await;
        let base = Connector {
            id: "ok".into(),
            name: "OK".into(),
            auth_mode: "token".into(),
            definition: r#"{"mcp":[{"serverName":"x"}]}"#.into(),
            ..Default::default()
        };
        create_connector(&pool, &base).await.unwrap();

        let cases: Vec<(&str, fn(&mut Connector))> = vec![
            ("bad id", |c| c.id = "Bad_ID".into()),
            ("empty name", |c| c.name = "  ".into()),
            ("bad mode", |c| c.auth_mode = "cli".into()),
            ("bad json", |c| c.definition = "{not json".into()),
            ("no mcp", |c| {
                c.definition = r#"{"tokenFields":[{"key":"T","label":"T"}]}"#.into()
            }),
            ("mcp no serverName", |c| {
                c.definition = r#"{"mcp":[{"url":"https://x"}]}"#.into()
            }),
        ];
        for (name, mut_c) in cases {
            let mut c = base.clone();
            c.id = format!("case-{name}");
            mut_c(&mut c);
            assert_eq!(
                create_connector(&pool, &c).await.unwrap_err(),
                StoreError::Validation,
                "{name}"
            );
        }
    }

    // 重复 id → ErrDuplicate；缺失行的 update/开关/删除 → ErrNotFound。
    #[tokio::test]
    async fn connector_duplicate_and_missing() {
        let pool = new_test_db().await;
        create_connector(&pool, &feishu()).await.unwrap();
        assert_eq!(
            create_connector(&pool, &feishu()).await.unwrap_err(),
            StoreError::Duplicate
        );

        let ghost = Connector {
            id: "ghost".into(),
            name: "Ghost".into(),
            auth_mode: "token".into(),
            definition: r#"{"mcp":[{"serverName":"x"}]}"#.into(),
            ..Default::default()
        };
        assert_eq!(
            update_connector(&pool, &ghost).await.unwrap_err(),
            StoreError::NotFound
        );
        assert_eq!(
            set_connector_enabled(&pool, "ghost", true).await.unwrap_err(),
            StoreError::NotFound
        );
        assert_eq!(
            delete_connector(&pool, "ghost").await.unwrap_err(),
            StoreError::NotFound
        );
    }

    // 空/过长/大写/非字母数字首字符的 id 均拒绝。
    #[tokio::test]
    async fn connector_id_pattern() {
        assert!(valid_connector_id("a"));
        assert!(valid_connector_id("a1-b2"));
        assert!(valid_connector_id(&"x".repeat(64)));
        assert!(!valid_connector_id(""));
        assert!(!valid_connector_id(&"x".repeat(65)));
        assert!(!valid_connector_id("Bad_ID"));
        assert!(!valid_connector_id("-abc"));
        // 尾随连字符合法（Go 正则 `^[a-z0-9][a-z0-9-]{0,63}$` 允许）。
        assert!(valid_connector_id("a-"));
        assert!(!valid_connector_id("a_b"));
        // 首字符必须是字母数字。
        assert!(!valid_connector_id("-a"));
    }
}
