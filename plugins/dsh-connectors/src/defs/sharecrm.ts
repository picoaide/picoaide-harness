import type { ConnectorDef } from '../types.ts'

/** 纷享销客CRM connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "sharecrm",
  "name": "纷享销客CRM",
  "description": "用自然语言查询客户、推进商机、写跟进记录、处理审批、建图表等，轻松搞定销售全链路工作。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://open.fxiaoke.com/mcp/connector?id=workbuddy",
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
      "serverName": "ShareCRM",
      "transport": "streamable-http",
      "url": "https://open.fxiaoke.com/mcp/connector?id=workbuddy"
    }
  ]
}
