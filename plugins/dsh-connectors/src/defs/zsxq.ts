import type { ConnectorDef } from '../types.ts'

/** 知识星球 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "zsxq",
  "name": "知识星球",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "zsxq-cli",
    "args": [
      "auth",
      "login",
      "--no-wait"
    ],
    "installCommand": "npm install -g zsxq-cli",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "zsxq-cli",
    "statusArgs": [
      "auth",
      "status"
    ]
  },
  "mcp": []
}
