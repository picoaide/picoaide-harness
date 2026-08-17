import type { ConnectorDef } from '../types.ts'

/** Lovrabet CLI connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "lovrabet-cli",
  "name": "Lovrabet CLI",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "lovrabet",
    "args": [
      "auth",
      "device",
      "--url-only",
      "--source",
      "workbuddy"
    ],
    "installCommand": "npm install -g @lovrabet/lovrabet-cli",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "lovrabet",
    "statusArgs": [
      "auth",
      "status",
      "--global",
      "--check"
    ]
  },
  "mcp": []
}
