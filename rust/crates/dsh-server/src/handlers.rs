//! 业务 handler 层（axum handler 包装 service 方法）。
//!
//! 每个 handler：请求提取 → service 调用 → Json 响应 或 错误信封。
//! 错误转换：service 的 *Error → (StatusCode, Json(ErrorResponse))。

use axum::extract::State;
use axum::http::StatusCode;
use axum::{Json, Router};
use std::sync::Arc;

use crate::error::{error_body, ErrorResponse};
use crate::router::AppState;

/// service_error 把各 service 的错误转换为 HTTP 错误响应。
pub fn service_error(status: u16, code: &str, message: &str) -> (StatusCode, Json<ErrorResponse>) {
    (StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), Json(error_body(code, message)))
}

/// handle_healthz 健康探针（无认证）。
pub async fn handle_healthz() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

/// handle_bootstrap 客户端 bootstrap（BearerAuth 保护由 router 挂载）。
pub async fn handle_bootstrap(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let user = picoaide_dsh_auth::verify_token(&state.pool, token)
        .await
        .map_err(|_| (StatusCode::UNAUTHORIZED, Json(error_body("AUTH_REQUIRED", "未认证"))))?;
    let svc = crate::bootstrap_service::BootstrapService::new(state.pool.clone());
    svc.build(&user.username, user.is_admin)
        .await
        .map(Json)
        .map_err(|e| service_error(500, "INTERNAL", &e.to_string()))
}

/// handle_brand_public 公开品牌配置。
pub async fn handle_brand_public(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let svc = crate::brand_service::BrandService::new(state.pool.clone());
    svc.public_brand()
        .await
        .map(Json)
        .map_err(|e| service_error(500, "INTERNAL", &e.to_string()))
}

/// handle_portal_public 公开门户配置。
pub async fn handle_portal_public(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let svc = crate::brand_service::BrandService::new(state.pool.clone());
    svc.public_portal()
        .await
        .map(Json)
        .map_err(|e| service_error(500, "INTERNAL", &e.to_string()))
}

/// handle_telemetry_skill_call 技能调用上报（BearerAuth 保护）。
pub async fn handle_telemetry_skill_call(
    State(state): State<Arc<AppState>>,
    payload: Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let version = payload.get("version").and_then(|v| v.as_str()).unwrap_or("");
    let svc = crate::telemetry_service::TelemetryService::new(state.pool.clone());
    svc.report_skill_call(name, version)
        .await
        .map(Json)
        .map_err(|e| {
            let (s, c, m) = match e {
                picoaide_dsh_store::StoreError::Validation => (400, "VALIDATION", "name/version 不合法"),
                _ => (500, "INTERNAL", "记录失败"),
            };
            service_error(s, c, m)
        })
}

/// register_client_handlers 客户端面路由（业务 handler 接入）。
pub fn register_client_handlers(router: Router<Arc<AppState>>) -> Router<Arc<AppState>> {
    router
        .route("/api/client/v2/brand", axum::routing::get(handle_brand_public))
        .route("/api/client/v2/portal", axum::routing::get(handle_portal_public))
        .route("/api/client/v2/config/bootstrap", axum::routing::get(handle_bootstrap))
        .route("/api/client/v2/telemetry/skill-call", axum::routing::post(handle_telemetry_skill_call))
        .route("/api/client/v2/auth/login", axum::routing::post(handle_client_login))
        .route("/api/client/v2/auth/me", axum::routing::get(handle_client_me))
        .route("/api/client/v2/auth/usage", axum::routing::get(handle_client_usage))
        .route("/api/server/admin/login", axum::routing::post(handle_admin_login))
        .route("/api/client/v2/marketplace/skills", axum::routing::post(handle_market_skills))
        .route("/api/client/v2/capabilities", axum::routing::post(handle_capabilities))
        .route("/api/server/admin/connectors", axum::routing::get(handle_connectors_list))
        .route("/api/server/admin/reports", axum::routing::get(handle_reports_list))
        .route("/api/server/admin/users", axum::routing::post(handle_admin_users))
        .route("/api/server/admin/departments", axum::routing::get(handle_admin_departments))
        .route("/api/server/admin/gateway/providers", axum::routing::get(handle_admin_gateway_providers))
        .route("/api/client/v2/marketplace/skills/detail", axum::routing::post(handle_market_skill_detail))
        .route("/api/client/v2/shared-skills", axum::routing::post(handle_shared_skills_visible))
        .route("/api/client/v2/agent-presets", axum::routing::post(handle_agent_share_visible))
        .route("/api/server/admin/auth/methods", axum::routing::get(handle_auth_methods))
        .route("/api/server/admin/usage/aggregate", axum::routing::post(handle_usage_aggregate))
        .route("/healthz", axum::routing::get(handle_healthz))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn healthz_handler_ok() {
        let r = handle_healthz().await;
        assert_eq!(r.0["ok"], true);
    }

    #[test]
    fn service_error_shape() {
        let (status, body) = service_error(400, "VALIDATION", "bad");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body.error.code, "VALIDATION");
    }
}

