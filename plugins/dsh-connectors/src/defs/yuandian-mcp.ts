import type { ConnectorDef } from '../types.ts'

/** 华宇元典法律数据 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "yuandian-mcp",
  "name": "华宇元典法律数据",
  "description": "华宇元典法律数据为智能体提供法律法规、案例文书、企业信息 MCP 工具能力。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://open.chineselaw.com/mcp/.well-known/oauth-authorization-server",
    "clientId": "",
    "authorizeUrl": "",
    "tokenUrl": "",
    "redirectUri": "http://127.0.0.1/callback",
    "pkce": true,
    "publicClient": true,
    "scopes": "offline_access"
  },
  "mcp": [
    {
      "serverName": "yuandian_mcp",
      "transport": "streamable-http",
      "url": "https://open.chineselaw.com/mcp"
    }
  ]
}
