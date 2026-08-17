import type { ConnectorDef } from '../types.ts'

/** 网易邮箱 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "netease-mail",
  "name": "网易邮箱",
  "description": "输入邮箱地址和 IMAP/SMTP 授权码（非登录密码）。支持 163、126、yeah.net 等网易邮箱，以及其他支持 IMAP/SMTP 的邮箱。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "NETEASE_EMAIL_USER",
      "label": "邮箱地址",
      "type": "text",
      "required": true
    },
    {
      "key": "NETEASE_EMAIL_PASS",
      "label": "IMAP/SMTP 授权码",
      "type": "password",
      "required": true
    }
  ],
  "mcp": []
}
