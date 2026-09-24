/**
 * Round-9 connector header fixes (audit R9-A / R9-D, 2026-09-24).
 *
 * Four user-visible regressions live in the same seam — what `renderHeaders`
 * bakes into a transport and who may change it afterwards:
 *
 *  R9A-1 — a declared `Authorization` whose template resolves to the EMPTY
 *  string (`'${MISSING_FIELD}'`, which the webadmin free-form KV can produce)
 *  was kept as the administrator's own credential, so it shadowed and blanked
 *  the provider's live token: the very first call (handshake included) went out
 *  with an empty bearer, every retry did too, and the row still said
 *  `connected`. An empty resolution is not a credential.
 *
 *  R9-D-1 — a provider-backed http transport is deliberately never rebuilt
 *  (R8-B-2), so every OTHER registration-time baked value stayed frozen: a
 *  definition declaring `X-Probe-Key: ''` ("leave empty to auto-fill the
 *  bearer") held the FIRST access token forever, the 401 self-heal obtained a
 *  fresh `Authorization` that the stale second header invalidated, and every
 *  later call 401ed while each failure burned another refresh grant. The
 *  credential now reaches that transport **in place** — the fence installs the
 *  connector's header record as the instance's `_requestInit.headers`, which
 *  the pinned SDK re-reads on every request — so nothing is disposed and no
 *  retry can be cut.
 *
 *  R9A-2 — the default bearer injection was gated on the whole header record
 *  being EMPTY, so a provider-less transport that declared any other header was
 *  rebuilt forever without ever gaining an `Authorization`: permanent 401.
 *
 *  R9A-3 — the provider-less rebuild does have to retire the old transport, and
 *  the shipped bridge's disposer closes the client the SDK may still be
 *  answering a call on (`Connection closed` mid-flight). The retire now waits
 *  for the endpoint's outbound calls to drain (bounded), and the rebuild still
 *  lands.
 *
 * Everything runs on the production path: the plugin's own `apply()`, its routes
 * and its on-disk credential store; a real authorization server (discovery +
 * PKCE + rotating refresh tokens + reuse detection); a real MCP endpoint that
 * authenticates a real HTTP header; and the transport construction the shipped
 * bridge builds (`requestInit: { headers }` + `authProvider`). The fence is the
 * production one, installed by `registerMcp` itself.
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
  type RealMcpServer,
} from './helpers/real-mcp-oauth-server.ts'
import { ConnectorStore } from '../src/store.ts'
import { isMcpTransportFenceHardened } from '../src/mcp-transport-fence.ts'
import type { ConnectorDef } from '../src/types.ts'

const servers: RealMcpServer[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()?.close()
})

/** One MCP registration the plugin handed to `ctx.plugin`. */
interface RegisteredTransport {
  transport: 'stdio' | 'streamable-http'
  serverName: string
  url?: string
  headers?: Record<string, string>
  authProvider?: {
    token: () => Promise<string | undefined>
    tokens: () => Promise<{ access_token?: string, refresh_token?: string } | undefined>
  }
}

function oauthPart(origin: string): Pick<ConnectorDef, 'authMode' | 'auth'> {
  return {
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
  }
}

/** An oauth connector with ONE streamable-http server and the given headers. */
function def(
  origin: string,
  headers?: Record<string, string>,
  fields: Array<{ key: string, label: string, type: 'password', required?: boolean }> = [],
): ConnectorDef {
  return {
    id: 'probe-mcp',
    name: 'Probe MCP',
    description: 'audit r9',
    ...oauthPart(origin),
    ...(fields.length === 0 ? {} : { tokenFields: fields }),
    mcp: [{
      serverName: 'probe-a',
      transport: 'streamable-http',
      url: `${origin}/mcp`,
      ...(headers === undefined ? {} : { headers }),
    }],
  }
}

async function state(h: ReturnType<typeof createHarness>, id = 'probe-mcp'): Promise<{ status: string, request?: { authorizeUrl?: string } | null }> {
  const res = await callRoute(h, `/api/pico/connectors/${id}/state`, 'GET')
  return JSON.parse(res.body) as { status: string, request?: { authorizeUrl?: string } | null }
}

async function awaitAuthorizeUrl(h: ReturnType<typeof createHarness>, id = 'probe-mcp'): Promise<string> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const url = (await state(h, id)).request?.authorizeUrl
    if (url) return url
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('no authorize URL')
}

