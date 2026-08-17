import type { ConnectorDef } from '../types.ts'

/** LemonClaw connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "lemonclaw",
  "name": "LemonClaw",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "lemonclaw-cli",
    "args": [
      "auth",
      "login"
    ],
    "installCommand": "npm install -g https://download.ningmengyun.com/Skills/lemonclaw-cli-launcher-1.0.2.tgz",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "lemonclaw-cli",
    "statusArgs": [
      "auth",
      "status"
    ]
  },
  "mcp": []
}
