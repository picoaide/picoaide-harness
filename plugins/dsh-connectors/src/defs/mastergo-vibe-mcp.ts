import type { ConnectorDef } from '../types.ts'

/** MasterGo 莫高设计 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "mastergo-vibe-mcp",
  "name": "MasterGo 莫高设计",
  "description": "连接 MasterGo 画布，让 AI 进行设计、修改、同步和获取 D2C 代码。",
  "authMode": "oauth",
  "auth": {
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
      "serverName": "mastergo",
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@mastergo/vibe-mcp",
        "--url=http://localhost:50678"
      ],
      "env": {
        "NO_PROXY": "localhost,127.0.0.1,::1"
      }
    }
  ]
}
