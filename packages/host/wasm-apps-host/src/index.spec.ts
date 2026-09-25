/**
 * 装配面回归：协议/分区注册、会话跟随、深链严格性、本机打开路由的持有性证明。
 *
 * 这一层刻意不 import electron —— 上面的 import 本身就在证明"插件主体可在纯
 * Node 下加载"（profile 冒烟与单测都走这条路）。
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  apply,
  wasmAppUrl,
  WASM_APP_AI_CONSENT_ROUTE,
  WASM_APP_CHANNEL_ROUTE,
  WASM_APP_DEEP_LINK_FOREIGN_EVENT,
  WASM_APP_OPEN_EVENT,
  WASM_APP_OPEN_ROUTE,
  WASM_APPS_AI_RUNNER_SERVICE,
  WASM_APPS_WINDOW_ADAPTER_SERVICE,
  WASM_APPS_LOCAL_PREFIX,
  WASM_APPS_HOST_ADAPTER_SERVICE,
  PLATFORM_REFUSAL_CODE_PREFIX,
  type Config,
} from './index.ts'
import { AI_CHAT_PATH } from './ai-chat.ts'
import { AI_CONSENT_FILE_NAME } from './ai-authorization.ts'
import type { AppSchemeRequestHandler, WasmAppsHostAdapter } from './electron-adapter.ts'
import { serverPartitionHash } from './partition.ts'
import type { AppSession, PicoSessionLike } from './session.ts'

/** 记录注册面与事件的假 Cordis 上下文（只实现本插件真正用到的成员）。 */
function fakeContext(options: {
  /** `null` = 显式不给适配器（模拟非 Electron 宿主）；缺省 = 给一个记录用的替身。 */
  adapter?: WasmAppsHostAdapter | null
  session?: AppSession | null
  restored?: boolean
  /** 平台出站替身（覆盖 F16 open 端点的回答）。 */
  fetch?: ((url: string, init: RequestInit) => Promise<Response>) | undefined
  /** 缺省给一个"放行"的围栏（部署里它总在）；显式 `null` = 模拟围栏服务缺席。 */
  fence?: { requestRejection: (request: { headers: IncomingMessage['headers'] }) => 401 | 403 | undefined } | null | undefined
  locale?: string
  /** 应用 AI 的执行面（§21.2 步骤③；桌面壳 `provide` 的那个服务名）。 */
  aiRunner?: unknown
  /** 窗口适配器（配合 `apply(ctx, {userDataDir})` 才建窗口管理器；生命周期用例需要）。 */
  windowAdapter?: unknown
  /**
   * 应用窗口 surface 注册表（§16.1）。给了 ⇒ `ctx.inject(['browserSurface'])` 的回调
   * **立刻**执行（模拟 browser 行已加载）；不给 ⇒ 回调挂起，测试可用
   * `provideBrowserSurface()` 模拟"注册表晚到"。
   */
  browserSurface?: unknown
} = {}) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const emitted: Array<{ event: string, payload: unknown }> = []
  const warnings: string[] = []
  const routes: Array<{ kind: string, path: string, handler: (req: IncomingMessage, res: ServerResponse) => void }> = []
  const injections: Array<{ deps: readonly string[], callback: (scope: { get: (name: string) => unknown }) => void }> = []
  let session: AppSession | null = options.session ?? null
  const partitions: string[] = []
  let defaultRegistrations = 0
  let currentHandler: AppSchemeRequestHandler | undefined

  /** 平台出站替身：默认把 F16 的 `open` 端点答成"版本 1.0.0，无变化，无计数"。 */
  const defaultFetch = async (url: string): Promise<Response> => {
    if (url.endsWith('/open')) return new Response(JSON.stringify({ version: '1.0.0', changed: false }), { status: 200 })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  const adapter: WasmAppsHostAdapter | undefined = options.adapter === null
    ? undefined
    : options.adapter ?? {
      handleAppScheme: (_scheme, handler) => { defaultRegistrations += 1; currentHandler = handler },
      handleInSession: (_scheme, partition) => { partitions.push(partition) },
      ...(options.fetch === undefined ? { fetch: defaultFetch } : { fetch: options.fetch }),
    }

  const webServerService = {
    port: 41234,
    register: (route: { kind: string, path: string, handler: (req: IncomingMessage, res: ServerResponse) => void }) => {
      routes.push(route)
      return () => {}
    },
  }
  const services = new Map<string, unknown>([
    [WASM_APPS_HOST_ADAPTER_SERVICE, adapter],
    ['picoSession', {
      getSession: () => session,
      isRestored: () => options.restored ?? true,
      clear: vi.fn(),
    } satisfies PicoSessionLike],
    ['desktopRuntime', { locale: options.locale ?? 'zh' }],
    ['connection', options.fence === null ? undefined : (options.fence ?? { requestRejection: () => undefined })],
    [WASM_APPS_AI_RUNNER_SERVICE, options.aiRunner],
    [WASM_APPS_WINDOW_ADAPTER_SERVICE, options.windowAdapter],
    ['browserSurface', options.browserSurface],
  ])

  /**
   * `ctx.inject` 的替身（本插件只用它取晚到的 `browserSurface`）。
   *
   * 语义与 Cordis 一致：服务**已经**在 ⇒ 回调立刻执行；还没到 ⇒ 挂起，等
   * {@link provideBrowserSurface} 触发（这正是 profile 里 browser 行在本插件之后
   * 加载的真实时序）。
   */
  const runInjection = (injection: { deps: readonly string[], callback: (scope: { get: (name: string) => unknown }) => void }, name: string): void => {
    injection.callback({ get: (key: string) => (key === name ? services.get(name) : undefined) })
  }
  const inject = (deps: readonly string[], callback: (scope: { get: (name: string) => unknown }) => void): (() => void) => {
    const injection = { deps, callback }
    injections.push(injection)
    if (deps.includes('browserSurface') && services.get('browserSurface') !== undefined) runInjection(injection, 'browserSurface')
    return () => {
      const index = injections.indexOf(injection)
      if (index >= 0) injections.splice(index, 1)
    }
  }

  const ctx = {
    get: (name: string) => (name === 'webServer' ? webServerService : services.get(name)),
    inject,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(handler)
      listeners.set(event, set)
      return () => { set.delete(handler) }
    },
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload })
      for (const handler of listeners.get(event) ?? []) handler(payload)
    },
    effect: (callback: () => (() => void) | void) => { callback() },
    logger: { warn: (message: string) => { warnings.push(message) }, info: () => {} },
    webServer: {
      port: 41234,
      register: (route: { kind: string, path: string, handler: (req: IncomingMessage, res: ServerResponse) => void }) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  return {
    ctx: ctx as unknown as Parameters<typeof apply>[0],
    partitions,
    emitted,
    warnings,
    routes,
    setSession: (next: AppSession | null) => { session = next },
    get defaultRegistrations() { return defaultRegistrations },
    get handler() { return currentHandler },
    /** 模拟 browser 行**晚于**本插件加载：注册表现在才出现。 */
    provideBrowserSurface: (registry: unknown) => {
      services.set('browserSurface', registry)
      for (const injection of [...injections]) {
        if (injection.deps.includes('browserSurface')) runInjection(injection, 'browserSurface')
      }
    },
    fireSessionChanged: () => {
      for (const handler of listeners.get('pico/session-changed') ?? []) handler(session)
    },
    fireDeepLink: (url: string) => {
      for (const handler of listeners.get('pico/deep-link') ?? []) handler(url)
    },
  }
}

/** 假 IncomingMessage（只用 method/headers/异步体）。 */
function fakeRequest(
  method: string,
  body?: string,
  headers: Record<string, string> = {},
  url: string = WASM_APP_OPEN_ROUTE,
): IncomingMessage {
  const request = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
  return request as unknown as IncomingMessage
}

/** 假 ServerResponse（记录 status/headers/body）。 */
function fakeResponse(): { res: ServerResponse, state: { status: number, body: string, headers: Record<string, string> } } {
  const state = { status: 0, body: '', headers: {} as Record<string, string> }
  const res = {
    writeHead: (status: number, headers?: Record<string, string>) => {
      state.status = status
      Object.assign(state.headers, headers ?? {})
      return res
    },
    setHeader: (name: string, value: string) => { state.headers[name] = value },
    end: (chunk?: string | Uint8Array) => {
      state.body = typeof chunk === 'string' ? chunk : (chunk === undefined ? '' : Buffer.from(chunk).toString('utf8'))
    },
  }
  return { res: res as unknown as ServerResponse, state }
}

/** 等一次微任务链（路由 handler 是 fire-and-forget 的 async）。 */
const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

const ALICE: AppSession = { serverURL: 'https://harness.example.com', token: 'tok', username: 'alice' }
/**
 * alice 在 `https://harness.example.com` 上的分区名（§7.2 冻结：
 * `persist:agent-browser-<user>@<server-hash>`）。哈希口径 = `serverPartitionHash`
 * （sha256 前 32 位 hex，去尾斜杠）；这里写死是为了让**形状本身**成为判据：
 * 换服务端地址必须换分区（跨租户不得串味），未登录仍是匿名分区。
 */
