import type { ConnectorDef } from '../types.ts'

/** 腾讯地图 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "tencent-map",
  "name": "腾讯地图",
  "description": "连接你的腾讯地图开发者 Key，用于地点搜索、路线规划、地址解析等。Key 仅存储在本机 ~/.workbuddy下。",
  "authMode": "token",
  "tokenFields": [
    {
      "key": "TENCENT_MAP_KEY",
      "label": "Key",
      "type": "text",
      "required": true
    }
  ],
  "mcp": []
}
