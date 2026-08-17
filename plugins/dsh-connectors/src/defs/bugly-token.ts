import type { ConnectorDef } from '../types.ts'

/** Bugly 质量概览 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "bugly-token",
  "name": "Bugly 质量概览",
  "description": "连接您的 Bugly 账号，用于查看产品的崩溃率、ANR 率、FOOM（OOM）率与启动耗时等质量概览。Token 仅存储在本机 ~/.workbuddy 下，不会上传云端。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "BUGLY_ACCESS_TOKEN",
      "label": "密钥",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "bugly",
      "transport": "streamable-http",
      "url": "https://bugly.tds.qq.com/mcp",
      "headers": {
        "Authorization": "Bearer ${BUGLY_ACCESS_TOKEN}"
      }
    }
  ]
}
