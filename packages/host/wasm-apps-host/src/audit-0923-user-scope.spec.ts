/**
 * 2026-09-23 独立审计 D（wasm-apps-host）—— WS-1 / WS-2 的回归用例。
 *
 * WS-1 有**两层**判据，这里两层都钉：
 *  ① 装配层（`index.ts` 的会话回调）：作用域变化（含 A→B 直接换号，不经登出）必须
 *     关闭全部应用窗口 —— 旧实现只在 `currentSession() === null` 时拆窗，探针实测
 *     A→B 后 `closeAppWindow` 调用 0 次、B 聚焦并使用 A 分区里的窗口；
 *  ② 窗口层（`windows.ts` 的 `open()`）：命中已有窗口时比对建窗时记录的分区，不一致
 *     就关掉重建 —— 分区是 Electron 创建后**不可改指**的属性，所以这是最后一道防线
 *     （即使将来某条路径没走会话回调）。
 *
 * WS-2：`/` 是**文档入口**而不是静态子资源 ⇒ 平台下架/拒绝之后不得本地直出。
 *
 * 变异验证：
 *  · WS-1①：把条件改回 `currentSession() === null` ⇒ 第一组红（closed 为 0、第二次
 *    open 返回 focused 且分区仍是 A 的）；
 *  · WS-1②：删掉 `windowPartitions.get(appId) !== partition` 分支 ⇒ 第二组红；
 *  · WS-2：把 `if (last === undefined) return false` 改回 `return true` ⇒ 第三组红
 *    （拒绝之后 `/` 仍是 200 且不出网）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apply,
  WASM_APPS_HOST_ADAPTER_SERVICE,
  WASM_APPS_LOCAL_PREFIX,
  WASM_APPS_WINDOW_ADAPTER_SERVICE,
} from './index.ts'
import { serverPartitionHash } from './partition.ts'
import { createWasmAppsWindows, type WasmAppsWindowAdapter } from './windows.ts'
import { WasmAppsCache } from './cache.ts'
import { createAppSchemeHandler } from './handler.ts'
import type { AppSession, PicoSessionLike } from './session.ts'

const PROOF_PARTITION_ALICE = `persist:agent-browser-alice@${serverPartitionHash('https://harness.example.com')}`
const PROOF_PARTITION_BOB = `persist:agent-browser-bob@${serverPartitionHash('https://harness.example.com')}`

const ALICE: AppSession = { serverURL: 'https://harness.example.com', token: 'tok-a', username: 'alice' }
const BOB: AppSession = { serverURL: 'https://harness.example.com', token: 'tok-b', username: 'bob' }

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/**
 * 替身自己造的句柄形状。
 *
 * 契约里的 `AppWindowHandle` 是**不透明的 `unknown`**（只有造它的适配器知道里面是
 * 什么），所以替身必须自己收窄 —— 这也是为什么断言用的是这里记下的字符串 id。
 */
interface FakeWindowHandle { id: string }

/** 从（不透明的）句柄里取回替身自己写进去的 id；形状不符时退化成可读的字符串。 */
function handleIdOf(handle: unknown): string {
  const id = (handle as { id?: unknown } | null | undefined)?.id
  return typeof id === 'string' ? id : String(id ?? '')
}

/** 录音替身：只记调用（与 `probe-a-user-switch.mjs` 同形）。 */
function recordingWindowAdapter(): WasmAppsWindowAdapter & { created: Array<{ appId: string, partition: string }>, focused: string[], closed: string[] } {
  const created: Array<{ appId: string, partition: string }> = []
  const focused: string[] = []
  const closed: string[] = []
  let next = 0
  return {
    created,
    focused,
    closed,
    createAppWindow(options) {
      created.push({ appId: String(options.appId), partition: String(options.partition) })
      next += 1
      return { id: `${String(options.appId)}#${next}` } satisfies FakeWindowHandle
    },
    focusAppWindow(handle: unknown) { focused.push(handleIdOf(handle)) },
    closeAppWindow(handle: unknown) { closed.push(handleIdOf(handle)) },
    setAspectRatio() {},
  }
}

