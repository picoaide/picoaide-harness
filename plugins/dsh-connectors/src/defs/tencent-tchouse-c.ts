import type { ConnectorDef } from '../types.ts'

/** 腾讯云数据仓库 TCHouse-C connector (generated from the WorkBuddy connector marketplace). */
export const def: ConnectorDef = {
  "id": "tencent-tchouse-c",
  "name": "腾讯云数据仓库 TCHouse-C",
  "description": "腾讯云数据仓库 TCHouse-C 智能运维与分析助手，用自然语言完成集群健康诊断、慢 SQL 分析、规格选型推荐、表结构设计与 NL2SQL 查询。",
  "authMode": "oauth",
  "auth": {
    "discoveryUrl": "https://tcmcpserver.cloud.tencent.com/tchousec/mcp/.well-known/oauth-authorization-server",
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
      "serverName": "tchouse-c",
      "transport": "streamable-http",
      "url": "https://tcmcpserver.cloud.tencent.com/tchousec/mcp"
    }
  ]
}
