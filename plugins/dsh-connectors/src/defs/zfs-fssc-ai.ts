import type { ConnectorDef } from '../types.ts'

/** 中兴新云AI智报 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "zfs-fssc-ai",
  "name": "中兴新云AI智报",
  "description": "连接您的财务云账号以使用 AI 智报。账号与密码仅用于向财务云登录换取会话凭证；密码不会被连接器存储，仅在服务端发起登录时使用。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "ZFS_LOGIN_KEY",
      "label": "财务云账号",
      "type": "text",
      "required": true
    },
    {
      "key": "ZFS_PASSWORD",
      "label": "财务云密码",
      "type": "password",
      "required": true
    }
  ],
  "mcp": []
}
