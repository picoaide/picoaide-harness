//! RBAC 权限模型（Go `serverauth/rbac.go` 的权限表部分等价，无 gin 中间件）。
//!
//! 角色: super_admin(全量) / auditor(只读审计) / user(普通员工)。
//! 权限: 声明式权限点常量 + 角色→权限映射（内存表）。

/// 权限点清单。命名规范: <域>:<动作>。
pub mod perms {
    pub const USER_READ: &str = "user:read";
    pub const USER_WRITE: &str = "user:write";
    pub const ROLE_ASSIGN: &str = "role:assign";
    pub const DEPT_READ: &str = "dept:read";
    pub const DEPT_WRITE: &str = "dept:write";
    pub const AUTH_READ: &str = "auth:read";
    pub const AUTH_WRITE: &str = "auth:write";
    pub const GATEWAY_READ: &str = "gateway:read";
    pub const GATEWAY_WRITE: &str = "gateway:write";
    pub const USAGE_READ: &str = "usage:read";
    pub const REPORT_WRITE: &str = "report:write";
    pub const QUOTA_WRITE: &str = "quota:write";
    pub const MARKET_READ: &str = "market:read";
    pub const MARKET_WRITE: &str = "market:write";
    pub const CAPABILITY_READ: &str = "capability:read";
    pub const CAPABILITY_WRITE: &str = "capability:write";
    pub const CONNECTOR_READ: &str = "connector:read";
    pub const CONNECTOR_WRITE: &str = "connector:write";
    pub const AUDIT_READ: &str = "audit:read";
    pub const AUDIT_RETENTION: &str = "audit:retention:write";
    pub const BRAND_READ: &str = "brand:read";
    pub const BRAND_WRITE: &str = "brand:write";
    pub const PORTAL_READ: &str = "portal:read";
    pub const PORTAL_WRITE: &str = "portal:write";
    pub const SERVER_INFO_READ: &str = "server-info:read";
    pub const ERROR_MON_READ: &str = "error-monitoring:read";
}

/// AllPermissions 全量权限集（super_admin）。
pub const ALL_PERMISSIONS: &[&str] = &[
    perms::USER_READ,
    perms::USER_WRITE,
    perms::ROLE_ASSIGN,
    perms::DEPT_READ,
    perms::DEPT_WRITE,
    perms::AUTH_READ,
    perms::AUTH_WRITE,
    perms::GATEWAY_READ,
    perms::GATEWAY_WRITE,
    perms::USAGE_READ,
    perms::REPORT_WRITE,
    perms::QUOTA_WRITE,
    perms::MARKET_READ,
    perms::MARKET_WRITE,
    perms::CAPABILITY_READ,
    perms::CAPABILITY_WRITE,
    perms::CONNECTOR_READ,
    perms::CONNECTOR_WRITE,
    perms::AUDIT_READ,
    perms::AUDIT_RETENTION,
    perms::BRAND_READ,
    perms::BRAND_WRITE,
    perms::PORTAL_READ,
    perms::PORTAL_WRITE,
    perms::SERVER_INFO_READ,
    perms::ERROR_MON_READ,
];

/// AuditorPermissions 只读三重审计权限（auditor）。
pub const AUDITOR_PERMISSIONS: &[&str] = &[
    perms::AUDIT_READ,
    perms::USAGE_READ,
    perms::USER_READ,
];

/// PermissionsOf 返回角色的权限集。
pub fn permissions_of(role: &str) -> &'static [&'static str] {
    match role {
        "super_admin" => ALL_PERMISSIONS,
        "auditor" => AUDITOR_PERMISSIONS,
        _ => &[],
    }
}

/// HasPermission 报告角色是否授权（纯函数，无 DB）。
pub fn has_permission(role: &str, perm: &str) -> bool {
    permissions_of(role).contains(&perm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rbac_roles() {
        assert!(has_permission("super_admin", perms::USER_READ));
        assert!(has_permission("super_admin", perms::BRAND_WRITE));
        assert!(has_permission("auditor", perms::AUDIT_READ));
        assert!(!has_permission("auditor", perms::USER_WRITE));
        assert!(!has_permission("user", perms::USER_READ));
        assert!(!has_permission("nobody", perms::USER_READ));
    }
}
