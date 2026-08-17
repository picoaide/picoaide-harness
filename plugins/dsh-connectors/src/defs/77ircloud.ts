import type { ConnectorDef } from '../types.ts'

/** 铱云AI供应链 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "77ircloud",
  "name": "铱云AI供应链",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "ircloud-cli",
    "args": [
      "auth",
      "login"
    ],
    "installCommand": "npm install -g https://oss-openclaw.77ircloud.com/cli_tools/workbuddy/npm/ircloud-cli-workbuddy-1.0.0.tgz",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "ircloud-cli",
    "statusArgs": [
      "auth",
      "status"
    ]
  },
  "mcp": []
}
