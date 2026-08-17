import type { ConnectorDef } from '../types.ts'

/** 智慧芽专利&文献融合检索 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "patsnap-search",
  "name": "智慧芽专利&文献融合检索",
  "description": "API Key 仅存储在本机，由 WorkBuddy 在连接 MCP 服务时注入到连接 URL 的 apikey 参数中，不会上传到云端。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "PATSNAP_API_KEY",
      "label": "智慧芽 API Key",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "patsnap-search",
      "transport": "streamable-http",
      "url": "https://connect.zhihuiya.com/2b0355/logic-mcp?apikey=${PATSNAP_API_KEY}"
    }
  ]
}
