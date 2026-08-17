import type { ConnectorDef } from '../types.ts'

/** 同程程心 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "tc-chengxin",
  "name": "同程程心",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "tc-chengxin",
    "args": [
      "auth",
      "login",
      "--no-wait"
    ],
    "installCommand": "npm install -g \"$TC_CONNECTOR_HOME/cli/tc-chengxin-cli.tgz\"",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "tc-chengxin",
    "statusArgs": [
      "auth",
      "status"
    ]
  },
  "mcp": []
}
