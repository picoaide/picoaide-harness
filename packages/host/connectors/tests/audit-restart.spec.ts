/**
 * 「客户端关掉、第二天再用」的生命周期审计（2026-09-14）。
 *
 * 背景（代码事实）：
 *  - 组件卸载只注销 MCP 注册，**凭据留在磁盘**（唯一删除路径是用户显式「断开」）；
 *    Windows 上点窗口关闭是隐藏到托盘，进程与心跳都还在（electron-runtime 的 close → hide）。
 *  - 重开（或退出后重开）时 `restoreAll()` 重新读凭据：`tokenNeedsRefresh()` 为真则先续期，
 *    然后重新注册 MCP；注册成功后建传输时若仍被 401，SDK 的 authProvider 会续期并重试。
 *
 * 注意测试边界：本套夹具**故意 mock 掉 `@deepseek-ai/dsh-mcp-client`**（它只记录 config，
 * 不真的连服务端），所以"连得上"必须由用例自己用 config 建传输来证明 —— 只看
 * `configs.length` 只能说明插件注册过，不能说明连上了。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { callRoute, createHarness, waitFor } from './helpers/connector-harness.ts'
import { completeAuthorization, startRealMcpServer, type RealMcpServer } from './helpers/real-mcp-oauth-server.ts'
import { ConnectorStore } from '../src/store.ts'
import type { ConnectorDef } from '../src/types.ts'

const servers: RealMcpServer[] = []
afterEach(async () => { while (servers.length) await servers.pop()?.close() })

function def(origin: string): ConnectorDef {
  return {
    id: 'moka', name: 'Moka', description: 'audit', authMode: 'oauth',
    auth: {
      authorizeUrl: `${origin}/oauth/authorize`, tokenUrl: `${origin}/oauth/token`, clientId: '',
      redirectUri: 'http://127.0.0.1/callback', pkce: true, publicClient: true,
      discoveryUrl: `${origin}/mcp`, scopes: 'offline_access',
    },
    mcp: [{ serverName: 'moka', transport: 'streamable-http', url: `${origin}/mcp` }],
  }
}

async function row(h: ReturnType<typeof createHarness>, id: string): Promise<{ status: string, error?: string }> {
  const body = JSON.parse((await callRoute(h, '/api/pico/connectors', 'GET')).body) as
    { connectors: Array<{ id: string, status: string, error?: string }> }
  return body.connectors.find(c => c.id === id) ?? { status: '?' }
}

async function awaitRow(
  h: ReturnType<typeof createHarness>,
  id: string,
  predicate: (r: { status: string, error?: string }) => boolean,
  timeoutMs = 8000,
): Promise<{ status: string, error?: string }> {
  const deadline = Date.now() + timeoutMs
  let current = await row(h, id)
  while (Date.now() < deadline && !predicate(current)) {
    await new Promise(r => setTimeout(r, 25))
    current = await row(h, id)
  }
  return current
}

/** One full "open the client, authorize, then quit" cycle on a directory. */
async function authorizeOnce(dir: string, server: RealMcpServer): Promise<void> {
  const first = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
  await callRoute(first, '/api/pico/connectors/moka/connect', 'POST')
  const deadline = Date.now() + 8000
  let url: string | undefined
  while (Date.now() < deadline && url === undefined) {
    const res = await callRoute(first, '/api/pico/connectors/moka/state', 'GET')
    url = (JSON.parse(res.body) as { request?: { authorizeUrl?: string } | null }).request?.authorizeUrl
    if (url === undefined) await new Promise(r => setTimeout(r, 25))
  }
  await completeAuthorization(url as string)
  await waitFor(() => first.configs.length === 1, 8000)
  first.dispose() // "close the app": MCP registrations go away, credentials stay on disk
}

