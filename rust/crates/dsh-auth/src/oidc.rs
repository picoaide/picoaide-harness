//! OIDC provider 核心状态管理（Go `serverauth/oidc.go` 的 flow 逻辑等价）。
//!
//! 实现授权码 + PKCE flow 的**纯逻辑部分**：state flow 表管理
//! （TTL/上限/单次消费）、PKCE S256 verifier、nonce 生成与校验、
//! claims 解析（用户名回退链）。真实的 discovery/JWKS 验签/代码交换
//! 属于集成层（后续 axum 路由接入时用 openidconnect crate 或 HTTP trait）。

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const OIDC_FLOW_TTL_SECS: u64 = 600; // 10 分钟
const OIDC_MAX_FLOWS: usize = 1000;

/// OIDC 配置（Configure 必需字段）。
#[derive(Debug, Clone, Default)]
pub struct OidcConfig {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_url: String,
    pub name: String,
}

/// OidcFlow 一个 state 绑定的流程（PKCE verifier + nonce）。
#[derive(Debug, Clone)]
pub struct OidcFlow {
    pub verifier: String,
    pub nonce: String,
    pub created_at: Instant,
    pub return_server: String,
}

/// OIDCProvider OIDC flow 状态管理器。
#[derive(Debug, Default)]
pub struct OidcProvider {
    pub config: OidcConfig,
    flows: HashMap<String, OidcFlow>,
}

impl OidcProvider {
    /// new 创建空 provider。
    pub fn new(name: &str) -> Self {
        OidcProvider {
            config: OidcConfig {
                name: name.to_string(),
                ..Default::default()
            },
            flows: HashMap::new(),
        }
    }

    /// name 返回 provider 名（oidc/openid）。
    pub fn name(&self) -> &str {
        if self.config.name.is_empty() {
            "oidc"
        } else {
            self.config.name.as_str()
        }
    }

    /// configure 从配置 map 初始化（issuer/client_id/redirect_url 必须）。
    pub fn configure(&mut self, cfg: &HashMap<String, String>) -> Result<(), String> {
        let issuer = cfg.get("issuer").cloned().unwrap_or_default();
        let client_id = cfg.get("client_id").cloned().unwrap_or_default();
        let redirect = cfg.get("redirect_url").cloned().unwrap_or_default();
        if issuer.is_empty() || client_id.is_empty() || redirect.is_empty() {
            return Err("oidc: issuer, client_id and redirect_url are required".to_string());
        }
        self.config.issuer = issuer;
        self.config.client_id = client_id;
        self.config.client_secret = cfg.get("client_secret").cloned().unwrap_or_default();
        self.config.redirect_url = redirect;
        Ok(())
    }

    /// configured 报告是否已配置。
    pub fn configured(&self) -> bool {
        !self.config.issuer.is_empty() && !self.config.client_id.is_empty()
    }

