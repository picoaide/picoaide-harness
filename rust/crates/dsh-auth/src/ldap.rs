//! LDAP 认证 provider（Go `serverauth/ldap.go` 等价）——核心逻辑 + 可注入连接。
//!
//! 设计：网络操作封装在 [`LdapConn`] trait（对应 Go ldapConn 接口），
//! 生产实现用 ldap3 异步连接；测试用内存 fake 验证业务逻辑
//! （Configure/username_of/display_name/filter 替换/组解析）。

use serde::Serialize;
use std::collections::HashMap;

const LDAP_TIMEOUT_SECS: u64 = 5;
/// ldapSearchPagingSize 每条 LDAP 页大小（全目录扫描保持内存平稳）。
const LDAP_SEARCH_PAGING_SIZE: u32 = 200;

/// DirectoryUser 一个目录条目（全量扫描捕获）。
#[derive(Debug, Clone, Default, Serialize)]
pub struct DirectoryUser {
    pub username: String,
    pub display_name: String,
    pub email: String,
    pub groups: Vec<String>,
}

/// DirectoryReport 全目录扫描摘要（webadmin 测试连接）。
#[derive(Debug, Clone, Default, Serialize)]
pub struct DirectoryReport {
    pub users: usize,
    pub groups: usize,
    pub sample: Vec<DirectoryUser>,
}

/// LdapEntry 目录条目（跨实现统一，对应 go-ldap Entry 字段子集）。
#[derive(Debug, Clone, Default)]
pub struct LdapEntry {
    pub dn: String,
    /// 属性名 → 值列表。
    pub attrs: HashMap<String, Vec<String>>,
}

impl LdapEntry {
    pub fn attr(&self, name: &str) -> String {
        self.attrs.get(name).and_then(|v| v.first()).cloned().unwrap_or_default()
    }
}

/// LdapConn 连接抽象（Go ldapConn 接口等价；可 fake 注入测试）。
#[async_trait::async_trait]
pub trait LdapConn {
    async fn bind(&mut self, dn: &str, password: &str) -> Result<(), String>;
    async fn search(&mut self, base: &str, filter: &str, attrs: &[String]) -> Result<Vec<LdapEntry>, String>;
}

/// LdapProvider LDAP 认证 provider。
#[derive(Debug, Clone)]
pub struct LdapProvider {
    pub server_url: String,
    pub bind_dn: String,
    pub bind_password: String,
    pub base_dn: String,
    pub user_filter: String,
    pub user_attr: String,
    pub group_filter: String,
    pub group_attr: String,
}

impl LdapProvider {
    pub fn new() -> Self {
        LdapProvider {
            server_url: String::new(),
            bind_dn: String::new(),
            bind_password: String::new(),
            base_dn: String::new(),
            user_filter: "(uid=%s)".to_string(),
            user_attr: "uid".to_string(),
            group_filter: String::new(),
            group_attr: "cn".to_string(),
        }
    }

    /// configure 从配置 map 初始化（Go Configure 等价）。
    pub fn configure(&mut self, cfg: &HashMap<String, String>) -> Result<(), String> {
        self.server_url = cfg.get("server_url").cloned().unwrap_or_default();
        self.bind_dn = cfg.get("bind_dn").cloned().unwrap_or_default();
        self.bind_password = cfg.get("bind_password").cloned().unwrap_or_default();
        self.base_dn = cfg.get("base_dn").cloned().unwrap_or_default();
        self.user_filter = cfg.get("user_filter").cloned().unwrap_or_else(|| "(uid=%s)".to_string());
        if self.user_filter.is_empty() {
            self.user_filter = "(uid=%s)".to_string();
        }
        self.user_attr = cfg.get("user_attr").cloned().unwrap_or_else(|| "uid".to_string());
        if self.user_attr.is_empty() {
            self.user_attr = "uid".to_string();
        }
        self.group_filter = cfg.get("group_filter").cloned().unwrap_or_default();
        self.group_attr = cfg.get("group_attr").cloned().unwrap_or_else(|| "cn".to_string());
        if self.group_attr.is_empty() {
            self.group_attr = "cn".to_string();
        }
        if self.server_url.is_empty() || self.base_dn.is_empty() {
            return Err("ldap: server_url and base_dn are required".to_string());
        }
        Ok(())
    }

