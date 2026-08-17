import type { ConnectorDef } from '../types.ts'

/** 腾讯健康全周期管理平台 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "archive-hospital-mcp",
  "name": "腾讯健康全周期管理平台",
  "description": "全周期管理平台机构端 AI 智能体的 MCP 连接器。基于原有全周期管理平台，通过引入对话式 AI 智能体，实现理解管理者意图，调度平台原有能力模块完成患者数据查询管理等操作",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://bingli.tengmed.com/mcp/.well-known/oauth-authorization-server",
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
      "serverName": "archive-hospital-mcp",
      "transport": "streamable-http",
      "url": "https://bingli.tengmed.com/mcp"
    }
  ]
}
