/**
 * End-to-end audit against a REAL MCP server protected by a REAL authorization
 * server (see helpers/real-mcp-oauth-server.ts). Nothing is mocked: discovery,
 * dynamic client registration, PKCE, the loopback callback, bearer validation,
 * access-token expiry, refresh rotation and reuse detection all run for real.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { callRoute, createHarness, waitFor } from './helpers/connector-harness.ts'
import {
  completeAuthorization,
  startRealMcpServer,
  startStaticTokenMcpServer,
  type RealMcpServer,
  type StaticTokenMcpServer,
} from './helpers/real-mcp-oauth-server.ts'
import { TokenRefresher } from '../src/mcp-oauth-provider.ts'
import { ConnectorStore } from '../src/store.ts'
import type { ConnectorDef } from '../src/types.ts'

const servers: RealMcpServer[] = []
const staticServers: StaticTokenMcpServer[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()?.close()
  while (staticServers.length) await staticServers.pop()?.close()
})

function def(origin: string): ConnectorDef {
  return {
    id: 'real-mcp', name: 'Real MCP', description: 'audit', authMode: 'oauth',
    auth: {
      authorizeUrl: `${origin}/oauth/authorize`, tokenUrl: `${origin}/oauth/token`, clientId: '',
      redirectUri: 'http://127.0.0.1/callback', pkce: true, publicClient: true,
      discoveryUrl: `${origin}/mcp`, scopes: 'mcp.read offline_access',
    },
    mcp: [{ serverName: 'real-mcp', transport: 'streamable-http', url: `${origin}/mcp` }],
  }
}

/**
 * One connector authorization, TWO streamable-http MCP servers.
 *
 * This is the production shape that makes the 401 path interesting: each server
 * owns its own transport AND its own provider object (`registerMcp` builds one
 * per server), while both share the single stored credential and therefore the
 * single `TokenRefresher`. Only a per-CREDENTIAL single flight can coalesce
 * their 401s; a per-provider (or per-transport) mutex cannot.
 */
function twoServerDef(origin: string): ConnectorDef {
  const base = def(origin)
  return {
    ...base,
    mcp: [
      { serverName: 'real-mcp-a', transport: 'streamable-http', url: `${origin}/mcp` },
      { serverName: 'real-mcp-b', transport: 'streamable-http', url: `${origin}/mcp` },
    ],
  }
}

/** The provider object `registerMcp` hands the transport (see `createOAuthProvider`). */
interface LiveAuthProvider {
  token: () => Promise<string | undefined>
  onUnauthorized: (ctx: unknown) => Promise<void>
  tokens: () => Promise<{ access_token?: string, refresh_token?: string } | undefined>
}

async function state(h: ReturnType<typeof createHarness>, id: string): Promise<{ status: string, error?: string, request?: { authorizeUrl?: string } | null }> {
  const res = await callRoute(h, `/api/pico/connectors/${id}/state`, 'GET')
  return JSON.parse(res.body) as { status: string, error?: string, request?: { authorizeUrl?: string } | null }
}

/** Poll the state route until an authorize URL appears (the flow is async). */
async function awaitAuthorizeUrl(h: ReturnType<typeof createHarness>, id: string): Promise<string> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const current = await state(h, id)
    const url = current.request?.authorizeUrl
    if (url) return url
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`no authorize URL appeared for ${id} (last state: ${JSON.stringify(await state(h, id))})`)
}

/** Poll the state route until the connector reaches a status. */
async function awaitStatus(h: ReturnType<typeof createHarness>, id: string, wanted: string): Promise<void> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const current = await state(h, id)
    if (current.status === wanted) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`status never became ${wanted} (last: ${JSON.stringify(await state(h, id))})`)
}

/** Drive one registered MCP transport through the REAL SDK client. */
async function openClient(url: string, authProvider: unknown): Promise<Client> {
  const client = new Client({ name: 'audit', version: '1' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: authProvider as never })
  await client.connect(transport)
  return client
}

