//! 管理面端点补全（面向 webadmin 前端实际请求）——users/departments/gateway/models 等。
//! 统一 handler：按 path + method 分发到 store/service。

use axum::extract::State;
use axum::http::{Method, StatusCode};
use axum::{Json, Router};
use sqlx::Row;
use std::sync::Arc;

use crate::error::{error_body, ErrorResponse};
use crate::router::AppState;

fn err(s: u16, c: &str, m: &str) -> (StatusCode, Json<ErrorResponse>) {
    (StatusCode::from_u16(s).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), Json(error_body(c, m)))
}

/// user_json 管理面用户 JSON（Go `userJSON` 等价）。
fn user_json(u: &picoaide_dsh_store::users::User) -> serde_json::Value {
    // Go time.Time{} 零值 JSON 为 "0001-01-01T00:00:00Z"（从未改密）。
    let pwd_changed = u.password_changed_at.timestamp();
    let pwd_changed_str = if pwd_changed == 0 {
        "0001-01-01T00:00:00Z".to_string()
    } else {
        u.password_changed_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    };
    serde_json::json!({
        "id": u.id,
        "username": u.username,
        "display_name": u.display_name,
        "email": u.email,
        "is_admin": u.is_admin,
        "role": u.role,
        "permissions": permissions_of(&u.role),
        "status": u.status,
        "quota_tokens": u.quota_tokens,
        "quota_money": u.quota_money,
        "source": u.source,
        "password_changeable": u.source == "local" && !u.password_hash.is_empty() && u.status == 1,
        "password_must_change": u.password_must_change,
        "password_changed_at": pwd_changed_str,
        "mfa_enabled": u.totp_enabled,
    })
}

/// permissions_of 角色 → 权限集合（Go `PermissionsOf` 等价）。
fn permissions_of(role: &str) -> Vec<&'static str> {
    match role {
        "super_admin" => vec![
            "user:read", "user:write", "role:assign",
            "dept:read", "dept:write",
            "auth:read", "auth:write",
            "gateway:read", "gateway:write",
            "usage:read", "report:write", "quota:write",
            "market:read", "market:write",
            "capability:read", "capability:write",
            "connector:read", "connector:write",
            "audit:read", "audit:retention:write",
            "brand:read", "brand:write",
            "portal:read", "portal:write",
            "server-info:read", "error-monitoring:read",
        ],
        "auditor" => vec!["audit:read", "usage:read", "user:read"],
        _ => vec![],
    }
}

/// human_duration 运行时长中文（Go humanDuration 等价）。
fn human_duration(sec: i64) -> String {
    let day = sec / 86400;
    let h = (sec % 86400) / 3600;
    let m = (sec % 3600) / 60;
    if day > 0 {
        format!("{day}天{h}时{m}分")
    } else if h > 0 {
        format!("{h}时{m}分")
    } else {
        format!("{m}分{}秒", sec % 60)
    }
}

/// read_load_avg 读 /proc/loadavg。
fn read_load_avg() -> (f64, f64, f64) {
    let Ok(s) = std::fs::read_to_string("/proc/loadavg") else {
        return (0.0, 0.0, 0.0);
    };
    let parts: Vec<&str> = s.split_whitespace().collect();
    let f = |i: usize| parts.get(i).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    (f(0), f(1), f(2))
}

/// read_mem_stats 读 /proc/meminfo（返回 allocated_mb, total_system_mb, system_memory_mb）。
fn read_mem_stats() -> (f64, f64, f64) {
    let Ok(s) = std::fs::read_to_string("/proc/meminfo") else {
        return (0.0, 0.0, 0.0);
    };
    let mut total_kb = 0.0f64;
    for line in s.lines() {
        if line.starts_with("MemTotal:") {
            if let Some(v) = line.split_whitespace().nth(1) {
                total_kb = v.parse::<f64>().unwrap_or(0.0);
            }
            break;
        }
    }
    let system_mb = total_kb / 1024.0;
    // Rust 进程堆大小无法精确从 /proc/meminfo 分离; 用进程 RSS(读 /proc/self/statm)。
    let rss_kb = std::fs::read_to_string("/proc/self/statm")
        .ok()
        .and_then(|s| s.split_whitespace().nth(1).map(|v| v.to_string()))
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    let rss_mb = rss_kb * 4.0 / 1024.0; // page size 4096 → KB
    // Go round1 语义: 一位小数(前端展示风格一致)。
    let round1 = |v: f64| (v * 10.0).round() / 10.0;
    (round1(rss_mb), round1(rss_mb), round1(system_mb))
}

/// read_disk 读 path 所在文件系统统计（libc statfs）。
fn read_disk(path: &str) -> (String, f64, f64, f64, f64) {
    let cpath = std::ffi::CString::new(path).unwrap_or_default();
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    let ok = unsafe { libc::statvfs(cpath.as_ptr(), &mut st) } == 0;
    if !ok {
        return (path.to_string(), 0.0, 0.0, 0.0, 0.0);
    }
    let block = st.f_frsize as f64;
    let total = st.f_blocks as f64 * block;
    let free = st.f_bavail as f64 * block;
    let bfree = st.f_bfree as f64 * block;
    let used = total - bfree;
    let pct = if total > 0.0 { (used / total * 100.0 * 10.0).round() / 10.0 } else { 0.0 };
    let gb = |v: f64| (v / 1024.0 / 1024.0 / 1024.0 * 10.0).round() / 10.0;
    (path.to_string(), gb(total), gb(used), gb(free), pct)
}

