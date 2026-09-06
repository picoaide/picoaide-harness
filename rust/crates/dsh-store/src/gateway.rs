//! 网关域（Go `serverstore/gateway.go` 等价）——LLM 上游与模型配置。
//!
//! 与 Go 语义等价：models JSON 列出入转换、价格 Option 列、default_model
//! settings 的读写守卫。Go 侧的 modelConfigCache（TTL 缓存）在 Rust 侧不做
//! （与 effective.rs 同口径：Rust 无缓存，直接查库，行为等价）。

use crate::errors::{map_db_error, StoreError};
use crate::settings::{get_setting, set_setting};
use sqlx::postgres::{PgPool, PgRow};
use sqlx::Row;

/// GatewayProvider 对应 gateway_providers 表行。
#[derive(Debug, Clone, Default)]
pub struct GatewayProvider {
    pub id: i64,
    pub name: String,
    pub base_url: String,
    pub api_key_enc: String,
    /// 库中以 JSON 数组文本存储，进出转换（Go scanProvider 同语义）。
    pub models: Vec<String>,
    pub enabled: i32,
    pub channel: String,
    /// 上游 API 方言(0043/0044)：openai(默认) | anthropic | both。
    pub protocol: String,
}

/// Model 对应 models 表行（join 上游的展示信息）。
#[derive(Debug, Clone, Default)]
pub struct Model {
    pub id: i64,
    pub name: String,
    pub provider_id: i64,
    pub display_name: String,
    pub default_params: String,
    /// 输入模态(0058)：'text'/'image'；空/非法 = 仅 text。存储为 JSON 数组文本。
    pub input_modalities: Vec<String>,
    /// 元/百万 token(0022)；None/0 = 未定价，费用按 0 计。
    pub input_price_per_1m: Option<f64>,
    pub output_price_per_1m: Option<f64>,
    /// 缓存命中输入价(0029)；None = 未配置（按 input_price_per_1m 计费）。
    pub cache_input_price_per_1m: Option<f64>,
    /// 低谷折扣率(0023)：None/0/1 = 无峰谷价；0<d<1 = 空闲时段费用 × d。
    pub offpeak_discount: Option<f64>,
    pub provider_name: String,
    pub provider_channel: String,
    pub provider_enabled: bool,
}

/// ---- 渠道同步模型排除名单(审计修复 H2) ----
/// 键：settings 中 "gateway.excluded_models.<providerID>"，值：JSON 数组。
const EXCLUDED_MODELS_KEY_PREFIX: &str = "gateway.excluded_models.";

fn excluded_models_key(provider_id: i64) -> String {
    format!("{EXCLUDED_MODELS_KEY_PREFIX}{provider_id}")
}

/// GetExcludedModels 返回某上游被排除同步的模型名（未配置时返回空）。
pub async fn get_excluded_models(pool: &PgPool, provider_id: i64) -> Result<Vec<String>, StoreError> {
    let (v, ok) = get_setting(pool, &excluded_models_key(provider_id)).await?;
    if !ok || v.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<String>>(&v).map_err(|_| StoreError::Validation)
}

/// AddExcludedModel 把模型名加入排除名单（幂等）。
pub async fn add_excluded_model(pool: &PgPool, provider_id: i64, name: &str) -> Result<(), StoreError> {
    let mut names = get_excluded_models(pool, provider_id).await?;
    if names.iter().any(|n| n == name) {
        return Ok(());
    }
    names.push(name.to_string());
    let b = serde_json::to_string(&names).unwrap_or_else(|_| "[]".to_string());
    set_setting(pool, &excluded_models_key(provider_id), &b).await
}

/// RemoveExcludedModel 从排除名单移除模型名（幂等；名单清空后删除 setting）。
pub async fn remove_excluded_model(pool: &PgPool, provider_id: i64, name: &str) -> Result<(), StoreError> {
    let names = get_excluded_models(pool, provider_id).await?;
    let out: Vec<String> = names.into_iter().filter(|n| n != name).collect();
    if out.is_empty() {
        sqlx::query("DELETE FROM settings WHERE key = $1")
            .bind(excluded_models_key(provider_id))
            .execute(pool)
            .await
            .map_err(map_db_error)?;
        return Ok(());
    }
    let b = serde_json::to_string(&out).unwrap_or_else(|_| "[]".to_string());
    set_setting(pool, &excluded_models_key(provider_id), &b).await
}

