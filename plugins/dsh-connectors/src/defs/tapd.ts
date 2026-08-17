import type { ConnectorDef } from '../types.ts'

/** TAPD connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "tapd",
  "name": "TAPD",
  "description": "管理需求、缺陷、任务和迭代。查询项目进度、拆分需求、流转状态、填写工时，覆盖需求到发布的研发全生命周期。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://websocket.tapd.cn/mcp/mcp",
    "clientId": "",
    "authorizeUrl": "",
    "tokenUrl": "",
    "redirectUri": "http://127.0.0.1/callback",
    "pkce": true,
    "publicClient": true,
    "scopes": "offline_access"
  },
  "mcp": [
    {
      "serverName": "tapd",
      "transport": "streamable-http",
      "url": "https://websocket.tapd.cn/mcp/mcp"
    }
  ]
}
