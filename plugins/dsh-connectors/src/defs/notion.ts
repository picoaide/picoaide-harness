import type { ConnectorDef } from '../types.ts'

/** Notion connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "notion",
  "name": "Notion",
  "description": "创建、搜索和管理 Notion 工作区。用自然语言读取页面、查询数据库、更新内容、整理知识库。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mcp.notion.com/mcp/.well-known/oauth-authorization-server",
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
      "serverName": "notion",
      "transport": "streamable-http",
      "url": "https://mcp.notion.com/mcp"
    }
  ]
}
