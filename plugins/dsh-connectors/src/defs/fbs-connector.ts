import type { ConnectorDef } from '../types.ts'

/** 福帮手 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "fbs-connector",
  "name": "福帮手",
  "description": "福帮手人机协同连接器：面向 WorkBuddy 的身份识别、场景包查询、首值与继续使用记录、乐包状态确认和超级合伙人交接。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://api2.u3w.com/fbs-mcp/mcp",
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
      "serverName": "fbs-connector",
      "transport": "streamable-http",
      "url": "https://api2.u3w.com/fbs-mcp/mcp"
    }
  ]
}
