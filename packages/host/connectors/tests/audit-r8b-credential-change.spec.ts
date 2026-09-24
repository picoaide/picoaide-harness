/**
 * R8-B regressions (2026-09-24): what a credential change may and may not do to
 * the connectors it announces itself to.
 *
 * Two properties, both about the SAME seam (`pico/connector-credentials-changed`
 * → re-registration and the `Authorization` a transport is constructed with):
 *
 *  R8-B-2 — a refresh must not kill the call that caused it. The listener used
 *  to re-register the WHOLE connector, and `registerMcp` retires the previous
 *  fibre before loading the new one; the shipped `dsh-mcp-client` disposer
 *  closes the client and its transport (`lib/index.js`, `ctx.effect(() => dispose,
 *  'mcp-client.connection')`). So the 401 refresh disposed the very transport
 *  the SDK was about to retry on — the SDK retries ONCE, on that transport —
 *  and the user's first call after a revoked token ended in `Connection closed`
 *  (measured at t+21…36 ms on both endpoint shapes). streamable-http transports
 *  read the live credential per request, so re-registering them is pure churn;
 *  only stdio children (which get the token in `env` at spawn) need it.
 *
 *  R8-B-1 — a DECLARED `Authorization` belongs to the connector. The round-7
 *  fix dropped every header whose name lower-cases to `authorization` whenever
 *  the transport also got an `authProvider`, so a definition that declares its
 *  own scheme (`ApiKey ${FIELD}` — the shape the admin console suggests, with
 *  `Authorization` as the literal key placeholder) was silently left
 *  unauthenticated: first call 401, re-authentication, retry 401. The drop is
 *  now keyed on PROVENANCE (only the bearer the framework baked from the stored
 *  token), and the coexistence is reported once.
 *
 * Everything below runs on the production path: the plugin's own `apply()`, its
 * routes and its on-disk credential store; a real authorization server
 * (discovery + DCR + PKCE + rotating refresh tokens with reuse detection); a
 * real MCP server that authenticates a real HTTP header; and the transport
 * construction the shipped patch builds (`requestInit: { headers }` +
 * `authProvider`).
 *
 * The ownership wiring is the point of the R8-B-2 case: the harness records the
 * registration fibres, and this spec makes the fibre OWN the transport the way
 * the real bridge does (`dispose → client.close()`). Without that three-line
 * wiring `retire()`'s `dispose()` is a no-op in tests, which is exactly how the
 * round-7 regression case stayed green while the field failed.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { callRoute, createHarness, seedCredential, waitFor } from './helpers/connector-harness.ts'
import {
  completeAuthorization,
  startRealMcpServer,
  startStaticTokenMcpServer,
  type RealMcpServer,
  type StaticTokenMcpServer,
} from './helpers/real-mcp-oauth-server.ts'
import type { ConnectorDef } from '../src/types.ts'

const servers: Array<RealMcpServer | StaticTokenMcpServer> = []
afterEach(async () => {
  while (servers.length) await servers.pop()?.close()
})

/** One MCP registration the plugin handed to `ctx.plugin`. */
interface RegisteredTransport {
  transport: 'stdio' | 'streamable-http'
  serverName: string
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  authProvider?: {
    token: () => Promise<string | undefined>
    tokens: () => Promise<{ access_token?: string, refresh_token?: string } | undefined>
  }
}

async function state(h: ReturnType<typeof createHarness>, id: string): Promise<{ status: string, request?: { authorizeUrl?: string } | null }> {
  const res = await callRoute(h, `/api/pico/connectors/${id}/state`, 'GET')
  return JSON.parse(res.body) as { status: string, request?: { authorizeUrl?: string } | null }
}

async function awaitAuthorizeUrl(h: ReturnType<typeof createHarness>, id: string): Promise<string> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const url = (await state(h, id)).request?.authorizeUrl
    if (url) return url
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('no authorize URL')
}

/**
 * A definition with ONE streamable-http server.
 * @param origin - the authorization server's origin.
 * @param staticEndpoint - true for the seeded-connector shape (deployment has a
 *   token endpoint but no discovery document ⇒ no network round trip before the
 *   re-registration), false for the discovery shape.
 */
function httpDef(origin: string, staticEndpoint: boolean): ConnectorDef {
  return {
    id: 'gated-mcp',
    name: 'Gated MCP',
    description: 'audit',
    authMode: 'oauth',
    auth: {
      authorizeUrl: `${origin}/oauth/authorize`,
      tokenUrl: `${origin}/oauth/token`,
      clientId: '',
      redirectUri: 'http://127.0.0.1/callback',
      pkce: true,
      publicClient: true,
      ...(staticEndpoint ? { registrationEndpoint: `${origin}/oauth/register` } : { discoveryUrl: `${origin}/mcp` }),
      scopes: 'mcp.read offline_access',
    },
    mcp: [{ serverName: 'gated-a', transport: 'streamable-http', url: `${origin}/mcp` }],
  }
}

