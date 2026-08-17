import type { ConnectorDef } from '../types.ts'

/** 上奇产业通-企业动态追踪 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "sq-company-dynamic",
  "name": "上奇产业通-企业动态追踪",
  "description": "请在下方填入您的企业动态追踪 API Key。该凭证仅存储在您本机，用于向企业动态追踪服务发起认证请求。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "API_KEY",
      "label": "API Key",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "sq-company-dynamic",
      "transport": "streamable-http",
      "url": "https://api.chanyedata.com/mcp/c3f5924cc60dbe1729f5cc332e627304/mcp",
      "headers": {
        "Authorization": "${API_KEY}"
      }
    }
  ]
}
