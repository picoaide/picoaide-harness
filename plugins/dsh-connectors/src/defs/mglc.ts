import type { ConnectorDef } from '../types.ts'

/** 芒果灵创 CLI connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "mglc",
  "name": "芒果灵创 CLI",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "mglc",
    "args": [
      "auth",
      "--source",
      "workbuddy"
    ],
    "installCommand": "curl -fsSL https://aigc-assets.mgtv.com/mglc/install.sh | bash",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "mglc",
    "statusArgs": [
      "status",
      "--text-plain"
    ]
  },
  "mcp": []
}
