import type { ConnectorDef } from '../types.ts'

/** Moka HR 智能体 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "moka",
  "name": "Moka HR 智能体",
  "description": "招聘和人事一体的 AI 同事，把查询与执行收进一个对话。人才推荐、招聘动态、考勤绩效、审批待办，一句话问清；智能寻聘、面试分析与面试官评估，一句话发起。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://mcp.mokahr.com/mcp/.well-known/oauth-authorization-server",
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
      "serverName": "moka",
      "transport": "streamable-http",
      "url": "https://mcp.mokahr.com/mcp"
    }
  ]
}
