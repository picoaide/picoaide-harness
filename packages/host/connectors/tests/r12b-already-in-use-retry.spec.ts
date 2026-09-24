/**
 * R12 B-03：`serverName already in use` **重试路径**重新发布活头记录 —— 这条承重行此前
 * 一条判据都没有。
 *
 * ## 被审的行（`src/index.ts`）
 *
 * `registerMcp` 的加载段在 `already in use`（HMR 残留 / 上一世代实例 / 另一插件实例）
 * 时会先 `await unregisterMcp(def, select)` 再重试**恰好一次**：
 *
 * ```
 *   :2407  fiber = await load().catch(async (cause) => {
 *   :2412    await unregisterMcp(def, select)          ← 丢掉这条注册的所有活头记录
 *   :2416    if (providerSuppliesAuthorization && …) publishPendingLiveHeaders()
 *   :2417    return await load()                       ← 第二次真实握手
 * ```
 *
 * `unregisterMcp` 会 `dropPendingLiveHeaders`，而 `:2416` 是**唯一**把它放回去的地方；
 * 重试用的还是同一个 `renderedHeaders.headers` 记录对象，即重试后的传输真正读的那一个。
 * 删掉 `:2416` 后：记录停在被替换的令牌上、端点两次看到旧令牌、注册以
 * `Server returned 401 after re-authentication` 收场 —— 而连接器面板的行状态**仍是
 * `connected`**（第九轮 R9-D-1 修的就是这个观测面）。
 *
 * ## 这条判据构造的交错（此前两轮都没构造过）
 *
 * day-1 用真 HTTP MCP 端点 + 真授权服务器完成一次完整 OAuth 连接；随后在服务端**作废**
 * 访问令牌（本地时钟仍认为它有效）。day-2 新建插件实例（开机 `restoreAll` 就是那次注册），
 * 第一次 `ctx.plugin` 抛 `already in use`，而**带外刷新（真实面板路由 `/refresh`，
 * 真授权服务器往返）落在重试的第二次握手内** —— 即 `:2416` 之后、`mcpRegistrations.set`
 * 之前。记录若没跟上，重试的传输就会带着死令牌上线。
 *
 * 端点是声明式头的形态（`X-Probe-Key: ''` ⇒ 框架填 `Bearer <活令牌>`，R9-D-1），
 * 判据全部读**端点侧事实**（哪些 bearer 到过、几次 401、几次 refresh 兑换），
 * 不读本用例自己写下的赋值。
 *
 * ## 与 J2-N2（`r11j2n2-live-header-sweep.spec.ts`）的边界
 *
 * 那条是**结构判据**（AST 形状：sweep 两个来源、无 `continue`）：它要的"两源共存"窗口
 * 在现有装置里**结构上不可达** —— 见该文件头部的认账段（`waitForRebuildClearance` 需要
 * fence 计过票的在途调用，而这里自建传输、票数恒 0）。本条覆盖的是同一条活头链上的
 * **另一条**路径（重试），它的窗口由 `ctx.plugin` 的失败/重试本身撑开，因此可以端到端。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 与 `r11b01-midreg-window.spec.ts` 同一取舍：`ctx.plugin` 换成本用例自己的真连接
// （真 pinned SDK 传输 + 真 HTTP 端点），上游桥不参与；`apply` 只需要存在。
vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { apply } from '../src/index.ts'
import { ConnectorStore } from '../src/store.ts'
import type { ConnectorDef } from '../src/types.ts'
import { browserFence, callRoute, waitFor, type CapturedConfig } from './helpers/connector-harness.ts'
import { completeAuthorization, startRealMcpServer, type RealMcpServer } from './helpers/real-mcp-oauth-server.ts'

const servers: RealMcpServer[] = []
afterEach(async () => { while (servers.length) await servers.pop()?.close() })

/** 端点校验这一枚头（声明空值 ⇒ 框架自动填 `Bearer <活令牌>`，R9-D-1 的形态）。 */
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
      headers: { [EXTRA_HEADER]: '' },
    }],
  }
}

interface Outcome {
  readonly config: CapturedConfig
  ok: boolean
  settled: boolean
  error?: string
}

/**
 * day-1 / day-2 的插件替身：`ctx.plugin` 真的经 pinned SDK 连到真端点。
 *
 * `ghost` = 第一次 `ctx.plugin` 抛 `already in use`（重试路径的入口）；
 * `race` = 在**第二次**（重试的）握手里、连接之前落地的动作（本用例放带外刷新）。
 */
