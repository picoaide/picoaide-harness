import type { ConnectorDef } from '../types.ts'

/** PandaData 金融数据 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "pandadata",
  "name": "PandaData 金融数据",
  "description": "查询、整理和分析 A 股、期货、期权、港美股、基金、宏观经济及量化因子等金融数据，支持统计比较与趋势归纳。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://pandadatamcp.pandaaiquant.com/mcp",
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
      "serverName": "pandadata",
      "transport": "streamable-http",
      "url": "https://pandadatamcp.pandaaiquant.com/mcp"
    }
  ]
}
