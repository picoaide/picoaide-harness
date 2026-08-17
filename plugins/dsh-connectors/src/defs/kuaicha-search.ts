import type { ConnectorDef } from '../types.ts'

/** 同花顺快查企业数据 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "kuaicha-search",
  "name": "同花顺快查企业数据",
  "description": "请输入从同花顺快查数据平台获取的 API Key。凭证仅保存在您的本机，由 WorkBuddy 在连接同花顺快查 MCP 时注入请求头；WorkBuddy 云端不存储、不接收该凭证。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "KUAICHA_API_KEY",
      "label": "同花顺快查 API Key",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "kuaicha-search",
      "transport": "streamable-http",
      "url": "https://bizveris.kuaicha365.com/mcp?source=workbuddy",
      "headers": {
        "open-authorization": "Bearer ${KUAICHA_API_KEY}"
      }
    }
  ]
}
