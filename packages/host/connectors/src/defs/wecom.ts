import type { ConnectorDef } from '../types.ts'

/** 企业微信 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "wecom",
  "name": "企业微信",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "wecom-cli",
    "args": [
      "auth",
      "init",
      "--noninteractive",
      "--no-browser"
    ],
    "installCommand": "npm install -g @wecom/cli",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "wecom-cli",
    "statusArgs": [
      "auth",
      "show"
    ]
  },
  "mcp": []
}
