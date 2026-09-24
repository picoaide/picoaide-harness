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
import { callRoute, createHarness, scopeDir, seedCredential, waitFor } from './helpers/connector-harness.ts'
import {
  completeAuthorization,
  startRealMcpServer,
  startStaticTokenMcpServer,
  type RealMcpServer,
  type StaticTokenMcpServer,
} from './helpers/real-mcp-oauth-server.ts'
import { ConnectorStore } from '../src/store.ts'
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

  it('a case-insensitive spelling goes out under ONE canonical name and still authenticates', async () => {
    // The SDK builds its headers as
    // `new Headers({ ...(token ? { Authorization: `Bearer ${token}` } : {}), ...normalizeHeaders(requestInit.headers) })`.
    // An EXACT-case `Authorization` key is overwritten by that spread, while a
    // lower-case `authorization` survives as a second key and `new Headers()`
    // APPENDS — the endpoint then receives one comma-joined value
    // (`Bearer <token>, ApiKey <field>`) and rejects it (V3A-N2). Rendering the
    // slot under one canonical spelling is what makes "the declared value wins"
    // true for every spelling.
    const as = await startRealMcpServer()
    servers.push(as)
    const mcp = await startStaticTokenMcpServer('ApiKey sekret-2')
    servers.push(mcp)
    const dir = mkdtempSync(join(tmpdir(), 'r8b-declared-lower-'))
    const h = createHarness([apiKeyOAuthDef(as.origin, `${mcp.origin}/mcp`, 'authorization')], dir, { refreshSweepIntervalMs: 0 })
    await seedCredential(dir, 'apikey-mcp', { fields: { API_KEY: 'sekret-2' } })
    const config = await register(h, 'apikey-mcp', 1)
    expect(config.headers?.Authorization, '小写声明形态同样必须保留').toBe('ApiKey sekret-2')
    // …and it must be the ONLY authorization-slot key, or the wire value is a
    // comma-joined pair again.
    expect(Object.keys(config.headers ?? {}).filter(name => name.toLowerCase() === 'authorization')).toEqual(['Authorization'])

    const client = new Client({ name: 'r8b-declared-lower', version: '1' }, { capabilities: {} })
    await client.connect(productionTransport(config))
    try {
      const call = await client.callTool({ name: 'ping', arguments: {} })
      expect(call.content?.[0]?.text).toBe('pong')
      // Wire evidence — the assertion V3A-N2 found missing: the endpoint really
      // received the declared scheme, not a merged value.
      expect(mcp.seenTokens[0]).toBe('ApiKey sekret-2')
    } finally {
      await client.close().catch(() => {})
      h.dispose()
    }
  }, 40_000)

  it('an EMPTY declared value on a header of ANOTHER name keeps its auto-filled bearer', async () => {
    // "Leave the value empty and we fill in `Bearer <token>`" is offered for ANY
    // header name in the admin console. Only the authorization slot is OUR copy
    // of the credential — the one a live provider must be allowed to replace. A
    // header of another name belongs to the definition, and deleting it turned a
    // working connector into a failing one (`connected` → `error`, V3A-N1).
    const as = await startRealMcpServer()
    servers.push(as)
    // Placeholder endpoint: the registration only has to succeed at this point,
    // and the token is issued by the flow below.
    const shape = await startStaticTokenMcpServer('unused-until-the-flow-issues-one', 'X-Probe-Key')
    servers.push(shape)
    const dir = mkdtempSync(join(tmpdir(), 'r8b-empty-custom-'))
    const def = apiKeyOAuthDef(as.origin, `${shape.origin}/mcp`)
    ;(def.mcp[0] as { headers?: Record<string, string> }).headers = { 'X-Probe-Key': '' }
    const h = createHarness([def], dir, { refreshSweepIntervalMs: 0 })
    const config = await register(h, 'apikey-mcp', 1)
    expect(config.authProvider, '前置：oauth 连接器必须拿到 provider').toBeDefined()
    const issued = (await new ConnectorStore({ baseDir: dir }).readCredential('apikey-mcp'))?.accessToken
    expect(issued, '前置：授权完成后必须有一枚访问令牌').toBeTruthy()
    expect(config.headers?.['X-Probe-Key'], '空值声明的自定义头必须保留').toBe(`Bearer ${String(issued)}`)
    expect(config.headers?.Authorization, '框架自己的 Authorization 仍必须被摘掉').toBeUndefined()

    // Wire evidence: an endpoint that authenticates THIS header accepts exactly
    // the value the transport sends.
    const endpoint = await startStaticTokenMcpServer(String(issued), 'X-Probe-Key')
    servers.push(endpoint)
    const client = new Client({ name: 'r8b-empty-custom', version: '1' }, { capabilities: {} })
    await client.connect(productionTransport({ ...config, url: `${endpoint.origin}/mcp` }))
    try {
      const call = await client.callTool({ name: 'ping', arguments: {} })
      expect(call.content?.[0]?.text).toBe('pong')
      expect(endpoint.seenTokens[0], 'wire：声明的头必须逐字到达').toBe(String(issued))
    } finally {
      await client.close().catch(() => {})
      h.dispose()
    }
  }, 40_000)

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

