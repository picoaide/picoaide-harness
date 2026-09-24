/**
 * R10 N1 regression — a credential file whose `fields` is not a record must not
 * take the connector down.
 *
 * The credential file is user-editable on purpose (the store sanitizes
 * hand-edited timestamps for exactly that reason), so `"fields": null` is a
 * legal file. The R10-B-05 fix that made `${FIELD}` resolve through
 * `Object.hasOwn` guarded only `undefined`:
 *
 * ```
 * const fields = credential?.fields
 * fields !== undefined && Object.hasOwn(fields, field)   // Object.hasOwn(null, …) throws
 * ```
 *
 * and the throw landed on three user-visible surfaces (W2 remeasured all three):
 *
 *  1. connecting: `status="error"` carrying the raw
 *     `TypeError: Cannot convert undefined or null to object`, zero registrations;
 *  2. the panel's refresh button: HTTP 500 `{"error":"internal error"}`, with the
 *     live header record stuck on the OLD token;
 *  3. a connector with BOTH a stdio and a provider-backed http server: the stdio
 *     child was never re-registered (the throwing call sat in front of the emit
 *     that re-registers it, R10 N1's amplifier).
 *
 * Every judge below is a real-path fact: the plugin's own routes, the credential
 * actually written to disk, the headers of a real `/mcp` request reached through
 * the pinned SDK transport, and the plugin's own registration count. A
 * non-record `fields` means "this credential carries no such field", which is the
 * same outcome as a field that was never set — the framework fills the slot with
 * the live bearer.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { callRoute, createHarness, seedCredential, waitFor } from './helpers/connector-harness.ts'
import { completeAuthorization, startRealMcpServer, type RealMcpServer } from './helpers/real-mcp-oauth-server.ts'
import { ConnectorStore } from '../src/store.ts'
import type { ConnectorDef } from '../src/types.ts'

const servers: RealMcpServer[] = []
afterEach(async () => { while (servers.length) await servers.pop()?.close() })

/** The declared header; `Authorization` has its own rules and is not the subject here. */
const PROBE_HEADER = 'x-probe-key'

function def(origin: string, declared: string, stdio = false): ConnectorDef {
  return {
    id: 'probe-mcp',
    name: 'Probe MCP',
    description: 'r10 h2 null fields',
    authMode: 'oauth',
    auth: {
      authorizeUrl: `${origin}/oauth/authorize`,
      tokenUrl: `${origin}/oauth/token`,
      clientId: '',
      redirectUri: 'http://127.0.0.1/callback',
      pkce: true,
      publicClient: true,
      discoveryUrl: `${origin}/mcp`,
      scopes: 'mcp.read offline_access',
    },
    tokenFields: [{ key: 'API_KEY', label: 'API key', type: 'password' }],
    mcp: [
      ...(stdio ? [{ serverName: 'probe-stdio', transport: 'stdio' as const, command: process.execPath, args: ['-e', ''] }] : []),
      { serverName: 'probe-a', transport: 'streamable-http', url: `${origin}/mcp`, headers: { 'X-Probe-Key': declared } },
    ],
  }
}

/** Connect + authorize through the plugin's own routes; returns the captured registration. */
async function connectAndAuthorize(h: ReturnType<typeof createHarness>, expected: number): Promise<Record<string, unknown>> {
  await callRoute(h, '/api/pico/connectors/probe-mcp/connect', 'POST')
  const deadline = Date.now() + 8000
  let url: string | undefined
  while (Date.now() < deadline) {
    const res = await callRoute(h, '/api/pico/connectors/probe-mcp/state', 'GET')
    url = (JSON.parse(res.body) as { request?: { authorizeUrl?: string } }).request?.authorizeUrl
    if (url) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (url === undefined) throw new Error('no authorize URL')
  await completeAuthorization(url)
  await waitFor(() => h.configs.length === expected, 15_000)
  return h.configs.at(-1) as unknown as Record<string, unknown>
}

/** The row as the panel sees it (the plugin's own state route). */
async function row(h: ReturnType<typeof createHarness>): Promise<{ status?: string, error?: string }> {
  const res = await callRoute(h, '/api/pico/connectors/probe-mcp/state', 'GET')
  return JSON.parse(res.body) as { status?: string, error?: string }
}

/** The construction the installed `dsh-mcp-client` performs (see the bridge). */
function productionTransport(config: Record<string, unknown>): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(String(config.url ?? '')), {
    requestInit: { headers: { ...((config.headers ?? {}) as Record<string, string>) } },
    ...(config.authProvider === undefined ? {} : { authProvider: config.authProvider as never }),
  })
}

