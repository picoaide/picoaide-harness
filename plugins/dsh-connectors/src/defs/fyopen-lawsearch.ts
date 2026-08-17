import type { ConnectorDef } from '../types.ts'

/** 法研·法律法规检索 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "fyopen-lawsearch",
  "name": "法研·法律法规检索",
  "description": "法研·法律法规检索，支持自然语言获取精准、现行有效的法规条文，将高质量、海量的法规知识库，无缝接入各类AI应用与工作流中。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://api.cjbdi.com:8443/354347/mcp_law_service/.well-known/oauth-authorization-server",
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
      "serverName": "fy-law-search-service",
      "transport": "streamable-http",
      "url": "https://api.cjbdi.com:8443/354347/mcp_law_service"
    }
  ]
}
