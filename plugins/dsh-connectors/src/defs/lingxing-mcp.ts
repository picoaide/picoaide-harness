import type { ConnectorDef } from '../types.ts'

/** 领星ERP connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "lingxing-mcp",
  "name": "领星ERP",
  "description": "连接您的领星ERP账号。X-Mcp-Key 仅存储在本机，由 WorkBuddy 在连接领星 MCP 服务时通过请求头注入。请勿向他人分享该密钥。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "LINGXING_MCP_KEY",
      "label": "X-Mcp-Key",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "lingxing-mcp",
      "transport": "streamable-http",
      "url": "https://openmcp.lingxing.com/mcp-servers/lingxing-mcp",
      "headers": {
        "X-Mcp-Key": "${LINGXING_MCP_KEY}"
      }
    }
  ]
}
