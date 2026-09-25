/**
 * R13 / V2 第 7 项 · 注册期活头追赶的**更早窗口**（入口读凭据 → 记录渲染）。
 *
 * ## 缺陷形态（修复前，本用例 CASE A 在未变异树上就是红的）
 *
 * `registerMcp` 在**入口**读一次凭据（`await store.readCredential(def.id)`），而这份
 * 快照直到很晚才被消费：中间的 stdio 审批闸、传输加固、MCP 桥的动态 import 全是
 * await。窗口里落地的刷新（面板 `/refresh`、60s 心跳、SDK 401 自愈）会让这次注册
 * **生来就带着被替换的令牌**：provider 与活头记录都用旧快照渲染，记录在握手上
 * 就上了线，代价是一次多余的 401、多花一次 refresh 兑换，而行状态仍停在
 * `connected`（靠 SDK 的 401 自愈兜住）—— 端点是唯一能看见这件事的地方。
 *
 * 修复：`catchUpEntryCredential()` 在快照被消费之前（provider 创建与记录渲染之前）
 * 按**世代号**（入口快照的 `updatedAt`，与 `adoptLatestRefresh` 同一判据）判断
 * 是否需要重放，来源是同一条 `latestRefresh`。这一段没有 await，窗口是被关掉而不是
 * 被挪走。
 *
 * ## 与既有用例的分工
 *
 *  - 本文件 **CASE A**：刷新落在**入口窗口内**（凭据已读、provider 未建）。
 *  - 本文件 **CASE B**：刷新落在 provider 已存在、句柄尚未安装时 —— 由既有的
 *    `adoptLatestRefresh` 追赶覆盖（删掉它 CASE B 红，见 `r11b01-midreg-window.spec.ts`
 *    的内存面见证）。CASE B 留在本文件里是**反向对照**：新的入口追赶不得取代它。
 *
 * 两条都只读**端点侧事实**：真 MCP 端点实际收到的 bearer（`stats.mcpBearerTokens` /
 * `mcpHeaders`）、它答过的 401 次数、它的 token 端点服务过的 `refresh_token` 兑换次数。
 * 每个真实边界都保持真实：真 HTTP MCP 端点、真 RFC 9728/8414/7591 授权服务器、
 * 真 pinned SDK 传输（按 `dsh-mcp-client` 的 `createTransport` 同形构造）、插件自己的
 * 路由与磁盘凭据 store。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { apply } from '../src/index.ts'
import { ConnectorStore } from '../src/store.ts'
import type { ConnectorDef } from '../src/types.ts'
import { browserFence, callRoute, waitFor, FAKE_MCP_SERVER, type CapturedConfig } from './helpers/connector-harness.ts'
import { completeAuthorization, startRealMcpServer, type RealMcpServer } from './helpers/real-mcp-oauth-server.ts'

const servers: RealMcpServer[] = []
/** Live harnesses, so a failing assertion still tears them down (no hung sockets). */
const harnesses: ProbeHarness[] = []
afterEach(async () => {
  while (harnesses.length) harnesses.pop()?.dispose()
  while (servers.length) await servers.pop()?.close()
})

/** The declared "leave empty to auto-fill the bearer" header (R9-D-1's shape). */
const EXTRA_HEADER = 'X-Probe-Key'
const testsRoot = dirname(fileURLToPath(import.meta.url))

/**
 * A definition for the streamable-http endpoint.
 * @param origin - the real MCP endpoint origin.
 * @param declared - whether the definition declares the auto-filled bearer header.
 * @returns the connector definition.
 */
function def(origin: string, declared: boolean): ConnectorDef {
  return {
    id: 'example-mcp', name: '示例 MCP 智能体', description: 'v2 probe', authMode: 'oauth',
    auth: {
      authorizeUrl: `${origin}/oauth/authorize`, tokenUrl: `${origin}/oauth/token`, clientId: '',
      redirectUri: 'http://127.0.0.1/callback', pkce: true, publicClient: true,
      discoveryUrl: `${origin}/mcp`, scopes: 'mcp.read offline_access',
    },
    mcp: declared
      ? [{ serverName: 'example-mcp', transport: 'streamable-http', url: `${origin}/mcp`, headers: { [EXTRA_HEADER]: '' } }]
      : [{ serverName: 'example-mcp', transport: 'streamable-http', url: `${origin}/mcp` }],
  }
}

