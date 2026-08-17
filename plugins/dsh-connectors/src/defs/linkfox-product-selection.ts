import type { ConnectorDef } from '../types.ts'

/** Linkfox 选品 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "linkfox-product-selection",
  "name": "Linkfox 选品",
  "description": "输入Linkfox Agent的 API Key，用于使用Linkfox 选品的所有服务。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "LINKFOX_AGENT_API_KEY",
      "label": "API Key",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "linkfox-product-selection",
      "transport": "streamable-http",
      "url": "https://mcp-tool-gateway.linkfox.com/mcp/any-tool",
      "headers": {
        "Authorization": "${LINKFOX_AGENT_API_KEY}"
      }
    }
  ]
}