/** 最小假 Cordis 上下文（与 `index.spec.ts` 的 fakeContext 同形，只保留本组用到的面）。 */
function fakeContext(initial: AppSession | null): {
  ctx: Parameters<typeof apply>[0]
  setSession: (next: AppSession | null) => void
  fireSessionChanged: () => void
  routes: Array<{ path: string, handler: (req: unknown, res: unknown) => void }>
  warnings: string[]
} {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const routes: Array<{ path: string, handler: (req: unknown, res: unknown) => void }> = []
  const warnings: string[] = []
  let session = initial
  const windowAdapter = recordingWindowAdapter()
  const services = new Map<string, unknown>([
    [WASM_APPS_HOST_ADAPTER_SERVICE, {
      handleAppScheme() {},
      handleInSession() {},
      fetch: async (url: string) => url.endsWith('/open')
        ? new Response(JSON.stringify({ version: '1.0.0', changed: false }), { status: 200 })
        : new Response('{}', { status: 200 }),
    }],
    ['picoSession', {
      getSession: () => session,
      isRestored: () => true,
      clear() {},
    } satisfies PicoSessionLike],
    ['desktopRuntime', { locale: 'zh' }],
    ['connection', { requestRejection: () => undefined }],
    [WASM_APPS_WINDOW_ADAPTER_SERVICE, windowAdapter],
  ])
  const webServer = {
    port: 41234,
    register: (route: { path: string, handler: (req: unknown, res: unknown) => void }) => { routes.push(route); return () => {} },
  }
  const ctx = {
    get: (name: string) => (name === 'webServer' ? webServer : services.get(name)),
    inject: () => () => {},
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(handler)
      listeners.set(event, set)
      return () => { set.delete(handler) }
    },
    emit: (event: string, payload: unknown) => { for (const handler of listeners.get(event) ?? []) handler(payload) },
    effect: (callback: () => (() => void) | void) => { callback() },
    logger: { warn: (message: string) => { warnings.push(message) }, info: () => {} },
    webServer,
  }
  return {
    ctx: ctx as unknown as Parameters<typeof apply>[0],
    setSession: (next: AppSession | null) => { session = next },
    fireSessionChanged: () => { for (const handler of listeners.get('pico/session-changed') ?? []) handler(session) },
    routes,
    warnings,
    // 让测试能拿到录音替身：挂到 ctx 上（等价于 `ctx.get(WASM_APPS_WINDOW_ADAPTER_SERVICE)`）。
    ...( { windowAdapter } as Record<string, unknown> ),
  } as never
}

const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 25) })

function fakeResponse(): { res: unknown, state: { status: number, body: string, headers: Record<string, string> } } {
  const state = { status: 0, body: '', headers: {} as Record<string, string> }
  const res = {
    writeHead: (status: number, headers?: Record<string, string>) => { state.status = status; Object.assign(state.headers, headers ?? {}); return res },
    setHeader: (name: string, value: string) => { state.headers[name] = value },
    end: (chunk?: string | Uint8Array) => {
      state.body = typeof chunk === 'string' ? chunk : (chunk === undefined ? '' : Buffer.from(chunk).toString('utf8'))
    },
  }
  return { res, state }
}

function fakeRequest(method: string, body: string | undefined, headers: Record<string, string>, url: string): unknown {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body) },
  }
}

describe('WS-1 直接换账号必须重建应用窗口（2026-09-23 审计）', () => {
  it('A→B（无登出）：旧窗口被关，B 的窗口建在 B 的分区上', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wasm-ws1-'))
    const h = fakeContext(ALICE) as unknown as {
      ctx: Parameters<typeof apply>[0]
      setSession: (next: AppSession | null) => void
      fireSessionChanged: () => void
      routes: Array<{ path: string, handler: (req: unknown, res: unknown) => void }>
      windowAdapter: ReturnType<typeof recordingWindowAdapter>
    }
    apply(h.ctx, { appOriginScheme: 'example-app', deepLinkScheme: 'example-harness', productName: 'Example Harness', userDataDir: dir })
    cleanups.push(() => { /* temp dir 由系统清理 */ })

    const routeOf = (): { path: string, handler: (req: unknown, res: unknown) => void } => {
      const route = h.routes.find((entry) => entry.path === WASM_APPS_LOCAL_PREFIX)
      if (route === undefined) throw new Error('local surface not registered')
      return route
    }
    const proofOf = async (): Promise<Record<string, string>> => {
      const { res, state } = fakeResponse()
      routeOf().handler(fakeRequest('GET', undefined, {}, `${WASM_APPS_LOCAL_PREFIX}/host-proof`), res)
      await flush()
      return { 'x-pico-host-proof': JSON.parse(state.body).proof }
    }
    const openApp = async (appId: string): Promise<{ status: number, body: string }> => {
      const headers = await proofOf()
      const { res, state } = fakeResponse()
      routeOf().handler(fakeRequest('POST', JSON.stringify({ app_id: appId }), headers, `${WASM_APPS_LOCAL_PREFIX}/open`), res)
      for (let i = 0; i < 200 && (state.status === 0 || state.body === ''); i++) await flush()
      return state
    }

    const first = await openApp('demo')
    expect(first.status).toBe(200)
    expect(h.windowAdapter.created).toHaveLength(1)
    expect(h.windowAdapter.created[0]?.partition).toBe(PROOF_PARTITION_ALICE)

    const closedBefore = h.windowAdapter.closed.length
    h.setSession(BOB)
    h.fireSessionChanged()
    await flush()

    // ① 旧作用域的窗口必须真的被关（分区不可改指）。
    expect(h.windowAdapter.closed.length - closedBefore).toBe(1)

    const second = await openApp('demo')
    expect(second.status).toBe(200)
    // ② B 拿到的是**新建**窗口，且分区是 B 的（旧实现：focused + A 的分区 = 跨账号身份泄漏）。
    expect(h.windowAdapter.created).toHaveLength(2)
    expect(h.windowAdapter.created[1]?.partition).toBe(PROOF_PARTITION_BOB)
    expect(h.windowAdapter.focused).toHaveLength(0)
    expect(second.body).toContain('"opened"')
    expect(PROOF_PARTITION_ALICE).not.toBe(PROOF_PARTITION_BOB)
  })

  it('同一账号的重复会话事件不拆窗（幂等，不打断用户）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wasm-ws1-idem-'))
    const h = fakeContext(ALICE) as unknown as {
      ctx: Parameters<typeof apply>[0]
      fireSessionChanged: () => void
      windowAdapter: ReturnType<typeof recordingWindowAdapter>
    }
    apply(h.ctx, { appOriginScheme: 'example-app', productName: 'Example Harness', userDataDir: dir })
    const windows = h.windowAdapter
    // 直接经窗口层建一个窗口（同一路径的另一半由上一个用例覆盖）。
    const direct = createWasmAppsWindows({
      adapter: windows,
      appScheme: 'example-app',
      productName: 'Example Harness',
      userDataDir: dir,
      partition: () => PROOF_PARTITION_ALICE,
      urlFor: (appId, path) => `example-app://${appId}${path}`,
      workArea: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    })
    await direct.open('demo')
    expect(windows.created).toHaveLength(1)
    // 同分区的再次 open 仍是 focus（不许每次 open 都重建）。
    const again = await direct.open('demo', '/other')
    expect(again.window).toBe('focused')
    expect(windows.created).toHaveLength(1)
    void h.fireSessionChanged
  })
})