/** The real stdio server appended to the day-2 definition (the approval seam). */
const STDIO_SERVER = {
  serverName: 'example-mcp-stdio',
  transport: 'stdio' as const,
  command: process.execPath,
  args: [FAKE_MCP_SERVER],
}

interface Outcome {
  config: CapturedConfig
  ok: boolean
  settled: boolean
  error?: string
}

interface ProbeOptions {
  /** The stdio approval seam: awaited inside the entry window, before the provider exists. */
  requestApproval?: (prompt: unknown) => Promise<boolean>
  /** Awaited inside `ctx.plugin`, after the transport's config exists but before it connects. */
  raceRefresh?: () => Promise<void>
}

interface ProbeHarness {
  configs: CapturedConfig[]
  connects: Outcome[]
  /** Ordering ledger: `approval` (entry-window seam) vs `plugin-N` (handshake). */
  events: string[]
  /** Live SDK clients, so a case can drive a real call AFTER registration. */
  clients: Map<string, Client>
  routes: Array<{ kind: 'exact' | 'prefix', path: string, handler: (req: never, res: never) => unknown }>
  dispose: () => void
}

/**
 * `ctx.plugin` really runs the pinned SDK transport (http and stdio alike) and
 * keeps the client alive until the harness is disposed, so a case can observe
 * what the LIVE transport sends after the registration settled.
 * @param defs - connector definitions.
 * @param dir - credential store directory.
 * @param options - the two real seams this probe injects through.
 * @returns the probe harness.
 */
function createProbeHarness(defs: ConnectorDef[], dir: string, options: ProbeOptions = {}): ProbeHarness {
  const configs: CapturedConfig[] = []
  const connects: Outcome[] = []
  const events: string[] = []
  const clients = new Map<string, Client>()
  const routes: ProbeHarness['routes'] = []
  const eventHandlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const effectDisposers: Array<() => void> = []
  const liveServerNames = new Set<string>()
  const fence = browserFence()
  let attempts = 0
  let raced = false

  const ctx = {
    get: (name: string) => {
      if (name === 'picoSession') return { getSession: () => ({ username: 'user-a' }) }
      if (name === 'connection') return fence
      if (name === 'desktopRuntime') return { locale: 'zh' }
      return undefined
    },
    on: (event: string, handler: (next: unknown) => void) => {
      const list = eventHandlers.get(event) ?? []
      list.push(handler as (...args: unknown[]) => void)
      eventHandlers.set(event, list)
      return () => {}
    },
    emit: (event: string, ...args: unknown[]) => { for (const h of eventHandlers.get(event) ?? []) h(...args) },
    plugin: async (_plugin: unknown, config: CapturedConfig) => {
      attempts += 1
      events.push(`plugin-${attempts}`)
      if (liveServerNames.has(config.serverName)) {
        throw new Error(`mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance`)
      }
      liveServerNames.add(config.serverName)
      configs.push(config)
      const outcome: Outcome = { config, ok: false, settled: false }
      connects.push(outcome)
      // The out-of-band refresh lands here: the bridge is "loading", the record
      // already exists (and for a declared header, is already attached), and the
      // provider's handle is not installed yet.
      if (options.raceRefresh !== undefined && !raced) {
        raced = true
        await options.raceRefresh()
      }
      const client = new Client({ name: 'dsh-mcp-client', version: '0.0.1' }, { capabilities: {} })
      clients.set(config.serverName, client)
      try {
        if (config.transport === 'stdio') {
          const transport = new StdioClientTransport({
            command: config.command ?? '',
            args: config.args ?? [],
            ...(config.env === undefined ? {} : { env: config.env }),
            stderr: 'ignore',
          })
          await client.connect(transport)
          await client.listTools()
        } else {
          // Verbatim from `dsh-mcp-client`'s createTransport: the SAME record
          // object the plugin handed over becomes `_requestInit.headers`, and the
          // provider is handed the SDK's own auth seam.
          const transport = new StreamableHTTPClientTransport(new URL(config.url as string), {
            requestInit: { headers: config.headers },
            ...(config.authProvider === undefined ? {} : { authProvider: config.authProvider as never }),
          })
          await client.connect(transport)
          await client.listTools()
        }
        outcome.ok = true
      } catch (error: unknown) {
        outcome.error = error instanceof Error ? error.message : String(error)
      } finally {
        outcome.settled = true
      }
      return {
        dispose: vi.fn(() => {
          liveServerNames.delete(config.serverName)
          void client.close().catch(() => {})
        }),
      }
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    effect: (register: () => (() => void) | undefined) => {
      const dispose = register()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
      return () => {}
    },
    webServer: { register: (route: ProbeHarness['routes'][number]) => { routes.push(route); return () => {} } },
  }

  const applyOptions: Record<string, unknown> = { connectors: defs, storeBaseDir: dir, refreshSweepIntervalMs: 0 }
  if (options.requestApproval !== undefined) {
    applyOptions.requestApproval = async (prompt: unknown) => {
      events.push('approval')
      return await (options.requestApproval as (p: unknown) => Promise<boolean>)(prompt)
    }
  }
  apply(ctx as never, applyOptions)
  let disposed = false
  const harness: ProbeHarness = {
    configs, connects, events, clients, routes,
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const client of clients.values()) void client.close().catch(() => {})
      for (const dispose of effectDisposers) {
        try { dispose() } catch { /* teardown never throws */ }
      }
    },
  }
  harnesses.push(harness)
  return harness
}

