import type { ConnectorDef } from '../types.ts'

/** jira connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "jira",
  "name": "jira",
  "description": "",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "undefined/.well-known/oauth-authorization-server",
    "clientId": "",
    "authorizeUrl": "",
    "tokenUrl": "",
    "redirectUri": "http://127.0.0.1/callback",
    "pkce": true,
    "publicClient": true,
    "scopes": "offline_access"
  },
  "mcp": [
    {
      "serverName": "jira",
      "transport": "stdio",
      "command": "npx",
      "args": [
        "atlassian-jira-mcp-server"
      ],
      "env": {
        "ATLASSIAN_SITE_NAME": "${JIRA_BASE_URL}",
        "ATLASSIAN_USER_EMAIL": "${JIRA_USERNAME}",
        "ATLASSIAN_API_TOKEN": "${JIRA_API_TOKEN}"
      }
    }
  ]
}
