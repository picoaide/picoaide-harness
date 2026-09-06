//! 路由命名空间常量（Go `internal/router` 命名空间唯一真源等价）。

/// NamespaceServer 服务端管理面（管理员/运维/审计用）。
pub const NAMESPACE_SERVER: &str = "/api/server";

/// NamespaceClientV2 客户端员工面（v2 大版本；桌面客户端/员工接入用）。
pub const NAMESPACE_CLIENT_V2: &str = "/api/client/v2";

/// NamespaceV1 LLM 网关命名空间（OpenAI/Anthropic 兼容）。
pub const NAMESPACE_V1: &str = "/v1";

/// Admin API 前缀（webadmin 调用）；= NamespaceServer + "/admin"。
pub const ADMIN_API: &str = "/api/server/admin";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_constants() {
        assert_eq!(NAMESPACE_SERVER, "/api/server");
        assert_eq!(NAMESPACE_CLIENT_V2, "/api/client/v2");
        assert_eq!(NAMESPACE_V1, "/v1");
        assert_eq!(ADMIN_API, "/api/server/admin");
    }
}
