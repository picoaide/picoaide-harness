import type { ConnectorDef } from '../types.ts'

/** 秒哒应用搭建 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "miaoda",
  "name": "秒哒应用搭建",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "miaoda",
    "args": [
      "login"
    ],
    "installCommand": "npm i -g miaoda-cli",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "miaoda",
    "statusArgs": [
      "status"
    ]
  },
  "mcp": []
}