    /// user_scan_filter 全量扫描用户过滤器（%s → *）。
    pub fn user_scan_filter(&self) -> String {
        if self.user_filter.contains("%s") {
            self.user_filter.replace("%s", "*")
        } else {
            self.user_filter.clone()
        }
    }

    /// group_scan_filter 组扫描过滤器（%s → *）。
    pub fn group_scan_filter(&self) -> String {
        if self.group_filter.contains("%s") {
            self.group_filter.replace("%s", "*")
        } else {
            self.group_filter.clone()
        }
    }

    /// username_of 取条目规范用户名（user_attr → cn → mail → DN RDN）。
    pub fn username_of(&self, e: &LdapEntry) -> String {
        let attr = if self.user_attr.is_empty() { "uid" } else { self.user_attr.as_str() };
        if let Some(v) = e.attrs.get(attr).and_then(|a| a.first()) {
            if !v.trim().is_empty() {
                return v.trim().to_string();
            }
        }
        for a in ["cn", "mail"] {
            if let Some(v) = e.attrs.get(a).and_then(|a| a.first()) {
                if !v.trim().is_empty() {
                    return v.trim().to_string();
                }
            }
        }
        if !e.dn.is_empty() {
            if let Some(i) = e.dn.find('=') {
                let rest = &e.dn[i + 1..];
                let j = rest.find(',').unwrap_or(rest.len());
                return rest[..j].trim().to_string();
            }
        }
        String::new()
    }

    /// display_name 取显示名：sn → cn。
    pub fn display_name(&self, e: &LdapEntry) -> String {
        if let Some(v) = e.attrs.get("sn").and_then(|a| a.first()) {
            if !v.trim().is_empty() {
                return v.trim().to_string();
            }
        }
        e.attr("cn").trim().to_string()
    }

    /// email_of 取邮箱。
    pub fn email_of(&self, e: &LdapEntry) -> String {
        e.attr("mail")
    }

    /// login_username 登录规范化（只取 user_attr；缺失回退输入，防 Alice/alice 分裂）。
    pub fn login_username(&self, e: &LdapEntry, dst: &str) -> String {
        let attr = if self.user_attr.is_empty() { "uid" } else { self.user_attr.as_str() };
        if let Some(v) = e.attrs.get(attr).and_then(|a| a.first()) {
            if !v.trim().is_empty() {
                return v.trim().to_string();
            }
        }
        dst.trim().to_string()
    }

    /// escape_filter 转义 LDAP 过滤器值（*()\\ 等，对应 go-ldap EscapeFilter）。
    pub fn escape_filter(s: &str) -> String {
        let mut out = String::new();
        for ch in s.chars() {
            match ch {
                '*' => out.push_str("\\2a"),
                '(' => out.push_str("\\28"),
                ')' => out.push_str("\\29"),
                '\\' => out.push_str("\\5c"),
                '\0' => out.push_str("\\00"),
                other => out.push(other),
            }
        }
        out
    }
}

