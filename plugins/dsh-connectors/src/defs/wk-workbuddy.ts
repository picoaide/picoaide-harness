import type { ConnectorDef } from '../types.ts'

/** 威科先行 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "wk-workbuddy",
  "name": "威科先行",
  "description": "威科先行依托全面、准确、及时更新的法规、案例等法律数据研发的MCP服务，支持语义检索、关键词检索等场景。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mcp.wkinfo.com.cn/mcp-servers/integrated//.well-known/oauth-authorization-server",
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
      "serverName": "wk-mcp",
      "transport": "streamable-http",
      "url": "https://mcp.wkinfo.com.cn/mcp-servers/integrated/"
    }
  ]
}
