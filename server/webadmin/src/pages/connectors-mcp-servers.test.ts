import { describe, expect, it } from 'vitest'
import { standardMcpServersToDefinition } from './connectors-mcp-servers'

/**
 * 与 Go 侧 `connector_mcp_servers_test.go` 同一张用例表：两个实现（管理端导入、
 * 服务端落库）必须对同一份输入给同一份规范定义，否则会出现"页面预览对了、保存
 * 后另一个样子"。
 */
describe('standard MCP configuration import', () => {
  const cases: Array<{ name: string; input: unknown; want: unknown }> = [
    {
      name: '标准形状（mcpServers 包装）',
      input: { mcpServers: { 'neo-crm': { type: 'streamableHttp', url: 'https://mcp.example.com/mcp' } } },
      want: {
        authMode: 'auto',
        mcp: [{ serverName: 'neo-crm', transport: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
      },
    },
    {
      name: '裸映射（省掉包装）',
      input: { 'neo-crm': { type: 'streamableHttp', url: 'https://mcp.example.com/mcp' } },
      want: {
        authMode: 'auto',
        mcp: [{ serverName: 'neo-crm', transport: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
      },
    },
    {
      name: '省略 type（有 url 即远程）',
      input: { mcpServers: { 'neo-crm': { url: 'https://mcp.example.com/mcp' } } },
      want: {
        authMode: 'auto',
        mcp: [{ serverName: 'neo-crm', transport: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
      },
    },
    {
      name: 'type 别名 http',
      input: { mcpServers: { 'neo-crm': { type: 'http', url: 'https://mcp.example.com/mcp' } } },
      want: {
        authMode: 'auto',
        mcp: [{ serverName: 'neo-crm', transport: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
      },
    },
    {
      name: 'stdio 形态',
      input: { mcpServers: { 'local-tools': { command: 'npx', args: ['-y', 'foo-mcp'], env: { FOO: 'bar' } } } },
      want: {
        authMode: 'auto',
        mcp: [{ serverName: 'local-tools', transport: 'stdio', command: 'npx', args: ['-y', 'foo-mcp'], env: { FOO: 'bar' } }],
      },
    },
    {
      name: '静态请求头保留',
      input: { mcpServers: { 'neo-crm': { url: 'https://mcp.example.com/mcp', headers: { 'X-Key': 'abc' } } } },
      want: {
        authMode: 'auto',
        mcp: [{ serverName: 'neo-crm', transport: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: { 'X-Key': 'abc' } }],
      },
    },
    {
      name: '我们的可选键与标准形状共存',
      input: { mcpServers: { 'neo-crm': { url: 'https://mcp.example.com/mcp' } }, examples: ['查商机'] },
      want: {
        authMode: 'auto',
        examples: ['查商机'],
        mcp: [{ serverName: 'neo-crm', transport: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
      },
    },
  ]

  for (const tc of cases) {
    it(tc.name, () => {
      expect(standardMcpServersToDefinition(tc.input)).toEqual(tc.want)
    })
  }

  const invalid: Array<{ name: string; input: unknown; mention: string }> = [
    { name: 'sse 不支持', input: { mcpServers: { a: { type: 'sse', url: 'https://mcp.example.com/sse' } } }, mention: 'sse' },
    { name: '未登记的键', input: { mcpServers: { a: { url: 'https://x.example/mcp', header: {} } } }, mention: 'header' },
    { name: 'serverName 不合法', input: { mcpServers: { NeoCrm: { url: 'https://x.example/mcp' } } }, mention: 'NeoCrm' },
    { name: '缺 url 与 command', input: { mcpServers: { a: { type: 'streamableHttp' } } }, mention: 'url' },
    { name: 'url 与 command 同时给', input: { mcpServers: { a: { url: 'https://x.example/mcp', command: 'npx' } } }, mention: 'command' },
    { name: 'stdio 却带 url', input: { mcpServers: { a: { type: 'stdio', command: 'npx', url: 'https://x.example/mcp' } } }, mention: 'url' },
    { name: 'mcpServers 不是对象', input: { mcpServers: [] }, mention: 'mcpServers' },
    { name: '空配置', input: { mcpServers: {} }, mention: '没有 server' },
    { name: 'server 项不是对象', input: { mcpServers: { a: 'npx foo' } }, mention: '必须是对象' },
  ]
  for (const tc of invalid) {
    it(`拒绝：${tc.name}`, () => {
      expect(() => standardMcpServersToDefinition(tc.input)).toThrowError(new RegExp(tc.mention))
    })
  }

  it('规范定义原样交回调用方处理（返回 null，不误判）', () => {
    expect(standardMcpServersToDefinition({
      authMode: 'oauth',
      mcp: [{ serverName: 'x', transport: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
    })).toBeNull()
    expect(standardMcpServersToDefinition({ tokenFields: [] })).toBeNull()
    expect(standardMcpServersToDefinition(null)).toBeNull()
    expect(standardMcpServersToDefinition([{ url: 'https://mcp.example.com/mcp' }])).toBeNull()
  })
})
