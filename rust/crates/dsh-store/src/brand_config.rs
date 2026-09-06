//! 品牌/门户配置模型（Go `internal/brand/brand.go` 的配置 load/save 等价）。
//!
//! 纯配置逻辑：BrandConfig/PortalConfig 与 settings 键一一映射。
//! HTTP 端点（logo 上传/快照）留给 router 集成层。

use crate::errors::StoreError;

pub const MAX_LOGO_BYTES: usize = 4 << 20;
pub const MAX_SNAPSHOT_KEEP: i32 = 10;

/// LoginBrand 登录页品牌。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct LoginBrand {
    pub logo_url: String,
    pub display_name: String,
    pub tagline: String,
    pub welcome: String,
}

/// ClientBrand 客户端品牌。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ClientBrand {
    pub logo_url: String,
    pub display_name: String,
    pub tagline: String,
}

/// BrandConfig 品牌配置（JSON 形态，与 settings 键一一映射）。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct BrandConfig {
    pub enabled: bool,
    pub login: LoginBrand,
    pub client: ClientBrand,
    pub favicon_url: String,
    pub title: String,
}

impl BrandConfig {
    /// load 从 settings map 加载（Go BrandConfig.load 等价）。
    pub fn load(s: &std::collections::HashMap<String, String>) -> Self {
        let login_logo = s.get("brand.login.logo").map(|v| v.as_str()).unwrap_or("");
        let client_logo = s.get("brand.client.logo").map(|v| v.as_str()).unwrap_or("");
        let favicon = s.get("brand.favicon").map(|v| v.as_str()).unwrap_or("");
        BrandConfig {
            enabled: s.get("brand.enabled").map(|v| v == "true").unwrap_or(false),
            login: LoginBrand {
                logo_url: if login_logo.is_empty() { String::new() } else { "/api/client/v2/brand/logo/login".into() },
                display_name: s.get("brand.login.display_name").cloned().unwrap_or_default(),
                tagline: s.get("brand.login.tagline").cloned().unwrap_or_default(),
                welcome: s.get("brand.login.welcome").cloned().unwrap_or_default(),
            },
            client: ClientBrand {
                logo_url: if client_logo.is_empty() { String::new() } else { "/api/client/v2/brand/logo/client".into() },
                display_name: s.get("brand.client.display_name").cloned().unwrap_or_default(),
                tagline: s.get("brand.client.tagline").cloned().unwrap_or_default(),
            },
            favicon_url: if favicon.is_empty() { String::new() } else { "/api/client/v2/brand/logo/favicon".into() },
            title: s.get("brand.title").cloned().unwrap_or_default(),
        }
    }

    /// load_from_db 从 settings 表加载。
    pub async fn load_from_db(pool: &sqlx::PgPool) -> Result<Self, StoreError> {
        let all = crate::settings::get_all_settings(pool).await?;
        Ok(Self::load(&all))
    }

    /// save 写回 settings（set 回调可管道到 SetSetting）。
    pub async fn save(&self, pool: &sqlx::PgPool) -> Result<(), StoreError> {
        let kv: Vec<(&str, String)> = vec![
            ("brand.enabled", self.enabled.to_string()),
            ("brand.login.display_name", self.login.display_name.clone()),
            ("brand.login.tagline", self.login.tagline.clone()),
            ("brand.login.welcome", self.login.welcome.clone()),
            ("brand.client.display_name", self.client.display_name.clone()),
            ("brand.client.tagline", self.client.tagline.clone()),
            ("brand.title", self.title.clone()),
        ];
        for (k, v) in kv {
            crate::settings::set_setting(pool, k, &v).await?;
        }
        Ok(())
    }
}

/// PortalConfig 门户首页配置。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct PortalConfig {
    pub enabled: bool,
    pub public: bool,
    pub welcome: String,
    pub subtitle: String,
    pub client_download_url: String,
    pub client_download_linux: String,
    pub client_download_mac: String,
    pub client_download_win: String,
    pub client_download_note: String,
    pub landing_path: String,
}

