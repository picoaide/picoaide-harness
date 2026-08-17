import type { ConnectorDef } from '../types.ts'

/** 飞书 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "feishu",
  "name": "飞书",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "lark-cli",
    "args": [
      "config",
      "init",
      "--new",
      "--lang",
      "en"
    ],
    "installCommand": "npm install -g @larksuite/cli",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "lark-cli",
    "statusArgs": [
      "auth",
      "status"
    ]
  },
  "mcp": []
}
