import type { ConnectorDef } from '../types.ts'

/** 销售易CRM connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "neo-crm",
  "name": "销售易CRM",
  "description": "用自然语言查客户、推商机、盘线索、领公海、写跟进，一句话打通销售工作闭环。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mcp.xiaoshouyi.com/mcp",
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
      "serverName": "neo-crm",
      "transport": "streamable-http",
      "url": "https://mcp.xiaoshouyi.com/mcp"
    }
  ]
}