/** The same connector plus a stdio server, i.e. a mixed connector. */
function mixedDef(origin: string): ConnectorDef {
  const base = httpDef(origin, false)
  return {
    ...base,
    mcp: [
      ...base.mcp,
      { serverName: 'gated-stdio', transport: 'stdio', command: process.execPath, args: ['-e', ''] },
    ],
  }
}

/** Run the connector's real authorization flow and return its registered config. */
async function register(
  h: ReturnType<typeof createHarness>,
  id: string,
  expected: number,
): Promise<RegisteredTransport> {
  await callRoute(h, `/api/pico/connectors/${id}/connect`, 'POST')
  await completeAuthorization(await awaitAuthorizeUrl(h, id))
  await waitFor(() => h.configs.length === expected, 8000)
  return h.configs[0] as unknown as RegisteredTransport
}

/** Build the transport the shipped bridge builds for one registered config. */
function productionTransport(config: RegisteredTransport): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(config.url ?? ''), {
    requestInit: { headers: config.headers ?? {} },
    ...(config.authProvider === undefined ? {} : { authProvider: config.authProvider as never }),
  })
}

/**
 * Give one registration fibre the ownership the real bridge has: its disposer
 * closes the transport it registered. `retire()` then really kills the live
 * transport instead of bumping a mock's call count.
 * @param h - the harness whose fibres are being wired.
 * @param index - index into `h.configs` / `h.fibers`.
 * @param client - the client whose transport that fibre owns.
 * @param onDispose - called with the elapsed ms when the fibre is disposed.
 */
function ownTransport(
  h: ReturnType<typeof createHarness>,
  index: number,
  client: Client,
  onDispose: (at: number, t0: number) => void,
): void {
  // The harness types its fibres as `vi.fn()` records; the disposer is called
  // here for real, so the callable shape is spelled out.
  const fiber = h.fibers[index] as unknown as { dispose: () => void }
  const original = fiber.dispose
  const t0 = Date.now()
  fiber.dispose = (() => {
    onDispose(Date.now() - t0, t0)
    void client.close().catch(() => {})
    original()
  }) as never
}

