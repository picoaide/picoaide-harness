import type { ConnectorDef } from '../types.ts'

/** AgentKey connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "agentkey",
  "name": "AgentKey",
  "description": "AgentKey 是 AI 助手获取可信工具和实时数据的能力市场。支持网页搜索、URL抓取、新闻、社交媒体、股票市场价格、电商产品数据、企业/公司数据、天气、地图和地理位置、旅行（航班/酒店）、实时信息或任何第三方API。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://api.agentkey.app/workbuddy/v1/mcp",
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
      "serverName": "agentkey",
      "transport": "streamable-http",
      "url": "https://api.agentkey.app/workbuddy/v1/mcp"
    }
  ]
}
