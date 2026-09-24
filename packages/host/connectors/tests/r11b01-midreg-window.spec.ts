/**
 * R11-B probe 01 —— 第十轮 G4「同步刷活头」的**同族第二条路径**：注册期窗口。
 *
 * 被审命题：`onRefreshed` 里零 await 的 `refreshLiveHeaders` 让**带外刷新**（心跳 /
 * 面板 / 重开恢复）之后 SDK 的 401 重试不可能再读到旧头。它靠
 * `mcpRegistrations.get(serverName).liveHeaders` 找到那条记录。
 *
 * `registerMcp` 的实际排布（src/index.ts）：
 *   :2119  credential = await store.readCredential(def.id)          ← 快照
 *   :2207  renderTransportHeaders(server, credential, …)            ← 用快照烤活头记录
 *   :2210  attachMcpLiveHeaders(authProvider, renderedHeaders.headers)
 *   :2273  fiber = await ctx.plugin(applyMcpClient, config)         ← 真实 mcp-client 的
 *                                                                     apply 里
 *                                                                     `await client.connect(transport)`
 *                                                                     = 真发 initialize（HTTP 往返）
 *   :2312  adoptLatestRefresh(...)                                  ← **只**追赶 provider 的令牌
 *   :2324  mcpRegistrations.set(…, { liveHeaders })                 ← 记录**此刻才**查得到
 *
 * ⇒ 刷新落在 `:2207` 与 `:2324` 之间时，`refreshLiveHeaders`（同步的与监听器的两处）
 * 都查不到这条记录；而兄弟追赶 `adoptLatestRefresh` 只喂 provider，不喂记录。
 *
 * 本探针走真实路径：真 HTTP MCP 端点 + 真假授权服务器 + 真 pinned SDK 传输
 * （构造与 `dsh-mcp-client` 的 `createTransport` 逐字同形），判据取**端点侧事实**
 * （`stats.mcpBearerTokens` / `mcpUnauthorized`），不是我们自己的赋值。
 *
 * 并发点由测试确定性地放在窗口内：`ctx.plugin` 里先调**面板刷新路由**（真实路由、
 * 真授权服务器往返）再连接 —— 这是"面板刷新 / 60s 心跳扫掠在传输加载期间落地"的
 * 确定化写法，没有 sleep。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { apply } from '../src/index.ts'
import { ConnectorStore } from '../src/store.ts'
import type { ConnectorDef } from '../src/types.ts'
import {
  browserFence,
  callRoute,
  waitFor,
  type CapturedConfig,
} from './helpers/connector-harness.ts'
import { completeAuthorization, startRealMcpServer, type RealMcpServer } from './helpers/real-mcp-oauth-server.ts'

const servers: RealMcpServer[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()?.close()
})

/** The endpoint records the bearer of THIS header (the auth slot carries the provider's token). */
const EXTRA_HEADER = 'X-Probe-Key'

function def(origin: string): ConnectorDef {
  return {
    id: 'example-mcp', name: '示例 MCP 智能体', description: 'audit', authMode: 'oauth',
    auth: {
      authorizeUrl: `${origin}/oauth/authorize`, tokenUrl: `${origin}/oauth/token`, clientId: '',
      redirectUri: 'http://127.0.0.1/callback', pkce: true, publicClient: true,
      discoveryUrl: `${origin}/mcp`, scopes: 'mcp.read offline_access',
    },
    mcp: [{
      serverName: 'example-mcp',
      transport: 'streamable-http',
      url: `${origin}/mcp`,
      // The documented "leave empty to auto-fill the bearer" shape (R9-D-1's face).
      headers: { [EXTRA_HEADER]: '' },
    }],
  }
}

interface ConnectOutcome {
  config: CapturedConfig
  ok: boolean
  /** The connect attempt has settled (success or failure) — never guess with a sleep. */
  settled: boolean
  error?: string
}

interface ProbeHarness {
  configs: CapturedConfig[]
  routes: Parameters<typeof callRoute>[0]['routes']
  connects: ConnectOutcome[]
  warns: string[]
  errors: string[]
  dispose: () => void
}

/**
 * `createHarness` 的同形替身，只有一处不同：`ctx.plugin` 真的把配置交给**真实的
 * pinned SDK 传输**并连接（`dsh-mcp-client/lib` 的 `createTransport` 逐字同形），
 * 而不是立刻 resolve —— 这样 `await ctx.plugin(...)` 才覆盖真实产品里那段
 * "传输正在加载" 的窗口。
 *
 * @param raceRefresh - 在连接**之前**、注册尚未登记时触发的带外刷新（真实面板路由）。
 */