describe('end-to-end against a real OAuth-protected MCP server', () => {
  it('connects through the full flow and calls a tool with the issued bearer token', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'e2e-real-'))
    const h = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })

    const connect = await callRoute(h, '/api/pico/connectors/real-mcp/connect', 'POST')
    expect(connect.status).toBe(200)

    // be the browser: open the authorize URL the flow published, follow its
    // redirect into the connector's loopback callback
    await completeAuthorization(await awaitAuthorizeUrl(h, 'real-mcp'))
    try {
      await waitFor(() => h.configs.length === 1, 4000)
    } catch (cause) {
      throw new Error(`no MCP registration after the callback; state=${JSON.stringify(await state(h, 'real-mcp'))}`)
    }
    await awaitStatus(h, 'real-mcp', 'connected')

    // dynamic client registration + PKCE code exchange really happened
    expect(server.stats.registrations).toBe(1)
    expect(server.stats.grants).toEqual(['authorization_code'])

    // the connector registered a real transport: drive it and call a tool
    const config = h.configs[0] as unknown as { url: string, authProvider?: unknown }
    expect(config.url).toBe(`${server.origin}/mcp`)
    expect(config.authProvider).toBeDefined()
    const client = new Client({ name: 'audit', version: '1' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      authProvider: config.authProvider as never,
    })
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).toEqual(['echo'])
    const call = await client.callTool({ name: 'echo', arguments: { text: 'hi' } })
    expect(call.content?.[0]?.text).toBe('echo:hi')
    expect(server.stats.toolCalls).toBe(1)
    await client.close()
    h.dispose()
  }, 30_000)

  it('recovers mid-session from a server-side token expiry by refreshing', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'e2e-expire-'))
    const h = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })

    await callRoute(h, '/api/pico/connectors/real-mcp/connect', 'POST')
    await completeAuthorization(await awaitAuthorizeUrl(h, 'real-mcp'))
    await waitFor(() => h.configs.length === 1, 8000)

    const config = h.configs[0] as unknown as { url: string, authProvider: LiveAuthProvider }
    // 判据的一半：401 必须经**我们的** `onUnauthorized` 收口（2026-09-24）。
    // 这条不是装饰 —— provider 一旦被 SDK 认成 OAuthClientProvider，
    // `adaptOAuthProvider` 就会硬编码它自己的 `onUnauthorized`，本用例随即变红。
    const hook = vi.spyOn(config.authProvider, 'onUnauthorized')
    const before = server.stats.grants.filter(g => g === 'refresh_token').length
    const beforeToken = (await config.authProvider.tokens())?.access_token
    const client = await openClient(config.url, config.authProvider)
    expect(server.stats.toolCalls).toBe(0)

    try {
      // the access token dies while the session is live: the next call gets 401
      // and the provider must refresh with the stored refresh token, then retry
      server.expireAccessTokens()
      const call = await client.callTool({ name: 'echo', arguments: { text: 'after-expiry' } })
      expect(call.content?.[0]?.text).toBe('echo:after-expiry')
      expect(server.stats.mcpUnauthorized).toBeGreaterThanOrEqual(1)
      expect(server.stats.grants).toContain('refresh_token')
      // 401 之后确实走了 onUnauthorized 的强制刷新（而不是 SDK 自己的那条路径）。
      // 次数是 1 还是 2 由 SSE 通道的 401 是否同时到达决定（实测两种都会出现），
      // 判据落在下面的续期次数上：无论几条 401 同时到，续期只能发生一次。
      expect(hook.mock.calls.length).toBeGreaterThanOrEqual(1)
      // 恰好一次续期，且**没有**第二次出示同一个 refresh token —— 这正是 CI 常红
      // （`Server returned 401 after re-authentication`）的直接判据。
      expect(server.stats.grants.filter(g => g === 'refresh_token').length - before).toBe(1)
      expect(server.stats.revokedRefreshReuse).toBe(0)
      // 重试带的是刷新后的活令牌，并且它真的通过了受保护端点的鉴权（上面那次成功的
      // 工具调用就是证据）；活视图也必须已经前移到服务端刚签发的那一代。
      const after = await config.authProvider.tokens()
      expect(after?.access_token).toBeDefined()
      expect(after?.access_token).not.toBe(beforeToken)
      expect(after?.refresh_token).toBe(server.stats.refreshTokensIssued.at(-1))
    } finally {
      // 断言失败也要关掉传输：SSE 通道会让 `server.close()` 一直等（afterEach 超时）。
      await client.close().catch(() => {})
    }
    h.dispose()
  }, 30_000)

  it('two MCP servers of ONE credential coalesce concurrent 401s into a single refresh', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'e2e-401-race-'))
    const h = createHarness([twoServerDef(server.origin)], dir, { refreshSweepIntervalMs: 0 })

    await callRoute(h, '/api/pico/connectors/real-mcp/connect', 'POST')
    await completeAuthorization(await awaitAuthorizeUrl(h, 'real-mcp'))
    await waitFor(() => h.configs.length === 2, 8000)

    const configs = h.configs as unknown as Array<{ url: string, serverName: string, authProvider: LiveAuthProvider }>
    // 两个 server ⇒ 两个 transport ⇒ 两个**不同的** provider 对象，只有一份凭据。
    expect(configs[0]!.authProvider).not.toBe(configs[1]!.authProvider)
    const [a, b] = await Promise.all([
      openClient(configs[0]!.url, configs[0]!.authProvider),
      openClient(configs[1]!.url, configs[1]!.authProvider),
    ])

    const before = server.stats.grants.filter(g => g === 'refresh_token').length
    server.expireAccessTokens()
    try {
      // 两条 401 同时在飞：修复前它们各自跑一次 SDK 自己的刷新，同一个单次 refresh
      // token 被出示两次 ⇒ 轮换复用检测吊销整个授权，一个调用挂、另一个报
      // `Server returned 401 after re-authentication`（实测 grants=2 / reuse=1）。
      const [first, second] = await Promise.all([
        a.callTool({ name: 'echo', arguments: { text: 'a' } }),
        b.callTool({ name: 'echo', arguments: { text: 'b' } }),
      ])
      expect(first.content?.[0]?.text).toBe('echo:a')
      expect(second.content?.[0]?.text).toBe('echo:b')
      // 并发 401 合并成**恰好一次**续期（per-id 单飞，不是 per-provider）。
      expect(server.stats.grants.filter(g => g === 'refresh_token').length - before).toBe(1)
      expect(server.stats.revokedRefreshReuse).toBe(0)
      // 前置：两条请求确实各自撞了一次 401（否则上面的"合并"是假绿）。
      expect(server.stats.mcpUnauthorized).toBeGreaterThanOrEqual(2)
    } finally {
      // 断言失败也要关掉传输：SSE 通道会让 `server.close()` 一直等（afterEach 超时）。
      await Promise.all([
        a.close().catch(() => {}),
        b.close().catch(() => {}),
      ])
    }
    h.dispose()
  }, 30_000)

  it('refreshes through the connector engine and keeps the rotated token usable', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'e2e-engine-'))
    const h = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    await callRoute(h, '/api/pico/connectors/real-mcp/connect', 'POST')
    await completeAuthorization(await awaitAuthorizeUrl(h, 'real-mcp'))
    await waitFor(() => h.configs.length === 1, 8000)

    const store = new ConnectorStore({ baseDir: dir })
    const refresher = new TokenRefresher({
      read: id => store.readCredential(id),
      write: (id, patch) => store.updateCredential(id, patch),
      target: () => ({ discoveryUrl: `${server.origin}/mcp`, resourceUrl: `${server.origin}/mcp` }),
    })
    const outcome = await refresher.refresh('real-mcp', { force: true })
    expect(outcome.ok).toBe(true)
    const stored = await store.readCredential('real-mcp')
    expect(stored?.refreshToken).toBe(server.stats.refreshTokensIssued.at(-1))
    // the rotated refresh token must still work: refresh again
    const second = await refresher.refresh('real-mcp', { force: true })
    expect(second.ok).toBe(true)
    expect(server.stats.revokedRefreshReuse).toBe(0)
    h.dispose()
  }, 30_000)
})

