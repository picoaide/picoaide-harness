import type { ConnectorDef } from '../types.ts'

/** EzyJoin智慧会议 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "ezjoin-meeting",
  "name": "EzyJoin智慧会议",
  "description": "用自然语言管理 EzyJoin 智慧会议：预约会议室、创建/取消会议、查询会议日程与 AI 纪要。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://www.ezyjoin.cn/api/mcp/message",
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
      "serverName": "ezjoin-meeting",
      "transport": "streamable-http",
      "url": "https://www.ezyjoin.cn/api/mcp/message"
    }
  ]
}
