import type { ConnectorDef } from '../types.ts'

/** 腾讯公益机构服务平台 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "gongyi-open-mcp",
  "name": "腾讯公益机构服务平台",
  "description": "腾讯公益机构服务平台连接器：用自然语言查询当前登录机构的用户与机构信息、项目、进展、财务披露等机构侧业务数据。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://ssl.gongyi.qq.com/gygw-web/api/open/tob/mcp/.well-known/oauth-authorization-server",
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
      "serverName": "gongyi-open-mcp",
      "transport": "streamable-http",
      "url": "https://ssl.gongyi.qq.com/gygw-web/api/open/tob/mcp"
    }
  ]
}