/// scan_provider 扫描 gateway_providers 一行（models JSON 解析失败回落空表）。
fn scan_provider(row: PgRow) -> Result<GatewayProvider, StoreError> {
    let id: i64 = row.get("id");
    let name: String = row.get("name");
    let base_url: String = row.get("base_url");
    let api_key_enc: String = row.get("api_key_enc");
    let models: String = row.get("models");
    let enabled: i32 = row.get("enabled");
    let channel: String = row.get("channel");
    let protocol: String = row.get("protocol");
    Ok(GatewayProvider {
        id,
        name,
        base_url,
        api_key_enc,
        models: serde_json::from_str::<Vec<String>>(&models).unwrap_or_default(),
        enabled,
        channel,
        protocol,
    })
}

/// ListGatewayProviders 返回全部上游（按 id 升序）。
pub async fn list_gateway_providers(pool: &PgPool) -> Result<Vec<GatewayProvider>, StoreError> {
    let rows = sqlx::query(
        "SELECT id, name, base_url, api_key_enc, models, enabled, channel, protocol
        FROM gateway_providers ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .map_err(map_db_error)?;
    rows.into_iter().map(scan_provider).collect()
}

/// GetGatewayProvider 加载单个上游或 ErrNotFound。
pub async fn get_gateway_provider(pool: &PgPool, id: i64) -> Result<GatewayProvider, StoreError> {
    let row = sqlx::query(
        "SELECT id, name, base_url, api_key_enc, models, enabled, channel, protocol
        FROM gateway_providers WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(map_db_error)?
    .ok_or(StoreError::NotFound)?;
    scan_provider(row)
}

/// AddGatewayProvider 插入上游；重名返回 ErrDuplicate。空 protocol 归一为 "openai"。
pub async fn add_gateway_provider(pool: &PgPool, p: &GatewayProvider) -> Result<i64, StoreError> {
    let protocol = if p.protocol.is_empty() { "openai" } else { p.protocol.as_str() };
    let models_json = serde_json::to_string(&p.models).unwrap_or_else(|_| "[]".to_string());
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO gateway_providers (name, base_url, api_key_enc, models, enabled, channel, protocol)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(&p.name)
    .bind(&p.base_url)
    .bind(&p.api_key_enc)
    .bind(models_json)
    .bind(p.enabled)
    .bind(&p.channel)
    .bind(protocol)
    .fetch_one(pool)
    .await
    .map_err(map_db_error)?;
    Ok(id)
}

/// UpdateGatewayProvider 更新全部字段；重名 ErrDuplicate，缺失行 ErrNotFound。
pub async fn update_gateway_provider(pool: &PgPool, p: &GatewayProvider) -> Result<(), StoreError> {
    let protocol = if p.protocol.is_empty() { "openai" } else { p.protocol.as_str() };
    let models_json = serde_json::to_string(&p.models).unwrap_or_else(|_| "[]".to_string());
    let res = sqlx::query(
        "UPDATE gateway_providers SET name=$1, base_url=$2, api_key_enc=$3, models=$4, enabled=$5, channel=$6, protocol=$7
        WHERE id=$8",
    )
    .bind(&p.name)
    .bind(&p.base_url)
    .bind(&p.api_key_enc)
    .bind(models_json)
    .bind(p.enabled)
    .bind(&p.channel)
    .bind(protocol)
    .bind(p.id)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// DeleteGatewayProvider 事务内删除上游及其 models；若默认模型属于该上游，
/// 同步重置 gateway.default_model；并清理渠道同步排除名单。
pub async fn delete_gateway_provider(pool: &PgPool, id: i64) -> Result<(), StoreError> {
    let mut tx = pool.begin().await.map_err(map_db_error)?;
    let names: Vec<String> = sqlx::query_scalar("SELECT name FROM models WHERE provider_id = $1")
        .bind(id as i32)
        .fetch_all(&mut *tx)
        .await
        .map_err(map_db_error)?;
    sqlx::query("DELETE FROM models WHERE provider_id = $1")
        .bind(id as i32)
        .execute(&mut *tx)
        .await
        .map_err(map_db_error)?;
    let res = sqlx::query("DELETE FROM gateway_providers WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    // 清理该上游的渠道同步排除名单(审计修复 H2)
    sqlx::query("DELETE FROM settings WHERE key = $1")
        .bind(excluded_models_key(id))
        .execute(&mut *tx)
        .await
        .map_err(map_db_error)?;
    for name in &names {
        clear_default_model_if(&mut *tx, name).await?;
    }
    tx.commit().await.map_err(map_db_error)?;
    Ok(())
}

/// SyncProviderModels 用上游 models JSON 列表整体替换 models 表行。
/// 空名/重名按首次出现去重（UNIQUE(provider_id, name) 约束）。
pub async fn sync_provider_models(pool: &PgPool, provider_id: i64, names: &[String]) -> Result<(), StoreError> {
    let mut seen = std::collections::HashSet::new();
    let mut deduped: Vec<&str> = Vec::new();
    for name in names {
        if name.is_empty() || !seen.insert(name.as_str()) {
            continue;
        }
        deduped.push(name.as_str());
    }
    let mut tx = pool.begin().await.map_err(map_db_error)?;
    sqlx::query("DELETE FROM models WHERE provider_id = $1")
        .bind(provider_id as i32)
        .execute(&mut *tx)
        .await
        .map_err(map_db_error)?;
    for name in deduped {
        sqlx::query("INSERT INTO models (name, provider_id, display_name) VALUES ($1, $2, $3)")
            .bind(name)
            .bind(provider_id as i32)
            .bind(name)
            .execute(&mut *tx)
            .await
            .map_err(map_db_error)?;
    }
    tx.commit().await.map_err(map_db_error)?;
    Ok(())
}

/// SyncProviderModel upsert 一个模型的 display_name 与 default_params（幂等），
/// 不覆盖已有行的 input_modalities 等管理员配置。
pub async fn sync_provider_model(
    pool: &PgPool,
    provider_id: i64,
    name: &str,
    default_params: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO models (name, provider_id, display_name, default_params)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(provider_id, name) DO UPDATE SET display_name=excluded.display_name, default_params=excluded.default_params",
    )
    .bind(name)
    .bind(provider_id as i32)
    .bind(name)
    .bind(default_params)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    Ok(())
}

/// RemoveMissingProviderModels 事务内删除 provider 下不在 keep 列表中的模型；
/// 若被删的是 gateway.default_model，重置为空串。返回删除数量。
pub async fn remove_missing_provider_models(
    pool: &PgPool,
    provider_id: i64,
    keep: &[String],
) -> Result<i64, StoreError> {
    let mut tx = pool.begin().await.map_err(map_db_error)?;
    let keep_set: std::collections::HashSet<&str> = keep.iter().map(|s| s.as_str()).collect();
    let rows = sqlx::query("SELECT id, name FROM models WHERE provider_id = $1")
        .bind(provider_id as i32)
        .fetch_all(&mut *tx)
        .await
        .map_err(map_db_error)?;
    let mut doomed: Vec<(i64, String)> = Vec::new();
    for r in rows {
        let id: i64 = r.get("id");
        let name: String = r.get("name");
        if !keep_set.contains(name.as_str()) {
            doomed.push((id, name));
        }
    }
    let mut deleted_default = false;
    for (id, name) in &doomed {
        sqlx::query("DELETE FROM models WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(map_db_error)?;
        let dm: Option<String> =
            sqlx::query_scalar("SELECT value FROM settings WHERE key = 'gateway.default_model'")
                .fetch_optional(&mut *tx)
                .await
                .map_err(map_db_error)?;
        if dm.as_deref() == Some(name.as_str()) {
            deleted_default = true;
        }
    }
    if deleted_default {
        sqlx::query("UPDATE settings SET value = '' WHERE key = 'gateway.default_model'")
            .execute(&mut *tx)
            .await
            .map_err(map_db_error)?;
    }
    tx.commit().await.map_err(map_db_error)?;
    Ok(doomed.len() as i64)
}

/// valid_input_modality 校验单个模态值。
pub fn valid_input_modality(m: &str) -> bool {
    m == "text" || m == "image"
}

/// NormalizeInputModalities 归一化输入模态：非法/空值过滤，去重，空结果回落仅 text。
pub fn normalize_input_modalities(raw: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for m in raw {
        if !valid_input_modality(m) || !seen.insert(m.as_str()) {
            continue;
        }
        out.push(m.clone());
    }
    if out.is_empty() {
        return vec!["text".to_string()];
    }
    out
}

/// ParseInputModalities 解析 models.input_modalities 列（JSON 文本数组；
/// 空/非法 = 仅 text）。
pub fn parse_input_modalities(raw: &str) -> Vec<String> {
    if raw.is_empty() {
        return vec!["text".to_string()];
    }
    match serde_json::from_str::<Vec<String>>(raw) {
        Ok(out) => normalize_input_modalities(&out),
        Err(_) => vec!["text".to_string()],
    }
}

/// model_cols 模型查询公共列（scan_model 与 SQL 保持同步）。
const MODEL_COLS: &str = "m.id, m.name, m.provider_id, COALESCE(m.display_name, m.name) AS display_name,
    COALESCE(m.default_params, '{}') AS default_params, COALESCE(m.input_modalities, '[\"text\"]') AS input_modalities,
    m.input_price_per_1m, m.output_price_per_1m, m.cache_input_price_per_1m, m.offpeak_discount,
    p.name AS provider_name, p.channel AS provider_channel, p.enabled AS provider_enabled";

fn scan_model(row: PgRow) -> Result<Model, StoreError> {
    let id: i64 = row.get("id");
    let name: String = row.get("name");
    let provider_id: i32 = row.get("provider_id");
    let display_name: String = row.get("display_name");
    let default_params: String = row.get("default_params");
    let modalities: String = row.get("input_modalities");
    let input_price: Option<f64> = row.get("input_price_per_1m");
    let output_price: Option<f64> = row.get("output_price_per_1m");
    let cache_price: Option<f64> = row.get("cache_input_price_per_1m");
    let offpeak: Option<f64> = row.get("offpeak_discount");
    let provider_name: String = row.get("provider_name");
    let provider_channel: String = row.get("provider_channel");
    let provider_enabled: i32 = row.get("provider_enabled");
    Ok(Model {
        id,
        name,
        provider_id: provider_id as i64,
        display_name,
        default_params,
        input_modalities: parse_input_modalities(&modalities),
        input_price_per_1m: input_price,
        output_price_per_1m: output_price,
        cache_input_price_per_1m: cache_price,
        offpeak_discount: offpeak,
        provider_name,
        provider_channel,
        provider_enabled: provider_enabled != 0,
    })
}

/// GetModel 按 id 加载模型（含上游信息）或 ErrNotFound。
pub async fn get_model(pool: &PgPool, id: i64) -> Result<Model, StoreError> {
    let row = sqlx::query(&format!(
        "SELECT {MODEL_COLS} FROM models m JOIN gateway_providers p ON p.id = m.provider_id WHERE m.id = $1"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(map_db_error)?
    .ok_or(StoreError::NotFound)?;
    scan_model(row)
}

/// ModelDefaultParams 按模型名加载 default_params；缺失 ErrNotFound。
pub async fn model_default_params(pool: &PgPool, name: &str) -> Result<String, StoreError> {
    let params: Option<String> = sqlx::query_scalar("SELECT default_params FROM models WHERE name = $1")
        .bind(name)
        .fetch_optional(pool)
        .await
        .map_err(map_db_error)?;
    params.ok_or(StoreError::NotFound)
}

/// ModelPrices 返回模型名对应的输入/输出单价与低谷折扣（元/百万 token）。
/// 模型缺失或未定价时返回 (0, 0, 0)。
pub async fn model_prices(pool: &PgPool, name: &str) -> (f64, f64, f64) {
    let row: Option<(Option<f64>, Option<f64>, Option<f64>)> = sqlx::query_as(
        "SELECT input_price_per_1m, output_price_per_1m, offpeak_discount FROM models WHERE name = $1",
    )
    .bind(name)
    .fetch_optional(pool)
    .await
    .unwrap_or(None);
    match row {
        Some((i, o, off)) => (i.unwrap_or(0.0), o.unwrap_or(0.0), off.unwrap_or(0.0)),
        None => (0.0, 0.0, 0.0),
    }
}

/// ModelCachePrice 返回缓存命中输入价（元/百万 token，0029）；0 = 未配置。
pub async fn model_cache_price(pool: &PgPool, name: &str) -> f64 {
    let v: Option<Option<f64>> =
        sqlx::query_scalar("SELECT cache_input_price_per_1m FROM models WHERE name = $1")
            .bind(name)
            .fetch_optional(pool)
            .await
            .unwrap_or(None);
    v.flatten().unwrap_or(0.0)
}

/// AddModel 插入模型行；重名 ErrDuplicate。空 default_params 归一 "{}"；
/// 空模态回落 ["text"]。
pub async fn add_model(pool: &PgPool, m: &Model) -> Result<i64, StoreError> {
    let default_params = if m.default_params.is_empty() { "{}" } else { m.default_params.as_str() };
    let modalities = if m.input_modalities.is_empty() {
        vec!["text".to_string()]
    } else {
        m.input_modalities.clone()
    };
    let modalities_json = serde_json::to_string(&modalities).unwrap_or_else(|_| "[\"text\"]".to_string());
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO models (name, provider_id, display_name, default_params, input_modalities, input_price_per_1m, output_price_per_1m, cache_input_price_per_1m, offpeak_discount)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
    )
    .bind(&m.name)
    .bind(m.provider_id as i32)
    .bind(&m.display_name)
    .bind(default_params)
    .bind(modalities_json)
    .bind(m.input_price_per_1m)
    .bind(m.output_price_per_1m)
    .bind(m.cache_input_price_per_1m)
    .bind(m.offpeak_discount)
    .fetch_one(pool)
    .await
    .map_err(map_db_error)?;
    Ok(id)
}

/// UpdateModel 更新模型行（模态归一化写入）；重名 ErrDuplicate，缺失 ErrNotFound。
pub async fn update_model(pool: &PgPool, m: &Model) -> Result<(), StoreError> {
    let modalities_json = serde_json::to_string(&normalize_input_modalities(&m.input_modalities))
        .unwrap_or_else(|_| "[\"text\"]".to_string());
    let res = sqlx::query(
        "UPDATE models SET name=$1, provider_id=$2, display_name=$3, default_params=$4, input_modalities=$5, input_price_per_1m=$6, output_price_per_1m=$7, cache_input_price_per_1m=$8, offpeak_discount=$9
        WHERE id=$10",
    )
    .bind(&m.name)
    .bind(m.provider_id as i32)
    .bind(&m.display_name)
    .bind(&m.default_params)
    .bind(modalities_json)
    .bind(m.input_price_per_1m)
    .bind(m.output_price_per_1m)
    .bind(m.cache_input_price_per_1m)
    .bind(m.offpeak_discount)
    .bind(m.id)
    .execute(pool)
    .await
    .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// ModelHasUsage 报告模型名是否有用量记录（改名防护，审计修复 M7）。
pub async fn model_has_usage(pool: &PgPool, name: &str) -> Result<bool, StoreError> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM usage WHERE model = $1")
        .bind(name)
        .fetch_one(pool)
        .await
        .map_err(map_db_error)?;
    Ok(n > 0)
}

/// DeleteModel 事务内删除模型；若被删模型是 gateway.default_model，重置为空串。
pub async fn delete_model(pool: &PgPool, id: i64) -> Result<(), StoreError> {
    let mut tx = pool.begin().await.map_err(map_db_error)?;
    let name: Option<String> = sqlx::query_scalar("SELECT name FROM models WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(map_db_error)?;
    let name = name.ok_or(StoreError::NotFound)?;
    let res = sqlx::query("DELETE FROM models WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(map_db_error)?;
    if res.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    clear_default_model_if(&mut *tx, &name).await?;
    tx.commit().await.map_err(map_db_error)?;
    Ok(())
}

/// clear_default_model_if 把指向指定模型名的 gateway.default_model 置空（事务内）。
async fn clear_default_model_if(tx: &mut sqlx::PgConnection, name: &str) -> Result<(), StoreError> {
    let dm: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'gateway.default_model'")
            .fetch_optional(&mut *tx)
            .await
            .map_err(map_db_error)?;
    if dm.as_deref() == Some(name) {
        sqlx::query("UPDATE settings SET value = '' WHERE key = 'gateway.default_model'")
            .execute(&mut *tx)
            .await
            .map_err(map_db_error)?;
    }
    Ok(())
}

/// ListAdminModels 返回全部模型（含已停用上游的，审计修复 M3）与价格/折扣字段。
pub async fn list_admin_models(pool: &PgPool) -> Result<Vec<Model>, StoreError> {
    let rows = sqlx::query(&format!(
        "SELECT {MODEL_COLS} FROM models m JOIN gateway_providers p ON p.id = m.provider_id ORDER BY m.id"
    ))
    .fetch_all(pool)
    .await
    .map_err(map_db_error)?;
    rows.into_iter().map(scan_model).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;

    #[test]
    fn parse_normalize_input_modalities_cases() {
        for (raw, want) in [
            (r#"["text"]"#, vec!["text"]),
            (r#"["text","image"]"#, vec!["text", "image"]),
            (r#"["image","text"]"#, vec!["image", "text"]),
            ("", vec!["text"]),
            ("not-json", vec!["text"]),
            (r#"["audio"]"#, vec!["text"]),
            (r#"["text","text"]"#, vec!["text"]),
            ("[]", vec!["text"]),
        ] {
            assert_eq!(parse_input_modalities(raw), want, "parse({raw:?})");
        }
        assert_eq!(normalize_input_modalities(&[]), vec!["text"]);
        assert!(!valid_input_modality("audio"));
    }

    #[tokio::test]
    async fn gateway_provider_crud() {
        let pool = new_test_db().await;
        let id = add_gateway_provider(
            &pool,
            &GatewayProvider {
                name: "deepseek-provider".into(),
                base_url: "https://api.deepseek.com".into(),
                api_key_enc: "enc-key".into(),
                models: vec!["deepseek-chat".into()],
                enabled: 1,
                channel: "deepseek".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(id > 0);
        // protocol 默认 openai；models JSON 往返一致
        let p = get_gateway_provider(&pool, id).await.unwrap();
        assert_eq!(p.channel, "deepseek");
        assert_eq!(p.protocol, "openai");
        assert_eq!(p.models, vec!["deepseek-chat"]);
        // 重名添加 → Duplicate
        let err = add_gateway_provider(
            &pool,
            &GatewayProvider {
                name: "deepseek-provider".into(),
                base_url: "http://b".into(),
                api_key_enc: "k".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err, StoreError::Duplicate);
        // 改名撞 UNIQUE → Duplicate；空 protocol 归一为 openai
        let id2 = add_gateway_provider(
            &pool,
            &GatewayProvider {
                name: "p2".into(),
                base_url: "http://b".into(),
                api_key_enc: "k".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut p2 = get_gateway_provider(&pool, id2).await.unwrap();
        p2.protocol.clear();
        update_gateway_provider(&pool, &p2).await.unwrap();
        assert_eq!(get_gateway_provider(&pool, id2).await.unwrap().protocol, "openai");
        p2.name = "deepseek-provider".into();
        assert_eq!(update_gateway_provider(&pool, &p2).await.unwrap_err(), StoreError::Duplicate);
        // list + not found
        assert_eq!(list_gateway_providers(&pool).await.unwrap().len(), 2);
        assert_eq!(get_gateway_provider(&pool, 999999).await.unwrap_err(), StoreError::NotFound);
    }

    #[tokio::test]
    async fn delete_provider_clears_default_model_and_excluded() {
        let pool = new_test_db().await;
        let pid = add_gateway_provider(
            &pool,
            &GatewayProvider {
                name: "p".into(),
                base_url: "http://a".into(),
                api_key_enc: "k".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sync_provider_model(&pool, pid, "def", "{}").await.unwrap();
        set_setting(&pool, "gateway.default_model", "def").await.unwrap();
        add_excluded_model(&pool, pid, "excluded-x").await.unwrap();
        delete_gateway_provider(&pool, pid).await.unwrap();
        let (v, ok) = get_setting(&pool, "gateway.default_model").await.unwrap();
        assert!(ok);
        assert_eq!(v, "");
        let (_, ok) = get_setting(&pool, &excluded_models_key(pid)).await.unwrap();
        assert!(!ok);
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM models WHERE provider_id = $1")
            .bind(pid as i32)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0);
        assert_eq!(delete_gateway_provider(&pool, pid).await.unwrap_err(), StoreError::NotFound);
    }

    #[tokio::test]
    async fn model_default_params_roundtrip() {
        let pool = new_test_db().await;
        let pid = add_gateway_provider(
            &pool,
            &GatewayProvider {
                name: "p".into(),
                base_url: "http://a".into(),
                api_key_enc: "k".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sync_provider_model(&pool, pid, "m1", r#"{"context_length":1048576,"max_output":393216}"#).await.unwrap();
        let params = model_default_params(&pool, "m1").await.unwrap();
        assert_eq!(params, r#"{"context_length":1048576,"max_output":393216}"#);
        assert_eq!(model_default_params(&pool, "nope").await.unwrap_err(), StoreError::NotFound);
    }

    #[tokio::test]
    async fn model_input_modalities_roundtrip() {
        let pool = new_test_db().await;
        let pid = add_gateway_provider(
            &pool,
            &GatewayProvider {
                name: "p".into(),
                base_url: "http://a".into(),
                api_key_enc: "k".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // AddModel 缺省仅 text；显式 [text,image] 往返一致
        let mid = add_model(
            &pool,
            &Model {
                name: "vision".into(),
                provider_id: pid,
                display_name: "视觉".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(get_model(&pool, mid).await.unwrap().input_modalities, vec!["text"]);
        let mid2 = add_model(
            &pool,
            &Model {
                name: "v2".into(),
                provider_id: pid,
                input_modalities: vec!["text".into(), "image".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(get_model(&pool, mid2).await.unwrap().input_modalities, vec!["text", "image"]);
        // UpdateModel 归一化写入
        let mut m2 = get_model(&pool, mid2).await.unwrap();
        m2.input_modalities = vec!["text".into(), "image".into(), "text".into()];
        update_model(&pool, &m2).await.unwrap();
        assert_eq!(get_model(&pool, mid2).await.unwrap().input_modalities, vec!["text", "image"]);
        // SyncProviderModel 重同步不覆盖已有行模态
        sync_provider_model(&pool, pid, "v2", r#"{"max_output":1}"#).await.unwrap();
        assert_eq!(get_model(&pool, mid2).await.unwrap().input_modalities, vec!["text", "image"]);
    }

    #[tokio::test]
    async fn sync_provider_models_dedupes_names() {
        let pool = new_test_db().await;
        let pid = add_gateway_provider(
            &pool,
            &GatewayProvider {
                name: "p".into(),
                base_url: "http://a".into(),
                api_key_enc: "k".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // 重名/空名列表不得触发 UNIQUE 冲突
        sync_provider_models(
            &pool,
            pid,
            &["m".into(), "m".into(), "x".into(), String::new()],
        )
        .await
        .unwrap();
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM models WHERE provider_id = $1")
            .bind(pid as i32)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 2);
    }

    #[tokio::test]
    async fn sync_and_remove_missing_clears_default() {
        let pool = new_test_db().await;
        let p1 = add_gateway_provider(
            &pool,
            &GatewayProvider {
                name: "a".into(),
                base_url: "http://a".into(),
                api_key_enc: "enc".into(),
                enabled: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let p2 = add_gateway_provider(
            &pool,
            &GatewayProvider {
                name: "b".into(),
                base_url: "http://b".into(),
                api_key_enc: "enc".into(),
                enabled: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // 两个 provider 提供同名模型（跨 provider 允许）
        sync_provider_model(&pool, p1, "gpt-4o", r#"{"context_length":1048576}"#).await.unwrap();
        sync_provider_model(&pool, p2, "gpt-4o", r#"{"max_output":393216}"#).await.unwrap();
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM models WHERE name = 'gpt-4o'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 2);
        // 每个 provider 都能删除自己的
        assert_eq!(remove_missing_provider_models(&pool, p1, &["gpt-4o".to_string()]).await.unwrap(), 0);
        assert_eq!(remove_missing_provider_models(&pool, p1, &[]).await.unwrap(), 1);
        let remains: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM models WHERE name = 'gpt-4o' AND provider_id = $1",
        )
        .bind(p2 as i32)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(remains, 1);
        // default_model 被删时重置为空
        set_setting(&pool, "gateway.default_model", "gpt-4o").await.unwrap();
        assert_eq!(remove_missing_provider_models(&pool, p2, &[]).await.unwrap(), 1);
        let (v, ok) = get_setting(&pool, "gateway.default_model").await.unwrap();
        assert!(ok);
        assert_eq!(v, "");
    }

    #[tokio::test]
    async fn excluded_models_crud() {
        let pool = new_test_db().await;
        let pid = add_gateway_provider(
            &pool,
            &GatewayProvider {
                name: "p".into(),
                base_url: "http://a".into(),
                api_key_enc: "k".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        add_excluded_model(&pool, pid, "deepseek-chat").await.unwrap();
        // 幂等：重复添加不报错、不重复
        add_excluded_model(&pool, pid, "deepseek-chat").await.unwrap();
        assert_eq!(get_excluded_models(&pool, pid).await.unwrap(), vec!["deepseek-chat"]);
        // 移除后名单清空（删除 setting）
        remove_excluded_model(&pool, pid, "deepseek-chat").await.unwrap();
        assert!(get_excluded_models(&pool, pid).await.unwrap().is_empty());
        let (_, ok) = get_setting(&pool, &excluded_models_key(pid)).await.unwrap();
        assert!(!ok);
        // 删除上游清理排除名单
        add_excluded_model(&pool, pid, "m1").await.unwrap();
        delete_gateway_provider(&pool, pid).await.unwrap();
        let (_, ok) = get_setting(&pool, &excluded_models_key(pid)).await.unwrap();
        assert!(!ok);
    }

    #[tokio::test]
    async fn model_has_usage_after_record() {
        let pool = new_test_db().await;
        let pid = add_gateway_provider(
            &pool,
            &GatewayProvider {
                name: "p".into(),
                base_url: "http://a".into(),
                api_key_enc: "k".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sync_provider_model(&pool, pid, "used", "{}").await.unwrap();
        assert!(!model_has_usage(&pool, "used").await.unwrap());
        let uid = crate::users::create_user(
            &pool,
            &crate::users::User {
                username: "u".into(),
                source: "local".into(),
                status: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // usage 分区表：写入迁移自带的 2026-08 分区
        sqlx::query(
            "INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, created_at) VALUES ($1, $2, 10, 10, '2026-08-15T00:00:00Z')",
        )
        .bind(uid as i32)
        .bind("used")
        .execute(&pool)
        .await
        .unwrap();
        assert!(model_has_usage(&pool, "used").await.unwrap());
    }

    #[tokio::test]
    async fn update_model_duplicate_and_delete_clears_default() {
        let pool = new_test_db().await;
        let pid = add_gateway_provider(
            &pool,
            &GatewayProvider {
                name: "p".into(),
                base_url: "http://a".into(),
                api_key_enc: "k".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sync_provider_model(&pool, pid, "m1", "{}").await.unwrap();
        sync_provider_model(&pool, pid, "m2", "{}").await.unwrap();
        // 改名撞 UNIQUE → Duplicate（审计修复 M2）
        let mid: i64 = sqlx::query_scalar("SELECT id FROM models WHERE name = 'm2'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let mut m = get_model(&pool, mid).await.unwrap();
        m.name = "m1".into();
        assert_eq!(update_model(&pool, &m).await.unwrap_err(), StoreError::Duplicate);
        // 同名模型在另一 provider 允许
        let pid2 = add_gateway_provider(
            &pool,
            &GatewayProvider {
                name: "q".into(),
                base_url: "http://q".into(),
                api_key_enc: "k".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sync_provider_model(&pool, pid2, "m1", "{}").await.unwrap();
        // 删除 default 模型后 default_model 清空
        set_setting(&pool, "gateway.default_model", "m1").await.unwrap();
        let def_id: i64 =
            sqlx::query_scalar("SELECT id FROM models WHERE name = 'm1' AND provider_id = $1")
                .bind(pid as i32)
                .fetch_one(&pool)
                .await
                .unwrap();
        delete_model(&pool, def_id).await.unwrap();
        let (v, ok) = get_setting(&pool, "gateway.default_model").await.unwrap();
        assert!(ok);
        assert_eq!(v, "");
        assert_eq!(get_model(&pool, def_id).await.unwrap_err(), StoreError::NotFound);
    }

    #[tokio::test]
    async fn model_prices_and_list_admin_includes_disabled() {
        let pool = new_test_db().await;
        let pid = add_gateway_provider(
            &pool,
            &GatewayProvider {
                name: "p".into(),
                base_url: "http://a".into(),
                api_key_enc: "k".into(),
                enabled: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mid = add_model(
            &pool,
            &Model {
                name: "m1".into(),
                provider_id: pid,
                display_name: "M1".into(),
                default_params: r#"{"max_output":1}"#.into(),
                input_price_per_1m: Some(1.5),
                output_price_per_1m: Some(3.0),
                cache_input_price_per_1m: Some(0.75),
                offpeak_discount: Some(0.5),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let m = get_model(&pool, mid).await.unwrap();
        assert_eq!(m.name, "m1");
        assert_eq!(m.provider_id, pid);
        assert_eq!(m.display_name, "M1");
        assert_eq!(m.input_price_per_1m, Some(1.5));
        assert_eq!(m.output_price_per_1m, Some(3.0));
        assert_eq!(m.cache_input_price_per_1m, Some(0.75));
        assert_eq!(m.offpeak_discount, Some(0.5));
        assert!(m.provider_enabled);
        assert_eq!(m.provider_name, "p");
        // 价格热路径读取
        assert_eq!(model_prices(&pool, "m1").await, (1.5, 3.0, 0.5));
        assert_eq!(model_cache_price(&pool, "m1").await, 0.75);
        // 未定价/缺失 → 0
        sync_provider_model(&pool, pid, "free", "{}").await.unwrap();
        assert_eq!(model_prices(&pool, "free").await, (0.0, 0.0, 0.0));
        assert_eq!(model_cache_price(&pool, "free").await, 0.0);
        assert_eq!(model_cache_price(&pool, "nope").await, 0.0);
        // 停用上游后 ListAdminModels 仍展示（审计修复 M3）
        let mut p = get_gateway_provider(&pool, pid).await.unwrap();
        p.enabled = 0;
        update_gateway_provider(&pool, &p).await.unwrap();
        let all = list_admin_models(&pool).await.unwrap();
        assert_eq!(all.len(), 2);
        let m1 = all.iter().find(|m| m.name == "m1").unwrap();
        assert_eq!(m1.provider_name, "p");
        assert!(!m1.provider_enabled);
    }
}
