import type { ConnectorDef } from '../types.ts'

/** 微盛企微管家SCRM connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "weisheng-scrm",
  "name": "微盛企微管家SCRM",
  "description": "输入微盛企微管家的 APP KEY，用于查询或管理企业微信中的客户信息、标签、客户群、营销素材、活码、群发、跟进记录、联系人、商机、汇报、抽奖、客户日程、聊天记录等业务能力。APP KEY 仅存储在本机，不会上传到云端。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "SCRM_APP_KEY",
      "label": "APP KEY",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "weisheng-scrm",
      "transport": "stdio",
      "command": "npx",
      "args": [
        "--registry=https://registry.npmmirror.com",
        "-y",
        "mcp-server-weisheng-scrm@latest"
      ],
      "env": {
        "SCRM_APP_KEY": "",
        "SCRM_BASE_URL": "https://open.wshoto.com",
        "npm_config_registry": "https://registry.npmmirror.com"
      }
    }
  ]
}
