import type { ConnectorDef } from '../types.ts'

/** 北森AI · HR专家 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "beisen-cli",
  "name": "北森AI · HR专家",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "beisen-cli",
    "args": [
      "auth",
      "login"
    ],
    "installCommand": "npm install -g beisen-cli",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": false,
    "statusCommand": "beisen-cli",
    "statusArgs": [
      "auth",
      "status"
    ]
  },
  "mcp": []
}
