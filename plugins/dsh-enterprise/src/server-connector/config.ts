export interface Session {
  serverURL: string
  username: string
  token: string
}

export interface BootstrapConfig {
  default_model: string
  models: { id: string; display_name: string }[]
  skills: { name: string; version: string; description: string }[]
  mcp: { id: number; name: string; description: string; recommended: boolean }[]
  web: { allow_private: boolean; search_endpoint: string }
}
