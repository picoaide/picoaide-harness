//! 管理面端点补全（面向 webadmin 前端实际请求）——users/departments/gateway/models 等。
//! 统一 handler：按 path + method 分发到 store/service。

use axum::extract::State;
use axum::http::{Method, StatusCode};
use axum::{Json, Router};
use std::sync::Arc;

use crate::error::{error_body, ErrorResponse};
use crate::router::AppState;

fn err(s: u16, c: &str, m: &str) -> (StatusCode, Json<ErrorResponse>) {
    (StatusCode::from_u16(s).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), Json(error_body(c, m)))
}

/// dispatch_admin 管理面统一分发（Go /api/server/admin/* 等价）。
pub async fn dispatch_admin(
    State(state): State<Arc<AppState>>,
    method: Method,
    uri: axum::http::Uri,
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

    // ---- users ----
    if path == "/api/server/admin/users" {
        if method == Method::GET {
            let page = params.get("page").and_then(|s| s.parse().ok()).unwrap_or(1i64);
            let size = params.get("size").and_then(|s| s.parse().ok()).unwrap_or(20i64);
            let q = params.get("q").cloned().unwrap_or_default();
            let (users, total) = picoaide_dsh_store::users::list_users(&pool, (page - 1) * size, size, &q)
                .await
                .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
            let items: Vec<serde_json::Value> = users
                .iter()
                .map(|u| serde_json::json!({
                    "id": u.id, "username": u.username, "display_name": u.display_name,
                    "email": u.email, "role": u.role, "status": u.status,
                    "is_admin": u.is_admin, "source": u.source, "created_at": u.created_at,
                }))
                .collect();
            return Ok(Json(serde_json::json!({ "users": items, "total": total })));
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
        return Ok(Json(serde_json::json!({
            "providers": [], "models": [], "default_model": "",
            "peak_windows": [], "monthly_quota_tokens": "", "monthly_quota_money": "",
        })));
    }

    // ---- providers ----
    if path == "/api/server/admin/providers" && method == Method::GET {
        let providers = picoaide_dsh_store::gateway::list_gateway_providers(&pool)
            .await
            .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
        let items: Vec<serde_json::Value> = providers
            .iter()
            .map(|p| serde_json::json!({
                "id": p.id, "name": p.name, "base_url": p.base_url,
                "api_key_enc": p.api_key_enc, "models": p.models,
                "enabled": p.enabled, "channel": p.channel, "protocol": p.protocol,
            }))
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
                "input_price_per_1m": m.input_price_per_1m, "output_price_per_1m": m.output_price_per_1m,
                "provider_name": m.provider_name, "provider_enabled": m.provider_enabled,
            }))
            .collect();
        return Ok(Json(serde_json::json!({ "models": items })));
    }

    // ---- auth config ----
    if path == "/api/server/admin/auth" && method == Method::GET {
        let all = picoaide_dsh_store::settings::get_all_settings(&pool)
            .await
            .map_err(|_| err(500, "INTERNAL", "查询失败"))?;
        let (pwds, browsers) = picoaide_dsh_auth::config::enabled_providers(&all);
        return Ok(Json(serde_json::json!({
            "enabled": pwds.join(","),
            "mode": all.get("auth.mode").cloned().unwrap_or_default(),
            "ldap": serde_json::json!({}),
            "oidc": serde_json::json!({}),
            "openid": serde_json::json!({}),
        })));
    }

    // ---- server-info ----
    if path == "/api/server/admin/server-info" && method == Method::GET {
        return Ok(Json(serde_json::json!({
            "version": "rust", "uptime_sec": 0, "go_version": "rust",
            "num_cpu": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
            "db": serde_json::json!({ "driver": "pg" }),
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
                "detail": l.detail, "created_at": l.created_at,
            }))
            .collect();
        return Ok(Json(serde_json::json!({ "logs": items, "total": total })));
    }

    // ---- usage overview ----
    if path == "/api/server/admin/usage/overview" && method == Method::GET {
        return Ok(Json(serde_json::json!({
            "monthly_tokens": 0, "monthly_cost": 0.0, "today_tokens": 0, "today_cost": 0.0,
        })));
    }

    Err(err(404, "NOT_FOUND", "未实现的端点"))
}
