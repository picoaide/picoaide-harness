//! 认证配置解析（Go `serverauth/config.go` 的纯解析部分等价）。
//!
//! settings 键:
//!   auth.enabled  local,ldap,openid,oidc（逗号分隔；优先级高于 auth.mode）
//!   auth.mode     local|ldap|both|oidc|openid（向后兼容推导）

use std::collections::HashMap;

/// EnabledProviders 从 settings 推导启用的 password/browser provider 名。
/// 强制本地 admin：任何模式都含 local（管理员回退）。
pub fn enabled_providers(settings: &HashMap<String, String>) -> (Vec<String>, Vec<String>) {
    let mode = settings.get("auth.mode").cloned().unwrap_or_else(|| "local".to_string());
    let enabled_raw = settings.get("auth.enabled").cloned().unwrap_or_default();
    let mut enabled: Vec<String> = Vec::new();
    if !enabled_raw.trim().is_empty() {
        for p in enabled_raw.split(',') {
            let p = p.trim();
            if !p.is_empty() {
                enabled.push(p.to_string());
            }
        }
    } else {
        match mode.as_str() {
            "ldap" | "both" => enabled = vec!["local".into(), "ldap".into()],
            "oidc" => enabled = vec!["local".into(), "oidc".into()],
            "openid" => enabled = vec!["local".into(), "openid".into()],
            _ => enabled = vec!["local".into()],
        }
    }
    let has = |name: &str| enabled.iter().any(|e| e == name);
    let mut pwds = Vec::new();
    if has("local") {
        pwds.push("local".to_string());
    }
    if has("ldap") {
        pwds.push("ldap".to_string());
    }
    if !has("local") {
        pwds.insert(0, "local".to_string());
    }
    // 两套 IdP 独立配置并存（openid.* 与 oidc.*）
    let mut browsers = Vec::new();
    if has("oidc") {
        browsers.push("oidc".to_string());
    }
    if has("openid") {
        browsers.push("openid".to_string());
    }
    (pwds, browsers)
}

/// strip_prefix 提取指定前缀的子 map。
pub fn strip_prefix(m: &HashMap<String, String>, prefix: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (k, v) in m {
        if let Some(rest) = k.strip_prefix(prefix) {
            out.insert(rest.to_string(), v.clone());
        }
    }
    out
}

/// ConfiguredApi 配置好的 auth 状态占位（完整 API 在 axum 层）。
#[derive(Debug, Default)]
pub struct ConfiguredApi {
    pub password_providers: Vec<String>,
    pub browser_providers: Vec<String>,
}

/// configure_providers 从 settings 推导 provider 名单（等价 ConfigureProviders 的核心）。
pub fn configure_providers(settings: &HashMap<String, String>) -> ConfiguredApi {
    let (pwds, browsers) = enabled_providers(settings);
    ConfiguredApi {
        password_providers: pwds,
        browser_providers: browsers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn default_is_local() {
        let (pwds, _) = enabled_providers(&s(&[]));
        assert_eq!(pwds, vec!["local"]);
    }

    #[test]
    fn enabled_overrides_mode() {
        let (pwds, bw) = enabled_providers(&s(&[
            ("auth.enabled", "ldap, openid"),
            ("auth.mode", "local"),
        ]));
        assert_eq!(pwds, vec!["local", "ldap"]);
        assert_eq!(bw, vec!["openid"]);
    }

    #[test]
    fn mode_backward_compat() {
        let (pwds, bw) = enabled_providers(&s(&[("auth.mode", "oidc")]));
        assert_eq!(pwds, vec!["local"]);
        assert_eq!(bw, vec!["oidc"]);
    }

    #[test]
    fn local_always_present() {
        let (pwds, _) = enabled_providers(&s(&[("auth.enabled", "ldap")]));
        assert_eq!(pwds, vec!["local", "ldap"]);
    }

    #[test]
    fn strip_prefix_works() {
        let m = s(&[("ldap.server_url", "x"), ("ldap.bind_dn", "y"), ("auth.mode", "local")]);
        let sub = strip_prefix(&m, "ldap.");
        assert_eq!(sub.len(), 2);
        assert_eq!(sub.get("server_url").map(|v| v.as_str()), Some("x"));
    }
}
