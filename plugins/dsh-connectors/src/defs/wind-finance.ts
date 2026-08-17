import type { ConnectorDef } from '../types.ts'

/** Wind 金融数据 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "wind-finance",
  "name": "Wind 金融数据",
  "description": "填写 Wind API Key 以启用万得金融数据查询，支持股票、债券、基金、指数、宏观数据的查询与分析。Key 仅保存在本机 ~/.workbuddy 下，不会上传云端。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "WIND_API_KEY",
      "label": "Wind API Key（个人密钥）",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "wind-finance",
      "transport": "streamable-http",
      "url": "https://mcp.wind.com.cn/vserver_workbuddy/mcp/",
      "headers": {
        "Authorization": "Bearer ${WIND_API_KEY}",
        "Accept": "application/json, text/event-stream"
      }
    }
  ]
}