describe('live public MCP endpoints (network)', () => {
  /**
   * The real, auth-free public endpoints: our transport shape must work against
   * servers we do not control (drift in headers/accept/protocol version shows up
   * here, not in a fake). Skipped automatically when the network is unavailable.
   */
  const publicTargets = [
    { name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp' },
    { name: 'Cloudflare docs', url: 'https://docs.mcp.cloudflare.com/mcp' },
  ]

  it('initializes and lists tools over the public internet', async () => {
    const results: string[] = []
    for (const target of publicTargets) {
      const client = new Client({ name: 'picoaide-audit', version: '1.0.0' }, { capabilities: {} })
      // 每个目标一份**单次预算**（2026-09-16）：本用例声明"离线 CI 不算失败"，
      // 但此前只看错误类型——链路慢/被丢包时 connect 会一直挂着，把 60s 的测试
      // 预算吃光后以超时失败（CI 实测 60_006ms），把"没网"误报成产品缺陷。
      // 现在超时与断网同样归入 offline（两者都不提供产品信号）。
      const controller = new AbortController()
      const perTarget = setTimeout(() => controller.abort(), 12_000)
      const transport = new StreamableHTTPClientTransport(new URL(target.url), {
        requestInit: { headers: {}, signal: controller.signal },
      })
      try {
        await client.connect(transport)
        const tools = await client.listTools()
        results.push(`${target.name}=${tools.tools.length}`)
        expect(tools.tools.length).toBeGreaterThan(0)
      } catch (error) {
        // a sandboxed/offline/slow CI box must not fail the suite: report and move on
        const message = String((error as Error)?.message ?? error)
        const offline = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|fetch failed|network|abort/iu.test(message)
          || (error as Error)?.name === 'AbortError'
        if (offline) {
          results.push(`${target.name}=offline`)
          continue
        }
        throw error
      } finally {
        clearTimeout(perTarget)
        await client.close().catch(() => {})
      }
    }
    expect(results.length).toBe(publicTargets.length)
  }, 60_000)
})

describe('end-to-end against a real static-token MCP server', () => {
  it('the token form connects and the transport sends the submitted bearer', async () => {
    const server = await startStaticTokenMcpServer('secret-token-1')
    staticServers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'e2e-token-'))
    const tokenDef: ConnectorDef = {
      id: 'static-mcp', name: 'Static MCP', description: 'audit', authMode: 'token',
      tokenFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
      // the definition maps the credential field into the request header; the
      // framework fills `${token}` from the stored fields
      mcp: [{ serverName: 'static-mcp', transport: 'streamable-http', url: `${server.origin}/mcp`, headers: { Authorization: 'Bearer ${token}' } }],
    }
    const h = createHarness([tokenDef], dir, { refreshSweepIntervalMs: 0 })
    const connect = await callRoute(h, '/api/pico/connectors/static-mcp/connect', 'POST')
    expect(connect.status).toBe(200)
    const submitted = await callRoute(h, '/api/pico/connectors/static-mcp/auth-submit', 'POST', {
      fields: { token: 'secret-token-1' },
    })
    expect(submitted.status).toBe(200)
    await waitFor(() => h.configs.length === 1, 8000)

    const config = h.configs[0] as unknown as { url: string, headers?: Record<string, string> }
    const client = new Client({ name: 'audit', version: '1' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers ?? {} } })
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).toEqual(['ping'])
    const call = await client.callTool({ name: 'ping', arguments: {} })
    expect(call.content?.[0]?.text).toBe('pong')
    expect(server.seenTokens).toContain('secret-token-1')
    await client.close()
    h.dispose()
  }, 30_000)

  it('a token-form connector is not refreshable and reports the failure honestly', async () => {
    const server = await startStaticTokenMcpServer('secret-token-1')
    staticServers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'e2e-token2-'))
    const tokenDef: ConnectorDef = {
      id: 'static-mcp', name: 'Static MCP', description: 'audit', authMode: 'token',
      tokenFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
      mcp: [{ serverName: 'static-mcp', transport: 'streamable-http', url: `${server.origin}/mcp`, headers: { Authorization: 'Bearer ${token}' } }],
    }
    const h = createHarness([tokenDef], dir, { refreshSweepIntervalMs: 0 })
    await callRoute(h, '/api/pico/connectors/static-mcp/connect', 'POST')
    await callRoute(h, '/api/pico/connectors/static-mcp/auth-submit', 'POST', { fields: { token: 'wrong-token' } })
    await waitFor(() => h.configs.length === 1, 8000)
    const refresh = await callRoute(h, '/api/pico/connectors/static-mcp/refresh', 'POST')
    expect(refresh.status).toBe(400) // not-applicable: no OAuth target
    const row = (JSON.parse((await callRoute(h, '/api/pico/connectors', 'GET')).body) as
      { connectors: Array<{ id: string, canRefresh: boolean }> }).connectors.find(c => c.id === 'static-mcp')
    expect(row?.canRefresh).toBe(false)
    h.dispose()
  }, 30_000)
})

