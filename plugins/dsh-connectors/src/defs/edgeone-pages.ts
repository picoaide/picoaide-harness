import type { ConnectorDef } from '../types.ts'

/** EdgeOne Makers connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "edgeone-pages",
  "name": "EdgeOne Makers",
  "description": "将项目部署到 EdgeOne Makers 并返回线上访问地址，支持全栈、云函数、AI Agent 等开发场景。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "undefined/.well-known/oauth-authorization-server",
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
      "serverName": "edgeone-pages",
      "transport": "stdio",
      "command": "npx",
      "args": [
        "edgeone-pages-mcp-fullstack@latest",
        "--region",
        "china"
      ]
    }
  ]
}
