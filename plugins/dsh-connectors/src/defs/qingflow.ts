import type { ConnectorDef } from '../types.ts'

/** 轻流 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "qingflow",
  "name": "轻流",
  "description": "轻流无代码平台连接器。通过自然语言创建应用、管理表单数据、处理审批流程、查询和导出数据，一站式连接轻流全部能力。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mcp.qingflow.com/mcp/.well-known/oauth-authorization-server",
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
      "serverName": "qingflow",
      "transport": "streamable-http",
      "url": "https://mcp.qingflow.com/mcp"
    }
  ]
}