/** Run the connector's real authorization flow and return its registered config. */
async function connectAndAuthorize(
  h: ReturnType<typeof createHarness>,
  expected = 1,
  id = 'probe-mcp',
): Promise<RegisteredTransport> {
  await callRoute(h, `/api/pico/connectors/${id}/connect`, 'POST')
  await completeAuthorization(await awaitAuthorizeUrl(h, id))
  await waitFor(() => h.configs.length === expected, 10_000)
  return h.configs[expected - 1] as unknown as RegisteredTransport
}

/**
 * Poll an ASYNC reader until it satisfies `ok`.
 *
 * The harness `waitFor` takes a SYNCHRONOUS predicate; handing it an async one
 * makes it return immediately (the false-green this repo already documented),
 * so async readers get this helper instead.
 */
async function waitForAsync<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error('waitForAsync: timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/**
 * Build the transport the shipped bridge builds for one registered config.
 *
 * `headers` is COPIED on purpose: the bridge's `Config` is
 * `headers: z.dict(String)`, and Schemastery resolves a dict into a NEW object
 * (`resolved.headers === passed` is false — measured), so the object the
 * production transport is constructed with is NOT the record the connector
 * keeps. That difference is the whole point of the live-view cases: only the
 * fence installing the connector's record on the instance makes a later
 * credential change reach the wire. A probe that handed over the same object
 * would stay green with the fence install removed.
 */
function productionTransport(config: RegisteredTransport): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(config.url ?? ''), {
    requestInit: { headers: { ...(config.headers ?? {}) } },
    ...(config.authProvider === undefined ? {} : { authProvider: config.authProvider as never }),
  })
}

/** The header one server last received, lower-cased lookup as HTTP itself is. */
function lastHeader(server: RealMcpServer, name: string): string {
  const last = server.stats.mcpHeaders[server.stats.mcpHeaders.length - 1] ?? {}
  const raw = last[name.toLowerCase()]
  return String(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''))
}

/**
 * Turn a registered connector into the provider-less shape by the repo's own
 * recipe: park the credential inside the refresh lead window (so the next
 * registration cannot take the networkless static-endpoint fast path), make the
 * metadata endpoint fail, and re-register through a session event.
 * @returns the bearer that registration baked into the headers.
 */
async function toProviderless(
  h: ReturnType<typeof createHarness>,
  server: RealMcpServer,
  dir: string,
  expected: number,
  id = 'probe-mcp',
): Promise<{ stale: string, config: RegisteredTransport }> {
  const store = new ConnectorStore({ baseDir: dir })
  const seeded = await store.readCredential(id)
  const stale = String(seeded?.accessToken ?? '')
  await store.updateCredential(id, { ...(seeded as never), expiresAt: Date.now() + 30_000, refreshedAt: Date.now() } as never)
  server.setMetadataFailure(50)
  h.emitSession({ username: 'user-a', serverURL: 'https://harness.example.com' })
  await waitFor(() => h.configs.length === expected, 15_000)
  const config = h.configs[expected - 1] as unknown as RegisteredTransport
  expect(config.authProvider, '前置：发现失败的那次注册没有 provider').toBeUndefined()
  return { stale, config }
}

/** Write a credential straight to disk — the shape a refresh leaves behind. */
async function announceNewToken(dir: string, accessToken: string, id = 'probe-mcp'): Promise<void> {
  const store = new ConnectorStore({ baseDir: dir })
  const current = await store.readCredential(id)
  await store.updateCredential(id, { ...(current as never), accessToken, expiresAt: Date.now() + 30_000, refreshedAt: Date.now() } as never)
}

