import type { ConnectorDef } from '../types.ts'

/** 腾讯营销投放 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "tencentads",
  "name": "腾讯营销投放",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "tencentads",
    "args": [
      "auth",
      "login"
    ],
    "installCommand": "npm install -g tencentads-cli@latest",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "tencentads",
    "statusArgs": [
      "auth",
      "status"
    ]
  },
  "mcp": []
}
