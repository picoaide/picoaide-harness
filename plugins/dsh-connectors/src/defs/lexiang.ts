import type { ConnectorDef } from '../types.ts'

/** 乐享知识库 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "lexiang",
  "name": "乐享知识库",
  "description": "搜索、创建和管理乐享知识库中的文档。支持导入 Markdown、按标签整理内容、追踪团队文档的更新动态。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mcp.lexiang-app.com/mcp/.well-known/oauth-authorization-server",
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
      "serverName": "lexiang",
      "transport": "streamable-http",
      "url": "https://mcp.lexiang-app.com/mcp"
    }
  ]
}
