import type { ConnectorDef } from '../types.ts'

/** 腾讯问卷 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "tencent-survey",
  "name": "腾讯问卷",
  "description": "创建、管理和分析腾讯问卷。用自然语言快速生成问卷、查看回收数据、设置题目逻辑。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://wj.qq.com/api/v2/mcp",
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
      "serverName": "tencent-survey",
      "transport": "streamable-http",
      "url": "https://wj.qq.com/api/v2/mcp"
    }
  ]
}
