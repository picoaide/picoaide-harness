//! 品牌服务层（Go `internal/brand` 的公开端点逻辑等价）。
//!
//! 公开品牌/门户配置 + logo 路径解析。HTTP 端点绑定留 router 层。

use picoaide_dsh_store::brand_config::{BrandConfig, PortalConfig};
use picoaide_dsh_store::errors::StoreError;
use serde_json::{json, Value};
use sqlx::PgPool;

/// BrandService 品牌服务。
#[derive(Clone)]
pub struct BrandService {
    pub pool: PgPool,
}

impl BrandService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// public_brand 公开品牌配置（禁用不吐旧值）。
    pub async fn public_brand(&self) -> Result<Value, StoreError> {
        let b = BrandConfig::load_from_db(&self.pool).await?;
        if !b.enabled {
            return Ok(json!({ "enabled": false }));
        }
        Ok(serde_json::to_value(&b).unwrap_or(json!({ "enabled": false })))
    }

    /// public_portal 公开门户配置。
    pub async fn public_portal(&self) -> Result<Value, StoreError> {
        let p = PortalConfig::load_from_db(&self.pool).await?;
        Ok(serde_json::to_value(&p).unwrap_or(json!({ "enabled": true })))
    }

    /// admin_brand 管理端品牌配置。
    pub async fn admin_brand(&self) -> Result<Value, StoreError> {
        let b = BrandConfig::load_from_db(&self.pool).await?;
        Ok(serde_json::to_value(&b).unwrap_or_default())
    }

    /// save_brand 保存品牌配置。
    pub async fn save_brand(&self, b: &BrandConfig) -> Result<Value, StoreError> {
        b.save(&self.pool).await?;
        Ok(json!({ "ok": true }))
    }

    /// save_portal 保存门户配置。
    pub async fn save_portal(&self, p: &PortalConfig) -> Result<Value, StoreError> {
        p.save(&self.pool).await?;
        Ok(json!({ "ok": true }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use picoaide_dsh_store::testutil::new_test_db;

    #[tokio::test]
    async fn brand_disabled_returns_empty() {
        let pool = new_test_db().await;
        let svc = BrandService::new(pool);
        let r = svc.public_brand().await.unwrap();
        assert_eq!(r["enabled"], false);
    }

    #[tokio::test]
    async fn brand_enable_roundtrip() {
        let pool = new_test_db().await;
        let svc = BrandService::new(pool.clone());
        let mut b = BrandConfig::load(&Default::default());
        b.enabled = true;
        b.login.display_name = "PicoAide".into();
        svc.save_brand(&b).await.unwrap();
        let r = svc.public_brand().await.unwrap();
        assert_eq!(r["enabled"], true);
        assert_eq!(r["login"]["display_name"], "PicoAide");
        // portal
        let p = PortalConfig::load_from_db(&pool).await.unwrap();
        assert!(p.enabled);
    }
}