/** Wait until the plugin's own state route reports the authorize URL of the flow. */
async function awaitAuthorizeUrl(routes: ProbeHarness['routes'], deadlineMs = 8_000): Promise<string> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const res = await callRoute({ routes } as never, '/api/pico/connectors/example-mcp/state', 'GET')
    const url = (JSON.parse(res.body) as { request?: { authorizeUrl?: string } | null }).request?.authorizeUrl
    if (url !== undefined) return url
    if (Date.now() > deadline) throw new Error('no authorize URL')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** Frames the endpoint received, classified: credential-less vs a declared bearer. */
function classify(server: RealMcpServer, from: number): { frames: string[], discovery: number } {
  const frames = server.stats.mcpHeaders.slice(from)
    .map(head => `${head['content-type'] === undefined ? 'no-body' : 'json-body'}:${String(head['x-probe-key'] ?? '<absent>')}`)
  return { frames, discovery: frames.filter(frame => frame.startsWith('no-body:<absent>')).length }
}

/**
 * How many 401s in the window can be attributed to a CREDENTIAL-LESS request.
 *
 * The endpoint pushes one entry into `mcpBearerTokens` per `/mcp` request (`''`
 * = the request carried no `Authorization` header at all — the SDK's own
 * discovery/probe traffic). A request without a token always 401s, so "the
 * window's 401s == the credential-less requests" is exactly the statement
 * "no 401 came from a stale credential" — and unlike a header-shape heuristic
 * it holds for both definition shapes (declared auto-filled header, or plain
 * provider-supplied `Authorization`).
 * @param server - the endpoint.
 * @param from - index into the bearer ledger where the window starts.
 * @returns the count of credential-less requests in the window.
 */
function credentialless(server: RealMcpServer, from: number): number {
  return server.stats.mcpBearerTokens.slice(from).filter(token => token === '').length
}