function createHarness(
  defs: ConnectorDef[],
  dir: string,
  options: { ghost?: boolean, race?: () => Promise<void> } = {},
): {
  configs: CapturedConfig[]
  connects: Outcome[]
  warns: string[]
  pluginAttempts: () => number
  /** 插件注册到 `ctx.webServer` 的路由（`callRoute` 直接驱动真 handler）。 */
  routes: Array<{ kind: 'exact' | 'prefix', path: string, handler: (req: never, res: never) => unknown }>
  /** 跑插件在 `ctx.effect` 里登记的所有 disposer（模拟关机）。 */
  dispose: () => void
} {
  const configs: CapturedConfig[] = []
  const connects: Outcome[] = []
  const warns: string[] = []
  const eventHandlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const effectDisposers: Array<() => void> = []
  const liveServerNames = new Set<string>()
  const routes: Array<{ kind: 'exact' | 'prefix', path: string, handler: (req: never, res: never) => unknown }> = []
  const fence = browserFence()
  let mode: 'normal' | 'ghost' | 'race' | 'done' = options.ghost === true ? 'ghost' : 'normal'
  let attempts = 0

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
      if (mode === 'ghost') {
        // 上一世代（HMR 残留 / 另一个插件实例）占着这个名字：正是 registerMcp
        // 会重试一次的那条失败。
        mode = 'race'
        throw new Error(`mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance`)
      }
      if (mode === 'race') {
        mode = 'done'
        if (options.race !== undefined) await options.race()
      }
      if (liveServerNames.has(config.serverName)) {
        throw new Error(`mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance`)
      }
      liveServerNames.add(config.serverName)
      configs.push(config)
      const outcome: Outcome = { config, ok: false, settled: false }
      connects.push(outcome)
      // 与 `dsh-mcp-client` 的 createTransport 同形：requestInit.headers 就是记录对象，
      // authProvider 让 SDK 每请求读活令牌。
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
      error: vi.fn((m?: unknown) => { warns.push(String(m)) }),
    },
    effect: (register: () => (() => void) | undefined) => {
      const dispose = register()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
      return () => {}
    },
    webServer: {
      register: (route: { kind: 'exact' | 'prefix', path: string, handler: (req: never, res: never) => unknown }) => {
        routes.push(route)
        return () => {}
      },
    },
  }

  apply(ctx as never, { connectors: defs, storeBaseDir: dir, refreshSweepIntervalMs: 0 })
  return {
    configs, connects, warns, pluginAttempts: () => attempts, routes,
    dispose: () => { for (const disposer of effectDisposers) disposer() },
  }
}

