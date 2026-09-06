//! PicoAide 认证层（Go `serverauth` 等价）。
//!
//! 密码 provider（local）、浏览器 provider（OIDC）、令牌签发/验证、RBAC。

pub mod admin_session;
pub mod config;
pub mod local;
pub mod mfa;
pub mod ratelimit;
pub mod rbac;
pub mod token;

pub use admin_session::{create_admin_session, validate_admin_session, verify_csrf, issue_csrf, AdminSession};
pub use config::{configure_providers, strip_prefix, ConfiguredApi};
pub use local::{local_provider_authenticate, UserInfo};
pub use mfa::{bump_mfa_challenge_attempts, consume_mfa_challenge, create_mfa_challenge, get_mfa_challenge, MfaChallenge};
pub use ratelimit::{login_allowed, login_key, LoginLimiter};
pub use rbac::{has_permission, permissions_of};
pub use token::{issue_token, revoke_token, verify_token, TOKEN_TTL_SECS};
