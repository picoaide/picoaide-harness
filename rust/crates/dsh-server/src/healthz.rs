//! 健康探针（Go `/healthz` JSON 探针等价）。

use serde::Serialize;

/// HealthzResponse 健康探针响应（无需认证返回 200）。
#[derive(Debug, Clone, Serialize)]
pub struct HealthzResponse {
    pub status: &'static str,
}

/// Healthz 构造探针响应。
pub fn healthz() -> HealthzResponse {
    HealthzResponse { status: "ok" }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthz_ok() {
        let r = healthz();
        assert_eq!(r.status, "ok");
        let json = serde_json::to_string(&r).unwrap();
        assert_eq!(json, r#"{"status":"ok"}"#);
    }
}
