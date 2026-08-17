import type { ConnectorDef } from '../types.ts'

/** 小鹅通 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "xiaoe-cloud-cli",
  "name": "小鹅通",
  "description": "用自然语言管理小鹅通店铺：查询课程与学员，创建和编辑课程，查看订单，并查找或上传图片、音频、电子书和文档素材。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://agent.xiaoe-tech.com/mcp/.well-known/oauth-authorization-server",
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
      "serverName": "xiaoe-cloud-cli",
      "transport": "streamable-http",
      "url": "https://agent.xiaoe-tech.com/mcp"
    }
  ]
}