describe('WS-1 兜底：分区不匹配时关掉旧窗口重建（windows.ts 层）', () => {
  it('作用域变了但映射没清（回调缺位）时，open 也必须落在当前分区', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wasm-ws1-fallback-'))
    const adapter = recordingWindowAdapter()
    let partition = PROOF_PARTITION_ALICE
    const windows = createWasmAppsWindows({
      adapter,
      appScheme: 'example-app',
      productName: 'Example Harness',
      userDataDir: dir,
      partition: () => partition,
      urlFor: (appId, path) => `example-app://${appId}${path}`,
      workArea: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    })
    await windows.open('demo')
    expect(adapter.created[0]?.partition).toBe(PROOF_PARTITION_ALICE)

    // 换号但**不**调用 closeAll（模拟"事件没到"）：下一次 open 必须自己纠正。
    partition = PROOF_PARTITION_BOB
    const next = await windows.open('demo')
    expect(next.window).toBe('opened')
    expect(adapter.closed).toHaveLength(1)
    expect(adapter.created).toHaveLength(2)
    expect(adapter.created[1]?.partition).toBe(PROOF_PARTITION_BOB)
    expect(adapter.focused).toHaveLength(0)
  })
})

describe('WS-2 根路径 `/` 不是静态子资源（2026-09-23 审计）', () => {
  it('判定层：非导航形态的 `/` 必须回源', () => {
    const cache = new WasmAppsCache({ root: mkdtempSync(join(tmpdir(), 'wasm-ws2-')) })
    expect(cache.isStaticSubresource('/', { accept: '*/*' })).toBe(false)
    expect(cache.isStaticSubresource('/a/b/', {})).toBe(false)
    // 静态资源照旧（不许把整条短路路径关掉）。
    expect(cache.isStaticSubresource('/app.js', {})).toBe(true)
    expect(cache.isStaticSubresource('/data.json', {})).toBe(true)
  })

  it('端到端：平台转为"一律拒绝"后 `/` 必须回源（旧实现本地直出 200）', async () => {
    const cache = new WasmAppsCache({ root: mkdtempSync(join(tmpdir(), 'wasm-ws2-e2e-')) })
    const scope = { serverHash: 'a'.repeat(32), userHash: 'b'.repeat(32) }
    let outbound = 0
    let refuse = false
    const handler = createAppSchemeHandler({
      appOriginScheme: 'example-app',
      session: () => ({ serverURL: 'https://harness.example.com', token: 'tok', username: 'alice' }),
      fetch: async () => {
        outbound += 1
        if (refuse) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'gone' } }), { status: 410 })
        const envelope = {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ rows: [1, 2, 3] }), 'utf8').toString('base64'),
          truncated: false,
        }
        return new Response(JSON.stringify(envelope), { status: 200, headers: { 'x-picoaide-app-version': '1.2.3' } })
      },
      clearSession: () => {},
      hostLocale: () => 'zh',
      cache,
      cacheScope: () => scope,
      cacheVersion: () => '1.2.3',
    })
    const call = async (path: string): Promise<{ status: number, text: string }> => {
      const response = await handler(new Request(`example-app://demo${path}`, { headers: { accept: '*/*' } }))
      return { status: response.status, text: await response.text() }
    }
    const first = await call('/')
    expect(first.status).toBe(200)
    expect(outbound).toBe(1)

    refuse = true
    const second = await call('/')
    // 判据：必须**回源**（出网 +1）并如实返回平台的拒绝状态。
    expect(outbound).toBe(2)
    expect(second.status).toBe(410)
    // 对照：非静态路径（/api/*）在同一条件下照样回源。
    const api = await call('/api/list')
    expect(outbound).toBe(3)
    expect(api.status).toBe(410)
  })
})
