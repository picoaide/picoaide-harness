import type { ConnectorDef } from '../types.ts'

/** Picset AI 视频生成 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "picset-video-generation",
  "name": "Picset AI 视频生成",
  "description": "请输入在 Picset AI 用户中心创建的 Agent SK。该 SK 仅由 WorkBuddy 保存在本机用户目录，并在连接 Picset AI 视频 MCP 时作为 Authorization 请求头发送。",
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
      "serverName": "picset-video-generation",
      "transport": "streamable-http",
      "url": "https://picsetai.cn/functions/v1/agent-video-mcp-v1/mcp",
      "headers": {
        "Authorization": "Bearer ${PICSET_AGENT_SK}"
      }
    }
  ]
}