impl Default for LdapProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn configure_requires_url_base() {
        let mut p = LdapProvider::new();
        assert!(p.configure(&cfg(&[])).is_err());
        let mut p = LdapProvider::new();
        assert!(p.configure(&cfg(&[("server_url", "ldap://x"), ("base_dn", "dc=example")])).is_ok());
        assert_eq!(p.user_filter, "(uid=%s)");
        assert_eq!(p.user_attr, "uid");
        assert_eq!(p.group_attr, "cn");
        // 自定义 user_attr
        let mut p = LdapProvider::new();
        p.configure(&cfg(&[("server_url", "ldap://x"), ("base_dn", "dc=example"), ("user_attr", "sAMAccountName"), ("group_attr", "name")])).unwrap();
        assert_eq!(p.user_attr, "sAMAccountName");
        assert_eq!(p.group_attr, "name");
    }

    #[test]
    fn scan_filters() {
        let mut p = LdapProvider::new();
        p.configure(&cfg(&[
            ("server_url", "ldap://x"),
            ("base_dn", "dc=example"),
            ("user_filter", "(uid=%s)"),
            ("group_filter", "(member=%s)"),
        ])).unwrap();
        assert_eq!(p.user_scan_filter(), "(uid=*)");
        assert_eq!(p.group_scan_filter(), "(member=*)");
        // 无占位过滤器原样
        let mut p = LdapProvider::new();
        p.configure(&cfg(&[("server_url", "ldap://x"), ("base_dn", "dc=example"), ("user_filter", "(objectClass=person)")])).unwrap();
        assert_eq!(p.user_scan_filter(), "(objectClass=person)");
    }

    #[test]
    fn username_attr_chain() {
        let mut p = LdapProvider::new();
        p.configure(&cfg(&[("server_url", "ldap://x"), ("base_dn", "dc=example"), ("user_attr", "mail")])).unwrap();
        let e = LdapEntry {
            dn: "cn=alice,dc=example".to_string(),
            attrs: HashMap::new(),
        };
        // mail 缺失 → cn → DN RDN 回退
        assert_eq!(p.username_of(&e), "alice");
        let mut attrs = HashMap::new();
        attrs.insert("mail".to_string(), vec!["a@x.com".to_string()]);
        let e2 = LdapEntry { dn: String::new(), attrs };
        assert_eq!(p.username_of(&e2), "a@x.com");
        // user_attr 缺失时 cn 回退
        let mut p2 = LdapProvider::new();
        p2.configure(&cfg(&[("server_url", "ldap://x"), ("base_dn", "dc=example")])).unwrap();
        let mut attrs = HashMap::new();
        attrs.insert("cn".to_string(), vec!["Alice".to_string()]);
        let e3 = LdapEntry { dn: String::new(), attrs };
        assert_eq!(p2.username_of(&e3), "Alice");
    }

    #[test]
    fn display_name_sn_then_cn() {
        let p = LdapProvider::new();
        let mut attrs = HashMap::new();
        attrs.insert("sn".to_string(), vec!["张三".to_string()]);
        attrs.insert("cn".to_string(), vec!["zhangsan".to_string()]);
        let e = LdapEntry { dn: String::new(), attrs };
        assert_eq!(p.display_name(&e), "张三");
        let mut attrs2 = HashMap::new();
        attrs2.insert("cn".to_string(), vec!["alice".to_string()]);
        let e2 = LdapEntry { dn: String::new(), attrs: attrs2 };
        assert_eq!(p.display_name(&e2), "alice");
    }

    #[test]
    fn login_username_only_user_attr() {
        let mut p = LdapProvider::new();
        p.configure(&cfg(&[("server_url", "ldap://x"), ("base_dn", "dc=example")])).unwrap();
        let mut attrs = HashMap::new();
        attrs.insert("cn".to_string(), vec!["Alice".to_string()]);
        let e = LdapEntry { dn: String::new(), attrs };
        // 登录时不用 cn 回退（防分裂），回退输入
        assert_eq!(p.login_username(&e, "alice"), "alice");
        // 有 uid 则用 uid
        let mut attrs2 = HashMap::new();
        attrs2.insert("uid".to_string(), vec!["alice".to_string()]);
        let e2 = LdapEntry { dn: String::new(), attrs: attrs2 };
        assert_eq!(p.login_username(&e2, "alice"), "alice");
    }

    #[test]
    fn escape_filter_special_chars() {
        assert_eq!(LdapProvider::escape_filter("a*b(c)"), "a\\2ab\\28c\\29");
        assert_eq!(LdapProvider::escape_filter("a\\b"), "a\\5cb");
    }
}
