import type { ConnectorDef } from '../types.ts'

/** shanlong-claw connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "shanlong-claw",
  "name": "shanlong-claw",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "\"$SL_CLI_HOME/bin/sl\"",
    "args": [
      "connector",
      "auth"
    ],
    "installCommand": "bash \"$SL_CONNECTOR_HOME/install.sh\"",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "\"$SL_CLI_HOME/bin/sl\"",
    "statusArgs": [
      "connector",
      "status"
    ]
  },
  "mcp": []
}