const ALICE_PARTITION = `persist:agent-browser-alice@${serverPartitionHash(ALICE.serverURL)!}`

describe('protocol and partition registration', () => {
  it('registers the default session plus the anonymous partition with no session', () => {
    const h = fakeContext()
    apply(h.ctx, {})
    expect(h.defaultRegistrations).toBe(1)
    expect(h.partitions).toEqual(['persist:agent-browser-anonymous'])
  })

  it('registers the logged-in user partition on a restored session (no event needed)', () => {
    const h = fakeContext({ session: ALICE, restored: true })
    apply(h.ctx, {})
    expect(h.partitions).toEqual([ALICE_PARTITION])
    // §7.2 冻结：分区名含**服务端地址哈希**（2026-09-21 审计 P1-10 证据②）。
    // 变异：`browserPartitionFor` 去掉 `@<hash>` 后缀 ⇒ 本组用例必红。
    expect(h.partitions[0]).not.toBe('persist:agent-browser-alice')
  })

  it('follows the session change (setPartition semantics) without duplicating registrations', () => {
    const h = fakeContext({ restored: true })
    apply(h.ctx, {})
    expect(h.partitions).toEqual(['persist:agent-browser-anonymous'])
    h.setSession(ALICE)
    h.fireSessionChanged()
    // 新分区被补注册，旧分区保留（已挂载的页面不受影响）。
    expect(h.partitions).toEqual(['persist:agent-browser-anonymous', ALICE_PARTITION])
    // 同一分区重复同步不重复注册（Electron 对同一 scheme 二次 handle 会抛）。
    h.fireSessionChanged()
    h.fireSessionChanged()
    expect(h.partitions).toEqual(['persist:agent-browser-anonymous', ALICE_PARTITION])
    h.setSession(null)
    h.fireSessionChanged()
    expect(h.partitions).toEqual(['persist:agent-browser-anonymous', ALICE_PARTITION])
  })

  it('换服务端地址 ⇒ 换分区（跨租户不得共用同一个持久分区）', () => {
    const h = fakeContext({ session: ALICE, restored: true })
    apply(h.ctx, {})
    const first = h.partitions[0]
    h.setSession({ ...ALICE, serverURL: 'https://other.example.com' })
    h.fireSessionChanged()
    expect(h.partitions[1]).not.toBe(first)
    expect(h.partitions[1]?.startsWith('persist:agent-browser-alice@')).toBe(true)
    // 尾斜杠是同一个服务端（分区名是磁盘目录名，不能因为一次地址写法不同就换空分区）：
    // 归一化之后同名 ⇒ 不产生第二次注册（`ensurePartition` 幂等）。
    const other = h.partitions[1]
    h.setSession({ ...ALICE, serverURL: 'https://other.example.com/' })
    h.fireSessionChanged()
    expect(h.partitions).toEqual([first, other])
  })

  it('honours an explicit partition override', () => {
    const h = fakeContext({ session: ALICE })
    apply(h.ctx, { partition: 'persist:custom-browser' } satisfies Config)
    expect(h.partitions).toEqual(['persist:custom-browser'])
  })

  it('warns once and stays inert without an Electron adapter', () => {
    const h = fakeContext({ adapter: null, session: ALICE })
    apply(h.ctx, {})
    expect(h.partitions).toEqual([])
    expect(h.warnings.some(message => message.includes('no Electron adapter'))).toBe(true)
  })
})

describe('deep links', () => {
  it('opens the app for a valid channel-scheme link', async () => {
    const h = fakeContext({ session: ALICE })
    apply(h.ctx, { deepLinkScheme: 'acmeai' })
    h.fireDeepLink('acmeai://app/my-notes')
    // R4-B-16 起深链也要先过 F16 打开闸门（一次平台 /open 往返），所以打开是**异步**的：
    // 断言内容不变，只是必须等这次往返落地（`defaultFetch` 把它答成 200/ok）。
    await flush()
    expect(h.emitted).toContainEqual({
      event: WASM_APP_OPEN_EVENT,
      payload: { app_id: 'my-notes', url: 'picoaide-app://my-notes/' },
    })
  })

  it('drops unknown schemes/hosts without a fallback and logs it', async () => {
    const h = fakeContext({ session: ALICE })
    apply(h.ctx, { deepLinkScheme: 'acmeai' })
    h.fireDeepLink('acmeai://auth?token=t')
    h.fireDeepLink('picoaide://app/my-notes')
    h.fireDeepLink('acmeai://app/my-notes/extra')
    // 等待闸门往返落地：这条断言是**否定**的，"还没开始处理"与"处理完没打开"必须区分
    // （否则异步化之后它会恒真）。
    await flush()
    expect(h.emitted.filter(entry => entry.event === WASM_APP_OPEN_EVENT)).toEqual([])
    // `picoaide://app/my-notes` 是**异渠道**链接（J13）⇒ 一条事件 + 一条 scheme 不符 warn；
    // 另外两条是"不是 app 深链"，各记一条。三条都**不回落**任何默认动作。
    expect(h.warnings.filter(message => message.includes('not an app link')).length).toBe(2)
    expect(h.warnings.filter(message => message.includes('another channel')).length).toBe(1)
    expect(h.emitted.filter(entry => entry.event === WASM_APP_DEEP_LINK_FOREIGN_EVENT)).toHaveLength(1)
  })

  it('ignores every deep link when no scheme was injected (fail-closed)', () => {
    const h = fakeContext({ session: ALICE })
    apply(h.ctx, {})
    expect(h.warnings.some(message => message.includes('no deep-link scheme'))).toBe(true)
    h.fireDeepLink('acmeai://app/my-notes')
    expect(h.emitted.filter(entry => entry.event === WASM_APP_OPEN_EVENT)).toEqual([])
  })
})

/**
 * R4-B-16（审计 2026-09-23）：**所有**打开路径走同一个 F16 闸门。
 *
 * 修复前 `openGate.check` 只有本机打开路由调：深链（与登录后的队列消费）直接建窗
 * ⇒ ① 拿不到 `changed`，不清版本缓存，而 `handler.ts` 会把宿主的旧版本写进
 * `X-PicoAide-App-Version` **覆盖平台下发的版本头**；② 不产生打开计数；
 * ③ 404/410 的生命周期反应（关窗 + 清缓存）与"版本无法确认则不打开"的硬闸门都不执行。
 *
 * 判据（都能咬到实现）：深链必须产生**恰好一次** `/open`；本机路由同样**恰好一次**
 * （闸门收进 `requestOpen` 后不许变成两次）；平台说"没了"时深链不建窗。
 */
describe('R4-B-16 深链同样过 F16 打开闸门', () => {
  it('深链打开产生一次 /open，并且版本变化时真的建窗', async () => {
    const created: Array<Record<string, unknown>> = []
    const openUrls: string[] = []
    const h = fakeContext({
      session: ALICE,
      windowAdapter: {
        createAppWindow: (options: Record<string, unknown>) => { created.push(options); return { id: created.length } },
        focusAppWindow: () => {},
        closeAppWindow: () => {},
        setAspectRatio: () => {},
        webContentsId: (handle: { id: number }) => handle.id,
        webContents: (handle: { id: number }) => ({ wc: handle.id }),
        workArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      },
      fetch: async (url) => {
        if (url.endsWith('/open')) {
          openUrls.push(url)
          return new Response(JSON.stringify({ version: '3.0.0', changed: true, title: 'Demo', opens: { today: { pv: 5, uv: 2 } } }), { status: 200 })
        }
        return new Response('{}', { status: 200 })
      },
    })
    apply(h.ctx, { userDataDir: mkdtempSync(join(tmpdir(), 'pico-wasm-apps-r4b16-')), appOriginScheme: 'acme-app', deepLinkScheme: 'acmeai' })
    h.fireDeepLink('acmeai://app/demo?path=%2Fnotes')
    // 等**事件**落地（`createAppWindow` 在 `windows.open()` 内部，早于 emit）。
    for (let i = 0; i < 200 && !h.emitted.some(entry => entry.event === WASM_APP_OPEN_EVENT); i++) await flush()

    expect(openUrls, '深链必须调平台的 open 端点（否则拿不到 changed / 不计打开次数）').toEqual([
      `${ALICE.serverURL}/api/client/v2/apps/wasm/demo/open`,
    ])
    expect(created).toHaveLength(1)
    expect(h.emitted).toContainEqual({
      event: WASM_APP_OPEN_EVENT,
      payload: { app_id: 'demo', url: 'acme-app://demo/notes' },
    })
  })

  it('平台说这个应用没了时，深链不建窗（生命周期分支同样生效）', async () => {
    const created: Array<Record<string, unknown>> = []
    const h = fakeContext({
      session: ALICE,
      windowAdapter: {
        createAppWindow: (options: Record<string, unknown>) => { created.push(options); return { id: created.length } },
        focusAppWindow: () => {},
        closeAppWindow: () => {},
        setAspectRatio: () => {},
        webContentsId: (handle: { id: number }) => handle.id,
        webContents: (handle: { id: number }) => ({ wc: handle.id }),
        workArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      },
      fetch: async (url) => url.endsWith('/open')
        ? new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'gone', details: { reason: 'app_not_found' } } }), { status: 404 })
        : new Response('{}', { status: 200 }),
    })
    apply(h.ctx, { userDataDir: mkdtempSync(join(tmpdir(), 'pico-wasm-apps-r4b16-404-')), appOriginScheme: 'acme-app', deepLinkScheme: 'acmeai' })
    h.fireDeepLink('acmeai://app/demo')
    for (let i = 0; i < 200 && !h.warnings.some(message => message.includes('as unavailable')); i++) await flush()

    expect(created, '404（不存在/软删）必须挡住新建窗口').toHaveLength(0)
    expect(h.emitted.filter(entry => entry.event === WASM_APP_OPEN_EVENT)).toEqual([])
  })
})

