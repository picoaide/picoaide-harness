import type { ConnectorDef } from '../types.ts'

/** 北大法宝·法律智能检索 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "pkulaw",
  "name": "北大法宝·法律智能检索",
  "description": "检索 + 核验一体：语义（自然语言描述）与关键词双模式检索法规、法条与司法案例；并可把文本中的法条引用与案号回北大法宝库逐条比对、对齐标准名称，输出带 pkulaw.com 原文链接的可溯源结果，专治法律幻觉。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://apim-gateway.pkulaw.com/mcp-law-agg/1.0.0/mcp",
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
      "serverName": "pkulaw",
      "transport": "streamable-http",
      "url": "https://apim-gateway.pkulaw.com/mcp-law-agg/1.0.0/mcp"
    }
  ]
}
