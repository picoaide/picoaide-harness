import type { ConnectorDef } from '../types.ts'

/** Picset AI 电商图片 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "picset-commerce-images",
  "name": "Picset AI 电商图片",
  "description": "请输入在 Picset AI 用户中心创建的密钥。该密钥仅由 WorkBuddy 保存在本机用户目录，并在连接 Picset AI 图片连接器时作为 Authorization 请求头发送。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "PICSET_AGENT_SK",
      "label": "Picset AI Secret Key",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "picset-commerce-images",
      "transport": "streamable-http",
      "url": "https://picsetai.cn/functions/v1/agent-mcp-v1/mcp",
      "headers": {
        "Authorization": "Bearer ${PICSET_AGENT_SK}"
      }
    }
  ]
}
