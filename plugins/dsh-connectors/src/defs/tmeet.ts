import type { ConnectorDef } from '../types.ts'

/** 腾讯会议 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "tmeet",
  "name": "腾讯会议",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "tmeet",
    "args": [
      "auth",
      "login",
      "--no-browser"
    ],
    "installCommand": "npm install -g @tencentcloud/tmeet",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "tmeet",
    "statusArgs": [
      "auth",
      "status"
    ]
  },
  "mcp": []
}
