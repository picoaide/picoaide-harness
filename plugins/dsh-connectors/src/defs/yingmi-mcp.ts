import type { ConnectorDef } from '../types.ts'

/** 盈米MCP connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "yingmi-mcp",
  "name": "盈米MCP",
  "description": "填写盈米 MCP API Key 以启用基金与市场数据查询。Key 仅保存在本机 ~/.workbuddy 下，不会上传云端。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "YINGMI_API_KEY",
      "label": "API Key",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "yingmi-mcp",
      "transport": "streamable-http",
      "url": "https://stargate.yingmi.com/mcp/v2?apiKey=${YINGMI_API_KEY}"
    }
  ]
}
