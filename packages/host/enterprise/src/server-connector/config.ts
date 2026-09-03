export interface Session {
  serverURL: string
  username: string
  token: string
  /** RBAC role from the server login response (v3b §4.4); undefined = 未返回. */
  role?: string
  /** 0057: 账号来源('local'|'external'); external=LDAP/OIDC 由 IdP 管理密码. */
  source?: string
  /** 0057: 是否可自助改密(本地认证且启用); 客户端据此渲染改密入口. */
  passwordChangeable?: boolean
  /** 0057: 管理员重置密码后强制改密; 为 true 时客户端进入强制改密页. */
  mustChangePassword?: boolean
}

export interface BootstrapModel {
  id: string
  display_name: string
  /** Server-configured provider defaults as JSON text (e.g. `{"max_output": N}`). */
  default_params?: string
  /** 0058: 模型接受的输入模态('text'/'image');缺失 = 仅 text(客户端 schema 缺省)。 */
  input_modalities?: string[]
}

export interface BootstrapConfig {
  default_model: string
  models: BootstrapModel[]
  skills: { name: string; version: string; description: string }[]
  mcp: { id: number; name: string; description: string; recommended: boolean }[]
  /** 连接器目录(0042):服务端下发,客户端连接器中心显示/连接。 */
  connectors?: { id: string; name: string; description: string; auth_mode: string; definition: string }[]
  web: {
    error_reporting_dsn?: string
    error_reporting_enabled?: boolean
    error_reporting_level?: string
    /** 服务端下发的默认思考强度(默认模型 reasoningEffort);缺省不覆盖用户设置 */
    default_thinking_level?: string
  }
}
