import { describe, expect, it } from 'vitest'
import { parseServerConnectors } from '../src/index.ts'

/**
 * Contract test with the PRODUCTION catalog (captured 2026-09-14 from the beta
 * environment's `connectors` table, enabled rows only). The bootstrap route
 * emits exactly `{id,name,description,auth_mode,definition}` and the client
 * parser must accept every real definition: a drift here means "the admin saved
 * a connector and the employee客户端 silently shows nothing".
 */
const REAL_CATALOG = [
    {"id": "moka", "name": "Moka HR 智能体", "description": "招聘和人事一体的 AI 同事,把查询与执行收进一个对话。人才推荐、招聘动态、考勤绩效、审批待办,一句话问清;智能寻聘、面试分析与面试官评估,一句话发起。", "auth_mode": "oauth", "definition": "{\"auth\":{\"discoveryUrl\":\"https://mcp.mokahr.com/mcp\",\"clientId\":\"\",\"authorizeUrl\":\"\",\"tokenUrl\":\"\",\"redirectUri\":\"http://127.0.0.1/callback\",\"pkce\":true,\"publicClient\":true,\"scopes\":\"offline_access\"},\"mcp\":[{\"serverName\":\"moka\",\"transport\":\"streamable-http\",\"url\":\"https://mcp.mokahr.com/mcp\"}]}"},
    {"id": "sales-easy", "name": "销售易", "description": "销售易 NeoCRM 官方 MCP:查询客户、线索、商机、联系人,执行 XOQL 查询与元数据操作", "auth_mode": "oauth", "definition": "{\"auth\":{\"authorizeUrl\":\"https://mcp.xiaoshouyi.com/oauth/authorize\",\"tokenUrl\":\"https://mcp.xiaoshouyi.com/oauth/token\",\"registrationEndpoint\":\"https://mcp.xiaoshouyi.com/oauth/register\",\"clientId\":\"\",\"redirectUri\":\"\",\"scopes\":\"offline_access\",\"pkce\":true,\"publicClient\":true},\"examples\":[\"查询最近赢单的 10 个商机\",\"统计各行业客户数量\",\"帮我找一下联系人张三\"],\"mcp\":[{\"serverName\":\"neo-crm\",\"transport\":\"streamable-http\",\"url\":\"https://mcp.xiaoshouyi.com/mcp\"}]}"},
]

describe('server catalog contract (real definitions)', () => {
  it('parses every enabled definition the server actually ships', () => {
    const defs = parseServerConnectors(REAL_CATALOG)
    expect(defs.map(d => d.id).sort()).toEqual(['moka', 'sales-easy'])
    const moka = defs.find(d => d.id === 'moka')
    expect(moka?.authMode).toBe('oauth')
    expect(moka?.mcp[0]?.transport).toBe('streamable-http')
    expect(moka?.mcp[0]?.url).toBe('https://mcp.mokahr.com/mcp')
    expect((moka?.auth as { discoveryUrl?: string })?.discoveryUrl).toBe('https://mcp.mokahr.com/mcp')
    const salesEasy = defs.find(d => d.id === 'sales-easy')
    expect(salesEasy?.authMode).toBe('oauth')
    expect((salesEasy?.auth as { tokenUrl?: string })?.tokenUrl).toBe('https://mcp.xiaoshouyi.com/oauth/token')
    // both are refreshable (refresh_token + offline_access scope)
    expect((moka?.auth as { scopes?: string })?.scopes).toBe('offline_access')
    expect((salesEasy?.auth as { scopes?: string })?.scopes).toBe('offline_access')
  })

  it('drops a row the client cannot trust instead of blanking the catalog', () => {
    const defs = parseServerConnectors([
      ...REAL_CATALOG,
      { id: 'evil', name: 'Evil', description: 'x', auth_mode: 'oauth', definition: JSON.stringify({ mcp: [{ serverName: 'evil', transport: 'streamable-http', url: 'http://169.254.169.254/mcp' }] }) },
      { id: 'broken', name: 'Broken', description: 'x', auth_mode: 'oauth', definition: '{not json' },
    ])
    expect(defs.map(d => d.id).sort()).toEqual(['moka', 'sales-easy'])
  })
})
