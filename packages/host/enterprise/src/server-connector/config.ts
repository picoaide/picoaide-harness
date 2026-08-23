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
  web: { allow_private: boolean; search_endpoint: string }
}
