export interface Session {
  serverURL: string
  username: string
  token: string
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
  web: {
    allow_private: boolean
    search_endpoint: string
    error_reporting_dsn?: string
    error_reporting_enabled?: boolean
    error_reporting_level?: string
    /** 服务端下发的默认思考强度(默认模型 reasoningEffort);缺省不覆盖用户设置 */
    default_thinking_level?: string
  }
}
