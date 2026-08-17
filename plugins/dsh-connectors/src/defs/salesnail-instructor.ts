import type { ConnectorDef } from '../types.ts'

/** SalesNail 讲师 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "salesnail-instructor",
  "name": "SalesNail 讲师",
  "description": "通过自然语言自助开通讲师试用、维护商业 Profile、生成客户方案，完成游戏创作、课程配置、实时带教，以及团队、学员、班级和商机的证据化分析与复盘。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://sn.long-arena.com/mcp/.well-known/oauth-authorization-server",
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
      "serverName": "salesnail-instructor",
      "transport": "streamable-http",
      "url": "https://sn.long-arena.com/mcp"
    }
  ]
}
