import type { ConnectorDef } from '../types.ts'

/** 腾讯文档 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "tencent-docs",
  "name": "腾讯文档",
  "description": "创建、编辑和协作腾讯文档。用自然语言管理在线表格、文档和幻灯片，轻松完成内容查询、数据整理和团队协同。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://docs.qq.com/openapi/mcp/.well-known/oauth-authorization-server",
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
      "serverName": "tencent-docs",
      "transport": "streamable-http",
      "url": "https://docs.qq.com/openapi/mcp"
    }
  ]
}
