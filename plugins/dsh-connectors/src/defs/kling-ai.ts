import type { ConnectorDef } from '../types.ts'

/** Kling AI connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "kling-ai",
  "name": "Kling AI",
  "description": "用可灵MCP打造独属于你的 AI 创作工作流。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://klingai.com/mcp",
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
      "serverName": "kling-ai",
      "transport": "streamable-http",
      "url": "https://klingai.com/mcp"
    }
  ]
}
