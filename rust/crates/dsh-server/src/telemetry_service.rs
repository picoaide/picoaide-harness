//! 遥测服务（Go `server/internal/telemetry` 等价）。
//!
//! 客户端上报 skill-call 事件：服务端递增技能调用计数（0040）。
//! 未知技能静默忽略（ok=true）；字段校验（name/version 长度、非法字符）。

use picoaide_dsh_store::errors::StoreError;
use serde_json::{json, Value};
use sqlx::PgPool;

pub const MAX_NAME_LEN: usize = 128;

/// TelemetryService 遥测服务。
#[derive(Clone)]
pub struct TelemetryService {
    pub pool: PgPool,
}

impl TelemetryService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// report_skill_call 上报技能调用（name/version 校验；未知技能静默 ok）。
    pub async fn report_skill_call(&self, name: &str, version: &str) -> Result<Value, StoreError> {
        let name = name.trim();
        if name.is_empty() || name.len() > MAX_NAME_LEN || name.contains(['/', '\\']) {
            return Err(StoreError::Validation);
        }
        let version = version.trim();
        if version.len() > MAX_NAME_LEN {
            return Err(StoreError::Validation);
        }
        // 未知技能静默忽略：调用失败不阻断（ok=true 语义由上层处理）。
        let _ = picoaide_dsh_store::skills::increment_skill_call(&self.pool, name, version).await;
        Ok(json!({ "ok": true }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use picoaide_dsh_store::testutil::new_test_db;

    #[tokio::test]
    async fn telemetry_report_ok() {
        let pool = new_test_db().await;
        let svc = TelemetryService::new(pool);
        let r = svc.report_skill_call("my-skill", "1.0.0").await.unwrap();
        assert_eq!(r["ok"], true);
    }

    #[tokio::test]
    async fn telemetry_invalid_name() {
        let pool = new_test_db().await;
        let svc = TelemetryService::new(pool);
        // 空名拒绝
        assert!(svc.report_skill_call("", "1.0.0").await.is_err());
        // 非法字符拒绝
        assert!(svc.report_skill_call("a/b", "1.0.0").await.is_err());
        // 超长拒绝
        let long = "a".repeat(129);
        assert!(svc.report_skill_call(&long, "1.0.0").await.is_err());
    }
}
