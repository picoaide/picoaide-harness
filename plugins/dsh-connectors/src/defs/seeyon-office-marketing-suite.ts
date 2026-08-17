import type { ConnectorDef } from '../types.ts'

/** 致远互联协同办公服务 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "seeyon-office-marketing-suite",
  "name": "致远互联协同办公服务",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "node",
    "args": [
      "$SEEYON_CONNECTOR_HOME/cli/seeyon-connector.js",
      "auth"
    ],
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "node",
    "statusArgs": [
      "$SEEYON_CONNECTOR_HOME/cli/seeyon-connector.js",
      "status"
    ]
  },
  "mcp": []
}
