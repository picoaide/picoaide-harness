import type { ConnectorDef } from '../types.ts'

/** 启信慧眼 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "qixinhuiyan-mcp",
  "name": "启信慧眼",
  "description": "通过启信慧眼 MCP 接入企业全景数据能力，支持用户用自然语言完成企业搜索、工商画像、风险识别、经营动态、知识产权等商业情报分析。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mcp.qixin.com/mcp/.well-known/oauth-authorization-server",
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
      "serverName": "qixin",
      "transport": "streamable-http",
      "url": "https://mcp.qixin.com/mcp"
    }
  ]
}
