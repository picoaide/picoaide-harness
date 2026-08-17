import type { ConnectorDef } from '../types.ts'

/** 同花顺法律AI助手 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "fazhi-law",
  "name": "同花顺法律AI助手",
  "description": "请输入从同花顺法律AI助手平台获取的 API Key。凭证仅保存在您的本机，由 WorkBuddy 在连接同花顺法律AI助手 MCP 时注入请求头；WorkBuddy 云端不存储、不接收该凭证。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "FAZHI_API_KEY",
      "label": "同花顺法律AI助手 API Key",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "fazhi-law",
      "transport": "streamable-http",
      "url": "https://bizveris.kuaicha365.com/law_agent/mcp?source=workbuddy",
      "headers": {
        "open-authorization": "Bearer ${FAZHI_API_KEY}"
      }
    }
  ]
}