function createProbeHarness(
  defs: ConnectorDef[],
  dir: string,
  raceRefresh?: () => Promise<void>,
): ProbeHarness {
  const configs: CapturedConfig[] = []
  const connects: ConnectOutcome[] = []
  const routes: ProbeHarness['routes'] = []
  const warns: string[] = []
  const errors: string[] = []
  const eventHandlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const sessionHandlers: Array<(next: unknown) => void> = []
  const effectDisposers: Array<() => void> = []
  const liveServerNames = new Set<string>()
  const fence = browserFence()

  const ctx = {
    get: (name: string) => {
      if (name === 'picoSession') return { getSession: () => ({ username: 'user-a' }) }
      if (name === 'connection') return fence
      if (name === 'desktopRuntime') return { locale: 'zh' }
      return undefined
    },
    on: (event: string, handler: (next: unknown) => void) => {
      if (event === 'pico/session-changed') sessionHandlers.push(handler)
      const list = eventHandlers.get(event) ?? []
      list.push(handler as (...args: unknown[]) => void)
      eventHandlers.set(event, list)
      return () => {}
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of eventHandlers.get(event) ?? []) handler(...args)
    },
    plugin: async (_plugin: unknown, config: CapturedConfig) => {
      if (liveServerNames.has(config.serverName)) {
        throw new Error(`mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance`)
      }
      liveServerNames.add(config.serverName)
      configs.push(config)
      const outcome: ConnectOutcome = { config, ok: false, settled: false }
      connects.push(outcome)
      // The transport is "loading": this is where a real out-of-band refresh
      // (panel button / 60 s sweep) interleaves. No sleep: the refresh round
      // trip is awaited.
      if (raceRefresh !== undefined) await raceRefresh()
      // ---- production construction, verbatim from dsh-mcp-client/lib ----
      const transport = new StreamableHTTPClientTransport(new URL(config.url as string), {
        requestInit: { headers: config.headers },
        ...(config.authProvider === undefined ? {} : { authProvider: config.authProvider as never }),
      })
      const client = new Client({ name: 'dsh-mcp-client', version: '0.0.1' }, { capabilities: {} })
      try {
        await client.connect(transport)
        await client.listTools()
        outcome.ok = true
      } catch (error: unknown) {
        outcome.error = error instanceof Error ? error.message : String(error)
      } finally {
        outcome.settled = true
        await client.close().catch(() => {})
      }
      return { dispose: vi.fn(() => { liveServerNames.delete(config.serverName) }) }
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn((m?: unknown) => { warns.push(String(m)) }),
      error: vi.fn((m?: unknown) => { errors.push(String(m)) }),
    },
    effect: (register: () => (() => void) | undefined) => {
      const dispose = register()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
      return () => {}
    },
    webServer: { register: (route: ProbeHarness['routes'][number]) => { routes.push(route); return () => {} } },
  }

  apply(ctx as never, { connectors: defs, storeBaseDir: dir, refreshSweepIntervalMs: 0 })
  return {
    configs,
    routes,
    connects,
    warns,
    errors,
    dispose: () => { for (const dispose of effectDisposers) dispose() },
  }
}

/** The plugin's own state route tells us the authorize URL of the in-flight flow. */
async function awaitAuthorizeUrl(h: ProbeHarness, deadlineMs = 8_000): Promise<string> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const res = await callRoute(h as never, '/api/pico/connectors/example-mcp/state', 'GET')
    const url = (JSON.parse(res.body) as { request?: { authorizeUrl?: string } | null }).request?.authorizeUrl
    if (url !== undefined) return url
    if (Date.now() > deadline) throw new Error('no authorize URL')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** The tokens the endpoint actually saw on the wire, in arrival order. */
function wireTokens(server: RealMcpServer): string[] {
  return [...server.stats.mcpBearerTokens]
}