/// db_stats 数据库统计（行数/磁盘/迁移版本）。
async fn db_stats(pool: &sqlx::PgPool) -> Result<(serde_json::Map<String, serde_json::Value>, i64, i64, String, i64), ()> {
    let tables = [
        "users", "groups", "user_groups", "settings", "api_tokens",
        "gateway_providers", "models", "usage", "apps", "app_releases",
        "app_grants", "audit_logs", "admin_sessions",
    ];
    // Go encoding/json 对 map 按键排序输出; serde_json Map 保留插入序。
    // 用维护的排序 key 构建 Map(先收集到 Vec 再排序),保证与 Go 同序。
    let mut counts: Vec<(&str, i64)> = Vec::new();
    let mut total = 0i64;
    for t in tables {
        let cnt: Result<i64, _> = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {t}")).fetch_one(pool).await;
        match cnt {
            Ok(c) => {
                counts.push((t, c));
                total += c;
            }
            Err(_) => {}
        }
    }
    counts.sort_by(|a, b| a.0.cmp(b.0));
    let mut map = serde_json::Map::new();
    for (t, c) in counts {
        map.insert(t.to_string(), serde_json::json!(c));
    }
    let disk_bytes: Result<i64, _> = sqlx::query_scalar("SELECT pg_database_size(current_database())")
        .fetch_one(pool)
        .await;
    let disk_bytes = disk_bytes.unwrap_or(0);
    let mig: Result<i32, _> = sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM schema_migrations")
        .fetch_one(pool)
        .await;
    let mig = mig.unwrap_or(0) as i64;
    Ok((map, total, disk_bytes, human_bytes(disk_bytes), mig))
}

/// regroup_by_provider 把 group=model 的聚合行按渠道归并（Go RegroupByProvider 等价）。
async fn regroup_by_provider(
    pool: &sqlx::PgPool,
    rows: Vec<picoaide_dsh_store::aggregate::UsageAggregateRow>,
) -> Result<Vec<picoaide_dsh_store::aggregate::UsageAggregateRow>, ()> {
    // 模型名 → 渠道名（models 表 join gateway_providers）。
    let mut map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mrows = sqlx::query(
        "SELECT m.name, COALESCE(p.name, '') AS provider FROM models m LEFT JOIN gateway_providers p ON p.id = m.provider_id ORDER BY m.id",
    )
    .fetch_all(pool)
    .await
    .map_err(|_| ())?;
    for r in mrows {
        let name: String = r.get("name");
        let provider: String = r.get("provider");
        map.entry(name).or_insert(provider);
    }
    type Row = picoaide_dsh_store::aggregate::UsageAggregateRow;
    let mut agg: std::collections::HashMap<String, Row> = std::collections::HashMap::new();
    for r in rows {
        let p = map.get(&r.label).cloned().filter(|s| !s.is_empty()).unwrap_or_else(|| "(未配置渠道)".into());
        match agg.get_mut(&p) {
            Some(cur) => {
                cur.prompt_tokens += r.prompt_tokens;
                cur.completion_tokens += r.completion_tokens;
                cur.requests += r.requests;
                cur.embed_requests += r.embed_requests;
                cur.embed_tokens += r.embed_tokens;
                cur.cache_tokens += r.cache_tokens;
                cur.cost += r.cost;
            }
            None => {
                let mut cp = r;
                cp.label = p.clone();
                agg.insert(p, cp);
            }
        }
    }
    let mut out: Vec<Row> = agg.into_values().collect();
    out.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}
fn human_bytes(n: i64) -> String {
    if n >= 1024 * 1024 * 1024 {
        format!("{:.1}GB", (n as f64) / 1024.0 / 1024.0 / 1024.0)
    } else if n >= 1024 * 1024 {
        format!("{:.1}MB", (n as f64) / 1024.0 / 1024.0)
    } else if n >= 1024 {
        format!("{:.1}KB", (n as f64) / 1024.0)
    } else {
        format!("{n}B")
    }
}

/// master_key 读取主密钥（env PICOAI_MASTER_KEY 或 data_dir/master.key）。
fn master_key() -> Result<Vec<u8>, String> {
    // 兼容两种形态: env 字符串(明文 ASCII)或 master.key 原始二进制(32字节)。
    if let Ok(k) = std::env::var("PICOAI_MASTER_KEY") {
        if k.len() == 16 || k.len() == 24 || k.len() == 32 {
            return Ok(k.into_bytes());
        }
    }
    let data_dir = std::env::var("DSH_DATA").unwrap_or_else(|_| "/data/picoaide-next-pg".into());
    let p = std::path::Path::new(&data_dir).join("master.key");
    let b = std::fs::read(&p).map_err(|e| format!("master.key 读取失败: {e}"))?;
    // Go 语义: 文件内容即字节 key(可能是二进制, 不要求 UTF-8)。
    if b.len() == 16 || b.len() == 24 || b.len() == 32 {
        Ok(b)
    } else {
        // 兜底: 文本形态(trim 后)。
        let s = String::from_utf8_lossy(&b).trim().to_string();
        if s.len() == 16 || s.len() == 24 || s.len() == 32 {
            Ok(s.into_bytes())
        } else {
            Err(format!("master key 长度非法: {}", b.len()))
        }
    }
}

/// decrypt_master_key 解密 "enc:v1:<base64(nonce||ciphertext)>"（Go util.Decrypt 等价）。
fn decrypt_master_key(enc: &str) -> Result<String, String> {
    use aes_gcm::aead::Aead;
    use aes_gcm::aead::KeyInit;
    const PREFIX: &str = "enc:v1:";
    if !enc.starts_with(PREFIX) {
        return Err("非加密值".into());
    }
    let raw = base64::decode(&enc[PREFIX.len()..]).map_err(|e| format!("base64: {e}"))?;
    let key = master_key()?;
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&key).map_err(|e| format!("gcm: {e}"))?;
    let nonce = &raw[..12];
    let ct = &raw[12..];
    let pt = cipher.decrypt(nonce.into(), ct).map_err(|e| format!("decrypt: {e}"))?;
    String::from_utf8(pt).map_err(|e| format!("utf8: {e}"))
}