/// handle_login 客户端登录（local provider；成功签发 token）。
pub async fn handle_client_login(
    State(state): State<Arc<AppState>>,
    payload: Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let username = payload.get("username").and_then(|v| v.as_str()).unwrap_or("");
    let password = payload.get("password").and_then(|v| v.as_str()).unwrap_or("");
    if username.is_empty() || password.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(error_body("VALIDATION", "请求体格式错误"))));
    }
    let info = picoaide_dsh_auth::local_provider_authenticate(&state.pool, username, password)
        .await
        .map_err(|_| (StatusCode::UNAUTHORIZED, Json(error_body("AUTH_FAILED", "用户名或密码错误"))))?;
    // 找 user id（签发 token 用）
    let user = picoaide_dsh_store::users::get_user_by_username(&state.pool, &info.username)
        .await
        .map_err(|_| (StatusCode::UNAUTHORIZED, Json(error_body("AUTH_FAILED", "用户名或密码错误"))))?;
    let token = picoaide_dsh_auth::issue_token(&state.pool, user.id)
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, Json(error_body("INTERNAL", "签发失败"))))?;
    Ok(Json(serde_json::json!({ "token": token, "user": { "username": info.username } })))
}

/// handle_client_me 当前用户（BearerAuth 保护，router 挂载时前置验证）。
pub async fn handle_client_me(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let user = picoaide_dsh_auth::verify_token(&state.pool, token)
        .await
        .map_err(|_| (StatusCode::UNAUTHORIZED, Json(error_body("AUTH_REQUIRED", "未认证"))))?;
    Ok(Json(serde_json::json!({ "user": { "username": user.username, "id": user.id } })))
}

/// handle_client_usage 员工用量概览（BearerAuth 保护）。
pub async fn handle_client_usage(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let user = picoaide_dsh_auth::verify_token(&state.pool, token)
        .await
        .map_err(|_| (StatusCode::UNAUTHORIZED, Json(error_body("AUTH_REQUIRED", "未认证"))))?;
    let summary = picoaide_dsh_store::usage::user_usage_summary(&state.pool, user.id)
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, Json(error_body("INTERNAL", "查询失败"))))?;
    Ok(Json(serde_json::json!({ "usage": {
        "monthly_usage": summary.monthly_usage,
        "monthly_cost": summary.monthly_cost,
        "total_usage": summary.total_usage,
        "total_cost": summary.total_cost,
    }})))
}