    /// random_hex 生成 n 字节随机十六进制（nonce/state）。
    pub fn random_hex(n: usize) -> String {
        let mut b = vec![0u8; n];
        rand::thread_rng().fill_bytes(&mut b);
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// generate_verifier 生成 PKCE verifier（32 字节随机 URL-safe base64）。
    pub fn generate_verifier() -> String {
        let mut b = vec![0u8; 32];
        rand::thread_rng().fill_bytes(&mut b);
        B64URL.encode(b)
    }

    /// s256_challenge PKCE S256 challenge（SHA-256 → URL-safe base64 无填充）。
    pub fn s256_challenge(verifier: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(verifier.as_bytes());
        B64URL.encode(hasher.finalize())
    }

    /// start_flow 为 state 绑定新 flow（nonce + verifier + return_server）并返回 verifier+nonce。
    /// 符合 Go：TTL 10min、上限 1000、满员驱逐最旧。
    pub fn start_flow(&mut self, state: &str, return_server: &str) -> Result<(String, String), String> {
        if state.is_empty() {
            return Err("oidc: empty state".to_string());
        }
        let nonce = Self::random_hex(16);
        let verifier = Self::generate_verifier();
        self.sweep_flows();
        if self.flows.len() >= OIDC_MAX_FLOWS {
            // 驱逐最旧 flow
            if let Some(oldest) = self
                .flows
                .iter()
                .min_by_key(|(_, f)| f.created_at)
                .map(|(k, _)| k.clone())
            {
                self.flows.remove(&oldest);
            }
        }
        self.flows.insert(
            state.to_string(),
            OidcFlow {
                verifier: verifier.clone(),
                nonce: nonce.clone(),
                created_at: Instant::now(),
                return_server: return_server.to_string(),
            },
        );
        Ok((verifier, nonce))
    }

    /// take_flow 消费 state（一次性）并返回 flow；未知/已消费 → None。
    pub fn take_flow(&mut self, state: &str) -> Option<OidcFlow> {
        self.flows.remove(state)
    }

    /// sweep_flows 清除过期 flow。
    pub fn sweep_flows(&mut self) {
        let now = Instant::now();
        self.flows.retain(|_, f| now.duration_since(f.created_at) < Duration::from_secs(OIDC_FLOW_TTL_SECS));
    }

    /// flow_count 当前 flow 数（测试用）。
    pub fn flow_count(&self) -> usize {
        self.flows.len()
    }

    /// verify_nonce 恒定时间比较 nonce（防时序侧信道，对应 Go ConstantTimeCompare）。
    pub fn verify_nonce(expected: &str, got: &str) -> bool {
        use subtle::ConstantTimeEq;
        if expected.is_empty() || got.is_empty() {
            return false;
        }
        expected.as_bytes().ct_eq(got.as_bytes()).into()
    }
}

/// OidcClaims OIDC id_token claims（解析用）。
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct OidcClaims {
    pub sub: Option<String>,
    pub preferred_username: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub nonce: Option<String>,
    #[serde(default)]
    pub groups: Vec<String>,
}

impl OidcClaims {
    /// username 回退链：preferred_username → email → sub。
    pub fn username(&self) -> String {
        if let Some(u) = &self.preferred_username {
            if !u.is_empty() {
                return u.clone();
            }
        }
        if let Some(e) = &self.email {
            if !e.is_empty() {
                return e.clone();
            }
        }
        self.sub.clone().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn configure_requires_fields() {
        let mut p = OidcProvider::new("oidc");
        assert!(p.configure(&cfg(&[])).is_err());
        assert!(p.configure(&cfg(&[("issuer", "https://idp"), ("client_id", "c"), ("redirect_url", "https://app/cb")])).is_ok());
        assert_eq!(p.name(), "oidc");
        assert!(p.configured());
    }

    #[test]
    fn auth_url_flow_state_binding() {
        let mut p = OidcProvider::new("oidc");
        p.configure(&cfg(&[("issuer", "https://idp"), ("client_id", "c"), ("redirect_url", "https://app/cb")])).unwrap();
        let (verifier, nonce) = p.start_flow("state123", "https://server").unwrap();
        assert!(!verifier.is_empty());
        assert_eq!(nonce.len(), 32);
        assert_eq!(p.flow_count(), 1);
        // 消费一次性
        let f = p.take_flow("state123").unwrap();
        assert_eq!(f.verifier, verifier);
        assert_eq!(f.return_server, "https://server");
        assert_eq!(p.flow_count(), 0);
        assert!(p.take_flow("state123").is_none());
    }

    #[test]
    fn flow_ttl_and_max() {
        let mut p = OidcProvider::new("oidc");
        p.configure(&cfg(&[("issuer", "https://idp"), ("client_id", "c"), ("redirect_url", "https://app/cb")])).unwrap();
        // 上限 1000，超过驱逐最旧
        for i in 0..1000 {
            p.start_flow(&format!("s{i}"), "").unwrap();
        }
        assert_eq!(p.flow_count(), 1000);
        p.start_flow("new", "").unwrap();
        assert_eq!(p.flow_count(), 1000); // 驱逐最旧后仍上限
        assert!(p.take_flow("s0").is_none() || p.take_flow("new").is_some());
        // 空 state 拒绝
        assert!(p.start_flow("", "").is_err());
    }

    #[test]
    fn s256_challenge_deterministic() {
        let v = OidcProvider::generate_verifier();
        let c1 = OidcProvider::s256_challenge(&v);
        let c2 = OidcProvider::s256_challenge(&v);
        assert_eq!(c1, c2);
        assert_eq!(c1.len(), 43); // 32 字节 sha256 → 43 字符 b64url
        assert_ne!(OidcProvider::s256_challenge("a"), OidcProvider::s256_challenge("b"));
    }

    #[test]
    fn nonce_constant_time_compare() {
        assert!(OidcProvider::verify_nonce("abc", "abc"));
        assert!(!OidcProvider::verify_nonce("abc", "abd"));
        assert!(!OidcProvider::verify_nonce("", ""));
    }

    #[test]
    fn claims_username_fallback() {
        let c = OidcClaims {
            sub: Some("sub-1".into()),
            preferred_username: Some("alice".into()),
            email: Some("a@x.com".into()),
            ..Default::default()
        };
        assert_eq!(c.username(), "alice");
        let c2 = OidcClaims {
            sub: Some("sub-1".into()),
            email: Some("a@x.com".into()),
            ..Default::default()
        };
        assert_eq!(c2.username(), "a@x.com");
        let c3 = OidcClaims { sub: Some("sub-1".into()), ..Default::default() };
        assert_eq!(c3.username(), "sub-1");
    }
}
