import type { ConnectorDef } from '../types.ts'

/** 及刻智能·时空数据MCP connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "opendata",
  "name": "及刻智能·时空数据MCP",
  "description": "请输入从及刻开放平台生成的MCP key，key仅保存在本机，key失效可通过下方链接去重新生成并更新。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "REGION_INSIGHT_API_KEY",
      "label": "MCP Key",
      "type": "password",
      "required": true
    }
  ],
  "mcp": []
}