/// handle_admin_login 管理端登录（本地 admin；成功创建 admin session + CSRF）。
pub async fn handle_admin_login(
    State(state): State<Arc<AppState>>,
    payload: Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let username = payload.get("username").and_then(|v| v.as_str()).unwrap_or("");
    let password = payload.get("password").and_then(|v| v.as_str()).unwrap_or("");
    if username.is_empty() || password.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(error_body("VALIDATION", "请求体格式错误"))));
    }
    let info = picoaide_dsh_auth::local_provider_authenticate(&state.pool, username, password)
        .await
        .map_err(|_| (StatusCode::UNAUTHORIZED, Json(error_body("AUTH_FAILED", "用户名或密码错误或非管理员"))))?;
    let user = picoaide_dsh_store::users::get_user_by_username(&state.pool, &info.username)
        .await
        .map_err(|_| (StatusCode::UNAUTHORIZED, Json(error_body("AUTH_FAILED", "用户名或密码错误或非管理员"))))?;
    if !user.has_management_access() {
        return Err((StatusCode::FORBIDDEN, Json(error_body("FORBIDDEN", "无管理权限"))));
    }
    let (session, csrf) = picoaide_dsh_auth::create_admin_session(&state.pool, user.id)
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, Json(error_body("INTERNAL", "会话创建失败"))))?;
    Ok(Json(serde_json::json!({ "session_id": session.id, "csrf_token": csrf, "user": { "username": info.username } })))
}

/// handle_market_skills 市场技能列表（授权制）。
pub async fn handle_market_skills(
    State(state): State<Arc<AppState>>,
    payload: Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let username = payload.get("username").and_then(|v| v.as_str()).unwrap_or("");
    let is_admin = payload.get("is_admin").and_then(|v| v.as_bool()).unwrap_or(false);
    let svc = crate::marketplace::MarketplaceService::new(state.pool.clone());
    svc.list_apps(&crate::marketplace::Viewer { username: username.into(), groups: vec![], is_admin }, "skill")
        .await
        .map(Json)
        .map_err(|e| service_error(e.status, &e.code, &e.message))
}

/// handle_capabilities 能力中心列表。
pub async fn handle_capabilities(
    State(state): State<Arc<AppState>>,
    payload: Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let username = payload.get("username").and_then(|v| v.as_str()).unwrap_or("");
    let is_admin = payload.get("is_admin").and_then(|v| v.as_bool()).unwrap_or(false);
    let svc = crate::capabilities_service::CapabilitiesService::new(state.pool.clone());
    svc.list(username, &[], is_admin, "all")
        .await
        .map(Json)
        .map_err(|e| service_error(500, "INTERNAL", &e.to_string()))
}

/// handle_connectors_list 连接器列表（admin）。
pub async fn handle_connectors_list(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let svc = crate::connector_service::ConnectorService::new(state.pool.clone());
    svc.list()
        .await
        .map(Json)
        .map_err(|e| service_error(500, "INTERNAL", &e.to_string()))
}

/// handle_reports_list 报表订阅列表。
pub async fn handle_reports_list(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let svc = crate::reports_service::ReportsService::new(state.pool.clone());
    svc.list()
        .await
        .map(Json)
        .map_err(|e| service_error(500, "INTERNAL", &e.to_string()))
}

/// handle_admin_users 用户列表（管理面）。
pub async fn handle_admin_users(
    State(state): State<Arc<AppState>>,
    payload: Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let page = payload.get("page").and_then(|v| v.as_i64()).unwrap_or(1);
    let size = payload.get("size").and_then(|v| v.as_i64()).unwrap_or(20);
    let q = payload.get("q").and_then(|v| v.as_str()).unwrap_or("");
    let (users, total) = picoaide_dsh_store::users::list_users(&state.pool, (page - 1) * size, size, q)
        .await
        .map_err(|e| service_error(500, "INTERNAL", &e.to_string()))?;
    let items: Vec<serde_json::Value> = users
        .iter()
        .map(|u| serde_json::json!({ "username": u.username, "display_name": u.display_name, "role": u.role, "status": u.status }))
        .collect();
    Ok(Json(serde_json::json!({ "users": items, "total": total })))
}

/// handle_admin_departments 部门列表（管理面）。
pub async fn handle_admin_departments(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let depts = picoaide_dsh_store::departments::list_departments(&state.pool)
        .await
        .map_err(|e| service_error(500, "INTERNAL", &e.to_string()))?;
    let items: Vec<serde_json::Value> = depts
        .iter()
        .map(|d| serde_json::json!({ "id": d.id, "name": d.name, "parent_id": d.parent_id, "member_count": d.member_count }))
        .collect();
    Ok(Json(serde_json::json!({ "departments": items })))
}