describe('local open route', () => {
  const routeOf = (h: ReturnType<typeof fakeContext>) => {
    // 前缀路由：注册在 WASM_APPS_LOCAL_PREFIX 上，open 由 handler 内按 pathname 分发。
    const route = h.routes.find(entry => entry.path === WASM_APPS_LOCAL_PREFIX)
    expect(route, 'open route must be registered').toBeDefined()
    return route!
  }

  /** 取一枚本机持有性令牌（R2：授权走请求头，不再依赖 Cookie/Host/Origin/端口）。 */
  const proofHeaderOf = async (h: ReturnType<typeof fakeContext>): Promise<Record<string, string>> => {
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('GET', undefined, {}, `${WASM_APPS_LOCAL_PREFIX}/host-proof`), res)
    await flush()
    expect(state.status).toBe(200)
    const proof = (JSON.parse(state.body) as { proof: string }).proof
    return { 'x-pico-host-proof': proof }
  }

  /**
   * **端到端**（R2-X-1 的宿主侧判据）：全程只经本机路由 —— ①引导端点取令牌 →
   * ②`GET /channel` 拿渠道 scheme → ③`POST /open` 打开。**没有任何手工注入的证明头**：
   * 令牌只来自引导端点的响应体。
   *
   * 唯一的替身是 `connection` 围栏（真实 BrowserAuth 需要 Electron 主进程 + 真 cookie，
   * 单测无法构造）—— 那属于**引导路径**的当日授权，零端口形态下换成帧管道握手（§22.2 R2）。
   * 变异：引导端点不返回令牌、或去掉 open 的证明闸 ⇒ 本用例必红。
   */
  it('端到端：引导取令牌 → channel 拿 scheme → open 打开（无手工注入）', async () => {
    const h = fakeContext({ session: ALICE })
    apply(h.ctx, { appOriginScheme: 'acme-app', deepLinkScheme: 'acmeai', productName: 'Acme' })

    // ① 引导：渲染层唯一能拿到令牌的地方。
    const boot = fakeResponse()
    routeOf(h).handler(fakeRequest('GET', undefined, {}, `${WASM_APPS_LOCAL_PREFIX}/host-proof`), boot.res)
    await flush()
    expect(boot.state.status).toBe(200)
    const issued = JSON.parse(boot.state.body) as { proof: string, expires_at: number }
    expect(typeof issued.proof).toBe('string')
    expect(issued.proof.length).toBeGreaterThan(16)
    expect(issued.expires_at).toBeGreaterThan(Date.now())

    // ② 渲染层用同一枚令牌取渠道信息（分享入口据此渲染）。
    const channel = fakeResponse()
    routeOf(h).handler(
      fakeRequest('GET', undefined, { 'x-pico-host-proof': issued.proof }, WASM_APP_CHANNEL_ROUTE),
      channel.res,
    )
    await flush()
    expect(channel.state.status).toBe(200)
    expect(JSON.parse(channel.state.body)).toEqual({
      appOriginScheme: 'acme-app',
      deepLinkScheme: 'acmeai',
      productName: 'Acme',
    })

    // ③ 同一枚令牌打开应用。
    const opened = fakeResponse()
    routeOf(h).handler(
      fakeRequest('POST', '{"app_id":"my-notes"}', { 'x-pico-host-proof': issued.proof }),
      opened.res,
    )
    await flush()
    expect(opened.state.status).toBe(200)
    expect(JSON.parse(opened.state.body)).toMatchObject({ window: 'opened', app_id: 'my-notes' })

    // 令牌语义（TTL / proof_expired / 重取）在 `host-request.spec.ts` 用**可注入时钟**的
    // 权威单测覆盖（这里用 jest 假时钟会连 flush 一起冻住，反而不如那一层干净）。
    // 反向对照：**不**带令牌的同一次调用 401（证明授权真的来自引导令牌）。
    const denied = fakeResponse()
    routeOf(h).handler(fakeRequest('POST', '{"app_id":"my-notes"}'), denied.res)
    await flush()
    expect(denied.state.status).toBe(401)
  })

  it('未知子路径 404（前缀路由必须按 pathname 分发）', async () => {
    const h = fakeContext()
    apply(h.ctx, {})
    const headers = await proofHeaderOf(h)
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('POST', '{}', headers, `${WASM_APPS_LOCAL_PREFIX}/unknown`), res)
    await flush()
    expect(state.status).toBe(404)
  })

  it('requires a POST', async () => {
    const h = fakeContext()
    apply(h.ctx, {})
    const headers = await proofHeaderOf(h)
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('GET', undefined, headers), res)
    await flush()
    expect(state.status).toBe(405)
  })

  it('refuses a local call without the host proof (R2 判据：不用 Cookie/Host/Origin/端口)', async () => {
    const h = fakeContext({ session: ALICE })
    apply(h.ctx, {})
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('POST', '{"app_id":"my-notes"}', { origin: 'http://127.0.0.1:41234' }), res)
    await flush()
    expect(state.status).toBe(401)
    expect(state.body).toContain('proof_required')
  })

  it('serves a request that carries a valid proof even with a foreign Origin (证明取代 Origin/Host 围栏)', async () => {
    const h = fakeContext({ session: ALICE })
    apply(h.ctx, {})
    const headers = await proofHeaderOf(h)
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('POST', '{"app_id":"my-notes"}', { ...headers, origin: 'https://evil.example', host: 'evil.example' }), res)
    await flush()
    // 授权只认证明头：Origin/Host 既不放行也不阻断（零端口形态下它们根本不存在）。
    expect(state.status).toBe(200)
  })

  it('rejects an unauthenticated open (未登录 ⇒ 401 AUTH_REQUIRED)', async () => {
    const h = fakeContext({ session: null })
    apply(h.ctx, {})
    const headers = await proofHeaderOf(h)
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('POST', '{"app_id":"my-notes"}', headers), res)
    await flush()
    expect(state.status).toBe(401)
    expect(state.body).toContain('AUTH_REQUIRED')
  })

  it('rejects an invalid app_id', async () => {
    const h = fakeContext({ session: ALICE })
    apply(h.ctx, {})
    for (const body of ['{}', '{"app_id":"Bad Id"}', '{"app_id":""}', 'not json']) {
      const headers = await proofHeaderOf(h)
      const { res, state } = fakeResponse()
      routeOf(h).handler(fakeRequest('POST', body, headers), res)
      await flush()
      expect(state.status, body).toBe(400)
    }
  })

  it('fails the proof bootstrap closed when the connection fence is absent', async () => {
    const h = fakeContext({ session: ALICE, fence: null })
    apply(h.ctx, {})
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('GET', undefined, {}, `${WASM_APPS_LOCAL_PREFIX}/host-proof`), res)
    await flush()
    expect(state.status).toBe(503)
    expect(state.body).toContain('browser session proof unavailable')
  })

  it('returns the internal URL and notifies the client face', async () => {
    const h = fakeContext({ session: ALICE })
    apply(h.ctx, {})
    const headers = await proofHeaderOf(h)
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('POST', '{"app_id":"my-notes"}', headers), res)
    await flush()
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body)).toEqual({ window: 'opened', app_id: 'my-notes', url: 'picoaide-app://my-notes/' })
    expect(h.emitted).toContainEqual({
      event: WASM_APP_OPEN_EVENT,
      payload: { app_id: 'my-notes', url: 'picoaide-app://my-notes/' },
    })
  })

  it('serves the channel read route with the injected scheme and fails closed without one (§16.1 CHN-4)', async () => {
    const h = fakeContext({ session: ALICE })
    apply(h.ctx, { appOriginScheme: 'example-harness-app', deepLinkScheme: 'example-harness', productName: 'Example Harness' })
    const headers = await proofHeaderOf(h)
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('GET', undefined, headers, WASM_APP_CHANNEL_ROUTE), res)
    await flush()
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body)).toEqual({
      appOriginScheme: 'example-harness-app',
      deepLinkScheme: 'example-harness',
      productName: 'Example Harness',
    })

    const bare = fakeContext({ session: ALICE })
    apply(bare.ctx, {})
    const bareHeaders = await proofHeaderOf(bare)
    const second = fakeResponse()
    routeOf(bare).handler(fakeRequest('GET', undefined, bareHeaders, WASM_APP_CHANNEL_ROUTE), second.res)
    await flush()
    expect(second.state.status).toBe(503)
  })

  it('queues a deep link while signed out and opens it after login (§7.6 / §23.2 N8)', async () => {
    const h = fakeContext({ session: null })
    apply(h.ctx, { deepLinkScheme: 'picoaide' })
    h.fireDeepLink('picoaide://app/my-notes?path=/notes')
    await flush()
    expect(h.emitted.filter(entry => entry.event === WASM_APP_OPEN_EVENT)).toHaveLength(0)
    h.setSession(ALICE)
    h.fireSessionChanged()
    await flush()
    expect(h.emitted).toContainEqual({
      event: WASM_APP_OPEN_EVENT,
      payload: { app_id: 'my-notes', url: 'picoaide-app://my-notes/notes' },
    })
  })

  it('broadcasts the foreign-channel event instead of silently dropping it (J13)', async () => {
    const h = fakeContext({ session: ALICE })
    apply(h.ctx, { deepLinkScheme: 'acmeai' })
    // 另一家企业客户端发来的链接（scheme 不同，形状合法）。
    h.fireDeepLink('other-brand://app/my-notes')
    await flush()
    expect(h.emitted).toContainEqual({
      event: WASM_APP_DEEP_LINK_FOREIGN_EVENT,
      payload: { app_id: 'my-notes', scheme: 'other-brand' },
    })
    // 不打开任何窗口（跨渠道深链不工作属预期）。
    expect(h.emitted.filter(entry => entry.event === WASM_APP_OPEN_EVENT)).toHaveLength(0)
    // 反向对照：**畸形**链接（不是 app 深链形状）不触发该事件，只记 warn。
    h.fireDeepLink('other-brand://auth?token=t')
    await flush()
    expect(h.emitted.filter(entry => entry.event === WASM_APP_DEEP_LINK_FOREIGN_EVENT)).toHaveLength(1)
  })

  it('drops a deep link whose path tries to escape the app origin (§23.2 N8 净化)', async () => {
    const h = fakeContext({ session: ALICE })
    apply(h.ctx, { deepLinkScheme: 'picoaide' })
    h.fireDeepLink('picoaide://app/my-notes?path=//evil.example/x')
    await flush()
    expect(h.emitted).toContainEqual({
      event: WASM_APP_OPEN_EVENT,
      payload: { app_id: 'my-notes', url: 'picoaide-app://my-notes/' },
    })
  })

  it('passes the platform open counts through unchanged (J7b：不做投影、不补默认)', async () => {
    const h = fakeContext({
      session: ALICE,
      fetch: async () => new Response(JSON.stringify({
        version: '1.2.3',
        changed: false,
        opens: { today: { pv: 7, uv: 3 } },
      }), { status: 200 }),
    })
    apply(h.ctx, {})
    const headers = await proofHeaderOf(h)
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('POST', '{"app_id":"my-notes"}', headers), res)
    await flush()
    expect(JSON.parse(state.body)).toEqual({
      window: 'opened',
      app_id: 'my-notes',
      url: 'picoaide-app://my-notes/',
      opens: { today: { pv: 7, uv: 3 } },
    })
  })

  it('omits opens entirely when the platform did not report it (缺省不得渲染成 0)', async () => {
    const h = fakeContext({
      session: ALICE,
      fetch: async () => new Response(JSON.stringify({ version: '1.2.3', changed: false }), { status: 200 }),
    })
    apply(h.ctx, {})
    const headers = await proofHeaderOf(h)
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('POST', '{"app_id":"my-notes"}', headers), res)
    await flush()
    const body = JSON.parse(state.body) as Record<string, unknown>
    expect(body.window).toBe('opened')
    expect(body).not.toHaveProperty('opens')
    // 反向对照（防假绿）：上面那条"有计数就透传"的用例证明这个字段确实会出现在响应里。
  })

  it('hard-gates a new window when the platform cannot confirm the version (§5.1b)', async () => {
    const h = fakeContext({ session: ALICE, fetch: async () => { throw new Error('network down') } })
    apply(h.ctx, {})
    const headers = await proofHeaderOf(h)
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('POST', '{"app_id":"my-notes"}', headers), res)
    await flush()
    expect(state.status).toBe(502)
    expect(state.body).toContain('OPEN_CHECK_FAILED')
  })

  it('keeps opening while the platform has no open endpoint yet (滚动升级窗口)', async () => {
    const h = fakeContext({ session: ALICE, fetch: async () => new Response('{}', { status: 404 }) })
    apply(h.ctx, {})
    const headers = await proofHeaderOf(h)
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('POST', '{"app_id":"my-notes"}', headers), res)
    await flush()
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body).window).toBe('opened')
  })

  /**
   * 生命周期反应（§7.2 / §16.1「触发源 = open 端点响应」；**R2-L2-2**）。
   *
   * 平台说应用**没了**（404 软删/未登记、410 下架）⇒ 关掉还开着的窗口 + 丢缓存；
   * **冻结不算"没了"**（只读快照，§19 Q3）⇒ 窗口与缓存都留着并给可辨文案；
   * 401/403 是**可恢复**的拒绝（登录过期/白名单）⇒ 窗必须留着，否则一次登录过期
   * 会表现成"应用被卸载"。
   * 变异：把关闭分支去掉 ⇒ ②/③b 红；把闸门放宽到所有 denied ⇒ ④ 红；
   * 把 `reason` 分流拆掉（退回只看 status）⇒ ③ 红。
   */
  it('平台报 410/404-not-found ⇒ 关窗 + 清缓存；冻结与 401 拒绝 ⇒ 窗留着（R2-L2-2 / P2-3）', async () => {
    const closed: string[] = []
    const opened: string[] = []
    const windowAdapter = {
      createAppWindow: (options: { appId: string }) => {
        opened.push(options.appId)
        return { id: options.appId }
      },
      focusAppWindow: () => {},
      closeAppWindow: (handle: { id: string }) => { closed.push(handle.id) },
      setAspectRatio: () => {},
    }
    let answer: () => Response = () => new Response(JSON.stringify({ version: '1.0.0', changed: false }), { status: 200 })
    const h = fakeContext({
      session: ALICE,
      windowAdapter,
      fetch: async (url) => (url.endsWith('/open') ? answer() : new Response('{}', { status: 200 })),
    })
    // `userDataDir` 是**配置**（窗口几何/缓存的落点），窗口适配器是**服务**（适配器注入）：
    // 两者都在，`windows` 才存在（缺一 ⇒ 退回"只发事件"的纯 Node 形态）。
    const userDataDir = mkdtempSync(join(tmpdir(), 'pico-wasm-apps-lifecycle-'))
    apply(h.ctx as unknown as Parameters<typeof apply>[0], { userDataDir })
    const proof = await proofHeaderOf(h)

    /**
     * 等 handler **真的写完响应**（而不是"睡 20ms 赌它写完了"）。
     *
     * 为什么必须改成轮询（2026-09-21）：建窗路径带**真实文件 I/O**（窗口记忆写
     * `<userData>/wasm-apps-windows.json`），原先固定 `setTimeout(20)` 在门禁并发
     * （`yarn check` 同时跑 4 个包）下会先于写盘完成 ⇒ 偶发拿到空响应 = 纯负载 flake，
     * 与产品行为无关。
     *
     * ⚠️ 等待条件必须是**本次调用真正要断言的那个可观察量**（`state.status`/`state.body`），
     * 不能拿一个"第一次调用之后就一直为真"的代理条件（作者第一版等的是"窗口记忆文件
     * 存在"——第一次 open 之后它恒真，于是第二次 open 直接返回空响应，把 flake 换成了
     * 必现的 SyntaxError）。上限 2s：真坏时花满预算并**抛错**（不是静默返回空状态）。
     */
    const openOnce = async (): Promise<{ status: number, body: string }> => {
      const { res, state } = fakeResponse()
      routeOf(h).handler(
        fakeRequest('POST', '{"app_id":"demo"}', proof),
        res,
      )
      for (let i = 0; i < 200; i++) {
        if (state.status !== 0 && state.body !== '') return state
        await flush()
        await new Promise(resolve => { setTimeout(resolve, 10) })
      }
      throw new Error('open 路由在 2s 内没有写完响应（status/body 仍为空）')
    }

    // ① 正常打开（窗口建立）—— 并断言 `window:'opened'`（新建）。
    // 变异：把 `window` 改回 `windows.has(target) ? 'focused' : 'opened'` ⇒ 这里变红
    // （真实适配器下新建完成时 has() 必为 true ⇒ 永远报"已聚焦"）。
    const first = await openOnce()
    expect(first.status).toBe(200)
    expect(JSON.parse(first.body)).toMatchObject({ window: 'opened' })
    expect(opened).toEqual(['demo'])

    // ①b 再打开同一个应用 ⇒ 聚焦已有窗口（`focused`）。
    const again = await openOnce()
    expect(JSON.parse(again.body)).toMatchObject({ window: 'focused' })
    expect(opened).toEqual(['demo'])

    // ② 平台说"已下架"（410）⇒ 关窗。
    answer = () => new Response(JSON.stringify({ error: { code: 'APP_GONE', reason: 'app_disabled' } }), { status: 410 })
    const gone = await openOnce()
    expect(gone.status).toBe(410)
    expect(closed).toEqual(['demo'])
    // 缓存也被丢掉：同一个应用再次打开时**不再**信旧版本（knownVersions 已清）。
    expect(h.warnings.join('\n')).toContain('closing its window and dropping its cache')

    // ③ 冻结（404 + `details.reason=app_frozen`）**不**关窗、**不**清缓存（P2-3，
    //    主控 2026-09-20）：冻结是只读快照（数据保留），平台把它与"软删/未登记"
    //    放在同一个 404 + `NOT_FOUND` 里，唯一区分凭据是 `reason`。只看 status 会
    //    把"被管理员停用"做成"应用消失"，§19 Q3 的冻结文案永远不可达。
    //    变异：把 `gate.reason === 'app_frozen'` 的判断拆掉（退回只看 status）⇒ 本节红。
    answer = () => new Response(JSON.stringify({ version: '1.0.0', changed: false }), { status: 200 })
    expect((await openOnce()).status).toBe(200)
    const closedBeforeFrozen = [...closed]
    answer = () => new Response(JSON.stringify({
      error: { code: 'NOT_FOUND', message: '应用已被管理员停用（冻结）', details: { reason: 'app_frozen' } },
    }), { status: 404 })
    const frozen = await openOnce()
    expect(frozen.status).toBe(404)
    expect(closed).toEqual(closedBeforeFrozen)
    expect(h.warnings.join('\n')).toContain('keeping its window and cache')
    // 平台的码**一律加 `PLATFORM_` 前缀**（跨端契约，见 PLATFORM_REFUSAL_CODE_PREFIX）：
    // 原样透传会与**本机**证明闸的码撞名（两层都有 `proof_required`），客户端只能
    // 把平台拒绝显示成"本页面无法证明自己属于这个客户端窗口"（2026-09-20 真机现场）。
    // 原码在 `platform_code` 里保留（诊断不受前缀影响）；`reason` 是"冻结 vs 不存在"
    // 的唯一区分凭据，必须一起给出去。
    expect(JSON.parse(frozen.body)).toMatchObject({
      error: {
        code: `${PLATFORM_REFUSAL_CODE_PREFIX}NOT_FOUND`,
        platform_code: 'NOT_FOUND',
        platform_reason: 'app_frozen',
        message: '应用已被管理员停用',
      },
    })
    // 冻结之后窗口仍在 ⇒ 平台恢复正常后再点一次是 **focused**（不是"关掉又新建"）。
    const openedBeforeFrozen = [...opened]
    answer = () => new Response(JSON.stringify({ version: '1.0.0', changed: false }), { status: 200 })
    const afterFrozen = await openOnce()
    expect(JSON.parse(afterFrozen.body)).toMatchObject({ window: 'focused' })
    expect(opened).toEqual(openedBeforeFrozen)

    // ③b `app_not_found`（同码同状态，只有 reason 不同）⇒ 仍然关窗 + 清缓存。
    answer = () => new Response(JSON.stringify({
      error: { code: 'NOT_FOUND', message: '应用不存在', details: { reason: 'app_not_found' } },
    }), { status: 404 })
    const missing = await openOnce()
    expect(missing.status).toBe(404)
    expect(closed).toEqual([...closedBeforeFrozen, 'demo'])
    expect(JSON.parse(missing.body)).toMatchObject({
      error: { code: `${PLATFORM_REFUSAL_CODE_PREFIX}NOT_FOUND`, platform_reason: 'app_not_found' },
    })

    // ④ 401（登录过期）**不**关窗：这是可恢复的拒绝。
    answer = () => new Response(JSON.stringify({ version: '1.0.0', changed: false }), { status: 200 })
    expect((await openOnce()).status).toBe(200)
    answer = () => new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED' } }), { status: 401 })
    const before = [...closed]
    expect((await openOnce()).status).toBe(401)
    expect(closed).toEqual(before)
  })

  /**
   * **应用窗口的分区 = 协议 handler 注册的分区**（2026-09-20 审计 P1-2）。
   *
   * 这是"应用窗口跑在按用户分区上"的**能力判据**（不是字符串断言）：同一个插件实例
   * 里，①`handleInSession` 收到的分区（协议 handler + 权限守卫 + 请求闸门都注册在
   * 那个 session 上）与 ②`createAppWindow` 收到的 `partition` 必须**逐字相等**；
   * ③切账号后新窗口必须落到新用户的分区，且该分区也确实被注册过。
   *
   * 变异：把 `partition: currentPartition` 从 `createWasmAppsWindows` 的选项里删掉
   * （窗口退回默认 session）⇒ 本条在类型层就编不过；改成常量 ⇒ ③ 红；让
   * `createAppWindow` 忽略 `partition` ⇒ 真机探针红（`temp/fix-appwin-r2/`）。
   */
  it('建窗用的分区与协议 handler 注册的分区逐字相同，并随账号切换', async () => {
    const created: Array<Record<string, unknown>> = []
    const windowAdapter = {
      createAppWindow: (options: Record<string, unknown>) => { created.push(options); return { id: created.length } },
      focusAppWindow: () => {},
      closeAppWindow: () => {},
      setAspectRatio: () => {},
    }
    let answer: () => Response = () => new Response(JSON.stringify({ version: '1.0.0', changed: false }), { status: 200 })
    const h = fakeContext({
      session: ALICE,
      windowAdapter,
      fetch: async url => (url.endsWith('/open') ? answer() : new Response('{}', { status: 200 })),
    })
    apply(h.ctx as unknown as Parameters<typeof apply>[0], { userDataDir: mkdtempSync(join(tmpdir(), 'pico-wasm-apps-partition-')) })
    const proof = await proofHeaderOf(h)

    const openOnce = async (appId: string): Promise<void> => {
      const { res } = fakeResponse()
      routeOf(h).handler(fakeRequest('POST', JSON.stringify({ app_id: appId }), proof), res)
      await flush()
      await new Promise(resolve => { setTimeout(resolve, 20) })
    }

    await openOnce('my-notes')
    expect(h.partitions).toEqual([ALICE_PARTITION])
    expect(created[0]?.partition).toBe(ALICE_PARTITION)
    // 窗口与协议注册必须同源：不同 = 应用页 `ERR_UNKNOWN_URL_SCHEME` 空白窗口。
    expect(created[0]?.partition).toBe(h.partitions[h.partitions.length - 1])

    // 切账号（登出再登录成 bob）⇒ 新分区被注册，新窗口跟着走。
    h.setSession({ serverURL: ALICE.serverURL, token: 'tok2', username: 'bob' })
    h.fireSessionChanged()
    answer = () => new Response(JSON.stringify({ version: '1.0.0', changed: false }), { status: 200 })
    await openOnce('other-app')
    const bobPartition = `persist:agent-browser-bob@${serverPartitionHash(ALICE.serverURL)!}`
    expect(h.partitions).toContain(bobPartition)
    expect(created[1]?.partition).toBe(bobPartition)

    // 自定义分区覆盖（config.partition）同样贯穿两处。
    const createdCustom: Array<Record<string, unknown>> = []
    const h2 = fakeContext({
      session: ALICE,
      windowAdapter: {
        createAppWindow: (options: Record<string, unknown>) => { createdCustom.push(options); return { id: 1 } },
        focusAppWindow: () => {},
        closeAppWindow: () => {},
        setAspectRatio: () => {},
      },
    })
    apply(h2.ctx as unknown as Parameters<typeof apply>[0], {
      userDataDir: mkdtempSync(join(tmpdir(), 'pico-wasm-apps-partition-')),
      partition: 'persist:agent-browser-custom',
    })
    const proof2 = await proofHeaderOf(h2)
    const r2 = fakeResponse()
    routeOf(h2).handler(fakeRequest('POST', '{"app_id":"my-notes"}', proof2), r2.res)
    await flush()
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(h2.partitions).toContain('persist:agent-browser-custom')
    expect(createdCustom[0]?.partition).toBe('persist:agent-browser-custom')
  })

  /**
   * **平台**的 401 `proof_required` 不得与本机证明闸的 401 撞名（2026-09-20 真机 P0）。
   *
   * 两层用的是**同一个字面码**：本机闸回 `{"error":"proof_required"}`（字符串形态，
   * 宿主 host-request.ts），平台拒绝经 open 路由回的是 `PLATFORM_PROOF_REQUIRED`
   * （对象形态 + `platform_code`）。客户端据此把"本机凭据被拒"与"服务端拒绝了这次
   * 打开"分流 —— 混在一起时后者的文案说成"没有发出任何请求"，而请求其实发了。
   *
   * 变异：把 `code: `${PLATFORM_REFUSAL_CODE_PREFIX}${gate.code…}`` 改回 `gate.code`
   * ⇒ 本条必红（而客户端那侧的 reason 用例也会红）。
   */
  it('平台的 401 proof_required 带 PLATFORM_ 前缀，与本机证明闸的 401 可区分', async () => {
    const h = fakeContext({
      session: ALICE,
      fetch: async url => (url.endsWith('/open')
        ? new Response(JSON.stringify({ error: { code: 'proof_required', message: '缺少持有性证明' } }), { status: 401 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 })),
    })
    apply(h.ctx, {})
    const headers = await proofHeaderOf(h)
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('POST', '{"app_id":"my-notes"}', headers), res)
    await flush()
    expect(state.status).toBe(401)
    expect(JSON.parse(state.body)).toMatchObject({
      error: { code: 'PLATFORM_PROOF_REQUIRED', platform_code: 'proof_required' },
    })
    // 反向对照：**不带令牌**时是本机证明闸的 401（字符串形态），两者永不混淆。
    const noProof = fakeResponse()
    routeOf(h).handler(fakeRequest('POST', '{"app_id":"my-notes"}'), noProof.res)
    await flush()
    expect(noProof.state.status).toBe(401)
    expect(JSON.parse(noProof.state.body)).toEqual({ error: 'proof_required' })
  })

  it('fails closed when the protocol could not be registered', async () => {
    const h = fakeContext({ adapter: null, session: ALICE })
    apply(h.ctx, {})
    const headers = await proofHeaderOf(h)
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('POST', '{"app_id":"my-notes"}', headers), res)
    await flush()
    expect(state.status).toBe(503)
    expect(state.body).toContain('PROTOCOL_UNAVAILABLE')
  })

  it('builds the app URL from the parsed app id only', () => {
    expect(wasmAppUrl('picoaide-app', 'my-notes')).toBe('picoaide-app://my-notes/')
    // 渠道参数化（§7.8/§10）：URL 由注入的 scheme 决定，不写死官方值。
    expect(wasmAppUrl('example-harness-app', 'my-notes', '/notes?page=2')).toBe('example-harness-app://my-notes/notes?page=2')
  })
})