/** One full OAuth connect through the plugin's own routes (day 1 of both cases). */
async function connectDay1(server: RealMcpServer, dir: string, declared: boolean): Promise<string> {
  const day1 = createProbeHarness([def(server.origin, declared)], dir)
  await callRoute({ routes: day1.routes } as never, '/api/pico/connectors/example-mcp/connect', 'POST')
  await completeAuthorization(await awaitAuthorizeUrl(day1.routes))
  await waitFor(() => day1.connects.length === 1 && day1.connects[0]?.ok === true, 15_000)
  expect(day1.connects[0]?.error, 'day 1 必须连上').toBeUndefined()
  day1.dispose()
  const store = new ConnectorStore({ baseDir: dir })
  return String((await store.readCredential('example-mcp'))?.accessToken ?? '')
}

describe('R13-V2-7: 注册期活头追赶的两段窗口', () => {
  it('CASE A — 刷新落在入口窗口内（凭据已读、provider 未建）：被替换的令牌不许上线', async () => {
    // ---- premise (mechanical, not prose): the approval seam really sits
    // between the credential read and the provider construction --------------
    const source = readFileSync(join(testsRoot, '..', 'src', 'index.ts'), 'utf8')
    const body = source.slice(
      source.indexOf('const registerMcp = async ('),
      source.indexOf('const unregisterMcp = async ('),
    )
    const iCredential = body.indexOf('await store.readCredential(def.id)')
    const iGate = body.indexOf('await checkStdioApproval(')
    const iProvider = body.indexOf('await mcpAuthProvider(')
    expect(iCredential, 'registerMcp 必须在入口读凭据（认账的锚点）').toBeGreaterThan(0)
    expect(
      iCredential < iGate && iGate < iProvider,
      '入口窗口的前提被移动了：凭据读取 → 审批闸（本用例的注入点）→ provider 创建的顺序不再成立，'
      + '本用例必须重新设计（它证明的是"入口读凭据之后、provider 创建之前"那个窗口）',
    ).toBe(true)
    // 修复的**接线锚点**（R13 V2 第 7 项）：追赶必须落在"快照被消费之前"。
    // 判据本体是下面的端点侧事实（拆掉追赶即红）；这一条只把"追赶被挪到 provider
    // 之后"这种接线退化也变成红灯。
    const iCatchUp = body.indexOf('catchUpEntryCredential()')
    expect(iCatchUp, '入口追赶（catchUpEntryCredential）不在 registerMcp 里').toBeGreaterThan(0)
    expect(
      iCredential < iCatchUp && iCatchUp < iProvider,
      '入口追赶被挪出了它要关的那个窗口：它必须晚于入口读凭据、早于 provider 创建',
    ).toBe(true)

    const server = await startRealMcpServer()
    servers.push(server)
    server.requireExtraHeader(EXTRA_HEADER)
    const dir = mkdtempSync(join(tmpdir(), 'v2cb-entry-'))

    const replaced = await connectDay1(server, dir, true)
    expect(replaced, 'day 1 之后磁盘上必须有凭据').not.toBe('')
    // The access token is dead server-side while the local clock still calls it
    // valid: only the refresh injected below can produce a working token.
    server.expireAccessTokens()
    const baselineWire = server.stats.mcpBearerTokens.length
    const baselineHeaders = server.stats.mcpHeaders.length
    const baselineUnauthorized = server.stats.mcpUnauthorized

    // ---- day 2: the refresh lands at the approval gate = INSIDE the entry
    // window (after the credential read, before mcpAuthProvider) -------------
    let holder: ProbeHarness | undefined
    let hookStatus = 0
    let tokenAtHook = ''
    const day2 = createProbeHarness(
      [{ ...def(server.origin, true), mcp: [...def(server.origin, true).mcp, STDIO_SERVER] }],
      dir,
      {
        requestApproval: async () => {
          const res = await callRoute({ routes: (holder as ProbeHarness).routes } as never, '/api/pico/connectors/example-mcp/refresh', 'POST')
          hookStatus = res.status
          tokenAtHook = String((await new ConnectorStore({ baseDir: dir }).readCredential('example-mcp'))?.accessToken ?? '')
          return true
        },
      },
    )
    holder = day2
    await waitFor(() => day2.connects.some(outcome => outcome.config.transport === 'streamable-http' && outcome.settled), 30_000)

    const http = day2.connects.find(outcome => outcome.config.transport === 'streamable-http')
    const store = new ConnectorStore({ baseDir: dir })
    const stored = await store.readCredential('example-mcp')
    const row = JSON.parse((await callRoute({ routes: day2.routes } as never, '/api/pico/connectors/example-mcp/state', 'GET')).body) as { status?: string }
    const wire = server.stats.mcpBearerTokens.slice(baselineWire)
    const { frames, discovery } = classify(server, baselineHeaders)
    const grants = server.stats.grants.filter(grant => grant === 'refresh_token').length
    const evidence = `events=${JSON.stringify(day2.events)} hookStatus=${hookStatus}`
      + ` tokenAtHook==stored:${tokenAtHook === stored?.accessToken}`
      + ` record=${JSON.stringify(http?.config.headers?.[EXTRA_HEADER])}`
      + ` stored=${JSON.stringify(String(stored?.accessToken ?? ''))} replaced=${JSON.stringify(replaced)}`
      + ` wire=${JSON.stringify(wire)} grants=${grants}`
      + ` unauthorizedDelta=${server.stats.mcpUnauthorized - baselineUnauthorized}`
      + ` credentialless=${credentialless(server, baselineWire)}`
      + ` error=${JSON.stringify(http?.error)} row=${JSON.stringify(row.status)} frames=${JSON.stringify(frames)}`
    console.log(`CASE A evidence: ${evidence}`)

    // Preconditions: the seam fired before the handshake, and the refresh really
    // landed while this registration was in flight.
    expect(day2.events[0], `注入点必须在握手之前跑过 —— ${evidence}`).toBe('approval')
    expect(day2.events, `握手必须真的发生过 —— ${evidence}`).toContain('plugin-1')
    expect(hookStatus, `注入的刷新必须成功（否则本用例什么都没证明）—— ${evidence}`).toBe(200)
    expect(tokenAtHook, `刷新必须换掉令牌 —— ${evidence}`).not.toBe(replaced)

    // Judgement 1 (endpoint fact): the window must not put the replaced token on
    // the wire — the record is rendered from the pre-refresh snapshot.
    expect(wire, `端点不该看到被替换的令牌 —— ${evidence}`).not.toContain(replaced)
    // Judgement 2 (endpoint fact): the endpoint must have seen the CURRENT token.
    expect(wire, `端点必须见到当前令牌 —— ${evidence}`).toContain(stored?.accessToken)
    // Judgement 3 (endpoint fact): the window costs exactly the one refresh we
    // injected — an extra grant is a self-heal round the catch-up should have
    // made unnecessary.
    expect(grants, `窗口必须恰好花掉一次 refresh 兑换 —— ${evidence}`).toBe(1)
    // Judgement 4 (endpoint fact): every 401 belongs to a credential-less probe.
    expect(
      server.stats.mcpUnauthorized - baselineUnauthorized,
      `窗口内的 401 必须全部来自没有凭据的探针 —— ${evidence}`,
    ).toBe(credentialless(server, baselineWire))
    // Judgement 5: the registration really succeeded (no runaway self-heal loop).
    expect(http?.ok, `注册必须成功 —— ${evidence}`).toBe(true)
    day2.dispose()
  }, 90_000)

  it('CASE B — 刷新落在 provider 已建、句柄未装时：既有的 adoptLatestRefresh 追赶仍承重（反向对照）', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    // NO declared header: the wire credential IS the provider's token, so the
    // header record can neither mask nor rescue the catch-up.
    const dir = mkdtempSync(join(tmpdir(), 'v2cb-provider-'))

    const replaced = await connectDay1(server, dir, false)
    expect(replaced, 'day 1 之后磁盘上必须有凭据').not.toBe('')
    // NOT revoked: the injected refresh is an ordinary proactive renewal, so the
    // pre-refresh token keeps working, nothing on the wire 401s, and the 401
    // self-heal is removed as an alternative adoption path.
    const baselineWire = server.stats.mcpBearerTokens.length
    const baselineHeaders = server.stats.mcpHeaders.length
    const baselineUnauthorized = server.stats.mcpUnauthorized

    let holder: ProbeHarness | undefined
    let hookStatus = 0
    const day2 = createProbeHarness([def(server.origin, false)], dir, {
      raceRefresh: async () => {
        const res = await callRoute({ routes: (holder as ProbeHarness).routes } as never, '/api/pico/connectors/example-mcp/refresh', 'POST')
        hookStatus = res.status
      },
    })
    holder = day2
    await waitFor(() => day2.connects.length === 1 && day2.connects[0]?.settled === true, 30_000)

    const http = day2.connects[0]
    const store = new ConnectorStore({ baseDir: dir })
    const stored = await store.readCredential('example-mcp')
    const handshakeWire = server.stats.mcpBearerTokens.slice(baselineWire)
    // The registration settled: everything the endpoint sees from now on is what
    // the LIVE transport reads out of its provider.
    const beforeCall = server.stats.mcpBearerTokens.length
    const client = day2.clients.get('example-mcp')
    let callError = ''
    try {
      await client?.callTool({ name: 'echo', arguments: { text: 'after-registration' } })
    } catch (error: unknown) {
      callError = error instanceof Error ? error.message : String(error)
    }
    const callWire = server.stats.mcpBearerTokens.slice(beforeCall)
    const { frames } = classify(server, baselineHeaders)
    const grants = server.stats.grants.filter(grant => grant === 'refresh_token').length
    const evidence = `hookStatus=${hookStatus} handshakeWire=${JSON.stringify(handshakeWire)}`
      + ` stored=${JSON.stringify(String(stored?.accessToken ?? ''))} replaced=${JSON.stringify(replaced)}`
      + ` callWire=${JSON.stringify(callWire)} callError=${JSON.stringify(callError)} grants=${grants}`
      + ` unauthorizedDelta=${server.stats.mcpUnauthorized - baselineUnauthorized}`
      + ` credentialless=${credentialless(server, baselineWire)}`
      + ` error=${JSON.stringify(http?.error)} frames=${JSON.stringify(frames)}`
    console.log(`CASE B evidence: ${evidence}`)

    // Preconditions: the refresh landed inside the handshake, and the handshake
    // itself succeeded on the (still valid) pre-refresh token.
    expect(hookStatus, `注入的刷新必须成功 —— ${evidence}`).toBe(200)
    expect(stored?.accessToken, `刷新必须换掉令牌 —— ${evidence}`).not.toBe(replaced)
    expect(http?.ok, `注册必须成功（这一步走的是刷新前的令牌）—— ${evidence}`).toBe(true)
    expect(handshakeWire, `握手确实用的是刷新前的令牌（对照组）—— ${evidence}`).toContain(replaced)

    // THE judgement (endpoint fact): after registration the live transport must
    // read the CURRENT token. Nothing else can have adopted it here: the wire
    // never 401s on a credential, so the self-heal path never runs — only
    // `adoptLatestRefresh` can have moved the provider off the snapshot it was
    // born with.
    expect(callWire.length, `注册后必须真的发出过一次请求 —— ${evidence}`).toBeGreaterThan(0)
    expect(callWire, `注册后的请求必须带当前令牌（追赶生效）—— ${evidence}`).toContain(stored?.accessToken)
    expect(callWire, `注册后的请求不许再带被替换的令牌 —— ${evidence}`).not.toContain(replaced)
    // Control: the window itself stayed cheap — exactly one grant, and no 401
    // from anything that carried a credential.
    expect(grants, `窗口必须恰好花掉一次 refresh 兑换 —— ${evidence}`).toBe(1)
    expect(
      server.stats.mcpUnauthorized - baselineUnauthorized,
      `窗口内的 401 必须全部来自没有凭据的探针 —— ${evidence}`,
    ).toBe(credentialless(server, baselineWire))
    expect(callError, `注册后的真实工具调用必须成功 —— ${evidence}`).toBe('')
    day2.dispose()
  }, 90_000)
})
