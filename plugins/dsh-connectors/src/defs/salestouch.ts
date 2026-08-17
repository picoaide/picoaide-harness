import type { ConnectorDef } from '../types.ts'

/** SalesTouch 经营执行 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "salestouch",
  "name": "SalesTouch 经营执行",
  "description": "通过自然语言连接 SalesTouch，完成组织资料、部门、角色权限、员工邀请、下属管理范围与销售流程配置，并处理销售执行、非销售工作、绩效、内部调研和经营汇总。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://touch.long-arena.com/mcp",
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
      "serverName": "salestouch",
      "transport": "streamable-http",
      "url": "https://touch.long-arena.com/mcp"
    }
  ]
}