describe('R8-B-2: a credential change must not kill the 401 recovery it caused', () => {
  it.each([
    ['discovery-endpoint shape', false],
    ['static-endpoint shape', true],
  ])('%s — the retried call survives the refresh', async (_name, staticEndpoint) => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r8b-cred-change-'))
    const h = createHarness([httpDef(server.origin, staticEndpoint)], dir, { refreshSweepIntervalMs: 0 })
    const config = await register(h, 'gated-mcp', 1)
    expect(config.transport).toBe('streamable-http')
    expect(config.authProvider, '前置：oauth 连接器必须拿到 provider').toBeDefined()

    const client = new Client({ name: 'r8b-cred-change', version: '1' }, { capabilities: {} })
    await client.connect(productionTransport(config))
    const disposed: number[] = []
    ownTransport(h, 0, client, at => disposed.push(at))
    try {
      // A real server's answer takes longer than the local work a credential
      // change triggered, so the retry really is in flight across it.
      server.setMcpDelay(300)
      server.expireAccessTokens()
      const stale = (await config.authProvider?.tokens())?.access_token
      expect(stale, '前置：授权完成后必须有一枚访问令牌').toBeTruthy()

      const call = await client.callTool({ name: 'echo', arguments: { text: 'after-refresh' } })
      expect(call.content?.[0]?.text, '被自己触发的重注册掐断的恢复（Connection closed）').toBe('echo:after-refresh')

      // The refresh itself was correct and single …
      expect(server.stats.grants.filter(grant => grant === 'refresh_token').length).toBe(1)
      expect(server.stats.revokedRefreshReuse, '同一个 refresh token 不得被出示两次').toBe(0)
      // … and it did NOT dispose the live transport: the http transport reads
      // the credential per request, so a credential change has nothing to hand
      // it and must leave it alone.
      expect(disposed, '凭据变更不得 dispose 活着的 streamable-http 传输').toEqual([])
      expect(h.configs.length, 'http 传输不需要（也不得被）重注册').toBe(1)
      // Wire evidence: the retry carried the live token, never the dead one again.
      const live = (await config.authProvider?.tokens())?.access_token
      expect(live).toBeDefined()
      expect(live).not.toBe(stale)
      const seen = server.stats.mcpBearerTokens
      const firstLive = seen.indexOf(live!)
      expect(firstLive).toBeGreaterThanOrEqual(0)
      expect(seen.slice(firstLive).filter(token => token === stale)).toEqual([])
      expect(seen.filter(token => token === stale).length).toBeGreaterThanOrEqual(1)
    } finally {
      await client.close().catch(() => {})
      h.dispose()
    }
  }, 40_000)

  it('a mixed connector re-registers ONLY its stdio child and keeps the live http transport', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r8b-cred-mixed-'))
    const h = createHarness([mixedDef(server.origin)], dir, { refreshSweepIntervalMs: 0, requestApproval: () => true })
    await callRoute(h, '/api/pico/connectors/gated-mcp/connect', 'POST')
    await completeAuthorization(await awaitAuthorizeUrl(h, 'gated-mcp'))
    await waitFor(() => h.configs.length === 2, 8000)
    const configs = h.configs as unknown as RegisteredTransport[]
    const httpIndex = configs.findIndex(entry => entry.transport === 'streamable-http')
    const stdioIndex = configs.findIndex(entry => entry.transport === 'stdio')
    expect(httpIndex, '前置：连接器必须有一个 http 服务器').toBeGreaterThanOrEqual(0)
    expect(stdioIndex, '前置：连接器必须有一个 stdio 服务器').toBeGreaterThanOrEqual(0)

    const client = new Client({ name: 'r8b-cred-mixed', version: '1' }, { capabilities: {} })
    await client.connect(productionTransport(configs[httpIndex]!))
    const disposed: number[] = []
    ownTransport(h, httpIndex, client, at => disposed.push(at))
    try {
      server.setMcpDelay(300)
      server.expireAccessTokens()
      const call = await client.callTool({ name: 'echo', arguments: { text: 'mixed' } })
      expect(call.content?.[0]?.text).toBe('echo:mixed')
      // The stdio child is the reason the event exists: it got the new token by
      // being registered again …
      await waitFor(() => h.configs.length === 3, 8000)
      const latest = h.configs[2] as unknown as RegisteredTransport
      expect(latest.transport, '凭据变更后必须重新注册的是 stdio 服务器').toBe('stdio')
      expect(latest.env?.PICOAIDE_CONNECTOR_ACCESS_TOKEN).toBe((await configs[httpIndex]!.authProvider?.tokens())?.access_token)
      // … while the http transport was neither retired nor re-registered.
      expect(h.configs.filter(entry => (entry as unknown as RegisteredTransport).transport === 'streamable-http').length).toBe(1)
      expect(disposed, '混合连接器同样不得 dispose 活着的 http 传输').toEqual([])
      expect(server.stats.revokedRefreshReuse).toBe(0)
    } finally {
      await client.close().catch(() => {})
      h.dispose()
    }
  }, 40_000)
})

