import type { ConnectorDef } from '../types.ts'

/** 极睿视频 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "infimind-video",
  "name": "极睿视频",
  "description": "请输入在极睿视频中为本次连接创建、专用于 WorkBuddy 的 MCP Token。凭证仅保存在本机 WorkBuddy 配置目录中，不会随 Connector 上架包分发；不得在其他 MCP 客户端复用。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "SORA_MCP_TOKEN",
      "label": "MCP Token",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "infimind-video",
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@infimind/video-mcp-cli@1.0.11"
      ],
      "env": {
        "SORA_MCP_TOKEN": "${SORA_MCP_TOKEN}",
        "SORA_API_URL": "https://aigc-next.iclip.cn/api"
      }
    }
  ]
}