describe('first connect without a credential', () => {
  it('reports "authorize first" instead of leaking the transport error', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'e2e-nocred-'))
    const h = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    // No credential exists: the row is disconnected and nothing registers yet.
    const listed = (JSON.parse((await callRoute(h, '/api/pico/connectors', 'GET')).body) as
      { connectors: Array<{ id: string, status: string }> }).connectors.find(c => c.id === 'real-mcp')
    expect(listed?.status).toBe('disconnected')

    // Model the failure a user hit in the field: the row carries no credential
    // while an authorization-protected transport is registered anyway. The
    // error surfaced on the row must tell the user what to do.
    const store = new ConnectorStore({ baseDir: dir })
    await store.writeCredential('real-mcp', { accessToken: 'revoked-token', updatedAt: Date.now() })
    h.emitSession({ username: 'user-a' })
    await new Promise(r => setTimeout(r, 300))
    const row = (JSON.parse((await callRoute(h, '/api/pico/connectors', 'GET')).body) as
      { connectors: Array<{ id: string, status: string, error?: string }> }).connectors.find(c => c.id === 'real-mcp')
    // either it connected (server would reject the token) or it explained why not
    if (row?.status === 'error') expect(row.error).toContain('需要先完成授权')
    h.dispose()
  }, 30_000)
})