describe('R9A-1: an empty-resolving declaration is not a credential', () => {
  it('a declared Authorization that resolves to the empty string does not shadow the provider token', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r9-1-'))
    const h = createHarness([def(server.origin, { Authorization: '${MISSING_FIELD}' })], dir, { refreshSweepIntervalMs: 0 })
    try {
      const config = await connectAndAuthorize(h)
      expect(config.authProvider, '前置：oauth 连接器必须拿到 provider').toBeDefined()
      expect(
        Object.keys(config.headers ?? {}).map(name => name.toLowerCase()),
        '空解析结果不得作为「定义自己的凭据」留下（R9A-1）',
      ).not.toContain('authorization')

      const client = new Client({ name: 'r9-1', version: '1' }, { capabilities: {} })
      await client.connect(productionTransport(config))
      try {
        // Baseline AFTER the handshake: the registration-time discovery probe is
        // a bearer-less GET against `/mcp` by design (the audit's own note).
        const bearersBefore = server.stats.mcpBearerTokens.length
        const unauthorizedBefore = server.stats.mcpUnauthorizedByMethod.POST ?? 0
        const call = await client.callTool({ name: 'echo', arguments: { text: 'r9-1' } })
        expect(call.content?.[0]?.text, '首次调用必须成功（回归形态是 401 after re-authentication）').toBe('echo:r9-1')
        expect(
          server.stats.mcpBearerTokens.slice(bearersBefore).filter(token => token === ''),
          '工具调用不得带空 bearer（回归形态是 4 次全空）',
        ).toEqual([])
        expect(
          (server.stats.mcpUnauthorizedByMethod.POST ?? 0) - unauthorizedBefore,
          '工具调用不得被 401（回归形态是每次都带空 bearer 被拒）',
        ).toBe(0)
      } finally {
        await client.close().catch(() => {})
      }

      const live = (await config.authProvider?.tokens())?.access_token
      expect(live, '前置：授权完成后必须有活令牌').toBeTruthy()
      expect(lastHeader(server, 'authorization'), '线上必须带 provider 的活令牌').toBe(`Bearer ${live}`)
      expect((await state(h)).status, '行状态仍是 connected').toBe('connected')
    } finally { h.dispose() }
  }, 40_000)

  it('a NON-empty declaration is still the definition\'s own credential (R8-B-1 preserved)', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r9-1c-'))
    const h = createHarness(
      [def(server.origin, { Authorization: 'ApiKey ${API_KEY}' }, [{ key: 'API_KEY', label: 'API key', type: 'password' }])],
      dir,
      { refreshSweepIntervalMs: 0 },
    )
    try {
      // The declared field has to exist before the oauth flow merges its token in.
      await seedCredential(dir, 'probe-mcp', { fields: { API_KEY: 'sekret-1' } })
      const config = await connectAndAuthorize(h)
      expect(config.authProvider).toBeDefined()
      expect(config.headers?.Authorization, '解析非空的声明必须保留并优先').toBe('ApiKey sekret-1')
      expect(h.warns.filter(line => line.includes('[declared-authorization]')).length, '共存必须报一次').toBe(1)
    } finally { h.dispose() }
  }, 40_000)

  it('an empty sibling spelling does not overwrite a non-empty declaration (R9A-4)', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r9-1d-'))
    const h = createHarness(
      [def(server.origin, { Authorization: 'ApiKey ${API_KEY}', authorization: '' }, [{ key: 'API_KEY', label: 'API key', type: 'password' }])],
      dir,
      { refreshSweepIntervalMs: 0 },
    )
    try {
      await seedCredential(dir, 'probe-mcp', { fields: { API_KEY: 'sekret-2' } })
      const config = await connectAndAuthorize(h)
      expect(config.headers?.Authorization, '空格拼写不得覆盖管理员配的方案').toBe('ApiKey sekret-2')
    } finally { h.dispose() }
  }, 40_000)
})

