/**
 * Electron 适配器回归：协议特权位与两次注册（默认 session + 分区）。
 *
 * `electron` 用 `vi.mock` 替身注入：本模块的静态 `import { protocol, session }
 * from 'electron'` 在纯 Node 下解析到的是 Electron 包的 CJS 入口（无命名导出），
 * 所以这个 spec 是"适配器形状"唯一的离线判据。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const registerSchemesAsPrivileged = vi.fn()
const defaultHandle = vi.fn()
const partitionHandle = vi.fn()
const fromPartition = vi.fn(() => ({ protocol: { handle: partitionHandle } }))
const defaultSessionFetch = vi.fn(async () => new Response('ok', { status: 200 }))

/**
 * 替身 `BrowserWindow`（`electron-adapter.spec.ts` 的第二个被测对象 =
 * `createRealElectronWindowAdapter`）。
 *
 * 为什么用替身而不是真 Electron：这里要钉的是"原生动作有没有按契约发生"
 * （几何进了构造参数、导航闸门按 app origin 判、标题不可被页面改写、关窗后
 * `isAlive` 变假），不是 Electron 自己的行为。真正的"窗口真的开了"由真机判据
 * （CDP 目标列表出现 `picoaide-app://<app_id>/`）承担。
 */
class FakeWebContents {
  static nextId = 100
  readonly id = (FakeWebContents.nextId += 1)
  url = ''
  readonly listeners = new Map<string, Array<(...args: never[]) => void>>()
  windowOpenHandler: ((details: unknown) => unknown) | undefined
  /** 下一次 `loadURL` 的失败（模拟被顶掉/加载错误）。 */
  nextLoadFailure: unknown

  on(event: string, listener: (...args: never[]) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }

  getURL(): string {
    return this.url
  }

  setWindowOpenHandler(handler: (details: unknown) => unknown): void {
    this.windowOpenHandler = handler
  }

  failNextLoad(cause: unknown): void {
    this.nextLoadFailure = cause
  }