/// fetch_deepseek_balance 调 DeepSeek /user/balance。
async fn fetch_deepseek_balance(
    base_url: &str,
    api_key: &str,
) -> Result<(bool, Vec<serde_json::Value>), String> {
    let base = base_url.trim_end_matches('/');
    let url = format!("{base}/user/balance");
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("上游请求失败: {e}"))?;
    if resp.status() != reqwest::StatusCode::OK {
        return Err(format!("upstream status {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("解析失败: {e}"))?;
    let available = body.get("is_available").and_then(|v| v.as_bool()).unwrap_or(false);
    let infos = body
        .get("balance_infos")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok((available, infos))
}

/// dispatch_admin 管理面统一分发（Go /api/server/admin/* 等价）。
pub async fn dispatch_admin(
    State(state): State<Arc<AppState>>,
    method: Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let path = uri.path();
    let qs = uri.query().unwrap_or("");
    let pool = state.pool.clone();
    let payload: serde_json::Value = if body.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_slice(&body).unwrap_or_else(|_| serde_json::json!({}))
    };
    let params: std::collections::HashMap<String, String> = qs
        .split('&')
        .filter(|s| !s.is_empty())
        .filter_map(|kv| {
            let mut p = kv.splitn(2, '=');
            let k = p.next()?;
            let v = p.next().unwrap_or("");
            Some((k.to_string(), v.to_string()))
        })
        .collect();

    // ---- me (当前会话管理员) ----
    if path == "/api/server/admin/me" {
        let sid = headers
            .get(axum::http::header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|c| {
                c.split(';').find_map(|part| {
                    let p = part.trim();
                    p.strip_prefix("picoaide_session=").map(|s| s.to_string())
                })
            })
            .unwrap_or_default();
        if sid.is_empty() {
            return Err(err(401, "AUTH_REQUIRED", "未登录"));
        }
        let u = picoaide_dsh_auth::validate_admin_session(&pool, &sid)
            .await
            .map_err(|_| err(401, "AUTH_REQUIRED", "会话失效"))?;
        // 返回当前会话的 CSRF token（Go handleMe 等价）。
        let csrf = picoaide_dsh_auth::get_admin_session(&pool, &sid)
            .await
            .map(|s| picoaide_dsh_auth::issue_csrf(&s.csrf_key, chrono::Utc::now()))
            .unwrap_or_default();
        return Ok(Json(serde_json::json!({ "user": user_json(&u), "csrf_token": csrf })));
    }

    // ---- users ----
    if path == "/api/server/admin/users" {
        if method == Method::GET {
            let page = params.get("page").and_then(|s| s.parse().ok()).unwrap_or(1i64).clamp(1, 100000);
            let size = params.get("size").and_then(|s| s.parse().ok()).unwrap_or(20i64);
            let size = if size < 1 || size > 200 { 20 } else { size };
            let q = params.get("q").cloned().unwrap_or_default();
            let (users, total) = picoaide_dsh_store::users::list_users(&pool, (page - 1) * size, size, &q)
                .await
                .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
            // 批量附组(部门归属) + 本月流量/成本 + 生效配额（对齐 Go listUsers）。
            let groups = picoaide_dsh_store::groups::user_groups_batch(&pool, &users)
                .await
                .unwrap_or_default();
            let ids: Vec<i64> = users.iter().map(|u| u.id).collect();
            let usage = picoaide_dsh_store::usage::user_monthly_usage_batch(&pool, &ids)
                .await
                .unwrap_or_default();
            let cost = picoaide_dsh_store::usage::user_monthly_cost_batch(&pool, &ids)
                .await
                .unwrap_or_default();
            // 生效配额(batch 预计算, map 闭包内不能 await)
            let mut eq_map: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
            let mut em_map: std::collections::HashMap<i64, f64> = std::collections::HashMap::new();
            for u in &users {
                if let Ok(eq) = picoaide_dsh_store::usage::effective_quota(&pool, u).await {
                    eq_map.insert(u.id, eq);
                }
                if let Ok(em) = picoaide_dsh_store::usage::effective_money_quota(&pool, u).await {
                    em_map.insert(u.id, em);
                }
            }
            let items: Vec<serde_json::Value> = users
                .iter()
                .map(|u| {
                    let mut v = user_json(u);
                    v["groups"] = serde_json::json!(groups.get(&u.id).cloned().unwrap_or_default());
                    v["monthly_usage"] = serde_json::json!(usage.get(&u.id).copied().unwrap_or(0));
                    v["monthly_cost"] = serde_json::json!(cost.get(&u.id).copied().unwrap_or(0.0));
                    if let Some(eq) = eq_map.get(&u.id) {
                        v["effective_quota_tokens"] = serde_json::json!(eq);
                    }
                    if let Some(em) = em_map.get(&u.id) {
                        v["effective_quota_money"] = serde_json::json!(em);
                    }
                    v
                })
                .collect();
            return Ok(Json(serde_json::json!({ "users": items, "total": total, "page": page, "size": size })));
        }
    }
    // users/:id
    if let Some(id_part) = path.strip_prefix("/api/server/admin/users/") {
        if !id_part.is_empty() && !id_part.contains('/') {
            if let Ok(id) = id_part.parse::<i64>() {
                if method == Method::DELETE {
                    picoaide_dsh_store::users::delete_user(&pool, id)
                        .await
                        .map_err(|_| err(500, "INTERNAL", "删除失败"))?;
                    return Ok(Json(serde_json::json!({ "ok": true })));
                }
                if method == Method::PUT {
                    let u = picoaide_dsh_store::users::get_user_by_id(&pool, id)
                        .await
                        .map_err(|_| err(404, "NOT_FOUND", "用户不存在"))?;
                    let mut upd = u;
                    if let Some(dn) = payload.get("display_name").and_then(|v| v.as_str()) {
                        upd.display_name = dn.to_string();
                    }
                    if let Some(role) = payload.get("role").and_then(|v| v.as_str()) {
                        upd.role = role.to_string();
                    }
                    if let Some(status) = payload.get("status").and_then(|v| v.as_i64()) {
                        upd.status = status as i32;
                    }
                    picoaide_dsh_store::users::update_user(&pool, &upd)
                        .await
                        .map_err(|_| err(500, "INTERNAL", "更新失败"))?;
                    return Ok(Json(serde_json::json!({ "ok": true })));
                }
            }
        }
    }

    // ---- departments ----
    if path == "/api/server/admin/departments" {
        if method == Method::GET {
            let depts = picoaide_dsh_store::departments::list_departments(&pool)
                .await
                .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
            let items: Vec<serde_json::Value> = depts
                .iter()
                .map(|d| serde_json::json!({
                    "id": d.id, "name": d.name, "parent_id": d.parent_id,
                    "leader_id": d.leader_id, "leader_name": d.leader_name,
                    "description": d.description, "member_count": d.member_count,
                    "child_count": d.child_count, "granted_count": d.granted_count,
                    "budget_money": d.budget_money, "monthly_cost": d.monthly_cost,
                }))
                .collect();
            return Ok(Json(serde_json::json!({ "departments": items })));
        }
        if method == Method::POST {
            let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let parent = payload.get("parent_id").and_then(|v| v.as_i64()).unwrap_or(0);
            let leader = payload.get("leader_id").and_then(|v| v.as_i64()).unwrap_or(0);
            let desc = payload.get("description").and_then(|v| v.as_str()).unwrap_or("");
            picoaide_dsh_store::departments::create_department(&pool, name, parent, leader, desc)
                .await
                .map_err(|_| err(400, "VALIDATION", "创建失败"))?;
            return Ok(Json(serde_json::json!({ "ok": true })));
        }
    }

    // ---- gateway (config) ----
    if path == "/api/server/admin/gateway" && method == Method::GET {
        let all = picoaide_dsh_store::settings::get_all_settings(&pool)
            .await
            .map_err(|_| err(500, "INTERNAL", "读取失败"))?;
        let rate_limit = all.get("gateway.rate_limit").cloned().filter(|s| !s.is_empty()).unwrap_or_else(|| "60".into());
        let monthly_quota = all.get("usage.monthly_quota").cloned().filter(|s| !s.is_empty()).unwrap_or_else(|| "0".into());
        let monthly_quota_money = all.get("usage.monthly_quota_money").cloned().filter(|s| !s.is_empty()).unwrap_or_else(|| "0".into());
        let retention = all.get("usage.retention_months").cloned().filter(|s| !s.is_empty()).unwrap_or_else(|| "6".into());
        return Ok(Json(serde_json::json!({
            "default_model": all.get("gateway.default_model").cloned().unwrap_or_default(),
            "rate_limit": rate_limit,
            "monthly_quota": monthly_quota,
            "monthly_quota_money": monthly_quota_money,
            "peak_windows": all.get("usage.peak_windows").cloned().unwrap_or_default(),
            "retention_months": retention,
            "error_reporting_dsn": all.get("web.error_reporting_dsn").cloned().unwrap_or_default(),
            "error_reporting_enabled": all.get("web.error_reporting_enabled").map(|v| v == "true").unwrap_or(false),
            "error_reporting_level": all.get("web.error_reporting_level").cloned().unwrap_or_default(),
            "glitchtip_base_url": all.get("web.glitchtip_base_url").cloned().unwrap_or_default(),
            "glitchtip_organization": all.get("web.glitchtip_organization").cloned().unwrap_or_default(),
            "default_thinking_level": all.get("web.default_thinking_level").cloned().unwrap_or_default(),
            "server_base_url": all.get("server.base_url").cloned().unwrap_or_default(),
        })));
    }

    // ---- providers ----
    if path == "/api/server/admin/providers" && method == Method::GET {
        let providers = picoaide_dsh_store::gateway::list_gateway_providers(&pool)
            .await
            .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
        let items: Vec<serde_json::Value> = providers
            .iter()
            .map(|p| {
                let key = if p.api_key_enc.is_empty() { "" } else { "***" };
                let protocol = if p.protocol.is_empty() { "openai" } else { &p.protocol };
                serde_json::json!({
                    "id": p.id, "name": p.name, "base_url": p.base_url,
                    "api_key": key, "models": p.models,
                    "enabled": p.enabled == 1, "channel": p.channel, "protocol": protocol,
                })
            })
            .collect();
        return Ok(Json(serde_json::json!({ "providers": items })));
    }

    // ---- models ----
    if path == "/api/server/admin/models" && method == Method::GET {
        let models = picoaide_dsh_store::gateway::list_admin_models(&pool)
            .await
            .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
        let items: Vec<serde_json::Value> = models
            .iter()
            .map(|m| serde_json::json!({
                "id": m.id, "name": m.name, "provider_id": m.provider_id,
                "display_name": m.display_name, "default_params": m.default_params,
                "input_modalities": m.input_modalities,
                "input_price_per_1m": m.input_price_per_1m, "output_price_per_1m": m.output_price_per_1m,
                "cache_input_price_per_1m": m.cache_input_price_per_1m, "offpeak_discount": m.offpeak_discount,
                "provider_name": m.provider_name, "provider_channel": m.provider_channel,
                "provider_enabled": m.provider_enabled,
            }))
            .collect();
        return Ok(Json(serde_json::json!({ "models": items })));
    }

    // ---- auth config ----
    if path == "/api/server/admin/auth" && method == Method::GET {
        let all = picoaide_dsh_store::settings::get_all_settings(&pool)
            .await
            .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
        let mask = |v: &str| -> String { if v.is_empty() { String::new() } else { "***".into() } };
        let min_len: i64 = all
            .get("auth.min_password_length")
            .and_then(|v| v.trim().parse().ok())
            .filter(|n: &i64| (8..=64).contains(n))
            .unwrap_or(10);
        return Ok(Json(serde_json::json!({ "auth": {
            "mode": all.get("auth.mode").cloned().unwrap_or_default(),
            "enabled": all.get("auth.enabled").cloned().unwrap_or_default(),
            "hide_local": all.get("auth.hide_local").map(|v| v == "true").unwrap_or(false),
            "min_password_length": min_len,
            "ldap": {
                "server_url": all.get("ldap.server_url").cloned().unwrap_or_default(),
                "bind_dn": all.get("ldap.bind_dn").cloned().unwrap_or_default(),
                "bind_password": mask(all.get("ldap.bind_password").map(|s| s.as_str()).unwrap_or("")),
                "base_dn": all.get("ldap.base_dn").cloned().unwrap_or_default(),
                "user_filter": all.get("ldap.user_filter").cloned().unwrap_or_default(),
                "user_attr": all.get("ldap.user_attr").cloned().unwrap_or_default(),
                "group_filter": all.get("ldap.group_filter").cloned().unwrap_or_default(),
                "group_attr": all.get("ldap.group_attr").cloned().unwrap_or_default(),
            },
            "oidc": {
                "issuer": all.get("oidc.issuer").cloned().unwrap_or_default(),
                "client_id": all.get("oidc.client_id").cloned().unwrap_or_default(),
                "client_secret": mask(all.get("oidc.client_secret").map(|s| s.as_str()).unwrap_or("")),
                "redirect_url": all.get("oidc.redirect_url").cloned().unwrap_or_default(),
            },
            "openid": {
                "issuer": all.get("openid.issuer").cloned().unwrap_or_default(),
                "client_id": all.get("openid.client_id").cloned().unwrap_or_default(),
                "client_secret": mask(all.get("openid.client_secret").map(|s| s.as_str()).unwrap_or("")),
                "redirect_url": all.get("openid.redirect_url").cloned().unwrap_or_default(),
            },
        } })));
    }

    // ---- server-info ----
    if path == "/api/server/admin/server-info" && method == Method::GET {
        // 目标: 与 Go sysinfo 输出结构一致(字段名对齐); 运行时值取本进程真实值。
        // 2026-09: runtime=rust 标识,前端据以切换「Go 运行时」标签 → 「Rust 运行时」。
        // rustc 版本由 build.rs 编译期注入(OUT_DIR/rustc_version.txt)。
        static RUSTC_VER: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        let rustc_ver = RUSTC_VER.get_or_init(|| {
            include_str!(concat!(env!("OUT_DIR"), "/rustc_version.txt")).trim().to_string()
        });
        static START: std::sync::OnceLock<std::time::SystemTime> = std::sync::OnceLock::new();
        let start = *START.get_or_init(std::time::SystemTime::now);
        let up = std::time::SystemTime::now()
            .duration_since(start)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let up_h = human_duration(up);
        let ver = std::env::var("DSH_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string());
        let num_cpu = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
        // tokio 工作线程数: 默认 = 可用并行线程数(等价 GOMAXPROCS 语义)。
        let tokio_threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
        let load_avg = read_load_avg();
        let mem = read_mem_stats();
        let disk = read_disk("/data");
        let db = db_stats(&pool).await.unwrap_or_default();
        return Ok(Json(serde_json::json!({
            "uptime_sec": up,
            "uptime_human": up_h,
            "runtime": "rust",
            "runtime_version": rustc_ver.clone(),
            // 兼容旧 key(Go 前端字段名): 保留 go_version,但值填 Rust 版本。
            "go_version": rustc_ver.clone(),
            "num_cpu": num_cpu,
            "gomaxprocs": tokio_threads,
            "goroutines": 0,
            "tokio_threads": tokio_threads,
            "mem": {
                "allocated_mb": mem.0,
                "total_system_mb": mem.1,
                "system_memory_mb": mem.2,
            },
            "load_avg": [load_avg.0, load_avg.1, load_avg.2],
            "disk": {
                "data_path": disk.0,
                "total_gb": disk.1,
                "used_gb": disk.2,
                "free_gb": disk.3,
                "used_pct": disk.4,
            },
            "db": {
                "driver": "pg",
                "tables": db.0,
                "total_rows": db.1,
                "disk_bytes": db.2,
                "disk_human": db.3,
                "schema_migrations": db.4,
            },
            "version": ver,
            "update_check": serde_json::Value::Null,
        })));
    }

    // ---- audit ----
    if path == "/api/server/admin/audit" && method == Method::GET {
        let page = params.get("page").and_then(|s| s.parse().ok()).unwrap_or(1i64);
        let size = params.get("size").and_then(|s| s.parse().ok()).unwrap_or(20i64);
        let (logs, total) = picoaide_dsh_store::audit::list_audit_logs_paged(&pool, (page - 1) * size, size)
            .await
            .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
        let items: Vec<serde_json::Value> = logs
            .iter()
            .map(|l| serde_json::json!({
                "id": l.id, "username": l.username, "action": l.action,
                "detail": l.detail, "prev_hash": l.prev_hash, "hash": l.hash,
                "created_at": l.created_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            }))
            .collect();
        return Ok(Json(serde_json::json!({ "logs": items, "total": total })));
    }

    // ---- usage overview ----
    if path == "/api/server/admin/usage/overview" && method == Method::GET {
        use chrono::Datelike;
        let now = chrono::Utc::now();
        let today_naive = now.date_naive();
        let month_from = chrono::NaiveDate::from_ymd_opt(today_naive.year(), today_naive.month(), 1).unwrap_or(today_naive);
        // range: from/to 查询参数（缺省近 30 天，对齐 Go usageDateRange）
        let from = params.get("from").and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .unwrap_or_else(|| today_naive - chrono::Duration::days(30));
        let to = params.get("to").and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .unwrap_or(today_naive);
        let q = picoaide_dsh_store::aggregate::UsageAggregateQuery::default();
        let range_rows = picoaide_dsh_store::aggregate::usage_aggregate(&pool, Some(from), Some(to), "day", &q)
            .await
            .map_err(|_| err(500, "INTERNAL", "统计失败"))?;
        let model_rows = picoaide_dsh_store::aggregate::usage_aggregate(&pool, Some(from), Some(to), "model", &q)
            .await
            .map_err(|_| err(500, "INTERNAL", "统计失败"))?;
        let mut top = model_rows.clone();
        top.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));
        if top.len() > 10 {
            top.truncate(10);
        }
        let month_rows = picoaide_dsh_store::aggregate::usage_aggregate(&pool, Some(month_from), Some(today_naive), "day", &q)
            .await
            .map_err(|_| err(500, "INTERNAL", "统计失败"))?;
        let today_rows = picoaide_dsh_store::aggregate::usage_aggregate(&pool, Some(today_naive), Some(today_naive), "day", &q)
            .await
            .map_err(|_| err(500, "INTERNAL", "统计失败"))?;
        let sum = |rows: &[picoaide_dsh_store::aggregate::UsageAggregateRow]| -> serde_json::Value {
            let mut cost = 0.0f64;
            let mut tokens = 0i64;
            let mut requests = 0i64;
            for r in rows {
                cost += r.cost;
                tokens += r.prompt_tokens + r.completion_tokens;
                requests += r.requests;
            }
            serde_json::json!({ "cost": cost, "tokens": tokens, "requests": requests })
        };
        let row_json = |r: &picoaide_dsh_store::aggregate::UsageAggregateRow| -> serde_json::Value {
            serde_json::json!({
                "label": r.label, "prompt_tokens": r.prompt_tokens, "completion_tokens": r.completion_tokens,
                "requests": r.requests, "embed_requests": r.embed_requests, "embed_tokens": r.embed_tokens,
                "cache_tokens": r.cache_tokens, "cost": r.cost,
            })
        };
        return Ok(Json(serde_json::json!({
            "range": sum(&range_rows),
            "month": sum(&month_rows),
            "today": sum(&today_rows),
            "trend": range_rows.iter().map(row_json).collect::<Vec<_>>(),
            "top_models": top.iter().map(row_json).collect::<Vec<_>>(),
        })));
    }

    // ---- channels（渠道注册表：从 providers 表 GROUP BY channel）----
    if path == "/api/server/admin/channels" && method == Method::GET {
        let rows = sqlx::query(
            "SELECT DISTINCT channel, base_url FROM gateway_providers WHERE channel <> '' ORDER BY channel",
        )
        .fetch_all(&pool)
        .await
        .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
        let items: Vec<serde_json::Value> = rows
            .iter()
            .map(|r| {
                let ch: String = r.get("channel");
                let bu: String = r.get("base_url");
                serde_json::json!({ "name": ch, "base_url": bu })
            })
            .collect();
        return Ok(Json(serde_json::json!({ "channels": items })));
    }

    // ---- portal（门户配置）----
    if path == "/api/server/admin/portal" && method == Method::GET {
        let cfg = picoaide_dsh_store::brand_config::PortalConfig::load_from_db(&pool)
            .await
            .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
        return Ok(Json(serde_json::json!({
            "enabled": cfg.enabled, "public": cfg.public, "welcome": cfg.welcome,
            "subtitle": cfg.subtitle,
            "client_download_linux": cfg.client_download_linux,
            "client_download_mac": cfg.client_download_mac,
            "client_download_win": cfg.client_download_win,
            "client_download_note": cfg.client_download_note,
            "landing_path": cfg.landing_path,
        })));
    }

    // ---- brand（品牌配置）----
    if path == "/api/server/admin/brand" && method == Method::GET {
        let cfg = picoaide_dsh_store::brand_config::BrandConfig::load_from_db(&pool)
            .await
            .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
        return Ok(Json(serde_json::json!({
            "enabled": cfg.enabled,
            "login": { "display_name": cfg.login.display_name, "tagline": cfg.login.tagline, "welcome": cfg.login.welcome },
            "client": { "display_name": cfg.client.display_name, "tagline": cfg.client.tagline },
            "title": cfg.title,
        })));
    }

    // ---- brand/snapshots ----
    if path == "/api/server/admin/brand/snapshots" && method == Method::GET {
        let rows = sqlx::query("SELECT id, created_at, data FROM brand_snapshots ORDER BY id DESC LIMIT 20")
            .fetch_all(&pool)
            .await
            .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
        let items: Vec<serde_json::Value> = rows
            .iter()
            .map(|r| {
                let id: i64 = r.get("id");
                let data: String = r.get("data");
                let created_at: chrono::DateTime<chrono::Utc> = r.get("created_at");
                serde_json::json!({
                    "id": id,
                    "created_at": created_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    "data": data,
                })
            })
            .collect();
        return Ok(Json(serde_json::json!({ "snapshots": items })));
    }

    // ---- usage（用量聚合，group 参数）----
    if path == "/api/server/admin/usage" && method == Method::GET {
        use chrono::Datelike;
        let now = chrono::Utc::now();
        let today_naive = now.date_naive();
        let from = params.get("from").and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .unwrap_or_else(|| today_naive - chrono::Duration::days(30));
        let to = params.get("to").and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .unwrap_or(today_naive);
        let group = params.get("group").map(|s| s.as_str()).unwrap_or("day");
        let q = picoaide_dsh_store::aggregate::UsageAggregateQuery::new();
        // group=provider: 底层按 model 聚合后按 models 表映射归并渠道（Go 语义）。
        let agg_group = if group == "provider" { "model" } else { group };
        let mut rows = picoaide_dsh_store::aggregate::usage_aggregate(&pool, Some(from), Some(to), agg_group, &q)
            .await
            .map_err(|_| err(500, "INTERNAL", "统计失败"))?;
        if group == "provider" {
            let rows_model = std::mem::take(&mut rows);
            rows = regroup_by_provider(&pool, rows_model).await.unwrap_or_default();
        }
        let items: Vec<serde_json::Value> = rows
            .iter()
            .map(|r| serde_json::json!({
                "label": r.label, "prompt_tokens": r.prompt_tokens, "completion_tokens": r.completion_tokens,
                "requests": r.requests, "embed_requests": r.embed_requests, "embed_tokens": r.embed_tokens,
                "cache_tokens": r.cache_tokens, "cost": r.cost,
            }))
            .collect();
        return Ok(Json(serde_json::json!({ "rows": items, "group": group })));
    }

    // ---- connectors ----
    if path == "/api/server/admin/connectors" && method == Method::GET {
        let conns = picoaide_dsh_store::connectors::list_connectors(&pool)
            .await
            .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
        let items: Vec<serde_json::Value> = conns
            .iter()
            .map(|c| serde_json::json!({
                "id": c.id, "name": c.name, "description": c.description,
                "auth_mode": c.auth_mode, "definition": c.definition,
                "enabled": c.enabled, "created_at": c.created_at,
                "updated_at": c.updated_at,
            }))
            .collect();
        return Ok(Json(serde_json::json!({ "connectors": items })));
    }

    // ---- concurrency ----
    if path == "/api/server/admin/concurrency" && method == Method::GET {
        let models = picoaide_dsh_store::gateway::list_admin_models(&pool)
            .await
            .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
        let since = chrono::Utc::now() - chrono::Duration::days(90);
        let peaks = picoaide_dsh_store::concurrency::peak_concurrency_by_model(&pool, since)
            .await
            .unwrap_or_default();
        let now_rfc = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let items: Vec<serde_json::Value> = models
            .iter()
            .map(|m| serde_json::json!({
                "model": m.name,
                "current": 0,
                "peak_90d": peaks.get(&m.name).copied().unwrap_or(0),
                "target": 0,
                "provider": m.provider_name,
            }))
            .collect();
        return Ok(Json(serde_json::json!({ "checked_at": now_rfc, "models": items })));
    }

    // ---- capabilities/approvals（统一审批队列: skills + agents）----
    if path == "/api/server/admin/capabilities/approvals" && method == Method::GET {
        let status = params.get("status").cloned().unwrap_or_else(|| "pending".into());
        let type_filter = params.get("type").cloned().unwrap_or_else(|| "all".into());
        let mut items: Vec<serde_json::Value> = Vec::new();
        let want_skill = type_filter == "all" || type_filter == "skill";
        let want_agent = type_filter == "all" || type_filter == "agent";
        if want_skill {
            let rows = picoaide_dsh_store::apps::list_releases_by_status(&pool, "skill", &status)
                .await
                .unwrap_or_default();
            // 只保留 org 渠道（员工上传）——Go ListSharedSkills → orgSkillReleases 语义。
            let org_apps: std::collections::HashSet<String> = picoaide_dsh_store::apps::list_apps(&pool, "skill", "org")
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|a| a.app_id)
                .collect();
            for r in rows {
                if !org_apps.contains(&r.app_id) {
                    continue;
                }
                if !r.deleted_at.is_none() {
                    continue;
                }
                let app = picoaide_dsh_store::apps::get_app(&pool, "skill", &r.app_id).await.ok();
                let official = app.as_ref().map(|a| a.official == 1).unwrap_or(false);
                items.push(serde_json::json!({
                    "kind": "skill", "name": r.app_id, "version": r.version,
                    "display_name": r.title, "description": r.description,
                    "author": r.publisher, "owner": app.as_ref().map(|a| a.owner.clone()).unwrap_or_default(),
                    "status": r.status, "reason": r.reason, "quality": r.quality,
                    "created_at": r.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
                    "downloads": r.downloads, "calls": r.calls,
                    "base_path": format!("/api/server/admin/shared-skills/{}/{}", r.app_id, r.version),
                    "grants_base": format!("/api/server/admin/shared-skills/{}", r.app_id),
                    "preview_path": format!("/api/server/admin/shared-skills/{}/{}/preview", r.app_id, r.version),
                    "conflict": false, "official": official,
                }));
            }
        }
        if want_agent {
            let rows = picoaide_dsh_store::apps::list_releases_by_status(&pool, "agent", &status)
                .await
                .unwrap_or_default();
            // 只保留 org 渠道（员工上传）。
            let org_apps: std::collections::HashSet<String> = picoaide_dsh_store::apps::list_apps(&pool, "agent", "org")
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|a| a.app_id)
                .collect();
            for r in rows {
                if !org_apps.contains(&r.app_id) {
                    continue;
                }
                if !r.deleted_at.is_none() {
                    continue;
                }
                let app = picoaide_dsh_store::apps::get_app(&pool, "agent", &r.app_id).await.ok();
                let official = app.as_ref().map(|a| a.official == 1).unwrap_or(false);
                items.push(serde_json::json!({
                    "kind": "agent", "name": r.app_id, "version": r.version,
                    "display_name": r.title, "description": r.description,
                    "author": r.publisher, "owner": app.as_ref().map(|a| a.owner.clone()).unwrap_or_default(),
                    "status": r.status, "reason": r.reason, "quality": r.quality,
                    "created_at": r.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
                    "downloads": r.downloads,
                    "base_path": format!("/api/server/admin/agent-presets/{}/{}", r.app_id, r.version),
                    "grants_base": format!("/api/server/admin/agent-presets/{}", r.app_id),
                    "preview_path": format!("/api/server/admin/agent-presets/{}/{}/preview", r.app_id, r.version),
                    "conflict": false, "official": official,
                }));
            }
        }
        // 按 created_at 降序（最新在前）
        items.sort_by(|a, b| {
            let ca = a.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
            let cb = b.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
            cb.cmp(ca)
        });
        return Ok(Json(serde_json::json!({ "approvals": items })));
    }

    // ---- skills（市场技能列表）----
    if path == "/api/server/admin/skills" && method == Method::GET {
        let apps = picoaide_dsh_store::apps::list_apps(&pool, "skill", "market")
            .await
            .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
        let mut items = Vec::new();
        for a in &apps {
            let rels = picoaide_dsh_store::apps::list_releases(&pool, "skill", &a.app_id)
                .await
                .unwrap_or_default();
            let best = rels
                .iter()
                .filter(|r| r.deleted_at.is_none() && r.status == "approved")
                .max_by_key(|r| r.created_at);
            items.push(serde_json::json!({
                "id": best.map(|r| r.id).unwrap_or_default(),
                "name": a.app_id,
                "version": best.map(|r| r.version.clone()).unwrap_or_default(),
                "description": if a.description.is_empty() { best.map(|r| r.description.clone()).unwrap_or_default() } else { a.description.clone() },
                "author": a.owner,
                "checksum": best.map(|r| r.checksum.clone()).unwrap_or_default(),
                "downloads": best.map(|r| r.downloads).unwrap_or(0),
                "calls": best.map(|r| r.calls).unwrap_or(0),
                "enabled": a.enabled == 1,
                "official": a.official == 1,
                "created_at": a.created_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                "updated_at": a.updated_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            }));
        }
        return Ok(Json(serde_json::json!({ "skills": items })));
    }

    // ---- agents（市场智能体列表）----
    if path == "/api/server/admin/agents" && method == Method::GET {
        let apps = picoaide_dsh_store::apps::list_apps(&pool, "agent", "market")
            .await
            .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
        let mut items = Vec::new();
        for a in &apps {
            let rels = picoaide_dsh_store::apps::list_releases(&pool, "agent", &a.app_id)
                .await
                .unwrap_or_default();
            let best = rels
                .iter()
                .filter(|r| r.deleted_at.is_none() && r.status == "approved")
                .max_by_key(|r| r.created_at);
            items.push(serde_json::json!({
                "id": best.map(|r| r.id).unwrap_or_default(),
                "name": a.app_id,
                "version": best.map(|r| r.version.clone()).unwrap_or_default(),
                "description": if a.description.is_empty() { best.map(|r| r.description.clone()).unwrap_or_default() } else { a.description.clone() },
                "author": a.owner,
                "checksum": best.map(|r| r.checksum.clone()).unwrap_or_default(),
                "downloads": best.map(|r| r.downloads).unwrap_or(0),
                "enabled": a.enabled == 1,
                "official": a.official == 1,
                "created_at": a.created_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                "updated_at": a.updated_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            }));
        }
        return Ok(Json(serde_json::json!({ "agents": items })));
    }

    // ---- usage/requests（请求日志分页）----
    if path == "/api/server/admin/usage/requests" && method == Method::GET {
        let page = params.get("page").and_then(|s| s.parse().ok()).unwrap_or(1i64);
        let size = params.get("size").and_then(|s| s.parse().ok()).unwrap_or(20i64);
        let username = params.get("username").cloned().unwrap_or_default();
        let model = params.get("model").cloned().unwrap_or_default();
        let kind = params.get("kind").cloned().unwrap_or_default();
        let from = params.get("from").and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .map(|d| chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(d.and_hms_opt(0, 0, 0).unwrap_or_default(), chrono::Utc));
        let to = params.get("to").and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .and_then(|d| d.succ_opt())
            .map(|d| chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(d.and_hms_opt(0, 0, 0).unwrap_or_default(), chrono::Utc));
        let (rows, total) = picoaide_dsh_store::requests::list_usage_requests(&pool, from, to, &username, &model, &kind, page, size)
            .await
            .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
        let items: Vec<serde_json::Value> = rows
            .iter()
            .map(|r| serde_json::json!({
                "id": r.id, "time": r.time.with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap()).to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "user_id": r.user_id, "username": r.username,
                "model": r.model, "kind": r.kind,
                "prompt_tokens": r.prompt_tokens, "completion_tokens": r.completion_tokens,
                "cache_tokens": r.cache_tokens, "cost": r.cost,
            }))
            .collect();
        return Ok(Json(serde_json::json!({ "rows": items, "total": total, "page": page, "size": size, "kind": kind })));
    }

    // ---- report-subscriptions（报表订阅）----
    if path == "/api/server/admin/report-subscriptions" && method == Method::GET {
        let subs = picoaide_dsh_store::reports::list_report_subscriptions(&pool)
            .await
            .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
        let items: Vec<serde_json::Value> = subs
            .iter()
            .map(|s| serde_json::json!({
                "id": s.id, "name": s.name, "enabled": s.enabled, "hook_url": s.hook_url,
                "last_run_at": s.last_run_at, "last_error": s.last_error,
                "created_at": s.created_at, "updated_at": s.updated_at,
            }))
            .collect();
        return Ok(Json(serde_json::json!({ "subscriptions": items })));
    }

    // ---- audit/settings ----
    if path == "/api/server/admin/audit/settings" && method == Method::GET {
        let days = picoaide_dsh_store::settings::audit_retention_days(&pool).await;
        return Ok(Json(serde_json::json!({ "retention_days": days })));
    }

    // ---- providers/:id/balance ----
    if let Some(id_part) = path.strip_prefix("/api/server/admin/providers/") {
        if let Some(bal) = id_part.strip_suffix("/balance") {
            if let Ok(pid) = bal.parse::<i64>() {
                let provider = picoaide_dsh_store::gateway::get_gateway_provider(&pool, pid)
                    .await
                    .map_err(|_| err(404, "NOT_FOUND", "provider 不存在"))?;
                // 解密上游 API key（master key 从 env 或 data_dir/master.key）。
                let key = decrypt_master_key(&provider.api_key_enc);
                let supported = provider.base_url.to_lowercase().contains("deepseek")
                    || provider.name.to_lowercase().contains("deepseek");
                if !supported || key.is_err() {
                    return Ok(Json(serde_json::json!({
                        "supported": false,
                        "fetched_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    })));
                }
                let api_key = key.unwrap_or_default();
                return match fetch_deepseek_balance(&provider.base_url, &api_key).await {
                    Ok((available, infos)) => Ok(Json(serde_json::json!({
                        "supported": true,
                        "is_available": available,
                        "infos": infos,
                        "fetched_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    }))),
                    Err(e) => Ok(Json(serde_json::json!({
                        "supported": true,
                        "is_available": false,
                        "infos": [],
                        "error": e,
                        "fetched_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    }))),
                };
            }
        }
    }

    Err(err(404, "NOT_FOUND", "未实现的端点"))
}
