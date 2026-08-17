import type { ConnectorDef } from '../types.ts'

/** 深知可信工作台 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "dknowc-mcp",
  "name": "深知可信工作台",
  "description": "深知可信工作台面向政策、法律、标准和公共服务场景，提供可信问答、权威检索、深度研究和材料整理能力。它可以帮助用户查询政策原文、办事条件、申报材料、补贴资质、法律法规和行业标准，梳理多地区、多时间范围的信息，并基于可追溯的权威来源形成清晰、可核验的结果。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mcp.dknowc.cn/s6/mcp",
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
      "serverName": "dknowc-mcp",
      "transport": "streamable-http",
      "url": "https://mcp.dknowc.cn/s6/mcp"
    }
  ]
}