impl PortalConfig {
    /// load 从 settings map 加载。
    pub fn load(s: &std::collections::HashMap<String, String>) -> Self {
        PortalConfig {
            enabled: s.get("portal.enabled").map(|v| v != "false").unwrap_or(true),
            public: s.get("portal.public").map(|v| v != "false").unwrap_or(true),
            welcome: s.get("portal.welcome").cloned().unwrap_or_default(),
            subtitle: s.get("portal.subtitle").cloned().unwrap_or_default(),
            client_download_url: s.get("portal.client_download_url").cloned().unwrap_or_default(),
            client_download_linux: s.get("portal.client_download_linux").cloned().unwrap_or_default(),
            client_download_mac: s.get("portal.client_download_mac").cloned().unwrap_or_default(),
            client_download_win: s.get("portal.client_download_win").cloned().unwrap_or_default(),
            client_download_note: s.get("portal.client_download_note").cloned().unwrap_or_default(),
            landing_path: s.get("portal.landing_path").cloned().unwrap_or_default(),
        }
    }

    /// load_from_db 从 settings 表加载。
    pub async fn load_from_db(pool: &sqlx::PgPool) -> Result<Self, StoreError> {
        let all = crate::settings::get_all_settings(pool).await?;
        Ok(Self::load(&all))
    }

    /// save 写回 settings。
    pub async fn save(&self, pool: &sqlx::PgPool) -> Result<(), StoreError> {
        let kv: Vec<(&str, String)> = vec![
            ("portal.enabled", self.enabled.to_string()),
            ("portal.public", self.public.to_string()),
            ("portal.welcome", self.welcome.clone()),
            ("portal.subtitle", self.subtitle.clone()),
            ("portal.client_download_url", self.client_download_url.clone()),
            ("portal.client_download_linux", self.client_download_linux.clone()),
            ("portal.client_download_mac", self.client_download_mac.clone()),
            ("portal.client_download_win", self.client_download_win.clone()),
            ("portal.client_download_note", self.client_download_note.clone()),
            ("portal.landing_path", self.landing_path.clone()),
        ];
        for (k, v) in kv {
            crate::settings::set_setting(pool, k, &v).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;
    use std::collections::HashMap;

    fn s(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn brand_load_mapping() {
        let map = s(&[
            ("brand.enabled", "true"),
            ("brand.login.display_name", "PicoAide"),
            ("brand.login.tagline", "tag"),
            ("brand.login.logo", "f.png"),
            ("brand.client.display_name", "Client"),
            ("brand.favicon", "fav.png"),
            ("brand.title", "PicoAide 控制台"),
        ]);
        let b = BrandConfig::load(&map);
        assert!(b.enabled);
        assert_eq!(b.login.display_name, "PicoAide");
        assert_eq!(b.login.logo_url, "/api/client/v2/brand/logo/login");
        assert_eq!(b.favicon_url, "/api/client/v2/brand/logo/favicon");
        assert_eq!(b.title, "PicoAide 控制台");
    }

    #[test]
    fn portal_load_defaults() {
        let p = PortalConfig::load(&s(&[]));
        assert!(p.enabled);
        assert!(p.public);
        let p2 = PortalConfig::load(&s(&[("portal.public", "false")]));
        assert!(!p2.public);
    }

    #[tokio::test]
    async fn brand_save_roundtrip() {
        let pool = new_test_db().await;
        let mut b = BrandConfig::load(&s(&[]));
        b.enabled = true;
        b.login.display_name = "PicoAide".into();
        b.save(&pool).await.unwrap();
        let loaded = BrandConfig::load_from_db(&pool).await.unwrap();
        assert!(loaded.enabled);
        assert_eq!(loaded.login.display_name, "PicoAide");
    }
}
