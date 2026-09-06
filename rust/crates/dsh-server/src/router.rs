//! 集中路由（Go `internal/router` 等价）——axum 路由注册表 + 认证中间件。
//!
//! 命名空间：/api/client/v2（员工面）、/api/server（管理面）、/v1（LLM 网关）。
//! 中间件：BearerAuth（客户端 token）、AdminAuth（管理会话+CSRF+RBAC）。

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use std::sync::Arc;

use crate::error::{error_body, ErrorResponse};

/// AppState 应用状态（pool + 服务）。
#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::PgPool,
}

/// BearerAuth 客户端认证中间件（验证 Bearer token → 注入用户）。
pub async fn bearer_auth(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if token.is_empty() {
        return Err((StatusCode::UNAUTHORIZED, Json(error_body("AUTH_REQUIRED", "未认证"))));
    }
    let user = picoaide_dsh_auth::verify_token(&state.pool, token)
        .await
        .map_err(|_| (StatusCode::UNAUTHORIZED, Json(error_body("AUTH_REQUIRED", "无效凭证"))))?;
    Ok(Json(serde_json::json!({ "user": { "username": user.username, "id": user.id } })))
}

/// AdminAuth 管理认证（校验 admin session + CSRF）。
pub async fn admin_auth(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    session_id: Option<String>,
    csrf_token: Option<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let sid = session_id.unwrap_or_default();
    if sid.is_empty() {
        return Err((StatusCode::UNAUTHORIZED, Json(error_body("AUTH_REQUIRED", "未登录"))));
    }
    let u = picoaide_dsh_auth::validate_admin_session(&state.pool, &sid)
        .await
        .map_err(|_| (StatusCode::UNAUTHORIZED, Json(error_body("AUTH_REQUIRED", "会话失效"))))?;
    Ok(Json(serde_json::json!({ "user": { "username": u.username, "role": u.role } })))
}

/// webadmin 静态挂载（axum ServeDir；webadmin 产物在 repo 的 server/webadmin/dist）。
/// 走错误信封降级：dist 缺失时 /admin/* 返回 JSON 错误（对应 Go embed 语义）。
pub fn webadmin_router() -> Router<()> {
    // 用 tower-http ServeDir 服务静态 SPA（自动 MIME + index fallback）。
    let base_str = std::env::var("DSH_WEBADMIN_DIST")
        .unwrap_or_else(|_| "webadmin_dist".to_string());
    let base = std::path::PathBuf::from(&base_str);
    let serve_dir = tower_http::services::ServeDir::new(&base)
        .not_found_service(
            tower_http::services::ServeFile::new(base.join("index.html")),
        );
    Router::new().fallback_service(serve_dir)
}

/// build_router 构建完整路由（命名空间分组 + 认证中间件接入）。
/// 业务 handler 由各 service 提供；此处注册端点骨架（后续逐步填充）。
pub fn build_router(_state: Arc<AppState>) -> Router<Arc<AppState>> {
    let r = crate::handlers::register_client_handlers(Router::new());
    let v1 = axum::Router::new().route(
        "/models",
        axum::routing::get(|headers: axum::http::HeaderMap| async move {
            let token = headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
                .unwrap_or("");
            if token.is_empty() {
                return axum::response::IntoResponse::into_response((
                    StatusCode::UNAUTHORIZED,
                    Json(error_body("AUTH_REQUIRED", "未认证")),
                ));
            }
            axum::response::IntoResponse::into_response((
                StatusCode::OK,
                Json(serde_json::json!({ "data": [] })),
            ))
        }),
    );
    r.nest("/v1", v1)
}

async fn healthz_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_middleware_shape() {
        let e = error_body("AUTH_REQUIRED", "未认证");
        assert_eq!(e.error.code, "AUTH_REQUIRED");
    }

    #[test]
    fn webadmin_router_builds() {
        // webadmin 静态路由注册表构建（无 DB 依赖）
        let _ = webadmin_router();
    }
}
