import type { ConnectorDef } from '../types.ts'

/** 携程问道 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "ctrip-wendao",
  "name": "携程问道",
  "description": "输入携程问道 API Token（从携程问道开放平台申请）",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "WENDAO_API_KEY",
      "label": "API Token",
      "type": "password",
      "required": true
    }
  ],
  "mcp": []
}