describe('R9-D-1: a credential change reaches a live provider-backed transport in place', () => {
  it('the declared X-Probe-Key follows the rotating token, with no rebuild and no cut call', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    // The endpoint authenticates the DECLARED header, so the frozen value is
    // fatal exactly as it is in the field.
    server.requireExtraHeader('X-Probe-Key')
    const dir = mkdtempSync(join(tmpdir(), 'r9-d1-'))
    const h = createHarness([def(server.origin, { 'X-Probe-Key': '' })], dir, { refreshSweepIntervalMs: 0 })
    try {
      const config = await connectAndAuthorize(h)
      const first = config.headers?.['X-Probe-Key']
      expect(first, '注册期把令牌烘焙进声明的头').toMatch(/^Bearer at-/u)
      const firstToken = first!.replace(/^Bearer /u, '')
      expect(config.authProvider).toBeDefined()

      const client = new Client({ name: 'r9-d1', version: '1' }, { capabilities: {} })
      const transport = productionTransport(config)
      await client.connect(transport)
      try {
        // The seam has to be the production one: the fence rewrites the live
        // instance's request fields, and THAT is why a later credential change
        // needs no rebuild (no dispose ⇒ nothing can cut a call in flight).
        expect(isMcpTransportFenceHardened(transport), '传输必须被生产围栏加固').toBe(true)
        expect(
          (transport as unknown as { _requestInit?: { headers?: unknown } })._requestInit?.headers,
          '围栏必须把连接器的活头记录装进 _requestInit.headers',
        ).toBe(config.headers)

        const ok = await client.callTool({ name: 'echo', arguments: { text: 'before' } })
        expect(ok.content?.[0]?.text).toBe('echo:before')

        // (1) the 401 self-heal: the retry must carry the refreshed header, and
        // the retry happens right after `saveTokens` resolves.
        const unauthorizedBefore = server.stats.mcpUnauthorizedByMethod.POST ?? 0
        server.expireAccessTokens()
        const healed = await client.callTool({ name: 'echo', arguments: { text: 'heal' } }).catch(error => error as Error)
        // Exactly ONE 401: the one that triggered the refresh. A retry that
        // replayed the stale declared header would 401 a second time (the shape
        // that burned a refresh grant per failure in the field), so this is the
        // criterion for "the credential is handed over before the retry".
        expect(
          (server.stats.mcpUnauthorizedByMethod.POST ?? 0) - unauthorizedBefore,
          '只有触发续期的那一次 POST 该被 401：带着旧声明头的重试会再 401 一次（现场=每次失败再烧一枚 grant）',
        ).toBe(1)
        expect(healed, 'R9-D-1 的现场：被冻死的头让 401 自愈后的重试也失败').not.toBeInstanceOf(Error)
        expect((healed as { content?: Array<{ text?: string }> }).content?.[0]?.text).toBe('echo:heal')
        const live = (await config.authProvider?.tokens())?.access_token
        expect(live, '401 自愈后 provider 侧必须有新访问令牌').toBeTruthy()
        expect(live).not.toBe(firstToken)
        expect(lastHeader(server, 'X-Probe-Key'), '声明的头必须刷新成活令牌').toBe(`Bearer ${live}`)
        expect(lastHeader(server, 'authorization'), 'Authorization 仍由 provider 供').toBe(`Bearer ${live}`)
        expect(h.configs.length, 'provider 在手的 http 传输不得被重建（R8-B-2）').toBe(1)

        // (2) the event path (heartbeat / panel refresh): a REAL rotation, with
        // no 401 anywhere. The live record must follow it, and the next call
        // must carry it without burning another grant.
        const grantsBefore = server.stats.grants.filter(grant => grant === 'refresh_token').length
        await callRoute(h, '/api/pico/connectors/probe-mcp/refresh', 'POST')
        const rotated = await waitForAsync(
          async () => (await config.authProvider?.tokens())?.access_token,
          token => token !== undefined && token !== live,
        )
        await waitFor(() => config.headers?.['X-Probe-Key'] === `Bearer ${rotated}`, 8000)
        const after = await client.callTool({ name: 'echo', arguments: { text: 'after' } })
        expect(after.content?.[0]?.text).toBe('echo:after')
        expect(lastHeader(server, 'X-Probe-Key'), '事件路径同样把新令牌送上线上').toBe(`Bearer ${rotated}`)
        expect(h.configs.length, '事件路径也不得重建').toBe(1)
        expect(
          server.stats.grants.filter(grant => grant === 'refresh_token').length - grantsBefore,
          '旋转一次只该烧一枚 grant（回归形态是每次失败再烧一枚）',
        ).toBe(1)
        expect(server.stats.revokedRefreshReuse, '没有 refresh token 复用').toBe(0)
      } finally {
        await client.close().catch(() => {})
      }
    } finally { h.dispose() }
  }, 60_000)

  it('the live record is what the SDK reads per request (seam contract, no fence re-run)', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r9-d1b-'))
    const h = createHarness([def(server.origin, { 'X-Probe-Key': 'static' })], dir, { refreshSweepIntervalMs: 0 })
    try {
      const config = await connectAndAuthorize(h)
      const client = new Client({ name: 'r9-d1b', version: '1' }, { capabilities: {} })
      await client.connect(productionTransport(config))
      try {
        // Mutating the RECORD (not the transport, not the config object) is the
        // whole mechanism: if the pinned SDK ever snapshots `requestInit.headers`
        // at construction, this stops reaching the wire and the fix silently
        // becomes a no-op.
        config.headers!['X-Probe-Key'] = 'mutated-by-hand'
        const call = await client.callTool({ name: 'echo', arguments: { text: 'seam' } })
        expect(call.content?.[0]?.text).toBe('echo:seam')
        expect(lastHeader(server, 'X-Probe-Key'), 'SDK 必须每次请求重读 _requestInit.headers').toBe('mutated-by-hand')
      } finally {
        await client.close().catch(() => {})
      }
    } finally { h.dispose() }
  }, 40_000)
})

