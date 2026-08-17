import type { ConnectorDef } from '../types.ts'

/** 企查查·法律数据 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "qcc-legal",
  "name": "企查查·法律数据",
  "description": "检索与核验中国法律法规和司法案例。覆盖全量现行法律、行政法规、司法解释——法规级到法条级逐字正文，标注时效性与效力级别；海量裁判文书及 2.5 万+ 权威案例（最高法/最高检指导性案例、公报案例、典型案例）；并对文本中的法条与案号引用逐条回库核验、标注时效、生成可溯源超链。用自然语言完成法条依据查找、类案检索、原文调取与法律引用核验，从源头消除法条与案号幻觉。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://agent.qcc.com/mcp/legal/stream/.well-known/oauth-authorization-server",
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
      "serverName": "qcc-legal",
      "transport": "streamable-http",
      "url": "https://agent.qcc.com/mcp/legal/stream"
    }
  ]
}
