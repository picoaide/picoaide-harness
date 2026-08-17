import type { ConnectorDef } from '../types.ts'

/** WPS知识库 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "wps-knowledgebase",
  "name": "WPS知识库",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "kwiki-cli",
    "args": [
      "auth",
      "login"
    ],
    "installCommand": "node \"$KWIKI_CONNECTOR_HOME/cli/install.js\"",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "kwiki-cli",
    "statusArgs": [
      "auth",
      "status"
    ]
  },
  "mcp": []
}
