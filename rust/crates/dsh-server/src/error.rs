//! JSON 错误信封（server/AGENTS.md §7 契约）。
//!
//! 所有 Go API 端点失败必须返回 `{"error":{"code":"ERR_CODE","message":"..."}}`。

use axum::Json;
use serde::Serialize;

/// ErrorBody 错误信封的 body。
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

/// ErrorResponse 完整错误响应。
#[derive(Debug, Clone, Serialize)]
pub struct ErrorResponse {
    pub error: ErrorBody,
}

/// ERROR_INTERNAL 通用内部错误码。
pub const ERROR_INTERNAL: &str = "INTERNAL";

/// error_body 构造错误信封。
pub fn error_body(code: &str, message: &str) -> ErrorResponse {
    ErrorResponse {
        error: ErrorBody {
            code: code.to_string(),
            message: message.to_string(),
        },
    }
}

/// write_json_error 生成 JSON 错误响应（可返回给 axum handler）。
pub fn write_json_error(code: &str, message: &str) -> Json<ErrorResponse> {
    Json(error_body(code, message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_shape() {
        let e = error_body("AUTH_REQUIRED", "未登录");
        assert_eq!(e.error.code, "AUTH_REQUIRED");
        assert_eq!(e.error.message, "未登录");
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"error\""));
        assert!(json.contains("\"code\""));
        assert!(json.contains("\"message\""));
    }
}
