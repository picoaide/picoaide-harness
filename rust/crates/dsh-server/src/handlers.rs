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
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    let svc = crate::bootstrap_service::BootstrapService::new(state.pool.clone());
    svc.build("anonymous", false)
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
