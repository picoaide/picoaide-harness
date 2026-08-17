import type { ConnectorDef } from '../types.ts'

/** CNB connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "cnb-api",
  "name": "CNB",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "cnb",
    "args": [
      "login"
    ],
    "installCommand": "npm install -g @cnbcool/cnb-cli",
    "deviceFlow": {
      "uriPattern": "(https?://[^\\s]*/oauth2/device[^\\s]*)",
      "codePattern": "user_code=([^&\\s]+)"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "cnb",
    "statusArgs": [
      "status"
    ]
  },
  "mcp": []
}
