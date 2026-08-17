import type { ConnectorDef } from '../types.ts'

/** 同舟金融研究 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "tongzhou-fin-research",
  "name": "同舟金融研究",
  "description": "连接公开行情、研报检索、行业图谱与同舟投研材料，为股市研究提供可复核证据。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mcp-gateway.textmind-gz.com/mcp/tongzhou-research/.well-known/oauth-authorization-server",
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
      "serverName": "tongzhou-fin-research",
      "transport": "streamable-http",
      "url": "https://mcp-gateway.textmind-gz.com/mcp/tongzhou-research"
    }
  ]
}