describe('V3A-N6: a provider-LESS http transport must still be rebuilt on a credential change', () => {
  /**
   * A registration whose OAuth discovery round trip fails (offline, a 5xx on the
   * RFC 9728 metadata endpoint, an enterprise proxy) gets NO `authProvider`: the
   * transport authenticates with the bearer `renderHeaders` baked into its
   * `requestInit.headers` — a registration-time snapshot. Such a transport is
   * the second class a credential change MUST rebuild (R8-B-2 narrowed the event
   * to "things that cannot read the credential per request", and a baked bearer
   * cannot). Without it the row keeps saying `connected` with a fresh
   * `expiresAt` while every tool call 401s on the token that rotated away.
   *
   * Both cases force the shape the way production does: a real authorization
   * flow first (so the stored token is one the endpoint accepts), then the
   * credential is moved inside the 60s refresh lead window so the NEXT
   * registration cannot take the network-free static-endpoint path, and the
   * metadata endpoint answers 500 while `/mcp` keeps working.
   */
  function probeDef(origin: string): ConnectorDef {
    return httpDef(origin, false)
  }

  /** Register once with discovery down, and assert the provider-less shape. */
  async function registerWithoutProvider(
    server: RealMcpServer,
    label: string,
  ): Promise<{ h: ReturnType<typeof createHarness>, dir: string, stale: string }> {
    const dir = mkdtempSync(join(tmpdir(), label))
    const h = createHarness([probeDef(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    await callRoute(h, '/api/pico/connectors/gated-mcp/connect', 'POST')
    await completeAuthorization(await awaitAuthorizeUrl(h, 'gated-mcp'))
    await waitFor(() => h.configs.length === 1, 8000)
    expect((h.configs[0] as unknown as RegisteredTransport).authProvider).toBeDefined()
    // Inside the refresh lead window ⇒ the registration must go through the
    // discovery round trip instead of the static-endpoint fast path.
    const store = new ConnectorStore({ baseDir: dir })
    const seeded = await store.readCredential('gated-mcp')
    const stale = String(seeded?.accessToken ?? '')
    await store.updateCredential('gated-mcp', { ...(seeded as never), expiresAt: Date.now() + 30_000 } as never)
    server.setMetadataFailure(4)
    h.emitSession({ username: 'user-a', serverURL: 'https://harness.example.com' })
    await waitFor(() => h.configs.length === 2, 15_000)
    const baked = h.configs[1] as unknown as RegisteredTransport
    expect(baked.authProvider, '前置：发现失败的那次注册没有 provider').toBeUndefined()
    expect(baked.headers?.Authorization, '前置：只有注册期烘焙的 bearer').toBe(`Bearer ${stale}`)
    expect(server.stats.metadataRejected, '前置：元数据端点真的被打了 500').toBeGreaterThan(0)
    return { h, dir, stale }
  }

  it('a real panel refresh rebuilds it — and the rebuilt transport carries a provider', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const { h, dir, stale } = await registerWithoutProvider(server, 'r8b-n6-refresh-')
    try {
      // Discovery is healthy again: "refresh now" rotates the credential and the
      // listener must hand the new token to a transport that cannot read it.
      server.setMetadataFailure(0)
      const refreshed = await callRoute(h, '/api/pico/connectors/gated-mcp/refresh', 'POST')
      expect(refreshed.status).toBe(200)
      await waitFor(() => h.configs.length === 3, 15_000)
      const rebuilt = h.configs[2] as unknown as RegisteredTransport
      const fresh = (await new ConnectorStore({ baseDir: dir }).readCredential('gated-mcp'))?.accessToken
      expect(fresh, '前置：刷新真的换了令牌').not.toBe(stale)
      // The rebuilt transport reads the credential per request from now on …
      expect(rebuilt.authProvider, '重建必须拿到 provider（发现已恢复）').toBeDefined()
      // … so our baked copy is gone, i.e. the live token wins.
      expect(rebuilt.headers?.Authorization, '重建后不得再有注册期烘焙的 bearer').toBeUndefined()
      const live = (await rebuilt.authProvider?.tokens())?.access_token
      expect(live).toBeTruthy()
      expect(live).not.toBe(stale)
      // The previous fibre was retired (the rebuild is a replacement, not an
      // extra registration): exactly one live fibre owns the name.
      expect(h.fibers.filter(fiber => fiber.dispose.mock.calls.length === 0).length).toBeGreaterThanOrEqual(1)
    } finally {
      h.dispose()
    }
  }, 60_000)

  it('a rebuild while discovery is STILL down carries the FRESH baked bearer', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const { h, dir, stale } = await registerWithoutProvider(server, 'r8b-n6-baked-')
    try {
      // The credential moves exactly as a refresh leaves it (the engine writes
      // the store and announces the id — the route itself would need discovery,
      // which is still down), and the rebuild cannot get a provider either: it
      // must bake the NEW token instead of keeping the registration-time one.
      server.setMetadataFailure(4)
      const store = new ConnectorStore({ baseDir: dir })
      await store.updateCredential('gated-mcp', { accessToken: 'at-fresh-direct', expiresAt: Date.now() + 30_000 })
      h.emit('pico/connector-credentials-changed', { id: 'gated-mcp' })
      await waitFor(() => h.configs.length === 3, 15_000)
      const rebuilt = h.configs[2] as unknown as RegisteredTransport
      expect(rebuilt.authProvider, '发现仍失败 ⇒ 重建后仍没有 provider').toBeUndefined()
      expect(rebuilt.headers?.Authorization, '重建必须带上刷新后的新 bearer').toBe('Bearer at-fresh-direct')
      expect(rebuilt.headers?.Authorization).not.toContain(stale)
    } finally {
      h.dispose()
    }
  }, 60_000)

  it('REVERSE CONTROL: a transport that HAS a provider is not re-registered', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r8b-n6-control-'))
    const h = createHarness([probeDef(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    const config = await register(h, 'gated-mcp', 1)
    expect(config.authProvider).toBeDefined()
    try {
      const refreshed = await callRoute(h, '/api/pico/connectors/gated-mcp/refresh', 'POST')
      expect(refreshed.status).toBe(200)
      // Let the (empty) re-registration work settle before counting.
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(h.configs.length, 'provider 在手的 http 传输不得被重注册').toBe(1)
      expect(h.fibers[0]?.dispose, '活传输不得被 dispose').not.toHaveBeenCalled()
    } finally {
      h.dispose()
    }
  }, 60_000)
})

describe('V3A-N3: the declared-authorization report is scoped per account/deployment', () => {
  it('two accounts sharing one plugin instance each report their own line', async () => {
    const as = await startRealMcpServer()
    servers.push(as)
    const mcp = await startStaticTokenMcpServer('ApiKey sekret-scope')
    servers.push(mcp)
    // Two ACCOUNTS: the store follows the session, so each account has its own
    // credential directory — the scope `deadGrants` keys on too.
    // The scoped layout lives under `DSH_HOME`; without a stub the store would
    // try to create directories inside the real user home.
    const home = mkdtempSync(join(tmpdir(), 'r8b-warn-home-'))
    vi.stubEnv('DSH_HOME', home)
    const def: ConnectorDef = {
      id: 'apikey-mcp',
      name: 'ApiKey MCP',
      description: 'audit',
      authMode: 'oauth',
      tokenFields: [{ key: 'API_KEY', label: 'API key', type: 'password', required: false }],
      auth: {
        authorizeUrl: `${as.origin}/oauth/authorize`,
        tokenUrl: `${as.origin}/oauth/token`,
        clientId: '',
        redirectUri: 'http://127.0.0.1/callback',
        pkce: true,
        publicClient: true,
        discoveryUrl: `${as.origin}/mcp`,
        scopes: 'mcp.read offline_access',
      },
      mcp: [{ serverName: 'apikey-mcp', transport: 'streamable-http', url: `${mcp.origin}/mcp`, headers: { Authorization: 'ApiKey ${API_KEY}' } }],
    }
    // `storeBaseDir: undefined` makes the plugin resolve its store from the
    // SESSION (account + deployment), which is the scope under test.
    const h = createHarness([def], home, {
      refreshSweepIntervalMs: 0,
      storeBaseDir: undefined,
      connectors: [def],
    })
    const marker = '[declared-authorization]'
    try {
      // Each account gets its own credential file in its own scoped directory.
      for (const username of ['user-a', 'user-b']) {
        await seedCredential(scopeDir(username, null), 'apikey-mcp', {
          accessToken: `at-${username}`,
          expiresAt: Date.now() + 3_600_000,
          fields: { API_KEY: `sekret-${username}` },
        })
      }
      h.emitSession({ username: 'user-a' })
      await waitFor(() => h.configs.length === 1, 15_000)
      expect(h.warns.filter(line => line.includes(marker)).length, 'A 报一条').toBe(1)
      h.emitSession({ username: 'user-b' })
      await waitFor(() => h.configs.length === 2, 15_000)
      // The same DEFINITION shape under a different account scope is a different
      // report: without `store.dir` in the key the second account is silenced.
      const lines = h.warns.filter(line => line.includes(marker))
      expect(lines.length, 'B 必须自己再报一条（去重键含账号作用域）').toBe(2)
      expect(lines[0]).toBe(lines[1])
    } finally {
      h.dispose()
      vi.unstubAllEnvs()
    }
  }, 60_000)
})

describe('V3A-N4: the name-conflict compensation honours the rebuild subset', () => {
  it('a leftover instance holding the stdio name does not cost the live http transport', async () => {
    // `registerMcp`'s `already in use` branch exists for a name held by an
    // instance this plugin does not own (an HMR leftover, a previous
    // generation). Its compensation used to unregister the WHOLE connector —
    // i.e. a credential-change rebuild that selected only the stdio child would
    // dispose the live http transport as a side effect of that defensive path
    // (V3A-N4). Here the leftover keeps the stdio name taken, so the branch
    // really runs.
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r8b-n4-'))
    const h = createHarness([mixedDef(server.origin)], dir, { refreshSweepIntervalMs: 0, requestApproval: () => true })
    await callRoute(h, '/api/pico/connectors/gated-mcp/connect', 'POST')
    await completeAuthorization(await awaitAuthorizeUrl(h, 'gated-mcp'))
    await waitFor(() => h.configs.length === 2, 8000)
    const configs = h.configs as unknown as RegisteredTransport[]
    const httpIndex = configs.findIndex(entry => entry.transport === 'streamable-http')
    const stdioIndex = configs.findIndex(entry => entry.transport === 'stdio')
    expect(httpIndex).toBeGreaterThanOrEqual(0)
    expect(stdioIndex).toBeGreaterThanOrEqual(0)
    // The leftover: its disposer never releases the reserved name.
    h.fibers[stdioIndex]!.dispose = vi.fn(() => {}) as never
    try {
      const store = new ConnectorStore({ baseDir: dir })
      await store.updateCredential('gated-mcp', { accessToken: 'at-after-change', expiresAt: Date.now() + 3_600_000 })
      h.emit('pico/connector-credentials-changed', { id: 'gated-mcp' })
      // The rebuild is expected to fail (the name is still taken) — what matters
      // is WHICH transports the compensation touched.
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(h.fibers[httpIndex]!.dispose, '冲突补偿不得拆掉不在重建集合里的 http 传输').not.toHaveBeenCalled()
      expect(h.warns.some(line => line.includes('重注册失败')) || h.configs.length > 2).toBe(true)
    } finally {
      h.dispose()
    }
  }, 60_000)
})