  emit(event: string, ...args: never[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

class FakeBrowserWindow {
  static readonly created: FakeBrowserWindow[] = []
  readonly options: Record<string, unknown>
  readonly webContents = new FakeWebContents()
  readonly listeners = new Map<string, Array<(...args: never[]) => void>>()
  readonly loaded: string[] = []
  readonly aspectRatios: Array<{ ratio: number, extraSize: unknown }> = []
  destroyed = false
  minimized = false
  visible = true
  focused = 0
  menuBarHidden = false

  constructor(options: Record<string, unknown>) {
    this.options = options
    FakeBrowserWindow.created.push(this)
  }

  on(event: string, listener: (...args: never[]) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }

  emit(event: string, ...args: never[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  setMenuBarVisibility(visible: boolean): void {
    this.menuBarHidden = !visible
  }

  loadURL(url: string): Promise<void> {
    this.loaded.push(url)
    this.webContents.url = url
    const failure = this.webContents.nextLoadFailure
    this.webContents.nextLoadFailure = undefined
    if (failure !== undefined) return Promise.reject(failure)
    return Promise.resolve()
  }

  focus(): void {
    this.focused += 1
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isMinimized(): boolean {
    return this.minimized
  }

  isVisible(): boolean {
    return this.visible
  }

  restore(): void {
    this.minimized = false
  }

  show(): void {
    this.visible = true
  }

  close(): void {
    this.destroyed = true
    this.emit('closed')
  }

  setAspectRatio(ratio: number, extraSize: unknown): void {
    this.aspectRatios.push({ ratio, extraSize })
  }
}

const getCursorScreenPoint = vi.fn(() => ({ x: 5, y: 6 }))
const getDisplayNearestPoint = vi.fn(() => ({ workArea: { x: 1, y: 2, width: 1600, height: 900 } }))

/**
 * 替身 `net.request`（ClientRequest）：`createPlatformFetch` 的被测对象。
 *
 * 记录 method/url/session/头/体，并按脚本回一个响应（或错误）。
 */
interface FakeClientRequest {
  method: string
  url: string
  session: unknown
  redirect: unknown
  headers: Record<string, string>
  body: Buffer[]
  aborted: boolean
  ended: boolean
  /** 是否在 `redirect` 事件里同步调过 `followRedirect()`（真实 Electron 的契约）。 */
  followed: boolean
  listeners: Map<string, Array<(...args: never[]) => void>>
  setHeader(name: string, value: string): void
  write(chunk: Buffer | string): void
  end(): void
  abort(): void
  followRedirect(): void
  on(event: string, listener: (...args: never[]) => void): void
  emit(event: string, ...args: never[]): void
}

/** 下一次 `net.request` 的行为脚本。 */
let netScript: {
  status?: number
  statusMessage?: string
  headers?: Record<string, string | string[]>
  chunks?: Buffer[]
  failWith?: Error
  respond?: boolean
  /**
   * 先回一个 3xx（`redirect` 事件），再按真实 Electron 的语义走：
   * 监听器里同步调了 `followRedirect()` ⇒ 继续跑这次请求的响应；没调 ⇒
   * `error: Redirect was cancelled`（2026-09-20 探针 `temp/fix-appwin-r2/probe-nav.mjs`
   * 在 Electron 43 上实测的形态）。
   */
  redirectTo?: string
  redirectStatus?: number
} = {}

const netRequests: FakeClientRequest[] = []

function makeClientRequest(options: { method: string, url: string, session: unknown, redirect: unknown }): FakeClientRequest {
  const request: FakeClientRequest = {
    method: options.method,
    url: options.url,
    session: options.session,
    redirect: options.redirect,
    headers: {},
    body: [],
    aborted: false,
    ended: false,
    followed: false,
    listeners: new Map(),
    setHeader(name, value) { request.headers[name] = value },
    write(chunk) { request.body.push(Buffer.from(chunk)) },
    on(event, listener) {
      const list = request.listeners.get(event) ?? []
      list.push(listener)
      request.listeners.set(event, list)
    },
    emit(event, ...args) {
      for (const listener of request.listeners.get(event) ?? []) listener(...args)
    },
    abort() {
      request.aborted = true
      request.emit('abort')
    },
    followRedirect() { request.followed = true },
    end() {
      request.ended = true
      if (netScript.failWith !== undefined) {
        queueMicrotask(() => { request.emit('error', netScript.failWith as never) })
        return
      }
      if (netScript.respond === false) return
      queueMicrotask(() => {
        if (netScript.redirectTo !== undefined) {
          request.emit('redirect', (netScript.redirectStatus ?? 302) as never, 'GET' as never, netScript.redirectTo as never)
          if (!request.followed) {
            request.emit('error', new Error('Redirect was cancelled') as never)
            return
          }
        }
        const response = {
          statusCode: netScript.status ?? 200,
          statusMessage: netScript.statusMessage ?? 'OK',
          headers: netScript.headers ?? { 'content-type': ['application/json'] },
          listeners: new Map<string, Array<(...args: never[]) => void>>(),
          on(event: string, listener: (...args: never[]) => void) {
            const list = this.listeners.get(event) ?? []
            list.push(listener)
            this.listeners.set(event, list)
          },
          emit(event: string, ...args: never[]) {
            for (const listener of this.listeners.get(event) ?? []) listener(...args)
          },
        }
        request.emit('response', response as never)
        for (const chunk of netScript.chunks ?? [Buffer.from('{"ok":true}')]) response.emit('data', chunk as never)
        response.emit('end' as never)
      })
    },
  }
  netRequests.push(request)
  return request
}

const netRequest = vi.fn((options: { method: string, url: string, session: unknown, redirect: unknown }) => makeClientRequest(options))

vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged },
  session: {
    defaultSession: { protocol: { handle: defaultHandle }, fetch: defaultSessionFetch },
    fromPartition,
  },
  BrowserWindow: FakeBrowserWindow,
  screen: { getCursorScreenPoint, getDisplayNearestPoint },
  net: { request: netRequest },
}))

/**
 * 浏览器包的 session 守卫（R2-L2-5）：**适配器的转发**是本节要证的接线 ——
 * scheme 传错（例如传成深链 scheme）或漏传 partition 时，真机探针与浏览器包自己的
 * 单测都不会红（探针在探针内部重实现了一遍闸门）。
 */
const guardEnsureSession = vi.fn()
const guardInstallGate = vi.fn()
vi.mock('@picoaide/dsh-browser/guard', () => ({
  ensureSessionGuard: guardEnsureSession,
  installAppSchemeRequestGate: guardInstallGate,
}))

const { DEFAULT_APP_SCHEME } = await import('./app-protocol.ts')
const { createRealElectronAdapter, createRealElectronWindowAdapter, registerAppScheme } = await import('./electron-adapter.ts')
// 动态 import（不是静态）：静态 import 会在上面的替身声明**之前**求值 mock 工厂。
const { session } = await import('electron')

beforeEach(() => {
  registerSchemesAsPrivileged.mockClear()
  defaultHandle.mockClear()
  partitionHandle.mockClear()
  fromPartition.mockClear()
  defaultSessionFetch.mockClear()
  guardEnsureSession.mockClear()
  guardInstallGate.mockClear()
  netRequest.mockClear()
  netRequests.length = 0
  netScript = {}
})

describe('registerAppScheme', () => {
  it('registers the frozen privilege set exactly once per scheme (§16.1 渠道参数化)', () => {
    registerAppScheme('schema-probe-a-app')
    registerAppScheme('schema-probe-a-app')
    expect(registerSchemesAsPrivileged).toHaveBeenCalledTimes(1)
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([{
      scheme: 'schema-probe-a-app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: true,
        codeCache: true,
      },
    }])
  })

  it('refuses an invalid or reserved scheme instead of registering it (fail-loud)', () => {
    for (const bad of ['', 'A-app', '-app', 'app_', 'https', 'file', 'javascript', 'x'.repeat(33)]) {
      expect(() => registerAppScheme(bad), bad).toThrow()
    }
    expect(registerSchemesAsPrivileged).not.toHaveBeenCalled()
  })

  it('registers a different channel scheme independently (per-scheme idempotency)', () => {
    registerAppScheme('schema-probe-b-app')
    registerSchemesAsPrivileged.mockClear()
    registerAppScheme('schema-probe-b-app')
    registerAppScheme('schema-probe-c-app')
    expect(registerSchemesAsPrivileged).toHaveBeenCalledTimes(1)
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({ scheme: 'schema-probe-c-app' }),
    ])
  })
})

