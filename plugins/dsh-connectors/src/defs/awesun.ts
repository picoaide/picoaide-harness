import type { ConnectorDef } from '../types.ts'

/** 向日葵远程控制 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "awesun",
  "name": "向日葵远程控制",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "awesun-cli",
    "args": [
      "login",
      "--qrcode",
      "--url"
    ],
    "installCommand": "npm install -g @aweray/awesun-cli@latest",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "awesun-cli",
    "statusArgs": [
      "login",
      "status"
    ]
  },
  "mcp": []
}
