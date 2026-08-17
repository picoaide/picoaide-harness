import type { ConnectorDef } from '../types.ts'

/** 钉钉 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "dingtalk",
  "name": "钉钉",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "dws",
    "args": [
      "auth",
      "login",
      "-y"
    ],
    "installCommand": "npm install -g dingtalk-workspace-cli",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "dws",
    "statusArgs": [
      "auth",
      "status"
    ]
  },
  "mcp": []
}