describe('package shape', () => {
  it('keeps the plugin body free of Electron and of a default export', () => {
    const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/from 'electron'/u)
    expect(source).not.toMatch(/require\('electron'\)/u)
    expect(source).not.toMatch(/export default/u)
    // 协议特权注册必须在 Electron 适配器里（桌面壳在 app.whenReady 之前调用它）。
    const adapter = readFileSync(fileURLToPath(new URL('./electron-adapter.ts', import.meta.url)), 'utf8')
    // 判据是"electron 的这几个面只在这个模块里 import"，不是"import 列表逐字等于…"：
    // 后者会随适配器长大而过期，而它守的语义与 import 顺序/成员个数无关。
    // 注意 `^`（多行）：文件头的模块注释里也写着这句 import，不加锚点会匹配到注释。
    const electronImport = /^import \{([^}]*)\} from 'electron'/mu.exec(adapter)?.[1] ?? ''
    for (const name of ['protocol', 'session', 'safeStorage']) {
      expect(electronImport, `${name} 必须由 electron-adapter 直接 import`).toContain(name)
    }
    expect(adapter).toContain('registerSchemesAsPrivileged')
    // 应用窗口载体在同一个 Electron seam 里（桌面壳 `provide` 它，见 desktop 的
    // `provideWasmAppsWindows`）。
    expect(adapter).toContain('createRealElectronWindowAdapter')
  })
})

