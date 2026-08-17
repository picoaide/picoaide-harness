import type { ConnectorDef } from '../types.ts'

/** ima知识库 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "ima-mcp",
  "name": "ima知识库",
  "description": "引用知识库资料及文件，浏览知识库详情。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://ima.qq.com/mcp/.well-known/oauth-authorization-server",
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
      "serverName": "ima-mcp",
      "transport": "streamable-http",
      "url": "https://ima.qq.com/mcp"
    }
  ]
}
