import type { ConnectorDef } from '../types.ts'

/** 微盟 WOS CLI connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "woscli",
  "name": "微盟 WOS CLI",
  "description": "",
  "authMode": "cli",
  "auth": {
    "command": "$HOME/.woscli/woscli",
    "args": [
      "login"
    ],
    "installCommand": "curl -fsSL https://ipaas-huawei-cloud-1252328573.cos.ap-shanghai.myqcloud.com/wai/install.sh -o /tmp/woscli-install.sh && sh /tmp/woscli-install.sh",
    "deviceFlow": {
      "uriPattern": "https?://[^\\s\\n\\r\"'<>]+"
    },
    "authWaitForExit": true,
    "suppressBrowser": true,
    "statusCommand": "$HOME/.woscli/woscli",
    "statusArgs": [
      "status"
    ]
  },
  "mcp": []
}
