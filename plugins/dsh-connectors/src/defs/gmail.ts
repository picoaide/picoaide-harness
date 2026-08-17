import type { ConnectorDef } from '../types.ts'

/** gmail connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "gmail",
  "name": "gmail",
  "description": "",
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
      "serverName": "gmail",
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "mcp-email"
      ],
      "env": {
        "EMAIL_USER": "${EMAIL_USER}",
        "EMAIL_PASSWORD": "${EMAIL_PASSWORD}",
        "EMAIL_TYPE": "gmail"
      }
    }
  ]
}
