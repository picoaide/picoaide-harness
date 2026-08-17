import type { ConnectorDef } from '../types.ts'

/** TextIn xParse·智能文档解析 connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "textin-xparse",
  "name": "TextIn xParse·智能文档解析",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "\"$HOME/.local/bin/xparse-cli\"",
    "args": [
      "--profile",
      "workbuddy",
      "auth",
      "device",
      "--open-browser=always",
      "--output=jsonl"
    ],
    "installCommand": "curl -fsSL https://dllf.intsig.net/download/2026/Solution/xparse-cli/v2.2.0/install.sh | env XPARSER_VERSION=v2.2.0 sh && \"$HOME/.local/bin/xparse-cli\" --profile workbuddy config set base_url https://api.textin.com",
    "deviceFlow": {
      "uriPattern": "\"verification_uri_complete\"\\s*:\\s*\"(https?://[^\"]+)\"",
      "codePattern": "\"user_code\"\\s*:\\s*\"([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})\""
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "\"$HOME/.local/bin/xparse-cli\"",
    "statusArgs": [
      "--profile",
      "workbuddy",
      "auth",
      "status",
      "--output=json"
    ]
  },
  "mcp": []
}