describe('R8-B-1: a declared Authorization is the connector\'s own credential', () => {
  /** An oauth connector whose endpoint authenticates a NON-bearer scheme. */
  function apiKeyOAuthDef(asOrigin: string, mcpUrl: string, header = 'Authorization'): ConnectorDef {
    return {
      id: 'apikey-mcp',
      name: 'ApiKey MCP (oauth-classified)',
      description: 'audit',
      authMode: 'oauth',
      tokenFields: [{ key: 'API_KEY', label: 'API key', type: 'password', required: false }],
      auth: {
        authorizeUrl: `${asOrigin}/oauth/authorize`,
        tokenUrl: `${asOrigin}/oauth/token`,
        clientId: '',
        redirectUri: 'http://127.0.0.1/callback',
        pkce: true,
        publicClient: true,
        discoveryUrl: `${asOrigin}/mcp`,
        scopes: 'mcp.read offline_access',
      },
      mcp: [{ serverName: 'apikey-mcp', transport: 'streamable-http', url: mcpUrl, headers: { [header]: 'ApiKey ${API_KEY}' } }],
    }
  }

  it('survives registration, authenticates the tool call, and is reported once', async () => {
    const as = await startRealMcpServer()
    servers.push(as)
    const mcp = await startStaticTokenMcpServer('ApiKey sekret-1')
    servers.push(mcp)
    const dir = mkdtempSync(join(tmpdir(), 'r8b-declared-'))
    const h = createHarness([apiKeyOAuthDef(as.origin, `${mcp.origin}/mcp`)], dir, { refreshSweepIntervalMs: 0 })
    // The declared field must exist before the oauth flow merges its token in.
    await seedCredential(dir, 'apikey-mcp', { fields: { API_KEY: 'sekret-1' } })
    const config = await register(h, 'apikey-mcp', 1)

    // Precondition: this is not the static class — the transport really got a
    // provider, so a name-keyed drop would have removed the header.
    expect(config.authProvider, '前置：oauth 连接器必须拿到 provider').toBeDefined()
    expect(await config.authProvider?.tokens()).toBeDefined()
    expect(config.headers?.Authorization, '声明形态的 Authorization 必须留在 requestInit 里').toBe('ApiKey sekret-1')
    // The coexistence is observable instead of implicit: one searchable line.
    const reported = h.warns.filter(line => line.includes('[declared-authorization]'))
    expect(reported.length, '声明 Authorization + OAuth 提供者必须报一次可检索的 warn').toBe(1)
    expect(reported[0]).toContain('apikey-mcp')

    const client = new Client({ name: 'r8b-declared', version: '1' }, { capabilities: {} })
    await client.connect(productionTransport(config))
    try {
      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name)).toEqual(['ping'])
      const call = await client.callTool({ name: 'ping', arguments: {} })
      expect(call.content?.[0]?.text).toBe('pong')
      // Wire evidence: the endpoint really received the declared scheme.
      expect(mcp.seenTokens[0]).toBe('ApiKey sekret-1')
      // A token refresh must not turn that into a second report (the line
      // describes the definition, not the token), nor drop the header.
      await callRoute(h, '/api/pico/connectors/apikey-mcp/refresh', 'POST')
      expect(h.warns.filter(line => line.includes('[declared-authorization]')).length).toBe(1)
    } finally {
      await client.close().catch(() => {})
      h.dispose()
    }
  }, 40_000)

  it('a case-insensitive spelling is kept too', async () => {
    const as = await startRealMcpServer()
    servers.push(as)
    const mcp = await startStaticTokenMcpServer('ApiKey sekret-2')
    servers.push(mcp)
    const dir = mkdtempSync(join(tmpdir(), 'r8b-declared-lower-'))
    const h = createHarness([apiKeyOAuthDef(as.origin, `${mcp.origin}/mcp`, 'authorization')], dir, { refreshSweepIntervalMs: 0 })
    await seedCredential(dir, 'apikey-mcp', { fields: { API_KEY: 'sekret-2' } })
    const config = await register(h, 'apikey-mcp', 1)
    expect(config.headers?.authorization, '小写声明形态同样必须保留').toBe('ApiKey sekret-2')
  }, 30_000)

  it('the framework\'s own baked bearer is still dropped, and the no-header class is untouched', async () => {
    // R7-B's invariant, restated where the new rule lives: with NO declared
    // headers the framework bakes `Bearer <token>` itself, and that copy is the
    // one that would shadow the provider's live token.
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r8b-baked-'))
    const def = httpDef(server.origin, false)
    const h = createHarness([def], dir, { refreshSweepIntervalMs: 0 })
    const config = await register(h, 'gated-mcp', 1)
    expect(config.headers?.Authorization, '框架自己烘焙的那一枚必须被摘掉').toBeUndefined()
    expect(h.warns.filter(line => line.includes('[declared-authorization]')), '没有声明头就不该有 warn').toEqual([])
    h.dispose()
  }, 30_000)

  it('a declared header on a connector WITHOUT a provider (static class) is untouched', async () => {
    const mcp = await startStaticTokenMcpServer('ApiKey sekret-3')
    servers.push(mcp)
    const dir = mkdtempSync(join(tmpdir(), 'r8b-declared-static-'))
    const tokenDef: ConnectorDef = {
      id: 'apikey-static',
      name: 'ApiKey MCP (token class)',
      description: 'audit',
      authMode: 'token',
      tokenFields: [{ key: 'API_KEY', label: 'API key', type: 'password', required: true }],
      mcp: [{ serverName: 'apikey-static', transport: 'streamable-http', url: `${mcp.origin}/mcp`, headers: { Authorization: 'ApiKey ${API_KEY}' } }],
    }
    const h = createHarness([tokenDef], dir, { refreshSweepIntervalMs: 0 })
    await callRoute(h, '/api/pico/connectors/apikey-static/connect', 'POST')
    await callRoute(h, '/api/pico/connectors/apikey-static/auth-submit', 'POST', { fields: { API_KEY: 'sekret-3' } })
    await waitFor(() => h.configs.length === 1, 8000)
    const config = h.configs[0] as unknown as RegisteredTransport
    expect(config.authProvider).toBeUndefined()
    expect(config.headers?.Authorization).toBe('ApiKey sekret-3')
    expect(h.warns.filter(line => line.includes('[declared-authorization]')), '没有 provider 就不是"声明 vs 提供者"的形态').toEqual([])
    h.dispose()
  }, 30_000)
})
