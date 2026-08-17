import type { ConnectorDef } from '../types.ts'

/** 有数智客 · 对公(To B)营销助手 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "youshu-bd-mate",
  "name": "有数智客 · 对公(To B)营销助手",
  "description": "更全面的功能请前往有数开放平台：https://open.yscredit.com/mcp/guide，在页面中点击\"一键免费接入\"，复制生成的提示词，返回 WorkBuddy，将提示词粘贴发送给模型，即可自动完成配置。如仅需使用对公营销助手基础功能，也可前往平台点击右上角头像\"获取 MCP Key\"，将 Key 粘贴到下方输入框。Key 仅存储在本机 ~/.workbuddy 下，不会上传云端。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "API_KEY",
      "label": "有数 MCP Key",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "youshu-bd-mate",
      "transport": "streamable-http",
      "url": "https://open.yscredit.com/ys-mcp/report",
      "headers": {
        "Authorization": "Bearer ${API_KEY}"
      }
    }
  ]
}