/**
 * 应用 AI 桥的**装配面**判据（§21.6 判据 1/2/3 的宿主侧一半）。
 *
 * 这里连的是**真的** `handleAiChat` + **真的** `createAiChatAuthorization`（文件形态）
 * + 真的本机授权路由；唯一的替身是"跑一轮模型"的执行面（它属于客户端 AI loop，桌面侧
 * 由 `packages/host/desktop/src/app-ai-runner.ts` 提供并用真 agent-loop 覆盖）。
 */
describe('应用 AI 桥（§21）：授权路由 → 闸门 → SSE，且不转发平台', () => {
  const routeOf = (h: ReturnType<typeof fakeContext>) => {
    const route = h.routes.find(entry => entry.path === WASM_APPS_LOCAL_PREFIX)
    expect(route, 'local surface must be registered').toBeDefined()
    return route!
  }

  const proofHeaderOf = async (h: ReturnType<typeof fakeContext>): Promise<Record<string, string>> => {
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('GET', undefined, {}, `${WASM_APPS_LOCAL_PREFIX}/host-proof`), res)
    await flush()
    expect(state.status).toBe(200)
    return { 'x-pico-host-proof': (JSON.parse(state.body) as { proof: string }).proof }
  }

  const consent = async (
    h: ReturnType<typeof fakeContext>,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<{ status: number, body: string }> => {
    const { res, state } = fakeResponse()
    routeOf(h).handler(
      fakeRequest('POST', JSON.stringify(body), headers, WASM_APP_AI_CONSENT_ROUTE),
      res,
    )
    // 授权记录带真实文件 I/O（原子写）⇒ 只冲微任务不够。
    await flush()
    await new Promise(resolve => { setTimeout(resolve, 20) })
    return state
  }

  /** 一次应用页的 AI 调用（走协议 handler，不是本机路由）。 */
  const chat = async (
    h: ReturnType<typeof fakeContext>,
    body: unknown,
  ): Promise<Response> => {
    expect(h.handler, 'the app protocol handler must be registered').toBeDefined()
    return await h.handler!(new Request(`picoaide-app://demo${AI_CHAT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }))
  }

  /** 记录调用次数的假执行面。 */
  const runnerOf = () => {
    const calls: Array<{ sessionId: string, appId: string, messages: readonly unknown[] }> = []
    return {
      calls,
      runner: {
        async run(input: { sessionId: string, appId: string, messages: readonly unknown[], onDelta: (text: string) => void }) {
          calls.push({ sessionId: input.sessionId, appId: input.appId, messages: input.messages })
          input.onDelta('你')
          input.onDelta('好')
          return { content: '你好' }
        },
      },
    }
  }

  it('未授权 ⇒ 403 app_ai_denied，且一次模型调用都不发生（零 token）', async () => {
    const { calls, runner } = runnerOf()
    const h = fakeContext({ session: ALICE, aiRunner: runner })
    apply(h.ctx, {})
    const response = await chat(h, { messages: [{ role: 'user', content: 'hi' }] })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'app_ai_denied' } })
    // 变异：去掉授权闸门（先跑模型再查授权）⇒ 这里变成 1。
    expect(calls).toHaveLength(0)
  })

  it('端到端：本机授权路由 "允许" ⇒ 应用页调用立刻 200 SSE；"撤销" ⇒ 回到 403', async () => {
    const { calls, runner } = runnerOf()
    const h = fakeContext({ session: ALICE, aiRunner: runner })
    apply(h.ctx, {})
    const proof = await proofHeaderOf(h)

    // ① 允许（渲染层的"允许"按钮走的就是这一条）。
    const granted = await consent(h, proof, { app_id: 'demo', granted: true })
    expect(granted.status).toBe(200)
    expect(JSON.parse(granted.body)).toEqual({ app_id: 'demo', granted: true })

    // ② 应用页调用：SSE 增量按序 + done 收尾。
    const served = await chat(h, { messages: [{ role: 'user', content: 'hi' }], stream: true })
    expect(served.status).toBe(200)
    const text = await served.text()
    expect(text).toContain('event: delta\ndata: {"delta":"你"}')
    expect(text).toContain('event: delta\ndata: {"delta":"好"}')
    expect(text).toContain('event: done')
    expect(calls).toHaveLength(1)
    // 隐藏会话 id 由闸门给出（不是应用可控的输入），且带**账号作用域** ——
    // 换账号必须落到另一个隐藏会话上（R13-GB）。
    expect(calls[0]?.sessionId).toBe(`app:demo#alice@${serverPartitionHash(ALICE.serverURL)!}`)

    // ③ 撤销（设置/面板里的那个出口）⇒ 下一次调用 403。
    const revoked = await consent(h, proof, { app_id: 'demo', granted: false })
    expect(revoked.status).toBe(200)
    const refused = await chat(h, { messages: [{ role: 'user', content: 'again' }] })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: { code: 'app_ai_denied' } })
    expect(calls).toHaveLength(1)
  })

  it('授权落盘（给了 userDataDir）：允许写进宿主文件，重新装配的实例仍然放行（判据 3）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-wasm-apps-consent-route-'))
    const { calls, runner } = runnerOf()

    // ① 第一个实例：经授权路由"允许"。
    const first = fakeContext({ session: ALICE, aiRunner: runner })
    apply(first.ctx, { userDataDir: dir })
    const granted = await consent(first, await proofHeaderOf(first), { app_id: 'demo', granted: true })
    expect(granted.status).toBe(200)
    const file = join(dir, AI_CONSENT_FILE_NAME)
    expect(existsSync(file), '授权必须落到宿主私有文件（内存态重启即忘）').toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('demo')

    // ② 第二个实例（同一目录 = 重启后的进程）：不经过任何"允许"，直接调用就该放行。
    const second = fakeContext({ session: ALICE, aiRunner: runner })
    apply(second.ctx, { userDataDir: dir })
    const served = await chat(second, { messages: [{ role: 'user', content: 'hi' }], stream: false })
    expect(served.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it('授权按用户维度隔离：另一个用户名下的授权不生效', async () => {
    const { calls, runner } = runnerOf()
    const h = fakeContext({ session: ALICE, aiRunner: runner })
    apply(h.ctx, {})
    const proof = await proofHeaderOf(h)
    await consent(h, proof, { app_id: 'demo', granted: true })

    h.setSession({ serverURL: ALICE.serverURL, token: 'tok2', username: 'bob' })
    h.fireSessionChanged()
    const response = await chat(h, { messages: [{ role: 'user', content: 'hi' }] })
    expect(response.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('隐藏会话按 (账号 × 服务端 × 应用) 分域：换账号拿到的是**另一个**会话 id', async () => {
    const { calls, runner } = runnerOf()
    const h = fakeContext({ session: ALICE, aiRunner: runner })
    apply(h.ctx, {})
    const proof = await proofHeaderOf(h)
    await consent(h, proof, { app_id: 'demo', granted: true })

    const alice = await chat(h, { messages: [{ role: 'user', content: 'alice-1' }], stream: false })
    expect(alice.status).toBe(200)

    // ② 直接换账号（不登出）：bob 也授权过同一个应用。
    h.setSession({ serverURL: ALICE.serverURL, token: 'tok2', username: 'bob' })
    h.fireSessionChanged()
    await consent(h, proof, { app_id: 'demo', granted: true })
    const bob = await chat(h, { messages: [{ role: 'user', content: 'bob-1' }], stream: false })
    expect(bob.status).toBe(200)

    expect(calls).toHaveLength(2)
    const aliceId = `app:demo#alice@${serverPartitionHash(ALICE.serverURL)!}`
    const bobId = `app:demo#bob@${serverPartitionHash(ALICE.serverURL)!}`
    expect(calls[0]?.sessionId).toBe(aliceId)
    // 变异：把作用域退回"只有应用"（`app:<app_id>`）⇒ 两行逐字相同，本断言红。
    expect(calls[1]?.sessionId).toBe(bobId)
    expect(calls[1]?.sessionId).not.toBe(calls[0]?.sessionId)

    // ③ 同名账号换服务端（测试/正式并存）同样是另一个作用域。
    h.setSession({ serverURL: 'https://second.example.com', token: 'tok3', username: 'bob' })
    h.fireSessionChanged()
    await consent(h, proof, { app_id: 'demo', granted: true })
    const elsewhere = await chat(h, { messages: [{ role: 'user', content: 'bob-2' }], stream: false })
    expect(elsewhere.status).toBe(200)
    expect(calls[2]?.sessionId).toBe(`app:demo#bob@${serverPartitionHash('https://second.example.com')!}`)
    expect(calls[2]?.sessionId).not.toBe(bobId)
  })

  it('授权路由要求持有性证明 / 已登录 / 合法 app_id / 布尔 granted', async () => {
    const h = fakeContext({ session: ALICE })
    apply(h.ctx, {})

    const noProof = await consent(h, {}, { app_id: 'demo', granted: true })
    expect(noProof.status).toBe(401)
    expect(JSON.parse(noProof.body)).toMatchObject({ error: 'proof_required' })

    const proof = await proofHeaderOf(h)
    const badApp = await consent(h, proof, { app_id: 'Not Valid', granted: true })
    expect(badApp.status).toBe(400)
    const badFlag = await consent(h, proof, { app_id: 'demo', granted: 'yes' })
    expect(badFlag.status).toBe(400)

    h.setSession(null)
    h.fireSessionChanged()
    const signedOut = await consent(h, proof, { app_id: 'demo', granted: true })
    expect(signedOut.status).toBe(401)
  })

  it('没有执行面 ⇒ 503 app_ai_unavailable（不静默给空答案）', async () => {
    const h = fakeContext({ session: ALICE })
    apply(h.ctx, {})
    const proof = await proofHeaderOf(h)
    await consent(h, proof, { app_id: 'demo', granted: true })
    const response = await chat(h, { messages: [{ role: 'user', content: 'hi' }] })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'app_ai_unavailable' } })
  })

  it('保留路径不转发平台：AI 调用与授权路由都不产生任何平台出站', async () => {
    const { runner } = runnerOf()
    const fetched: string[] = []
    const h = fakeContext({
      session: ALICE,
      aiRunner: runner,
      fetch: async (url) => {
        fetched.push(url)
        return new Response(JSON.stringify({ version: '1.0.0', changed: false }), { status: 200 })
      },
    })
    apply(h.ctx, {})
    const proof = await proofHeaderOf(h)
    await consent(h, proof, { app_id: 'demo', granted: true })
    const served = await chat(h, { messages: [{ role: 'user', content: 'hi' }], stream: false })
    expect(served.status).toBe(200)
    // 变异：把 `__picoaide/ai/chat` 落进"普通应用请求"分支 ⇒ 这里会多出一条平台 URL。
    expect(fetched).toEqual([])
  })
})