/** Drive the transport the plugin built, proving the persisted credential works. */
async function callToolVia(
  h: ReturnType<typeof createHarness>,
  server: RealMcpServer,
): Promise<{ text: string | undefined, refreshes: number }> {
  const config = h.configs[0] as unknown as { url: string, authProvider: never }
  const before = server.stats.grants.filter(g => g === 'refresh_token').length
  const client = new Client({ name: 'restart-audit', version: '1' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(new URL(config.url), { authProvider: config.authProvider })
  try {
    await client.connect(transport)
    const call = await client.callTool({ name: 'echo', arguments: { text: 'day-2' } })
    return {
      text: call.content?.[0]?.text,
      refreshes: server.stats.grants.filter(g => g === 'refresh_token').length - before,
    }
  } finally {
    await client.close().catch(() => {})
  }
}

describe('restart lifecycle: 第二天打开还能不能用', () => {
  it('关机期间 access token 失效 → 重开时凭据仍可用（自动续期后调用成功）', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'restart-a-'))
    await authorizeOnce(dir, server)

    // the app was closed long enough for the access token to lapse server-side
    server.expireAccessTokens()

    const next = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    await waitFor(() => next.configs.length === 1, 8000)
    const result = await callToolVia(next, server)
    expect(result.text).toBe('echo:day-2')
    // the SDK refreshed the dead token on the wire (the sweep only pre-empts,
    // it does not repair an already-dead token)
    expect(server.stats.grants).toContain('refresh_token')
    expect(result.refreshes).toBeGreaterThanOrEqual(1)
    next.dispose()
  }, 30_000)

  it('fields-only token connector is restored after a full restart', async () => {
    // Regression: restoreAll used to require `accessToken`, so token/device
    // connectors (whose credential is a declared field such as an API key)
    // were silently left disconnected after app restart.
    const tokenDef: ConnectorDef = {
      id: 'api-key-conn', name: 'API Key', description: 'audit', authMode: 'token',
      tokenFields: [{ key: 'api_key', label: 'API key', type: 'password', required: true }],
      mcp: [{ serverName: 'api-key-conn', transport: 'stdio', command: process.execPath, args: ['-e', ''] }],
    }
    const dir = mkdtempSync(join(tmpdir(), 'restart-token-'))
    await new ConnectorStore({ baseDir: dir }).updateCredential('api-key-conn', {
      fields: { api_key: 'secret-key' },
    })

    const first = createHarness([tokenDef], dir, { refreshSweepIntervalMs: 0, requestApproval: () => true })
    await waitFor(() => first.configs.length === 1, 5_000)
    expect((first.configs[0] as unknown as { env?: Record<string, string> }).env?.api_key).toBe('secret-key')
    first.dispose()

    const second = createHarness([tokenDef], dir, { refreshSweepIntervalMs: 0, requestApproval: () => true })
    await waitFor(() => second.configs.length === 1, 5_000)
    expect((second.configs[0] as unknown as { env?: Record<string, string> }).env?.api_key).toBe('secret-key')
    second.dispose()
  }, 20_000)

  it('续期把 refresh token 轮换后，第二天（再一次重开）仍然能续期', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'restart-b-'))
    await authorizeOnce(dir, server)

    // day 2: token lapsed, reopen, use it
    server.expireAccessTokens()
    const day2 = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    await waitFor(() => day2.configs.length === 1, 8000)
    expect((await callToolVia(day2, server)).text).toBe('echo:day-2')
    day2.dispose()

    // day 3: again with the rotated refresh token that must have been persisted
    server.expireAccessTokens()
    const day3 = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    await waitFor(() => day3.configs.length === 1, 8000)
    expect((await callToolVia(day3, server)).text).toBe('echo:day-2')
    expect(server.stats.revokedRefreshReuse).toBe(0)
    day3.dispose()
  }, 30_000)

  it('本地记录的过期时间已过（关机超过一小时）→ 重开时主动续期，而不是先撞 401', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'restart-c-'))
    await authorizeOnce(dir, server)

    // what a >1h shutdown looks like locally: the recorded expiry has passed
    const store = new ConnectorStore({ baseDir: dir })
    await store.updateCredential('moka', { expiresAt: Date.now() - 60_000 })
    const grantsBefore = server.stats.grants.filter(g => g === 'refresh_token').length

    const next = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    // restore refreshes BEFORE registering, so the token endpoint is hit even
    // though this harness never connects a transport (the bridge is mocked).
    const deadline = Date.now() + 8000
    while (Date.now() < deadline
      && server.stats.grants.filter(g => g === 'refresh_token').length === grantsBefore) {
      await new Promise(r => setTimeout(r, 25))
    }
    const refreshed = server.stats.grants.filter(g => g === 'refresh_token').length
    expect(refreshed).toBeGreaterThan(grantsBefore)
    // 等「落盘」而不是等「grant 计数」：grant 在 token 端点应答的那一刻就计数，
    // 而轮换后的凭据是客户端处理完应答才写回 store。负载高时（CI 4 vCPU + 多包并发）
    // 两者之间会被调度拉开，紧跟着读到的还是种子里的 `now - 60s`，断言必红（实测差值
    // 恰为 60_037ms）——所以轮询到新过期时间可见为止。
    let stored = await store.readCredential('moka')
    const persistedDeadline = Date.now() + 8000
    while (Date.now() < persistedDeadline && !((stored?.expiresAt ?? 0) > Date.now())) {
      await new Promise(r => setTimeout(r, 25))
      stored = await store.readCredential('moka')
    }
    expect(stored?.expiresAt).toBeGreaterThan(Date.now())
    next.dispose()
  }, 30_000)

  it('授权已在服务端被吊销（refresh token 也失效）→ 重开时明确报「需要重新授权」', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'restart-d-'))
    await authorizeOnce(dir, server)

    const store = new ConnectorStore({ baseDir: dir })
    await store.updateCredential('moka', {
      accessToken: 'at-revoked', refreshToken: 'rt-revoked', expiresAt: Date.now() - 60_000,
    })

    const next = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    const settled = await awaitRow(next, 'moka', r => r.status === 'unauthorized' || r.status === 'error')
    expect(settled.status).toBe('unauthorized')
    expect(settled.error ?? '').toContain('重新授权')
    next.dispose()
  }, 30_000)
})