/** 等面板状态里出现 `request.authorizeUrl`（授权流程已开始）。 */
async function awaitAuthorizeUrl(h: ReturnType<typeof createHarness>, deadlineMs = 8_000): Promise<string> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const res = await callRoute(h as never, '/api/pico/connectors/example-mcp/state', 'GET')
    const url = (JSON.parse(res.body) as { request?: { authorizeUrl?: string } | null }).request?.authorizeUrl
    if (url !== undefined) return url
    if (Date.now() > deadline) throw new Error('no authorize URL')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('R12 B-03: `already in use` 重试路径必须重新发布活头记录', () => {
  it('重试握手内落地的带外刷新仍然到达"传输真正读的那条记录"', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    server.requireExtraHeader(EXTRA_HEADER)
    const dir = mkdtempSync(join(tmpdir(), 'r12b-retry-'))

    // ---- day 1：真实授权 + 真实连接（注册 #1） ------------------------------
    const day1 = createHarness([def(server.origin)], dir)
    await callRoute(day1 as never, '/api/pico/connectors/example-mcp/connect', 'POST')
    await completeAuthorization(await awaitAuthorizeUrl(day1))
    await waitFor(() => day1.connects.length === 1 && day1.connects[0]?.ok === true, 15_000)
    expect(day1.connects[0]?.error, 'day 1 必须连上').toBeUndefined()
    expect(day1.pluginAttempts(), 'day 1 只该有一次 ctx.plugin').toBe(1)

    const store = new ConnectorStore({ baseDir: dir })
    const before = await store.readCredential('example-mcp')
    const replaced = String(before?.accessToken ?? '')
    expect(replaced, 'day 1 之后磁盘上必须有凭据').not.toBe('')
    // 服务端作废访问令牌、本地时钟仍认为有效：只有下面注入的那次刷新能产出端点接受
    // 的令牌。day-1 的实例必须先 dispose（模拟关机），否则 day-2 用的是同一个 map。
    server.expireAccessTokens()
    const baselineWire = server.stats.mcpBearerTokens.length
    const baselineHeaders = server.stats.mcpHeaders.length
    const baselineUnauthorized = server.stats.mcpUnauthorized
    day1.dispose()

    // ---- day 2：新实例开机恢复 ⇒ 第一次 ctx.plugin 抛 already in use，
    // 带外刷新落在**重试的**第二次握手内 -------------------------------------
    const day2 = createHarness([def(server.origin)], dir, {
      ghost: true,
      race: async () => {
        const res = await callRoute(day2 as never, '/api/pico/connectors/example-mcp/refresh', 'POST')
        expect(res.status, '注入的刷新必须成功（否则这条用例什么都没证明）').toBe(200)
      },
    })
    await waitFor(() => day2.connects.length === 1 && day2.connects[0]?.settled === true, 30_000)

    const stored = await store.readCredential('example-mcp')
    const row = JSON.parse((await callRoute(day2 as never, '/api/pico/connectors/example-mcp/state', 'GET')).body) as { status?: string }
    const day2Wire = server.stats.mcpBearerTokens.slice(baselineWire)
    const frames = server.stats.mcpHeaders.slice(baselineHeaders)
      .map(head => `${head['content-type'] === undefined ? 'no-body' : 'json-body'}:${String(head['x-probe-key'] ?? '<absent>')}`)
    const evidence = `attempts=${String(day2.pluginAttempts())} configs=${String(day2.configs.length)}`
      + ` record=${JSON.stringify(day2.configs[0]?.headers?.[EXTRA_HEADER])}`
      + ` stored=${JSON.stringify(String(stored?.accessToken ?? ''))}`
      + ` replaced=${JSON.stringify(replaced)} wire=${JSON.stringify(day2Wire)}`
      + ` error=${JSON.stringify(day2.connects[0]?.error)} row=${JSON.stringify(row.status)} frames=${JSON.stringify(frames)}`
      + ` warns=${JSON.stringify(day2.warns.slice(0, 4))}`

    // 前置：重试真的发生了（否则这条用例证明不了任何事）。
    expect(day2.pluginAttempts(), `already in use 重试必须跑过 —— ${evidence}`).toBe(2)
    expect(day2.configs.length, `只有一次注册走到了传输 —— ${evidence}`).toBe(1)
    // 前置：刷新真的轮换了凭据。
    expect(stored?.accessToken, `刷新必须换掉令牌 —— ${evidence}`).not.toBe(replaced)
    // 判据 1：重试后的传输读的那条记录已经跟上当前令牌（`:2416` 就是这条判据的承重行）。
    expect(day2.configs[0]?.headers?.[EXTRA_HEADER], `重新发布的记录必须跟上当前令牌 —— ${evidence}`)
      .toBe(`Bearer ${String(stored?.accessToken ?? '')}`)
    // 判据 2：被替换的令牌不再出现在线上。
    expect(day2Wire, `端点不该再看到被替换的令牌 —— ${evidence}`).not.toContain(replaced)
    // 判据 3：重试的注册真的成功了（没有变成"反复自愈"的循环）。
    expect(day2.connects[0]?.ok, `重试后的传输必须加载成功 —— ${evidence}`).toBe(true)
    // 判据 4：窗口内的每一次 401 都必须来自**没有凭据的发现探针**（RFC 9728 的
    // resource_metadata 探路），不能来自旧凭据 —— 逐帧按"有没有声明头"分类后对账。
    const discoveryFrames = frames.filter(frame => frame.startsWith('no-body:<absent>')).length
    expect(
      server.stats.mcpUnauthorized - baselineUnauthorized,
      `窗口内的 401 必须全部是发现探针（没有一条来自旧凭据）—— ${evidence}`,
    ).toBe(discoveryFrames)
    expect(frames.some(frame => frame.includes(replaced)), `没有任何一帧可以带被替换的令牌 —— ${evidence}`).toBe(false)
    // 判据 5：窗口的代价恰好是我们注入的那一次刷新（多出来的就是多余兑换）。
    expect(
      server.stats.grants.filter(grant => grant === 'refresh_token').length,
      `窗口必须恰好花掉一次 refresh 兑换 —— ${evidence}`,
    ).toBe(1)
    day2.dispose()
  }, 60_000)
})
