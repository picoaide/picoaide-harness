import type { ConnectorDef } from '../types.ts'

/** 水滴征信 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "cisp-mcp",
  "name": "水滴征信",
  "description": "请从水滴征信平台获取 API Key。凭证仅存储在本机，不会上传到云端。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "CISP_API_KEY",
      "label": "API Key",
      "type": "password",
      "required": true
    }
  ],
  "mcp": [
    {
      "serverName": "cisp-mcp",
      "transport": "streamable-http",
      "url": "https://cisp.zenitera.com/mcp",
      "headers": {
        "Authorization": "Bearer ${CISP_API_KEY}"
      }
    }
  ]
}