describe('R9A-2: the default bearer injection is keyed on the authorization slot', () => {
  it('a provider-less transport that declares another header still gets its Authorization back', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r9-2-'))
    const h = createHarness(
      [def(server.origin, { 'X-Probe-Key': 'static-value' })],
      dir,
      { refreshSweepIntervalMs: 0 },
    )
    try {
      await connectAndAuthorize(h)
      const { stale } = await toProviderless(h, server, dir, 2)

      // (1) the gate itself: the SAME valid credential, re-registered. Before
      // the fix this rebuild produced `{"X-Probe-Key": "..."}` with no
      // Authorization at all — forever, because nothing else re-bakes it.
      const base = h.configs.length
      h.emit('pico/connector-credentials-changed', { id: 'probe-mcp' })
      await waitFor(() => h.configs.length === base + 1, 12_000)
      const rebuilt = h.configs.at(-1) as unknown as RegisteredTransport
      expect(rebuilt.authProvider, '前置：该形态没有 provider').toBeUndefined()
      expect(rebuilt.headers?.['X-Probe-Key'], '定义自己的头保持原值').toBe('static-value')
      expect(rebuilt.headers?.Authorization, '重建必须注入 bearer（回归形态是永久无 Authorization）').toBe(`Bearer ${stale}`)

      // (2) the consequence: the transport really authenticates.
      const client = new Client({ name: 'r9-2', version: '1' }, { capabilities: {} })
      await client.connect(productionTransport(rebuilt))
      try {
        const call = await client.callTool({ name: 'echo', arguments: { text: 'r9-2' } })
        expect(call.content?.[0]?.text, 'provider-less 传输必须真的能调用（回归形态是握手即 401）').toBe('echo:r9-2')
        expect(lastHeader(server, 'authorization'), '线上必须带 bearer').toBe(`Bearer ${stale}`)
      } finally {
        await client.close().catch(() => {})
      }

      // (3) a rotated credential reaches the rebuilt transport too.
      await announceNewToken(dir, 'at-r9-fresh')
      h.emit('pico/connector-credentials-changed', { id: 'probe-mcp' })
      await waitFor(() => h.configs.length === base + 2, 12_000)
      expect(
        (h.configs.at(-1) as unknown as RegisteredTransport).headers?.Authorization,
        '重建必须带上刷新后的新 bearer',
      ).toBe('Bearer at-r9-fresh')
    } finally { h.dispose() }
  }, 60_000)
})

