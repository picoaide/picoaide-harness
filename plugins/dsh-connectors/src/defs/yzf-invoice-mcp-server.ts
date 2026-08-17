import type { ConnectorDef } from '../types.ts'

/** 云帐房AI开票 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "yzf-invoice-mcp-server",
  "name": "云帐房AI开票",
  "description": "通过自然语言使用云帐房 AI 开票能力，完成开票信息识别，并前往电子税局开票。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://super-ai-app.yunzhangfang.com/api/mcp/invoice/stream/.well-known/oauth-authorization-server",
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
      "serverName": "yzf-invoice-mcp-server",
      "transport": "streamable-http",
      "url": "https://super-ai-app.yunzhangfang.com/api/mcp/invoice/stream"
    }
  ]
}
