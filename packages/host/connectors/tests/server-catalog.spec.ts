import { describe, expect, it } from 'vitest'
import { parseServerConnectors } from '../src/index.ts'

// 服务端 0042 种子的真实定义(从 migrations-pg/0042_connectors.sql 复制)。
const EXAMPLE_MCP_DEF = JSON.stringify({
  auth: {
    discoveryUrl: 'https://mcp.example.com/mcp',
    clientId: '',
    authorizeUrl: '',
    tokenUrl: '',
    redirectUri: 'http://127.0.0.1/callback',
    pkce: true,
    publicClient: true,
    scopes: 'offline_access',
  },
  mcp: [{ serverName: 'example-mcp', transport: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
})

const GLITCHTIP_DEF = JSON.stringify({
  tokenFields: [
    { key: 'GLITCHTIP_BASE_URL', label: '服务地址(必填,如自部署地址或 app.glitchtip.com)', type: 'text', required: true },
    { key: 'GLITCHTIP_TOKEN', label: 'API Token(Auth Tokens 页创建,需 org:read / project:read / event:read)', type: 'password', required: true },
    { key: 'GLITCHTIP_ORGANIZATION', label: '组织 slug(如 picoaide)', type: 'text', required: true },
  ],
  examples: ['查询当前未解决的错误 issue', '查看最近一次异常的堆栈详情', '列出错误追踪中的高优先级问题'],
  mcp: [{ serverName: 'glitchtip', transport: 'stdio', command: 'npx', args: ['-y', 'glitchtip-mcp'], env: {} }],
})

describe('parseServerConnectors', () => {
  it('解析 example-mcp: 目录行字段覆盖 + auth/mcp 完整保留', () => {
    const defs = parseServerConnectors([
      { id: 'example-mcp', name: '示例 MCP 智能体', description: '示例描述', auth_mode: 'oauth', definition: EXAMPLE_MCP_DEF },
    ])
    expect(defs).toHaveLength(1)
    const m = defs[0]!
    expect(m.id).toBe('example-mcp')
    expect(m.name).toBe('示例 MCP 智能体')
    expect(m.authMode).toBe('oauth')
    expect(m.auth?.discoveryUrl).toBe('https://mcp.example.com/mcp')
    expect(m.auth?.pkce).toBe(true)
    expect(m.auth?.publicClient).toBe(true)
    expect(m.mcp).toEqual([{ serverName: 'example-mcp', transport: 'streamable-http', url: 'https://mcp.example.com/mcp' }])
  })

  it('解析 glitchtip: tokenFields/examples/mcp 完整保留, authMode=token', () => {
    const defs = parseServerConnectors([
      { id: 'glitchtip', name: 'GlitchTip', description: '错误追踪', auth_mode: 'token', definition: GLITCHTIP_DEF },
    ])
    expect(defs).toHaveLength(1)
    const g = defs[0]!
    expect(g.id).toBe('glitchtip')
    expect(g.authMode).toBe('token')
    expect(g.tokenFields).toHaveLength(3)
    expect(g.tokenFields![0]).toMatchObject({ key: 'GLITCHTIP_BASE_URL', required: true, type: 'text' })
    expect(g.examples).toHaveLength(3)
    expect(g.mcp).toEqual([{ serverName: 'glitchtip', transport: 'stdio', command: 'npx', args: ['-y', 'glitchtip-mcp'], env: {} }])
  })

  it('剔除非法条目, 其余保留', () => {
    const defs = parseServerConnectors([
      { id: 'bad', name: 'Bad', description: '', auth_mode: 'token', definition: '{not json' },
      { id: 'nomcp', name: 'NoMcp', description: '', auth_mode: 'token', definition: '{"tokenFields":[]}' },
      { id: 'good', name: 'Good', description: 'x', auth_mode: 'oauth', definition: EXAMPLE_MCP_DEF },
    ])
    expect(defs).toHaveLength(1)
    expect(defs[0]!.id).toBe('good')
  })

  it('目录行缺 auth_mode 时回退定义 JSON 的 authMode', () => {
    const defs = parseServerConnectors([
      { id: 'example-mcp', name: '', description: '', auth_mode: '', definition: EXAMPLE_MCP_DEF },
    ])
    expect(defs[0]!.authMode).toBe('oauth')
    expect(defs[0]!.name).toBe('') // 目录行 name 为空 → 原样(定义内没有 name)
  })

  it('drops a row with an unsupported auth_mode instead of silently registering it', () => {
    const defs = parseServerConnectors([
      { id: 'legacy-cli', name: 'Legacy CLI', description: '', auth_mode: 'cli', definition: EXAMPLE_MCP_DEF },
      { id: 'good', name: 'Good', description: '', auth_mode: 'oauth', definition: EXAMPLE_MCP_DEF },
    ])
    expect(defs.map(d => d.id)).toEqual(['good'])
  })

  it('never emits an undefined name (the settings panel calls name.toLowerCase on search)', () => {
    const defs = parseServerConnectors([
      { id: 'nameless', name: undefined as unknown as string, description: undefined as unknown as string, auth_mode: 'oauth', definition: EXAMPLE_MCP_DEF },
    ])
    expect(defs).toHaveLength(1)
    expect(typeof defs[0]!.name).toBe('string')
    expect(typeof defs[0]!.description).toBe('string')
  })

  it('服务端合成 defaultValue 能透传到 tokenFields', () => {
    const def = JSON.parse(GLITCHTIP_DEF) as Record<string, unknown>
    const fields = (def.tokenFields as Array<Record<string, unknown>>).map((f) => (
      f.key === 'GLITCHTIP_BASE_URL' ? { ...f, defaultValue: 'https://gt.example.com' } : f
    ))
    def.tokenFields = fields
    const defs = parseServerConnectors([
      { id: 'glitchtip', name: 'GlitchTip', description: '', auth_mode: 'token', definition: JSON.stringify(def) },
    ])
    expect(defs[0]!.tokenFields![0]).toMatchObject({ key: 'GLITCHTIP_BASE_URL', defaultValue: 'https://gt.example.com' })
  })
})