/// handle_admin_gateway_providers 网关上游列表（管理面）。
pub async fn handle_admin_gateway_providers(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let providers = picoaide_dsh_store::gateway::list_gateway_providers(&state.pool)
        .await
        .map_err(|e| service_error(500, "INTERNAL", &e.to_string()))?;
    let items: Vec<serde_json::Value> = providers
        .iter()
        .map(|p| serde_json::json!({ "name": p.name, "base_url": p.base_url, "protocol": p.protocol, "enabled": p.enabled }))
        .collect();
    Ok(Json(serde_json::json!({ "providers": items })))
}

/// handle_market_skill_detail 市场技能详情（授权制）。
pub async fn handle_market_skill_detail(
    State(state): State<Arc<AppState>>,
    payload: Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let username = payload.get("username").and_then(|v| v.as_str()).unwrap_or("");
    let is_admin = payload.get("is_admin").and_then(|v| v.as_bool()).unwrap_or(false);
    let svc = crate::marketplace::MarketplaceService::new(state.pool.clone());
    svc.get_app(&crate::marketplace::Viewer { username: username.into(), groups: vec![], is_admin }, "skill", name)
        .await
        .map(Json)
        .map_err(|e| service_error(e.status, &e.code, &e.message))
}

/// handle_shared_skills_visible 组织共享技能可见列表。
pub async fn handle_shared_skills_visible(
    State(state): State<Arc<AppState>>,
    payload: Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let username = payload.get("username").and_then(|v| v.as_str()).unwrap_or("");
    let is_admin = payload.get("is_admin").and_then(|v| v.as_bool()).unwrap_or(false);
    let svc = crate::shared_skills_service::SharedSkillsService::new(state.pool.clone());
    svc.list_visible(username, &[], is_admin)
        .await
        .map(Json)
        .map_err(|e| service_error(e.status, &e.code, &e.message))
}

/// handle_agent_share_visible 共享智能体可见列表。
pub async fn handle_agent_share_visible(
    State(state): State<Arc<AppState>>,
    payload: Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let username = payload.get("username").and_then(|v| v.as_str()).unwrap_or("");
    let is_admin = payload.get("is_admin").and_then(|v| v.as_bool()).unwrap_or(false);
    let svc = crate::agent_share_service::AgentShareService::new(state.pool.clone());
    svc.list_visible(username, &[], is_admin)
        .await
        .map(Json)
        .map_err(|e| service_error(e.status, &e.code, &e.message))
}

/// handle_auth_methods 公开认证方法列表。
pub async fn handle_auth_methods(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let all = picoaide_dsh_store::settings::get_all_settings(&state.pool)
        .await
        .map_err(|e| service_error(500, "INTERNAL", &e.to_string()))?;
    let (pwds, browsers) = picoaide_dsh_auth::config::enabled_providers(&all);
    // 与 Go 契约一致：methods 数组 [{name, configured, browser, hidden}]
    let mut methods = Vec::new();
    for p in &pwds {
        methods.push(serde_json::json!({ "name": p, "configured": true, "browser": false, "hidden": false }));
    }
    for b in &browsers {
        methods.push(serde_json::json!({ "name": b, "configured": true, "browser": true, "hidden": false }));
    }
    Ok(Json(serde_json::json!({ "methods": methods })))
}

/// handle_usage_aggregate 用量聚合（管理面运维）。
pub async fn handle_usage_aggregate(
    State(state): State<Arc<AppState>>,
    payload: Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let group = payload.get("group").and_then(|v| v.as_str()).unwrap_or("day");
    let rows = picoaide_dsh_store::aggregate::usage_aggregate(
        &state.pool,
        None,
        None,
        group,
        &picoaide_dsh_store::aggregate::UsageAggregateQuery::default(),
    )
    .await
    .map_err(|e| service_error(500, "INTERNAL", &e.to_string()))?;
    let items: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| serde_json::json!({ "label": r.label, "prompt_tokens": r.prompt_tokens, "completion_tokens": r.completion_tokens, "requests": r.requests, "cost": r.cost }))
        .collect();
    Ok(Json(serde_json::json!({ "rows": items })))
}