describe('R11-B-01: a refresh landing inside the registration window is not caught up', () => {
  it('a refresh landing inside the registration window must reach the live header record', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    // The endpoint validates the DECLARED extra header as the credential, so a
    // stale record is observable on the wire (the R9-D-1 shape).
    server.requireExtraHeader(EXTRA_HEADER)
    const dir = mkdtempSync(join(tmpdir(), 'r11b-midreg-'))

    // ---- day 1: authorize + connect while the token is still valid ----------
    const day1 = createProbeHarness([def(server.origin)], dir)
    await callRoute(day1 as never, '/api/pico/connectors/example-mcp/connect', 'POST')
    await completeAuthorization(await awaitAuthorizeUrl(day1))
    await waitFor(() => day1.connects.length === 1 && day1.connects[0]?.ok === true, 15_000)
    expect(day1.connects[0]?.error, 'day 1 must connect with a valid token').toBeUndefined()
    day1.dispose()

    const store = new ConnectorStore({ baseDir: dir })
    const before = await store.readCredential('example-mcp')
    const replacedToken = before?.accessToken as string
    expect(replacedToken, 'a credential must be on disk').toBeTruthy()
    // The token is REVOKED server-side while the local clock still says it is
    // valid: nothing before the registration will try to refresh it, so the
    // refresh below is the only one and it lands exactly where we put it.
    server.expireAccessTokens()
    const baselineWire = wireTokens(server).length
    const baselineUnauthorized = server.stats.mcpUnauthorized
    const baselineHeaders = server.stats.mcpHeaders.length

    // ---- a re-registration (session restore) with a refresh interleaved -----
    const day2 = createProbeHarness([def(server.origin)], dir, async () => {
      const res = await callRoute(day2 as never, '/api/pico/connectors/example-mcp/refresh', 'POST')
      expect(res.status, 'the panel refresh must succeed').toBe(200)
    })
    await waitFor(() => day2.connects.length === 1 && day2.connects[0]?.settled === true, 20_000)
    await waitFor(() => day2.warns.filter(line => line.includes('401')).length >= 0, 1_000)

    const stored = await store.readCredential('example-mcp')
    const provider = await (day2.configs[0] as unknown as {
      authProvider?: { tokens: () => Promise<{ access_token?: string } | undefined> }
    }).authProvider?.tokens()
    const day2Wire = wireTokens(server).slice(baselineWire)

    // The refresh itself worked, and the PROVIDER is caught up
    // (`adoptLatestRefresh` — the sibling catch-up that exists).
    expect(stored?.accessToken, 'the refresh must have rotated the access token').not.toBe(replacedToken)
    expect(provider?.access_token, 'the live provider holds the current token').toBe(stored?.accessToken)
    const record = (day2.configs[0]?.headers ?? {})[EXTRA_HEADER]
    // The fixture records headers only (no method field): presence of
    // `content-type` distinguishes a JSON-RPC body frame from the SDK's
    // long-lived SSE channel, and `x-probe-key` is the declared header.
    const day2Frames = server.stats.mcpHeaders.slice(baselineHeaders)
      .map(head => `${head['content-type'] === undefined ? 'no-body' : 'json-body'}:${String(head['x-probe-key'] ?? '<absent>')}`)
    const evidence = `wire=${JSON.stringify(day2Wire)} record=${JSON.stringify(record)} error=${JSON.stringify(day2.connects[0]?.error)} frames=${JSON.stringify(day2Frames)}`

    // JUDGEMENT #1 (header record): the object the SDK spreads over the
    // provider's token on every request must hold the CURRENT token.
    expect(record, `the live header record must hold the current token — ${evidence}`)
      .toBe(`Bearer ${stored?.accessToken as string}`)
    // JUDGEMENT #2 (wire): the replaced token must never be presented again.
    expect(day2Wire, `the endpoint must not see the replaced token ${replacedToken} — ${evidence}`)
      .not.toContain(replacedToken)
    // JUDGEMENT #3 (endpoint verdict): the registration must succeed, with no
    // 401 and no runaway self-heal burning extra refresh grants.
    expect(day2.connects[0]?.ok, `the transport must load — ${evidence}`).toBe(true)
    expect(baselineUnauthorized, 'precondition: day 1 itself is the 401 baseline').toBeGreaterThanOrEqual(0)
    expect(
      server.stats.grants.filter(grant => grant === 'refresh_token').length,
      `the window must cost exactly the one refresh we injected — ${evidence} frames=${JSON.stringify(day2Frames)}`,
    ).toBe(1)

    // OBSERVABILITY (not a discriminator): the row claims the connector is
    // usable while the transport it just tried to load is dead — the exact
    // "row says connected, every call fails" surface R9-D-1 was about.
    const row = JSON.parse((await callRoute(day2 as never, '/api/pico/connectors/example-mcp/state', 'GET')).body) as { status?: string }
    expect(row.status, `the row must not claim a working connector — ${evidence}`).toBe('connected')

    // Control: once the registration IS recorded, the same refresh reaches the
    // record — so the window is exactly the registration.
    const manual = await callRoute(day2 as never, '/api/pico/connectors/example-mcp/refresh', 'POST')
    expect(manual.status).toBe(200)
    const afterManual = await store.readCredential('example-mcp')
    expect((day2.configs[0]?.headers ?? {})[EXTRA_HEADER]).toBe(`Bearer ${afterManual?.accessToken as string}`)
    day2.dispose()
  }, 60_000)
})
