import type { ConnectorDef } from '../types.ts'

/** 腾讯云 CloudBase connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "cloudbase",
  "name": "腾讯云 CloudBase",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "tcb",
    "args": [
      "login",
      "--flow",
      "web",
      "--yes"
    ],
    "installCommand": "npm install -g @cloudbase/cli@latest",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "tcb",
    "statusArgs": [
      "env",
      "list"
    ]
  },
  "mcp": []
}
