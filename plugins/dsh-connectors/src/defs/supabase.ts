import type { ConnectorDef } from '../types.ts'

/** supabase connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "supabase",
  "name": "supabase",
  "description": "",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mcp.supabase.com/mcp/.well-known/oauth-authorization-server",
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
      "serverName": "supabase",
      "transport": "streamable-http",
      "url": "https://mcp.supabase.com/mcp"
    }
  ]
}
