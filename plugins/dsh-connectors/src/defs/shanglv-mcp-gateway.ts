import type { ConnectorDef } from '../types.ts'

/** 用友智能服务（AI BaaS） connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "shanglv-mcp-gateway",
  "name": "用友智能服务（AI BaaS）",
  "description": "通过用友银企联、税企联、商旅云等财务服务产品，为企业提供财务税务与银行资金数据服务，并提供企业商旅运营服务和行程服务。用自然语言完成企业的资金、税务、商旅的全面运营管理。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mcp-gateway.yql.net/mcp/",
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
      "serverName": "shanglv-mcp-gateway",
      "transport": "streamable-http",
      "url": "https://mcp-gateway.yql.net/mcp/"
    }
  ]
}