describe('createRealElectronAdapter', () => {
  it('registers the handler on the default session and on a named partition', () => {
    const adapter = createRealElectronAdapter()
    const handler = (): Response => new Response('x')
    adapter.handleAppScheme(DEFAULT_APP_SCHEME, handler)
    expect(defaultHandle).toHaveBeenCalledWith(DEFAULT_APP_SCHEME, handler)

    adapter.handleInSession('schema-probe-d-app', 'persist:agent-browser-alice', handler)
    expect(fromPartition).toHaveBeenCalledWith('persist:agent-browser-alice')
    expect(partitionHandle).toHaveBeenCalledWith('schema-probe-d-app', handler)
  })

  it('把权限守卫与请求闸门转发到正确的 session（默认 / 分区），带 scheme 与判据（R2-L2-5）', () => {
    const adapter = createRealElectronAdapter()
    const isAppSurface = (id: number | undefined): boolean => id === 7

    // 默认 session：两个守卫都不带 partition。
    adapter.ensureSessionGuard?.()
    expect(guardEnsureSession).toHaveBeenCalledTimes(1)
    expect(guardEnsureSession.mock.calls[0]?.[0]).toBe(session.defaultSession)

    adapter.installAppSchemeRequestGate?.('schema-probe-e-app', isAppSurface)
    expect(guardInstallGate).toHaveBeenCalledTimes(1)
    const [defaultTarget, defaultOptions] = guardInstallGate.mock.calls[0] as unknown as [unknown, { scheme: string, isAppSurfaceWebContents: unknown }]
    expect(defaultTarget).toBe(session.defaultSession)
    // scheme 与判据都要**原样**转发：这里是"传成深链 scheme / 判据写反"的唯一判据点。
    expect(defaultOptions.scheme).toBe('schema-probe-e-app')
    expect(defaultOptions.isAppSurfaceWebContents).toBe(isAppSurface)

    // 分区：target 换成该分区，参数不变。
    adapter.ensureSessionGuard?.('persist:agent-browser-alice')
    adapter.installAppSchemeRequestGate?.('schema-probe-e-app', isAppSurface, 'persist:agent-browser-alice')
    expect(fromPartition).toHaveBeenCalledWith('persist:agent-browser-alice')
    expect(guardEnsureSession).toHaveBeenLastCalledWith(expect.objectContaining({ protocol: { handle: partitionHandle } }))
    const [partitionTarget, partitionOptions] = guardInstallGate.mock.calls[1] as unknown as [unknown, { scheme: string, isAppSurfaceWebContents: unknown }]
    expect(partitionTarget).toEqual(expect.objectContaining({ protocol: { handle: partitionHandle } }))
    expect(partitionOptions.scheme).toBe('schema-probe-e-app')
    expect(partitionOptions.isAppSurfaceWebContents).toBe(isAppSurface)
  })

  /**
   * 出站**必须走 `net.request`**（2026-09-20 真机实测的 CORS 预检缺陷）。
   *
   * 判据的核心不是"实现细节"，而是**Origin 头能不能真的出去**：平台对非幂等请求强制
   * 校验 `Origin == <app scheme>://<app_id>`（`appserver.checkClientOrigin`），而
   * `session.fetch` 只要带 Origin 就先发 CORS 预检（平台没有 OPTIONS 路由 ⇒ 404 ⇒
   * `net::ERR_FAILED`），现象是"窗口开了、应用页永远说连不上服务端"。
   */
  it('平台出站走 net.request 并原样带上 Origin（session.fetch 的 CORS 预检会打死应用页）', async () => {
    const adapter = createRealElectronAdapter()
    const response = await adapter.fetch!('https://harness.example.com/api/client/v2/apps/wasm/demo/request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'picoaide-app://demo',
        Authorization: 'Bearer token',
        'X-Pico-App-Proof': 'proof',
      },
      body: JSON.stringify({ hello: 'world' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    // 出站是 net.request，且**没有**碰 session.fetch（那条路会发预检）。
    expect(netRequest).toHaveBeenCalledTimes(1)
    expect(defaultSessionFetch).not.toHaveBeenCalled()
    const request = netRequests[0]!
    expect(request.url).toBe('https://harness.example.com/api/client/v2/apps/wasm/demo/request')
    expect(request.method).toBe('POST')
    expect(request.session).toBe(session.defaultSession)
    // `manual`：**不让 Chromium 自己跟跳** —— 每一次重定向都要过同源判据（P2-2）。
    expect(request.redirect).toBe('manual')
    // Origin 与自定义头逐字送达 —— 这条是本次缺陷的回归判据。
    // （`Headers` 迭代把名字小写化，HTTP 头名本就大小写不敏感。）
    expect(request.headers['origin']).toBe('picoaide-app://demo')
    expect(request.headers['authorization']).toBe('Bearer token')
    expect(request.headers['x-pico-app-proof']).toBe('proof')
    expect(Buffer.concat(request.body).toString('utf8')).toBe(JSON.stringify({ hello: 'world' }))
    expect(request.ended).toBe(true)
  })

  it('丢掉逐跳/传输层头（体已解压，content-encoding/length 原样带进去会截断响应）', async () => {
    const adapter = createRealElectronAdapter()
    netScript = {
      status: 200,
      headers: {
        'content-type': ['application/json'],
        'content-encoding': ['gzip'],
        'content-length': ['999999'],
        'transfer-encoding': ['chunked'],
        'x-request-id': ['abc'],
      },
      chunks: [Buffer.from('{"ok":true}')],
    }
    const response = await adapter.fetch!('https://harness.example.com/x', { method: 'GET' })
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('transfer-encoding')).toBeNull()
    expect(response.headers.get('x-request-id')).toBe('abc')
    expect(await response.text()).toBe('{"ok":true}')
  })

  it('abort 信号真的中止出站请求（应用请求预算到点必须停，不能挂着）', async () => {
    const adapter = createRealElectronAdapter()
    netScript = { respond: false }
    const controller = new AbortController()
    const pending = adapter.fetch!('https://harness.example.com/x', { method: 'POST', body: '{}', signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(netRequests[0]?.aborted).toBe(true)
  })

  it('传输层错误转成 rejection（而不是永远挂起的 promise）', async () => {
    const adapter = createRealElectronAdapter()
    netScript = { failWith: new Error('net::ERR_CONNECTION_REFUSED') }
    await expect(adapter.fetch!('https://harness.example.com/x', { method: 'GET' })).rejects.toThrow('ERR_CONNECTION_REFUSED')
  })

  /**
   * P2-1：**响应构造失败也必须 settle**（2026-09-20 审计实测 status 700 时 3 s 不
   * settle，随后 abort 也救不回）。
   *
   * 触发面：`new Response(body, {status})` 对 ∉[200,599] 抛 RangeError，对含非
   * 0x20–0x7E 的 statusText 抛 TypeError —— 原实现先置 `settled = true` 再构造，
   * 异常路径于是被 `fail()` 的早退吞掉，promise 永久 pending，调用方的 AbortSignal
   * 也已被摘掉（"一次失败"被放大成"永不返回"）。
   *
   * 变异：把 `settled = true` 挪回 `resolve` 之前 ⇒ 本用例两个断言都变红（挂起）。
   */
  it('响应无法构造成 Response 时必定 reject（status 700 / 非法 statusText），不得挂起', async () => {
    const adapter = createRealElectronAdapter()

    netScript = { status: 700, statusMessage: 'Weird', headers: { 'content-type': ['text/plain'] }, chunks: [Buffer.from('hi')] }
    await expect(adapter.fetch!('https://harness.example.com/x', { method: 'GET' })).rejects.toThrow(/status/i)

    // statusText 里的换行是非法的（Response 构造期 TypeError）。
    netScript = { status: 200, statusMessage: 'OK\nX-Injected: 1', headers: { 'content-type': ['text/plain'] }, chunks: [Buffer.from('hi')] }
    await expect(adapter.fetch!('https://harness.example.com/x', { method: 'GET' })).rejects.toThrow()

    // 且不是靠"永不 settle"骗过断言：两条都必须在预算内给出结论（Promise.race 兜底）。
    netScript = { status: 700 }
    const outcome = await Promise.race([
      adapter.fetch!('https://harness.example.com/x', { method: 'GET' }).then(() => 'resolved', () => 'rejected'),
      new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 1000)),
    ])
    expect(outcome).toBe('rejected')
  })

  /**
   * P2-2：跨源 302 **不带凭据出去**（fail-closed）。
   *
   * 这条出站通道每次都带 `Authorization: Bearer <员工令牌>` 与 `X-Pico-App-Proof`，
   * 平台 API 没有任何合法的跨源重定向用途。审计实测旧实现（`redirect: 'follow'`）会把
   * 两件凭据原样送到新 host（`net.request` 与 `session.fetch` 两代都如此）。
   *
   * 判据打在**能力**上：①promise reject；②`followRedirect()` 一次都没调（=不会发出
   * 第二个请求）；③同源 302 仍照旧跟随（正对照，防止"一刀切成谁都不跟"）。
   *
   * 变异：把 `redirect: 'manual'` 改回 `'follow'`（或删掉 `sameOriginRedirect` 判定）
   * ⇒ 第一段断言变红。
   */
  it('跨源 302 中止并报错（不发第二个请求）；同源 302 仍然跟随', async () => {
    const adapter = createRealElectronAdapter()

    // 跨源：初始 https://harness.example.com，Location 指向别的 host。
    netScript = { redirectTo: 'https://evil.example/steal' }
    await expect(adapter.fetch!('https://harness.example.com/x', {
      method: 'POST',
      headers: { Authorization: 'Bearer SECRET-TOKEN', 'X-Pico-App-Proof': 'PROOF-JTI' },
      body: '{}',
    })).rejects.toThrow(/cross-origin redirect/)
    expect(netRequests[0]?.followed).toBe(false)
    expect(netRequests[0]?.aborted).toBe(true)

    // 相对 Location（同源）⇒ 跟随，并且拿得到最终响应。
    netRequests.length = 0
    netScript = { redirectTo: '/moved', status: 200, chunks: [Buffer.from('FINAL')] }
    const followed = await adapter.fetch!('https://harness.example.com/x', { method: 'GET' })
    expect(netRequests[0]?.followed).toBe(true)
    expect(followed.status).toBe(200)

    // 换端口 = 换 origin（`http://127.0.0.1:1` → `http://127.0.0.1:2`）⇒ 同样拒绝。
    netRequests.length = 0
    netScript = { redirectTo: 'http://127.0.0.1:2/landed' }
    await expect(adapter.fetch!('http://127.0.0.1:1/x', { method: 'GET' })).rejects.toThrow(/cross-origin redirect/)
    expect(netRequests[0]?.followed).toBe(false)
  })

  it('不支持的 body 形态一律拒绝（悄悄丢 body 会让平台回一个看不懂的 400）', async () => {
    const adapter = createRealElectronAdapter()
    netScript = {}
    await expect(adapter.fetch!('https://harness.example.com/x', {
      method: 'POST',
      body: new ReadableStream() as unknown as BodyInit,
    })).rejects.toThrow(/unsupported request body/)
  })
})

/**
 * 应用窗口载体（W-C 独立窗口）的**原生动作面**。
 *
 * 这一组用例存在的理由：`windows.ts` 的几何/生命周期逻辑早已有纯逻辑判据，但
 * "这些语义有没有接到真实 Electron 上"在 2026-09-20 之前**零判据** ——
 * `WASM_APPS_WINDOW_ADAPTER_SERVICE` 没有任何 provider，`createRealElectronWindowAdapter`
 * 根本不存在。契约对、现象空（点"打开"回 `opened`，屏幕上什么都没有）就是从这里来的。
 */
describe('createRealElectronWindowAdapter', () => {
  const APP_SCHEME = 'schema-probe-app'
  /** 判据里用的按用户分区（形状与 `browserPartitionFor` 一致）。 */
  const PARTITION = 'persist:agent-browser-alice'
  /** 宿主诊断出口的收集器（拒绝导航/窗口的文案是**唯一**的可见出口）。 */
  let warned: string[] = []

  beforeEach(() => {
    FakeBrowserWindow.created.length = 0
    getCursorScreenPoint.mockClear()
    getDisplayNearestPoint.mockClear()
    fromPartition.mockClear()
    warned = []
  })

  /** 建一个窗口并返回（替身）实例与句柄。 */
  function createProbeWindow(adapter: ReturnType<typeof createRealElectronWindowAdapter>, appId = 'demo') {
    const handle = adapter.createAppWindow({
      appId,
      url: `${APP_SCHEME}://${appId}/`,
      title: '演示应用 · PicoAide Harness',
      partition: PARTITION,
      width: 1280,
      height: 720,
      x: 10,
      y: 20,
      minimumWidth: 320,
      minimumHeight: 240,
    })
    const win = FakeBrowserWindow.created[FakeBrowserWindow.created.length - 1]!
    return { handle, win }
  }

  /**
   * P1-2（2026-09-20 审计）：应用窗口必须落在**插件显式给出的按用户分区**上，
   * 不是默认 session —— §7.2:240 / R2S-8 冻结的是"复用内置浏览器的按用户分区"。
   *
   * 变异：把 `partition` 从 `webPreferences` 里去掉（或写死 `undefined`）⇒ 本用例红；
   * 把 `ensureSessionGuard` 装回默认 session ⇒ 第二条 spec 红。
   */
  it('窗口落在插件给的分区上（webPreferences.partition + 同一个 session 实例）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    const { win } = createProbeWindow(adapter)

    expect(win.options.webPreferences).toMatchObject({ partition: PARTITION })
    // 解析分区（而不是拿默认 session）：`fromPartition` 是唯一入口。
    expect(fromPartition).toHaveBeenCalledWith(PARTITION)
    expect(win.options.webPreferences).toMatchObject({
      session: expect.objectContaining({ protocol: { handle: partitionHandle } }),
    })
    expect(win.options.webPreferences).not.toMatchObject({ session: session.defaultSession })
  })

  it('分区非法/缺席一律建窗期抛（静默退回默认 session 正是 P1-2 的形态）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    for (const bad of ['', undefined, null]) {
      expect(() => adapter.createAppWindow({
        appId: 'demo',
        url: `${APP_SCHEME}://demo/`,
        title: 'x',
        partition: bad as unknown as string,
        width: 1280,
        height: 720,
        x: 0,
        y: 0,
        minimumWidth: 320,
        minimumHeight: 240,
      }), String(bad)).toThrow(/partition/)
    }
    expect(FakeBrowserWindow.created).toHaveLength(0)
  })

  it('把几何/标题原样交给 BrowserWindow，并用应用 origin 加载（§7.2/§16.1）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    const { win } = createProbeWindow(adapter)

    expect(win.options).toMatchObject({
      width: 1280,
      height: 720,
      x: 10,
      y: 20,
      minWidth: 320,
      minHeight: 240,
      title: '演示应用 · PicoAide Harness',
      show: true,
      autoHideMenuBar: true,
    })
    // 应用页面**必须**是应用 origin：加载 http(s) 会把应用当作普通网页（且请求
    // 闸门会拒掉它的应用 scheme 子资源）。
    expect(win.loaded).toEqual([`${APP_SCHEME}://demo/`])
    expect(win.menuBarHidden).toBe(true)
    // 沙箱：应用 HTML 是不可信内容，不得拿到 Node。
    expect(win.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    })
  })

  it('标题不可被页面改写（防伪装），且句柄能报出 webContents id（请求闸门白名单要用）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    const { handle, win } = createProbeWindow(adapter)

    const event = { preventDefault: vi.fn(), defaultPrevented: false }
    win.emit('page-title-updated', event as never, '登录' as never, true as never)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)

    expect(adapter.webContentsId?.(handle)).toBe(win.webContents.id)
    expect(adapter.isAlive?.(handle)).toBe(true)
  })

  it('关窗后 isAlive 变假（否则第二次 open 会回 focused 而屏幕上没有窗口）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    const { handle, win } = createProbeWindow(adapter)

    adapter.closeAppWindow(handle)
    expect(win.destroyed).toBe(true)
    expect(adapter.isAlive?.(handle)).toBe(false)
    expect(adapter.webContentsId?.(handle)).toBeUndefined()
    // 已销毁的句柄上再操作必须是 no-op（不能抛，也不能"复活"一个死窗口）。
    expect(() => adapter.focusAppWindow(handle, `${APP_SCHEME}://demo/next`)).not.toThrow()
    expect(() => adapter.setAspectRatio(handle, 1.5, { width: 0, height: 0 })).not.toThrow()
    expect(() => adapter.closeAppWindow(handle)).not.toThrow()
  })

  it('聚焦已有窗口：导航到目标路径 + 把最小化的窗口带回来（软闸门不能"点了没反应"）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    const { handle, win } = createProbeWindow(adapter)
    win.minimized = true
    win.visible = false

    adapter.focusAppWindow(handle, `${APP_SCHEME}://demo/settings`)
    expect(win.loaded).toEqual([`${APP_SCHEME}://demo/`, `${APP_SCHEME}://demo/settings`])
    expect(win.minimized).toBe(false)
    expect(win.visible).toBe(true)
    expect(win.focused).toBeGreaterThan(0)

    // 同一个 URL 不重复加载（避免每次点"打开"都把应用重置回首页）。
    const before = win.loaded.length
    adapter.focusAppWindow(handle, `${APP_SCHEME}://demo/settings`)
    expect(win.loaded).toHaveLength(before)
  })

  it('导航闸门只放行同 app origin；跨 app 与 http(s) 一律拒（§7.2 N7）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    const { handle, win } = createProbeWindow(adapter)
    adapter.installAppWindowGuards?.(handle, 'demo')

    /** 触发一次导航，返回 event.preventDefault 是否被调用。 */
    const navigate = (
      url: string,
      eventName: 'will-navigate' | 'will-frame-navigate' | 'will-redirect' = 'will-navigate',
      isMainFrame = true,
    ) => {
      const event = { preventDefault: vi.fn(), defaultPrevented: false, url, isMainFrame }
      win.webContents.emit(eventName, event as never, url as never)
      return event.preventDefault.mock.calls.length > 0
    }

    expect(navigate(`${APP_SCHEME}://demo/settings`)).toBe(false)
    expect(navigate(`${APP_SCHEME}://other-app/`)).toBe(true)
    expect(navigate('https://harness.example.com/')).toBe(true)
    expect(navigate('javascript:alert(1)')).toBe(true)
    // 顶层 frame 的 will-frame-navigate 仍要闸。
    expect(navigate('https://evil.example.com/', 'will-frame-navigate', true)).toBe(true)
    // 子框架：**跨 app 内嵌必须拒**（换壳，P2-3）；http(s) 子框架放行（平台 CSP 兜底）。
    expect(navigate(`${APP_SCHEME}://other-app/`, 'will-frame-navigate', false)).toBe(true)
    expect(navigate(`${APP_SCHEME}://demo/embed`, 'will-frame-navigate', false)).toBe(false)
    expect(navigate('https://harness.example.com/embed', 'will-frame-navigate', false)).toBe(false)
    expect(navigate('file:///etc/hostname', 'will-frame-navigate', false)).toBe(true)

    // 弹窗一律拒（§20.2：应用窗口不得 window.open）。
    expect(win.webContents.windowOpenHandler?.({ url: 'https://harness.example.com/' })).toEqual({ action: 'deny' })
  })

  /**
   * P1-1（2026-09-20 审计）：**重定向走同一道闸门**。
   *
   * 只挂 `will-navigate`/`will-frame-navigate` 时，一次 302 就能把窗口换到外站或
   * **另一个应用的 origin**（换壳）—— 真机探针实测过（`temp/appwin-audit/probe-h1-h2.mjs`：
   * `nav:redirect-external = https://example.com/`、`nav:redirect-otherapp = picoaide-app://appb/`）。
   *
   * 变异：删掉 `contents.on('will-redirect', …)` 那一行 ⇒ 本用例的 302 断言全红
   * （真机版本见 `temp/fix-appwin-r2/probe-appwin.mjs`，用真实 302 打）。
   */
  it('will-redirect 与 will-navigate 共用同一判据：跨 app / 外站 302 一律拒，同 app 302 放行', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME, warn: message => warned.push(message) })
    const { handle, win } = createProbeWindow(adapter)
    adapter.installAppWindowGuards?.(handle, 'demo')

    const redirected = (url: string, isMainFrame = true): boolean => {
      const event = { preventDefault: vi.fn(), defaultPrevented: false, url, isMainFrame }
      win.webContents.emit('will-redirect' as never, event as never)
      return event.preventDefault.mock.calls.length > 0
    }

    expect(redirected('https://example.com/')).toBe(true)
    expect(redirected(`${APP_SCHEME}://other-app/`)).toBe(true)
    expect(redirected('file:///etc/hostname')).toBe(true)
    // 同 app origin 的 302 必须放行（应用自己的跳转是正常功能）。
    expect(redirected(`${APP_SCHEME}://demo/after-login`)).toBe(false)
    // 子框架的重定向：跨 app 拒、http(s) 放行。
    expect(redirected(`${APP_SCHEME}://other-app/`, false)).toBe(true)
    expect(redirected('https://example.com/embed', false)).toBe(false)
    // 拒绝必须走**同一个**出口（日志文案与 will-navigate 一致：`refused a … navigation`）。
    expect(warned.filter(message => message.includes('refused a foreign-app navigation'))).toHaveLength(2)
    expect(warned.filter(message => message.includes('refused a external navigation'))).toHaveLength(2)
  })

  it('比例锁定原样转发给原生窗口，且权限守卫装在**应用分区**（不是默认 session）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    const { handle, win } = createProbeWindow(adapter)

    adapter.setAspectRatio?.(handle, 1.777, { width: 0, height: 0 })
    expect(win.aspectRatios).toEqual([{ ratio: 1.777, extraSize: { width: 0, height: 0 } }])

    adapter.ensureSessionGuard?.(PARTITION)
    expect(guardEnsureSession).toHaveBeenCalledTimes(1)
    // 装到**应用窗口真正落地的那个分区**：装默认 session 会一边保护不到应用窗口，
    // 一边用 last-wins 覆盖主窗口在同一 session 上的剪贴板白名单（P1-2 的耦合）。
    expect(guardEnsureSession.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ protocol: { handle: partitionHandle } }))
    expect(guardEnsureSession.mock.calls[0]?.[0]).not.toBe(session.defaultSession)
    expect(fromPartition).toHaveBeenCalledWith(PARTITION)

    // 非法分区不得静默退回默认 session。
    expect(() => adapter.ensureSessionGuard?.('')).toThrow(/partition/)
  })

  it('工作区取鼠标所在显示器（多显示器每次打开重新求值）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    expect(adapter.workArea?.()).toEqual({ x: 1, y: 2, width: 1600, height: 900 })
    expect(getCursorScreenPoint).toHaveBeenCalledTimes(1)
    expect(getDisplayNearestPoint).toHaveBeenCalledWith({ x: 5, y: 6 })
  })

  it('被后续导航顶掉的加载（ERR_ABORTED）不记成故障，其它失败照记', async () => {
    const warned: string[] = []
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME, warn: message => warned.push(message) })
    const handle = adapter.createAppWindow({
      appId: 'demo',
      url: `${APP_SCHEME}://demo/`,
      title: '演示应用 · PicoAide Harness',
      partition: PARTITION,
      width: 1280,
      height: 720,
      x: 0,
      y: 0,
      minimumWidth: 320,
      minimumHeight: 240,
    })
    const win = FakeBrowserWindow.created[FakeBrowserWindow.created.length - 1]!
    // 聚焦导航顶掉上一次加载：真机实测的 ERR_ABORTED (-3)。
    win.webContents.failNextLoad(Object.assign(new Error("ERR_ABORTED (-3) loading 'picoaide-app://demo/notes'"), { code: 'ERR_ABORTED', errno: -3 }))
    adapter.focusAppWindow(handle, `${APP_SCHEME}://demo/notes`)
    await Promise.resolve()
    await Promise.resolve()
    expect(warned.filter(message => message.includes('ERR_ABORTED'))).toEqual([])
    // 真正的失败仍然要能被看见。
    win.webContents.failNextLoad(new Error('ERR_CONNECTION_REFUSED'))
    adapter.focusAppWindow(handle, `${APP_SCHEME}://demo/other`)
    await Promise.resolve()
    await Promise.resolve()
    expect(warned.some(message => message.includes('ERR_CONNECTION_REFUSED'))).toBe(true)
  })

  it('非法应用源 scheme 一律构造期抛（fail-loud，别等窗口打开后每个导航都被拒）', () => {
    for (const bad of ['', 'App', 'https', 'picoaide_app']) {
      expect(() => createRealElectronWindowAdapter({ appScheme: bad }), bad).toThrow()
    }
  })
})
