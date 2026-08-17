import type { ConnectorDef } from '../types.ts'

/** 恒生聚源 MCP connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "gildata",
  "name": "恒生聚源 MCP",
  "description": "连接您的恒生聚源 MCP，用于查询金融结构化数据、研究报告、公司公告、新闻资讯、条件选股、宏观行业、工商企业数据。Token 与接口地址仅存储在本机 ~/.workbuddy 下。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "GILDATA_TOKEN",
      "label": "Access Token",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "gildata-finance-data",
      "transport": "streamable-http",
      "url": "https://api.gildata.com/mcp-servers/aidata-assistant-srv-tool?token=${GILDATA_TOKEN}"
    }
  ]
}