/**
 * 三处「设计已冻结、实现没接通」的接线（2026-09-21 审计 B1/B2/B3）。
 *
 * 这一组刻意走**生产装配路径**（`apply` → 本机打开路由 → 协议 handler），而不是
 * 直接调 `windows.open` / `handler(...)`：三处缺口的共同形态就是"子模块有实现、
 * 生产调用点为零"，只测子模块的用例正是掩盖它们的东西。
 */
describe('接线缺口回归（B1 surface / B2 窗口几何 / B3 内容缓存）', () => {
  const routeOf = (h: ReturnType<typeof fakeContext>) => {
    const route = h.routes.find(entry => entry.path === WASM_APPS_LOCAL_PREFIX)
    expect(route, 'open route must be registered').toBeDefined()
    return route!
  }
  const proofOf = async (h: ReturnType<typeof fakeContext>): Promise<string> => {
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('GET', undefined, {}, `${WASM_APPS_LOCAL_PREFIX}/host-proof`), res)
    for (let i = 0; i < 200 && state.status === 0; i++) await flush()
    expect(state.status).toBe(200)
    return (JSON.parse(state.body) as { proof: string }).proof
  }
  /** 走本机打开路由并把响应读全（handler 是 fire-and-forget）。 */
  const openViaRoute = async (
    h: ReturnType<typeof fakeContext>,
    body: string,
    proof: string,
  ): Promise<{ status: number, body: string }> => {
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('POST', body, { 'x-pico-host-proof': proof }), res)
    for (let i = 0; i < 300; i++) {
      if (state.status !== 0 && state.body !== '') return state
      await flush()
      await new Promise(resolve => { setTimeout(resolve, 5) })
    }
    throw new Error('open 路由在预算内没有写完响应')
  }
  /** 等一个"调用另一个异步面"的可观察结果（深链/协议 handler 都是 fire-and-forget）。 */
  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 300; i++) {
      if (check()) return
      await flush()
      await new Promise(resolve => { setTimeout(resolve, 5) })
    }
    throw new Error('等待的条件在预算内没有成立')
  }

  const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 }

  /** 建窗替身：记录几何，报 webContents（surface 注册要用）。 */
  function windowStub(): {
    created: Array<Record<string, unknown>>
    adapter: Record<string, unknown>
  } {
    const created: Array<Record<string, unknown>> = []
    return {
      created,
      adapter: {
        createAppWindow: (options: Record<string, unknown>) => { created.push(options); return { id: created.length } },
        focusAppWindow: () => {},
        closeAppWindow: () => {},
        setAspectRatio: () => {},
        webContentsId: (handle: { id: number }) => handle.id,
        webContents: (handle: { id: number }) => ({ wc: handle.id }),
        workArea: () => WORK_AREA,
      },
    }
  }

  const openAnswer = (version: string): Response =>
    new Response(JSON.stringify({ version, changed: true }), { status: 200 })

  /**
   * B1：应用窗口注册为 browser runtime 的 surface（§16.1 的 `kind:'app'`）。
   *
   * 变异：删掉 `windows.ts` 的 `registerSurface` 调用 ⇒ "建窗即注册" 红；
   * 删掉 `ctx.inject(['browserSurface'])` 那段 ⇒ "晚到补注册" 红。
   */
  it('B1 建窗即注册 surface（appId/scheme/webContents/分区 scope），登出注销', async () => {
    const registered: Array<{ id: number, appId: string, appScheme: string, webContents?: unknown, scope?: string }> = []
    const unregistered: number[] = []
    const surfaceRegistry = {
      registerApp: (input: { id: number, appId: string, appScheme: string, webContents?: unknown, scope?: string }) => {
        registered.push(input)
        return { id: input.id }
      },
      unregister: (id: number) => { unregistered.push(id) },
    }
    const { created, adapter } = windowStub()
    const h = fakeContext({
      session: ALICE,
      windowAdapter: adapter,
      browserSurface: surfaceRegistry,
      fetch: async url => (url.endsWith('/open') ? openAnswer('2.0.0') : new Response('{}', { status: 200 })),
    })
    apply(h.ctx, { userDataDir: mkdtempSync(join(tmpdir(), 'pico-wasm-apps-surface-')), appOriginScheme: 'acme-app' })
    const proof = await proofOf(h)

    const opened = await openViaRoute(h, '{"app_id":"demo"}', proof)
    expect(opened.status).toBe(200)
    expect(created).toHaveLength(1)
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({
      appId: 'demo',
      appScheme: 'acme-app',
      scope: ALICE_PARTITION,
      webContents: { wc: 1 },
    })

    // 登出 ⇒ closeAll ⇒ surface 注销（否则模型还能寻址到一个已经销毁的 webContents）。
    h.setSession(null)
    h.fireSessionChanged()
    expect(unregistered).toEqual([registered[0]?.id])
  })

  it('B1 browser 行晚到（profile 里本插件在前）⇒ 补注册已经开着的窗口', async () => {
    const registered: Array<{ id: number, appId: string }> = []
    const { adapter } = windowStub()
    const h = fakeContext({
      session: ALICE,
      windowAdapter: adapter,
      // 刻意不给 browserSurface：模拟 browser 行还没加载。
      fetch: async url => (url.endsWith('/open') ? openAnswer('2.0.0') : new Response('{}', { status: 200 })),
    })
    apply(h.ctx, { userDataDir: mkdtempSync(join(tmpdir(), 'pico-wasm-apps-surface-late-')), appOriginScheme: 'acme-app' })
    const proof = await proofOf(h)
    expect((await openViaRoute(h, '{"app_id":"demo"}', proof)).status).toBe(200)
    expect(registered).toHaveLength(0)

    // 注册表现在才出现（browser 插件 apply）。
    h.provideBrowserSurface({
      registerApp: (input: { id: number, appId: string }) => { registered.push(input); return { id: input.id } },
      unregister: () => {},
    })
    expect(registered.map(entry => entry.appId)).toEqual(['demo'])
  })

  /**
   * B2：作者声明的窗口几何（`window.ratio/width/height`）进建窗路径。
   *
   * 变异：把打开路由里的 `parseDeclaredWindowGeometry` 结果丢掉（回退成
   * `windows.open(target, path)` 的老调用）⇒ 本组三条全红。
   */
  it('B2 请求体里的 window（客户端目录行那份）决定首次尺寸与比例锁', async () => {
    const { created, adapter } = windowStub()
    const h = fakeContext({
      session: ALICE,
      windowAdapter: adapter,
      fetch: async url => (url.endsWith('/open') ? openAnswer('2.0.0') : new Response('{}', { status: 200 })),
    })
    apply(h.ctx, { userDataDir: mkdtempSync(join(tmpdir(), 'pico-wasm-apps-geometry-')), appOriginScheme: 'acme-app' })
    const proof = await proofOf(h)

    const opened = await openViaRoute(h, '{"app_id":"demo","window":{"ratio":1.7778,"width":1600}}', proof)
    expect(opened.status).toBe(200)
    expect(created[0]).toMatchObject({ width: 1600, height: 900 })
    expect(created[0]?.ratio).toBeCloseTo(1.7778, 4)
    // 详情页显示的「窗口比例 16:9」与真实窗口必须一致：比例锁就是这条断言的行为面。
    expect(created[0]?.minimumWidth).toBeGreaterThan(0)
  })

  it('B2 请求体没带 window ⇒ 目录兜底（与详情页读到的是同一份服务端数据）', async () => {
    const { created, adapter } = windowStub()
    const catalogUrls: string[] = []
    const h = fakeContext({
      session: ALICE,
      windowAdapter: adapter,
      fetch: async (url) => {
        if (url.endsWith('/open')) return openAnswer('2.0.0')
        if (url.endsWith('/catalog')) {
          catalogUrls.push(url)
          return new Response(JSON.stringify({ apps: [{ app_id: 'demo', title: 'Demo', window: { ratio: 2, width: 1000 } }] }), { status: 200 })
        }
        return new Response('{}', { status: 200 })
      },
    })
    apply(h.ctx, { userDataDir: mkdtempSync(join(tmpdir(), 'pico-wasm-apps-geometry-cat-')), appOriginScheme: 'acme-app' })
    const proof = await proofOf(h)

    expect((await openViaRoute(h, '{"app_id":"demo"}', proof)).status).toBe(200)
    expect(created[0]).toMatchObject({ width: 1000, height: 500 })
    expect(created[0]?.ratio).toBe(2)
    expect(catalogUrls).toEqual([`${ALICE.serverURL}/api/client/v2/apps/wasm/catalog`])

    // 第二个应用复用**同一份**目录（同一个会话只拉一次），不再发第二次请求。
    expect((await openViaRoute(h, '{"app_id":"demo","path":"/notes"}', proof)).status).toBe(200)
    expect(catalogUrls).toHaveLength(1)
  })

  it('B2 深链打开（没有请求体那条路径）同样拿目录兜底', async () => {
    const { created, adapter } = windowStub()
    const h = fakeContext({
      session: ALICE,
      windowAdapter: adapter,
      fetch: async (url) => {
        // R4-B-16：深链同样过 F16 闸门 ⇒ 平台的 /open 端点必须答（拿不到版本时硬闸门
        // 会拒绝新建窗口，这正是本组用例之外新增的行为）。
        if (url.endsWith('/open')) return openAnswer('2.0.0')
        if (url.endsWith('/catalog')) {
          return new Response(JSON.stringify({ apps: [{ app_id: 'demo', window: { ratio: 4 / 3 } }] }), { status: 200 })
        }
        return new Response('{}', { status: 200 })
      },
    })
    apply(h.ctx, { userDataDir: mkdtempSync(join(tmpdir(), 'pico-wasm-apps-geometry-link-')), appOriginScheme: 'acme-app', deepLinkScheme: 'acmeai' })
    h.fireDeepLink('acmeai://app/demo?path=%2Fnotes')
    await until(() => created.length === 1)
    expect(created[0]).toMatchObject({ width: 1280, height: 960 })
    expect(created[0]?.ratio).toBeCloseTo(4 / 3, 6)
  })

  /**
   * B3：静态资源缓存的**读/写**半环（F11）。
   *
   * 走生产链路：本机打开路由把平台版本写进 `knownVersions` → 协议 handler 用
   * `(scope, app_id, version, path)` 读/写缓存。第二次取同一个静态资源必须**零出网**。
   *
   * 变异：把 `index.ts` 里传给 handler 的 `cache`/`cacheScope`/`cacheVersion` 任一项
   * 删掉 ⇒ 第二条断言（第二次仍出网）红。
   */
  it('B3 打开校验的版本进缓存键：第二次取同一静态资源零出网', async () => {
    const { adapter } = windowStub()
    const userDataDir = mkdtempSync(join(tmpdir(), 'pico-wasm-apps-cache-wire-'))
    let requestCalls = 0
    const h = fakeContext({
      session: ALICE,
      windowAdapter: adapter,
      fetch: async (url) => {
        if (url.endsWith('/open')) return openAnswer('3.1.4')
        // 目录兜底与内容请求**分账**：只有 `/request` 才是"应用内容回源"。
        if (url.endsWith('/catalog')) return new Response(JSON.stringify({ apps: [] }), { status: 200 })
        requestCalls += 1
        return new Response(JSON.stringify({
          status: 200,
          headers: { 'Content-Type': 'application/javascript' },
          body: Buffer.from(`payload-${String(requestCalls)}`).toString('base64'),
          truncated: false,
        }), { status: 200 })
      },
    })
    apply(h.ctx, { userDataDir, appOriginScheme: 'acme-app' })
    const proof = await proofOf(h)
    expect((await openViaRoute(h, '{"app_id":"demo"}', proof)).status).toBe(200)

    const handler = h.handler
    expect(handler, '协议 handler 必须已注册').toBeDefined()
    const first = await handler!(new Request('acme-app://demo/app.js', { headers: { accept: '*/*' } }))
    expect(await first.text()).toBe('payload-1')
    expect(requestCalls).toBe(1)

    const second = await handler!(new Request('acme-app://demo/app.js', { headers: { accept: '*/*' } }))
    expect(await second.text()).toBe('payload-1')
    // 缓存命中 ⇒ 一次都不回源（F11 的性能承诺）。
    expect(requestCalls).toBe(1)
    expect(second.headers.get('x-picoaide-app-version')).toBe('3.1.4')
    // 落盘位置在 `<userData>/wasm-apps-cache`（诊断/清理口径）。
    expect(existsSync(join(userDataDir, 'wasm-apps-cache'))).toBe(true)

    // 会话切换（登出）⇒ 缓存整根清掉（§7.5「会话切换清空」）。
    h.setSession(null)
    h.fireSessionChanged()
    await until(() => !existsSync(join(userDataDir, 'wasm-apps-cache', String(process.pid))))
    expect(existsSync(join(userDataDir, 'wasm-apps-cache'))).toBe(true)
  })
})
