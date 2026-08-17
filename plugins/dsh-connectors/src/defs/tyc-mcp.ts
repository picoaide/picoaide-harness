import type { ConnectorDef } from '../types.ts'

/** 天眼查 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "tyc-mcp",
  "name": "天眼查",
  "description": "通过天眼查 MCP 查询多维度企业数据。支持工商登记、股东结构、司法风险、知识产权、董监高、经营数据等 160+ 项企业数据能力，用自然语言完成企业尽调与商业情报分析。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mcp.tianyancha.com/v1/.well-known/oauth-authorization-server",
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
      "serverName": "tyc-mcp",
      "transport": "streamable-http",
      "url": "https://mcp.tianyancha.com/v1"
    }
  ]
}
