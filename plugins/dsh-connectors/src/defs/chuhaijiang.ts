import type { ConnectorDef } from '../types.ts'

/** 出海匠 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "chuhaijiang",
  "name": "出海匠",
  "description": "基于实时 TikTok Shop 数据完成选品、竞品分析、达人筛选与带货内容创作，并管理社媒账号、发布内容、运营评论和私信。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mcp.gateway.chuhaijiang.com/mcp/oauth/.well-known/oauth-authorization-server",
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
      "serverName": "chuhaijiang",
      "transport": "streamable-http",
      "url": "https://mcp.gateway.chuhaijiang.com/mcp/oauth"
    }
  ]
}
