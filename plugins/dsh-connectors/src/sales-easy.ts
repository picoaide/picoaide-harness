import type { ConnectorDef } from './types.ts'

/**
 * 销售易 (NeoCRM) connector.
 *
 * Sales-Easy hosts an official streamable-HTTP MCP server at
 * `https://mcp.xiaoshouyi.com/mcp` guarded by a standard RFC 8414 OAuth
 * authorization server (authorization code + PKCE + dynamic client
 * registration, `offline_access` for refresh tokens). The connector reuses
 * the framework's OAuth flow and injects the bearer token as the MCP
 * Authorization header — mirroring WorkBuddy's OAuth connectors.
 */

const MCP_URL = 'https://mcp.xiaoshouyi.com/mcp'
const OAUTH_ISSUER = 'https://mcp.xiaoshouyi.com'

export const salesEasyDef: ConnectorDef = {
  id: 'sales-easy',
  name: '销售易',
  description: '销售易 NeoCRM 官方 MCP：查询客户、线索、商机、联系人，执行 XOQL 查询与元数据操作',
  authMode: 'oauth',
  auth: {
    authorizeUrl: `${OAUTH_ISSUER}/oauth/authorize`,
    tokenUrl: `${OAUTH_ISSUER}/oauth/token`,
    registrationEndpoint: `${OAUTH_ISSUER}/oauth/register`,
    clientId: '',
    redirectUri: '',
    scopes: 'offline_access',
    pkce: true,
    publicClient: true,
  },
  examples: [
    '查询最近赢单的 10 个商机',
    '统计各行业客户数量',
    '帮我找一下联系人张三',
  ],
  mcp: [
    {
      serverName: 'neo-crm',
      transport: 'streamable-http',
      url: MCP_URL,
    },
  ],
}
