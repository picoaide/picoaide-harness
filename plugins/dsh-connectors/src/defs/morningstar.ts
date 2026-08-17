import type { ConnectorDef } from '../types.ts'

/** 晨星 Morningstar connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "morningstar",
  "name": "晨星 Morningstar",
  "description": "接入晨星全球与中国基金数据，通过自然语言实现基金查询、筛选、分析与深度研究，以及组合穿透分析",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mcp.morningstar.cn/mcp",
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
      "serverName": "morningstar",
      "transport": "streamable-http",
      "url": "https://mcp.morningstar.cn/mcp"
    }
  ]
}
