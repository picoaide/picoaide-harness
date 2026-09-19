/**
 * 装配面回归：协议/分区注册、会话跟随、深链严格性、本机打开路由的持有性证明。
 *
 * 这一层刻意不 import electron —— 上面的 import 本身就在证明"插件主体可在纯
 * Node 下加载"（profile 冒烟与单测都走这条路）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  apply,
  wasmAppUrl,
  WASM_APP_CHANNEL_ROUTE,
  WASM_APP_DEEP_LINK_FOREIGN_EVENT,
  WASM_APP_OPEN_EVENT,
  WASM_APP_OPEN_ROUTE,
  WASM_APPS_LOCAL_PREFIX,
  WASM_APPS_HOST_ADAPTER_SERVICE,
  type Config,
} from './index.ts'
import type { AppSchemeRequestHandler, WasmAppsHostAdapter } from './electron-adapter.ts'
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
} = {}) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const emitted: Array<{ event: string, payload: unknown }> = []
  const warnings: string[] = []
  const routes: Array<{ kind: string, path: string, handler: (req: IncomingMessage, res: ServerResponse) => void }> = []
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
  ])

  const ctx = {
    get: (name: string) => (name === 'webServer' ? webServerService : services.get(name)),
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
    expect(h.partitions).toEqual(['persist:agent-browser-alice'])
  })

  it('follows the session change (setPartition semantics) without duplicating registrations', () => {
    const h = fakeContext({ restored: true })
    apply(h.ctx, {})
    expect(h.partitions).toEqual(['persist:agent-browser-anonymous'])
    h.setSession(ALICE)
    h.fireSessionChanged()
    // 新分区被补注册，旧分区保留（已挂载的页面不受影响）。
    expect(h.partitions).toEqual(['persist:agent-browser-anonymous', 'persist:agent-browser-alice'])
    // 同一分区重复同步不重复注册（Electron 对同一 scheme 二次 handle 会抛）。
    h.fireSessionChanged()
    h.fireSessionChanged()
    expect(h.partitions).toEqual(['persist:agent-browser-anonymous', 'persist:agent-browser-alice'])
    h.setSession(null)
    h.fireSessionChanged()
    expect(h.partitions).toEqual(['persist:agent-browser-anonymous', 'persist:agent-browser-alice'])
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
  it('opens the app for a valid channel-scheme link', () => {
    const h = fakeContext({ session: ALICE })
    apply(h.ctx, { deepLinkScheme: 'acmeai' })
    h.fireDeepLink('acmeai://app/my-notes')
    expect(h.emitted).toContainEqual({
      event: WASM_APP_OPEN_EVENT,
      payload: { app_id: 'my-notes', url: 'picoaide-app://my-notes/' },
    })
  })

  it('drops unknown schemes/hosts without a fallback and logs it', () => {
    const h = fakeContext({ session: ALICE })
    apply(h.ctx, { deepLinkScheme: 'acmeai' })
    h.fireDeepLink('acmeai://auth?token=t')
    h.fireDeepLink('picoaide://app/my-notes')
    h.fireDeepLink('acmeai://app/my-notes/extra')
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
    apply(h.ctx, { appOriginScheme: 'gentech-harness-app', deepLinkScheme: 'gentech-harness', productName: 'Gentech Harness' })
    const headers = await proofHeaderOf(h)
    const { res, state } = fakeResponse()
    routeOf(h).handler(fakeRequest('GET', undefined, headers, WASM_APP_CHANNEL_ROUTE), res)
    await flush()
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body)).toEqual({
      appOriginScheme: 'gentech-harness-app',
      deepLinkScheme: 'gentech-harness',
      productName: 'Gentech Harness',
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
    expect(wasmAppUrl('gentech-harness-app', 'my-notes', '/notes?page=2')).toBe('gentech-harness-app://my-notes/notes?page=2')
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
    expect(adapter).toContain("import { protocol, safeStorage, session } from 'electron'")
    expect(adapter).toContain('registerSchemesAsPrivileged')
  })
})
