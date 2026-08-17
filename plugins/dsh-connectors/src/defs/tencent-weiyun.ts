import type { ConnectorDef } from '../types.ts'

/** 微云 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "tencent-weiyun",
  "name": "微云",
  "description": "查看、下载、删除微云文件，并且提供上传文件到微云、生成分享链接能力，帮你管理微云文件",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://www.weiyun.com/api/v3/mcpserver",
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
      "serverName": "weiyun",
      "transport": "streamable-http",
      "url": "https://www.weiyun.com/api/v3/mcpserver"
    }
  ]
}
