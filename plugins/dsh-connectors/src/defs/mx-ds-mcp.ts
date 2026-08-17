import type { ConnectorDef } from '../types.ts'

/** 东方财富妙想MCP connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "mx-ds-mcp",
  "name": "东方财富妙想MCP",
  "description": "通过自然语言查询的金融投研 MCP 工具套件，依托东方财富数据源，提供A股、港股、美股、基金、债券、指数板块、宏观数据查询，具备多条件资产筛选、券商研报检索、全市场公告解析、金融资讯检索能力。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mxapi.eastmoney.com/mxds/v2/mcp",
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
      "serverName": "mx-ds-mcp",
      "transport": "streamable-http",
      "url": "https://mxapi.eastmoney.com/mxds/v2/mcp"
    }
  ]
}