/** Drive one tool call through a real transport and return the server's answer. */
async function callThrough(server: RealMcpServer, config: Record<string, unknown>): Promise<string> {
  const client = new Client({ name: 'r10-h2', version: '1' }, { capabilities: {} })
  try {
    await client.connect(productionTransport(config))
    const result = await client.callTool({ name: 'echo', arguments: { text: 'h2' } }) as { content?: Array<{ text?: string }> }
    return result.content?.[0]?.text ?? ''
  } finally {
    await client.close().catch(() => {})
  }
}

/** The live bearer the provider holds right now (the token the SDK would send). */
async function liveToken(config: Record<string, unknown>): Promise<string> {
  const provider = config.authProvider as { tokens: () => Promise<{ access_token?: string } | undefined> } | undefined
  expect(provider, '前置：provider-backed 注册必须有 authProvider').toBeDefined()
  const tokens = await provider?.tokens()
  const token = tokens?.access_token ?? ''
  expect(token, '前置：provider 必须有活令牌').not.toBe('')
  return token
}

const REQUIRED_HEADER = 'X-Probe-Key'

describe('R10 N1: a credential file with "fields": null', () => {
  it('registers, answers the panel refresh with 200, and keeps the live header on the new token', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    // The endpoint authenticates on the DECLARED slot, so the wire fact below is
    // exactly the header the `${…}` render produced.
    server.requireExtraHeader(REQUIRED_HEADER)
    const dir = mkdtempSync(join(tmpdir(), 'r10h2-null-'))
    const h = createHarness([def(server.origin, '${API_KEY}')], dir, { refreshSweepIntervalMs: 0 })
    try {
      await seedCredential(dir, 'probe-mcp', { fields: null as never })
      // 前置：盘上真的是 `"fields": null`（手改文件的形态），不是被 store 规范化掉了。
      const onDisk = JSON.parse(readFileSync(join(dir, 'probe-mcp.json'), 'utf8')) as { fields?: unknown }
      expect(onDisk.fields, '前置：凭据文件里就是 null').toBeNull()

      // ① 注册：不能因为一个 cosmetic 的凭据文件缺陷整条失败。
      const config = await connectAndAuthorize(h, 1)
      expect((config as { authProvider?: unknown }).authProvider, '前置：provider-backed（活头记录存在）').toBeDefined()
      const state = await row(h)
      expect(state.status, `注册必须成功（实际：${JSON.stringify(state)}）`).toBe('connected')
      expect(state.error ?? '', '行上不得出现原始 TypeError').not.toContain('Cannot convert')

      // `${API_KEY}` 解析不出值（整个声明就是一个模板）⇒ 这一槽位不携带凭据 ⇒
      // 框架按"留空自动填 bearer"处理（与 R10 N3 的未知字段同一条规则）。
      const before = await liveToken(config)
      expect((config.headers as Record<string, string>)[REQUIRED_HEADER], '活头必须是框架填的 bearer')
        .toBe(`Bearer ${before}`)
      expect(await callThrough(server, config), '连接器必须照常可用').toBe('echo:h2')
      expect(server.stats.mcpUnauthorizedByMethod.POST ?? 0, '线上不得出现 401').toBe(0)

      // ② 面板刷新：旧行为是 HTTP 500 + 活头停在旧令牌。
      const res = await callRoute(h, '/api/pico/connectors/probe-mcp/refresh', 'POST')
      expect(res.status, `刷新路由必须给出 200（实际 ${String(res.status)} ${res.body}）`).toBe(200)
      const after = await liveToken(config)
      expect(after, '前置：刷新必须真的换了令牌（否则"活头跟随"这条断言空转）').not.toBe(before)
      await waitFor(() => (config.headers as Record<string, string>)[REQUIRED_HEADER] === `Bearer ${after}`, 15_000)
      // ③ 线上事实：下一条真实请求带的是新令牌，且被端点接受。
      expect(await callThrough(server, config), '刷新后必须照常可用').toBe('echo:h2')
      expect(server.stats.mcpBearerTokens.at(-1), '线上必须看到刷新后的令牌').toBe(after)
      expect(server.stats.mcpUnauthorizedByMethod.POST ?? 0, '整条链路上不得出现 401').toBe(0)
    } finally { h.dispose() }
  }, 90_000)

  it('a mixed stdio + http connector still re-registers its stdio child on refresh', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r10h2-mixed-'))
    const h = createHarness([def(server.origin, '${API_KEY}', true)], dir, {
      refreshSweepIntervalMs: 0,
      requestApproval: () => true,
    })
    try {
      // W2 的复现形态：先用手改文件的那份凭据完成注册（否则一切都被注册失败挡住，
      // 测不出放大器的后果），**再把文件改成 `"fields": null`**，然后走面板刷新。
      await seedCredential(dir, 'probe-mcp', { fields: { API_KEY: 'seed-key' } })
      const http = await connectAndAuthorize(h, 2)
      expect((http as { authProvider?: unknown }).authProvider, '前置：http 半必须是 provider-backed（活头记录存在）').toBeDefined()
      expect(h.configs.map(config => config.transport).sort(), '前置：stdio 与 http 两条注册都在').toEqual(['stdio', 'streamable-http'])
      expect((http.headers as Record<string, string>)[REQUIRED_HEADER], '前置：注册时的活头是声明值').toBe('seed-key')
      const before = h.configs.length

      // 手改凭据文件：`"fields": null`（store 明确容忍手改文件）。
      const store = new ConnectorStore({ baseDir: dir })
      await store.updateCredential('probe-mcp', { fields: null as never })

      const res = await callRoute(h, '/api/pico/connectors/probe-mcp/refresh', 'POST')
      // ① 拆掉 try/catch（旧行为）：同步刷活头抛出 ⇒ 刷新 promise 拒绝 ⇒ 这里 500。
      expect(res.status, `刷新路由必须给出 200（实际 ${String(res.status)} ${res.body}）`).toBe(200)
      // ② 同一个异常若穿出 onRefreshed，`ctx.emit` 永不执行 ⇒ stdio 子进程拿不到新凭据
      // （注册数停在 2）。事件是唯一的重注册入口，所以这条断言就是"emit 真的跑了"。
      await waitFor(() => h.configs.length > before, 15_000)
      expect(h.configs.map(config => config.serverName)).toContain('probe-stdio')
      expect(h.configs.length, 'stdio 必须被重新注册').toBe(before + 1)
      // ③ 活头必须跟到刷新后的令牌（拆掉 `fields` 守卫时渲染抛错、就地更新被跳过 ⇒ 停在 seed-key）。
      const live = await liveToken(http)
      await waitFor(() => (http.headers as Record<string, string>)[REQUIRED_HEADER] === `Bearer ${live}`, 15_000)
      expect(await row(h)).toMatchObject({ status: 'connected' })
    } finally { h.dispose() }
  }, 90_000)

  it('control: a real field record still resolves exactly', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r10h2-ctl-'))
    const h = createHarness([def(server.origin, 'Token ${API_KEY}')], dir, { refreshSweepIntervalMs: 0 })
    try {
      await seedCredential(dir, 'probe-mcp', { fields: { API_KEY: 'field-value-1' } })
      const config = await connectAndAuthorize(h, 1)
      // 声明的值本身就是这一槽位的凭据（认证仍走 provider 的 Authorization），
      // 所以这里断言渲染记录逐字解析 —— 守卫不得误杀真实字段。
      expect((config.headers as Record<string, string>)[REQUIRED_HEADER], '真实字段必须逐字解析').toBe('Token field-value-1')
      expect(await callThrough(server, config)).toBe('echo:h2')
      expect(server.stats.mcpUnauthorizedByMethod.POST ?? 0).toBe(0)
    } finally { h.dispose() }
  }, 90_000)

  it('control: an ARRAY "fields" is not a field record either ("${0}" must not resolve)', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    server.requireExtraHeader(REQUIRED_HEADER)
    const dir = mkdtempSync(join(tmpdir(), 'r10h2-arr-'))
    const h = createHarness([def(server.origin, '${0}')], dir, { refreshSweepIntervalMs: 0 })
    try {
      await seedCredential(dir, 'probe-mcp', { fields: ['leaked-index'] as never })
      const config = await connectAndAuthorize(h, 1)
      const token = await liveToken(config)
      expect((config.headers as Record<string, string>)[REQUIRED_HEADER], '非记录必须等价于"没有字段"').toBe(`Bearer ${token}`)
      expect(await callThrough(server, config)).toBe('echo:h2')
      // 线上原始头里不得出现数组元素（旧查表会把 `${0}` 解析成 'leaked-index'）。
      for (const record of server.stats.mcpHeaders) {
        expect(String(record[PROBE_HEADER] ?? ''), '数组元素不得被当成字段值上线').not.toContain('leaked-index')
      }
    } finally { h.dispose() }
  }, 90_000)
})
