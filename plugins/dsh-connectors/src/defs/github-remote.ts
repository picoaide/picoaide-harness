import type { ConnectorDef } from '../types.ts'

/** github-remote connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "github-remote",
  "name": "github-remote",
  "description": "",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://api.githubcopilot.com/mcp/",
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
      "serverName": "github-remote",
      "transport": "streamable-http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": ""
      }
    }
  ]
}
