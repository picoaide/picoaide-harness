export interface Session {
  serverURL: string
  username: string
  token: string
  /** RBAC role from the server login response (v3b §4.4); undefined = 未返回. */
  role?: string
}

export interface BootstrapModel {
  id: string
  display_name: string
  /** Server-configured provider defaults as JSON text (e.g. `{"max_output": N}`). */
  default_params?: string
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
