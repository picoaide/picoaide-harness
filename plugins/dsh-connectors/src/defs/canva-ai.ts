import type { ConnectorDef } from '../types.ts'

/** Canva可画 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "canva-ai",
  "name": "Canva可画",
  "description": "无缝调用Canva可画的设计能力。一句话生成海报、演示文稿、小红书封面等设计，通过文字描述调整尺寸、填充品牌模板及检索已有内容",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mcp.canva.com/mcp",
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
      "serverName": "canva-mcp",
      "transport": "streamable-http",
      "url": "https://mcp.canva.com/mcp"
    }
  ]
}
