import type { ConnectorDef } from '../types.ts'

/** 九数云BI connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "jiushuyun",
  "name": "九数云BI",
  "description": "上传 Excel 或 CSV 表格，一键生成原生的可视化数据分析报告、仪表板、图表。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://work.jiushuyun.com/mcp",
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
      "serverName": "jiushuyun",
      "transport": "streamable-http",
      "url": "https://work.jiushuyun.com/mcp"
    }
  ]
}
