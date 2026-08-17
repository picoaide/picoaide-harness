import type { ConnectorDef } from '../types.ts'

/** 摩知轮商标查询 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "mzl-trademark",
  "name": "摩知轮商标查询",
  "description": "用自然语言检索商标：按名称、申请人、申请号、注册号、尼斯类别、法律状态、日期范围查询，覆盖中国及 110+ 海外国家/地区商标局；并支持以图搜图的图形近似检索。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://www.mozlen.com/mcp",
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
      "serverName": "mzl-trademark",
      "transport": "streamable-http",
      "url": "https://www.mozlen.com/mcp"
    }
  ]
}
