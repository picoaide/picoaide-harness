import type { ConnectorDef } from '../types.ts'

/** QQ邮箱 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "qq-mail",
  "name": "QQ邮箱",
  "description": "收发、搜索和整理 QQ 邮件。用自然语言读取邮件内容、汇总邮件线程、管理文件夹。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://api.mail.qq.com/mcp",
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
      "serverName": "qq-mail",
      "transport": "streamable-http",
      "url": "https://api.mail.qq.com/mcp"
    }
  ]
}