describe('concurrency against the real authorization server', () => {
  it('ON-DEMAND + SWEEP refresh racing: exactly one grant, the stored token stays usable', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'e2e-race-'))
    const h = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    await callRoute(h, '/api/pico/connectors/real-mcp/connect', 'POST')
    await completeAuthorization(await awaitAuthorizeUrl(h, 'real-mcp'))
    await waitFor(() => h.configs.length === 1, 8000)

    const store = new ConnectorStore({ baseDir: dir })
    const refresher = new TokenRefresher({
      read: id => store.readCredential(id),
      write: (id, patch) => store.updateCredential(id, patch),
      target: () => ({ discoveryUrl: `${server.origin}/mcp`, resourceUrl: `${server.origin}/mcp` }),
    })
    const grantsBefore = server.stats.grants.filter(g => g === 'refresh_token').length
    // the sweep and a tool-call 401 fire together (the common field race)
    const [a, b] = await Promise.all([
      refresher.refresh('real-mcp', { force: true }),
      refresher.refresh('real-mcp', { force: true }),
    ])
    expect(a.ok && b.ok).toBe(true)
    const grantsAfter = server.stats.grants.filter(g => g === 'refresh_token').length
    expect(grantsAfter - grantsBefore).toBe(1)
    expect(server.stats.revokedRefreshReuse).toBe(0)
    // the rotated credential is the one stored, and it still works
    const third = await refresher.refresh('real-mcp', { force: true })
    expect(third.ok).toBe(true)
    expect(server.stats.revokedRefreshReuse).toBe(0)
    h.dispose()
  }, 30_000)
})
