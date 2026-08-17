import type { ConnectorDef } from '../types.ts'

/** Tec-Do 2.0 广告与增长情报 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "tec-do",
  "name": "Tec-Do 2.0 广告与增长情报",
  "description": "面向出海广告投放和增长团队的 AI 能力集合。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://tec-chi-external-skill-mcp.tec-do.cn/mcp/.well-known/oauth-authorization-server",
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
      "serverName": "tec-do",
      "transport": "streamable-http",
      "url": "https://tec-chi-external-skill-mcp.tec-do.cn/mcp"
    }
  ]
}
