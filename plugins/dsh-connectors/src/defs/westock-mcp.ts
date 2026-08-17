import type { ConnectorDef } from '../types.ts'

/** 腾讯自选股 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "westock-mcp",
  "name": "腾讯自选股",
  "description": "直连腾讯自选股，实时掌握毫秒级行情与资金动态，用自然语言分析自选数据、设置股价提醒、管理模拟交易，轻松搞定盯盘与投资决策。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://stockbuddy.qq.com/cgi/cgi-bin/openai/mcp/mcp",
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
      "serverName": "westock-mcp",
      "transport": "streamable-http",
      "url": "https://stockbuddy.qq.com/cgi/cgi-bin/openai/mcp/mcp"
    }
  ]
}
