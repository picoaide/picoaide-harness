import type { ConnectorDef } from '../types.ts'

/** 腾讯健康NGES connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "tencent-health-nges",
  "name": "腾讯健康NGES",
  "description": "腾讯健康NGES MCP服务，支持智能问数和合规审核等功能",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://test.nges.qq.com/mcp/aggregate/.well-known/oauth-authorization-server",
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
      "serverName": "nges",
      "transport": "streamable-http",
      "url": "https://test.nges.qq.com/mcp/aggregate"
    }
  ]
}