describe('R9A-3: the provider-less rebuild waits for the call in flight', () => {
  it('an in-flight call survives the rebuild, and the rebuild still lands with the new token', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r9-3-'))
    const h = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0, rebuildIdleGraceMs: 4000 })
    try {
      await connectAndAuthorize(h)
      await toProviderless(h, server, dir, 2)
      const config = h.configs.at(-1) as unknown as RegisteredTransport
      const client = new Client({ name: 'r9-3', version: '1' }, { capabilities: {} })
      await client.connect(productionTransport(config))
      let settledAt = 0
      let disposedAt = 0
      // The harness fibres are records; wire this one the way the real bridge
      // owns its transport (dispose → client.close()), which is what made the
      // cut visible in the field.
      const fiber = h.fibers.at(-1) as unknown as { dispose: () => void }
      const original = fiber.dispose
      fiber.dispose = (() => {
        disposedAt = Date.now()
        void client.close().catch(() => {})
        original()
      }) as never

      try {
        server.setMcpDelay(600)
        await announceNewToken(dir, 'at-r9-mid')
        const t0 = Date.now()
        h.emit('pico/connector-credentials-changed', { id: 'probe-mcp' })
        // The rebuild needs ~600ms (its own discovery probe is delayed by the
        // same fixture knob) to reach `retire()`; this call is sent 300ms in and
        // answered 600ms later, so the two MUST overlap.
        await new Promise(resolve => setTimeout(resolve, 300))
        const call = await client.callTool({ name: 'echo', arguments: { text: 'mid' } }).then(
          (result) => { settledAt = Date.now(); return result },
          (error: unknown) => { settledAt = Date.now(); throw error },
        )
        expect(call.content?.[0]?.text, '在途调用必须活下来（回归形态是 ERR:Connection closed）').toBe('echo:mid')
        expect(settledAt - t0, '前置：调用确实与重建窗口重叠').toBeGreaterThan(500)

        // …and the deferral must not swallow the rebuild: the new transport
        // takes over with the rotated token.
        await waitFor(() => h.configs.length === 3, 12_000)
        const rebuilt = h.configs.at(-1) as unknown as RegisteredTransport
        expect(rebuilt.headers?.Authorization, '重建最终必须带上轮换后的 bearer').toBe('Bearer at-r9-mid')
        expect(disposedAt, '前置：旧传输确实被 retire 过（否则下面的断言是空的）').toBeGreaterThan(0)
        expect(disposedAt, '旧传输必须等调用返回之后才被 retire').toBeGreaterThanOrEqual(settledAt)
      } finally {
        await client.close().catch(() => {})
      }
    } finally { h.dispose() }
  }, 60_000)

  it('a stalled call cannot starve the rebuild forever (the wait is bounded)', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r9-3b-'))
    const h = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0, rebuildIdleGraceMs: 300 })
    try {
      await connectAndAuthorize(h)
      await toProviderless(h, server, dir, 2)
      const config = h.configs.at(-1) as unknown as RegisteredTransport
      // A tool call that never comes back: it keeps the endpoint's outbound
      // count at 1 for the whole grace, so the credential update has to proceed
      // on the bound (and say so) instead of waiting forever. Only `tools/call`
      // hangs — the handshake stays real.
      const hanging: typeof fetch = async (input, init) => {
        if (!String(init?.body ?? '').includes('tools/call')) return await fetch(input as never, init as never)
        // Hangs until the SDK aborts it, i.e. until the retired transport is
        // closed — which is exactly the disposition this case asserts.
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal?.aborted === true) reject(new Error('aborted'))
          else signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      const client = new Client({ name: 'r9-3b', version: '1' }, { capabilities: {} })
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url ?? ''), {
        requestInit: { headers: config.headers ?? {} },
        fetch: hanging,
      }))
      try {
        const pending = client.callTool({ name: 'echo', arguments: { text: 'stall' } })
          .then(() => 'resolved' as const, (error: unknown) => error as Error)
        // Let the POST reach the fenced fetch (and be counted) first.
        await new Promise(resolve => setTimeout(resolve, 200))
        await announceNewToken(dir, 'at-r9-stall')
        h.emit('pico/connector-credentials-changed', { id: 'probe-mcp' })
        await waitFor(() => h.configs.length === 3, 12_000)
        expect(
          h.warns.some(line => line.includes('重建等待在途调用超时')),
          '等待超时必须留下可检索的一行（否则「有界」只是注释）',
        ).toBe(true)
        expect(
          (h.configs.at(-1) as unknown as RegisteredTransport).headers?.Authorization,
          '超时后仍必须完成重建（新凭据不许被卡住）',
        ).toBe('Bearer at-r9-stall')
        // The calls that outlive the grace are not silently forgotten: retiring
        // the transport hands them a determinate error instead of a hang.
        await client.close().catch(() => {})
        expect(await pending, '被 retire 的挂起调用必须收到明确错误').toBeInstanceOf(Error)
      } finally {
        await client.close().catch(() => {})
      }
    } finally { h.dispose() }
  }, 60_000)
})

describe('R9A-5: a template that resolves to nothing follows the documented "leave empty" rule', () => {
  it('a declared header of another name gets the framework bearer, not an empty value', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r9-5-'))
    const h = createHarness([def(server.origin, { 'X-Probe-Key': '${MISSING_FIELD}' })], dir, { refreshSweepIntervalMs: 0 })
    try {
      const config = await connectAndAuthorize(h)
      expect(config.headers?.['X-Probe-Key'], '解析为空 = 未提供 ⇒ 按「留空自动填 bearer」处理').toMatch(/^Bearer at-/u)
      expect(config.headers?.Authorization, '授权槽同样由框架注入（provider 在手时再交给 provider）').toBeUndefined()
    } finally { h.dispose() }
  }, 40_000)
})
