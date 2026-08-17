import type { ConnectorDef } from '../types.ts'

/** AI-HIVE connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "ai-hive",
  "name": "AI-HIVE",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "npx",
    "args": [
      "-y",
      "@infimind-next/ai-hive-mcp@0.2.1",
      "auth"
    ],
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "npx",
    "statusArgs": [
      "-y",
      "@infimind-next/ai-hive-mcp@0.2.1",
      "status"
    ]
  },
  "mcp": []
}
