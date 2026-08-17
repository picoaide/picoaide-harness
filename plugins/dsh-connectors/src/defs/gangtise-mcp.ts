import type { ConnectorDef } from '../types.ts'

/** Gangtise投研 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "gangtise-mcp",
  "name": "Gangtise投研",
  "description": "Gangtise MCP汇聚机构级观点，研报，日程等另类数据，提供投研AI Agent预生成数据及全球行情/财务/估值/宏观行业等结构化数据。Key 与接口地址仅存储在本机 ~/.workbuddy 下。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "GTS_ACCESS_KEY",
      "label": "Access Key",
      "type": "password",
      "required": true
    },
    {
      "key": "GTS_SECRET_KEY",
      "label": "Secret Key",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "gangtise-mcp",
      "transport": "streamable-http",
      "url": "https://openapi.gangtise.com/application/open-mcp/",
      "headers": {
        "accessKey": "${GTS_ACCESS_KEY}",
        "secretKey": "${GTS_SECRET_KEY}"
      }
    }
  ]
}
