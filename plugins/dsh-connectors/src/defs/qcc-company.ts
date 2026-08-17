import type { ConnectorDef } from '../types.ts'

/** 企查查 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "qcc-company",
  "name": "企查查",
  "description": "查询和核实企业工商登记信息。支持股东结构、实际控制人、受益所有人、高管团队、对外投资、财务数据、年报及上市信息查询，用自然语言快速完成企业身份核验与背景调查。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://agent.qcc.com/mcp/company/stream",
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
      "serverName": "qcc-company",
      "transport": "streamable-http",
      "url": "https://agent.qcc.com/mcp/company/stream"
    }
  ]
}
