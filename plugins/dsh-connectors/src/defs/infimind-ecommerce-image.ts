import type { ConnectorDef } from '../types.ts'

/** 极睿电商生图 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "infimind-ecommerce-image",
  "name": "极睿电商生图",
  "description": "每位用户须登录个人账户，手动创建名为 WorkBuddy 的独立 Token，且不得在其他 MCP 客户端复用。仅专业版或企业版个人账户可调用，任务消耗该用户本人积分。凭证由 WorkBuddy 仅保存在本机。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "MCP_TOKEN",
      "label": "WorkBuddy Token",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "infimind-ecommerce-image",
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@infimind/image-mcp-cli@1.0.9"
      ],
      "env": {
        "MCP_TOKEN": "${MCP_TOKEN}",
        "API_URL": "https://aigc-next.ecpro.com"
      }
    }
  ]
}
