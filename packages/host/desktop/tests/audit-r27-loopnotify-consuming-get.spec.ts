/**
 * FIX-36（第二十七轮 AA3-04）回归：`GET /api/pico/desktop/loop-notify/session` 是
 * **状态变更 GET**（read-then-clear 消费待跳转会话，P2-24），修前它同时落在两条缝里：
 *
 *  1. **exact 胜过 prefix**：上游 webserver 先查 exact 表、未命中才走 prefix
 *     （`dsh-host-webserver` 的派发），而 `connection` 的 Host/Origin 围栏 +
 *     BrowserAuth cookie 校验**只装在 `/api` 那条 prefix 通道**上 ⇒ 任何以
 *     `kind: 'exact'` 注册的 `/api/**` 路径都绕过它。本文件用**真实 `WebServer` +
 *     真实 socket** 复现，并带对照腿（同一台 webserver 的 `/api` prefix 路径确实
 *     被围栏挡住 —— 证明围栏本身有效，而不是"没接线所以看起来一样"）。
 *  2. **GET 豁免**：`write-proof.ts` 的"GET 读面豁免"被用在一个非只读的 GET 上
 *     （全文件 `acceptWriteProof` 0 命中）。
 *
 * 后果：本机任意进程一个裸 GET 就能把待跳转会话**取走并清空** —— 持证明的渲染层
 * 轮询再也拿不到（`sessionId: null`，用户点系统通知"没反应"），并顺带泄露会话 id。
 *
 * 判据六条腿（都真跑）：
 *  A. 负向：裸 GET 被拒（403）、不泄露会话 id、**不消费**（随后持证明的请求仍能取到）；
 *  B. 对照：同一 webserver 的 prefix `/api` 路径仍 401（围栏真的在跑）；
 *  C. 正向：持证明的同源 GET 与修前**逐字相同**（状态码 / content-type / 响应字节），
 *     且消费语义不变（第二发拿到清空载荷）；
 *  D. 等价：消费闸与写面闸 `acceptWriteProof` 的**真实非 GET 路径**逐字同结论
 *     （消费闸是"方法视图 + 同一份实现"，这条腿钉住视图不许漏字段）；
 *  E. 未接线 ⇒ fail-closed 503（证明机制缺席时不静默放行，也不消费）；
 *  F. 豁免表：desktop 注册的**每一条 exact 路由**要么挂证明、要么在表里写明为什么
 *     不必（纯读），且表**双向不陈旧**（新路由没登记 ⇒ 红；登记了却没注册 ⇒ 红）；
 *     `proof: true` 的行还要在**真实注册的处理器**上跑一遍伪造请求（断言动作未被驱动）。
 *
 * 另两条：
 *  G. 渲染层形态：轮询用浏览器缺省 credentials（同源 ⇒ 自动带 `dsh-auth-*` cookie），
 *     不允许静默改成 `omit`（那会让正常轮询拿不到证明）；
 *  H. 漂移检测：上面的围栏替身必须仍与 pinned 上游的判定面同形（上游改了
 *     `requestRejection` / Origin / cookie 名规则 ⇒ 这条红，逼人重新对齐替身）。
 */
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRAND_FAVICON_PATH, BRAND_MANIFEST_PATH } from '../src/brand-web-route.ts'
import { fetchLoopNotifySession } from '../src/client/loop-notify.tsx'
import { DESKTOP_DIRECTORY_PICKER_PATH } from '../src/directory-picker-contract.ts'
import { DESKTOP_UPDATE_CHECK_PATH, DESKTOP_UPDATE_INSTALL_PATH, DESKTOP_UPDATE_PATH } from '../src/desktop-update-contract.ts'
import { DESKTOP_TITLEBAR_DOUBLE_CLICK_PATH } from '../src/desktop-window-contract.ts'
import { apply } from '../src/index.ts'
import { resolvedDesktopConfig } from './helpers/desktop-config.ts'
import { DESKTOP_LOOP_NOTIFY_SESSION_PATH, type DesktopLoopNotifySessionResponse } from '../src/loop-notify-contract.ts'
import { handleDesktopLoopNotifySessionRequest } from '../src/loop-notify-route.ts'
import { RENDERER_BOOT_REPORT_PATH, type RendererBootReport } from '../src/renderer-boot-contract.ts'
import { acceptWriteProof, type WriteProofDeps } from '../src/write-proof.ts'

const PENDING_SESSION_ID = 'session-3f7c1a2b-aa3'
const PENDING_AT = 1_700_000_000_000
const HARNESS_PORT = 43121
const HARNESS_AUTHORITY = `127.0.0.1:${String(HARNESS_PORT)}`
const HARNESS_ORIGIN = `http://${HARNESS_AUTHORITY}`

/* ------------------------------------------------------------------ *
 * 上游判定面的替身（`connection.requestRejection`）
 * ------------------------------------------------------------------ */

/** authority 绑定的 BrowserAuth cookie 名（上游 `browser-auth.ts` 的 `dsh-auth-<authority>`）。 */
function proofCookieFor(authority: string): string {
  return `dsh-auth-${authority}=v1.signature`
}

/**
 * 上游 `connection.requestRejection()` 的行为替身，逐条对齐 pinned 上游：
 * `rpc-host.ts` 的 `isTrustedApiRequest(request, trustedHosts)` → 403、
 * `browserAuth.isAuthenticated(request)` → 401；
 * `api-request-trust.ts` 的 Host 栅栏（回环/受信 authority）、`sec-fetch-site:
 * cross-site` 拒绝、Origin 存在时必须等于 Host（**缺席 Origin 直接放行** ——
 * 同源 GET 在 Chromium 里就没有 Origin）；
 * `browser-auth.ts` 的 cookie 名由 authority 派生。
 *
 * 与上游的漂移由本文件最后一条用例（读 pinned 源码）看住。
 */
function upstreamShapedJudge(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined {
  const headers = request.headers as Record<string, unknown>
  const host = headers['host']
  if (typeof host !== 'string' || !/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) return 403
  if (headers['sec-fetch-site'] === 'cross-site') return 403
  const origin = headers['origin']
  if (typeof origin === 'string' && new URL(origin).host !== host) return 403
  return headers['cookie'] === proofCookieFor(host) ? undefined : 401
}

function proofDepsWithJudge(): WriteProofDeps {
  return { fence: () => ({ requestRejection: upstreamShapedJudge }), label: 'test' }
}

/* ------------------------------------------------------------------ *
 * 真实 WebServer + 真实 socket 的夹具
 * ------------------------------------------------------------------ */

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

interface RawAnswer {
  readonly status: number
  readonly contentType: string | undefined
  readonly body: string
}

/** 真实 socket 上的一个请求（Node 自动填 Host；GET 不带 Origin —— 与渲染层同形）。 */
function rawRequest(port: number, method: string, path: string, headers: Record<string, string>): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        const contentType = res.headers['content-type']
        resolve({
          status: res.statusCode ?? 0,
          contentType: typeof contentType === 'string' ? contentType : undefined,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

interface ConsumingGetFixture {
  readonly port: number
  readonly authority: string
  readonly proofCookie: string
  /** 证明判定被调用的次数（修前 exact 路由是 0 —— AA3 探针的 fenceCallsForExactRoute）。 */
  readonly judgeCalls: () => number
  /** prefix `/api` 通道的围栏被调用次数（对照腿的自证）。 */
  readonly prefixFenceCalls: () => number
  readonly consumes: () => number
  readonly pendingSessionId: () => string | null
}

/**
 * 起一台真实 webserver：exact = **产品处理器**（带证明依赖）；prefix `/api` = 与
 * `connection` 同形的围栏通道（先判证明，再 401/403）。
 * @param options - `wireProof: false` 模拟"路由没接证明依赖"的 fail-closed 形态。
 * @returns 夹具句柄（端口、证明 cookie 与三个可观测计数）。
 */
async function startConsumingGetFixture(options: { readonly wireProof?: boolean } = {}): Promise<ConsumingGetFixture> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const server = ctx.webServer
  const port = server.port
  const authority = `127.0.0.1:${String(port)}`
  const judge = vi.fn(upstreamShapedJudge)
  let prefixFenceCalls = 0

  // 围栏只装在 prefix 通道上（与上游 connection 的 `/api` 通道同形）。
  server.register({
    kind: 'prefix',
    path: '/api',
    handler: (req, res) => {
      prefixFenceCalls += 1
      const rejection = judge(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      res.writeHead(200)
      res.end('prefix-passed')
    },
  })

  let consumed = 0
  let pending: DesktopLoopNotifySessionResponse | undefined = {
    sessionId: PENDING_SESSION_ID,
    requestedAt: PENDING_AT,
  }
  const proof: WriteProofDeps = { fence: () => ({ requestRejection: judge }), label: 'test' }
  server.register({
    kind: 'exact',
    path: DESKTOP_LOOP_NOTIFY_SESSION_PATH,
    handler: async (req, res) => {
      await handleDesktopLoopNotifySessionRequest(req, res, `http://${authority}`, () => {
        consumed += 1
        const current = pending ?? { sessionId: null, requestedAt: 0 }
        pending = undefined
        return current
      }, options.wireProof === false ? undefined : proof)
    },
  })

  return {
    port,
    authority,
    proofCookie: proofCookieFor(authority),
    judgeCalls: () => judge.mock.calls.length,
    prefixFenceCalls: () => prefixFenceCalls,
    consumes: () => consumed,
    pendingSessionId: () => pending?.sessionId ?? null,
  }
}

/* ------------------------------------------------------------------ *
 * A/B/C/E：真实 socket 上的四条腿
 * ------------------------------------------------------------------ */

describe('FIX-36：状态变更 GET 的持有性证明（真实 WebServer + 真实 socket）', () => {
  it('A/B：裸 GET 被拒且不消费待跳转会话；同一 webserver 的 prefix `/api` 仍被围栏挡住', async () => {
    const fixture = await startConsumingGetFixture()

    // 本机任意进程的原始形态：无 Origin、无 cookie。
    const forged = await rawRequest(fixture.port, 'GET', DESKTOP_LOOP_NOTIFY_SESSION_PATH, {})
    expect(forged.status).toBe(403)
    expect(JSON.parse(forged.body)).toEqual({
      error: 'browser session proof required',
      hint: 'reopen the application window from its launch URL',
    })
    // 不得泄露待跳转会话，也不得把它消费掉。
    expect(forged.body).not.toContain(PENDING_SESSION_ID)
    expect(fixture.consumes()).toBe(0)
    expect(fixture.pendingSessionId()).toBe(PENDING_SESSION_ID)
    // exact 路由**真的**进过围栏（修前这里是 0：exact 绕过围栏 + 处理器不要证明）。
    expect(fixture.judgeCalls()).toBeGreaterThanOrEqual(1)

    // 对照腿：同一条 webserver 上，prefix `/api` 空间的其它路径确实被围栏挡住。
    const control = await rawRequest(fixture.port, 'GET', '/api/pico/desktop/not-a-real-route', {})
    expect(control.status).toBe(401)
    expect(control.body).toBe('unauthorized')
    expect(fixture.prefixFenceCalls()).toBe(1)

    // 持证明的渲染层轮询**仍然**拿得到那份待跳转会话 ⇒ 前面两发都没消费它。
    const real = await rawRequest(fixture.port, 'GET', DESKTOP_LOOP_NOTIFY_SESSION_PATH, {
      cookie: fixture.proofCookie,
    })
    expect(real.status).toBe(200)
    expect(JSON.parse(real.body)).toEqual({ sessionId: PENDING_SESSION_ID, requestedAt: PENDING_AT })
    expect(fixture.consumes()).toBe(1)
  })

  it('C：持证明的同源 GET 与修前逐字相同（状态码 / content-type / 字节 / 消费语义）', async () => {
    const fixture = await startConsumingGetFixture()

    const first = await rawRequest(fixture.port, 'GET', DESKTOP_LOOP_NOTIFY_SESSION_PATH, {
      cookie: fixture.proofCookie,
    })
    expect(first.status).toBe(200)
    expect(first.contentType).toBe('application/json; charset=utf-8')
    // 逐字：修前这条路径就是 `finishJson(res, 200, consume())`。
    expect(first.body).toBe(`{"sessionId":"${PENDING_SESSION_ID}","requestedAt":${String(PENDING_AT)}}`)

    // P2-24 消费语义不变：第二发拿到清空载荷，不能重复跳转。
    const second = await rawRequest(fixture.port, 'GET', DESKTOP_LOOP_NOTIFY_SESSION_PATH, {
      cookie: fixture.proofCookie,
    })
    expect(second.status).toBe(200)
    expect(second.body).toBe('{"sessionId":null,"requestedAt":0}')
    expect(fixture.consumes()).toBe(2)
  })

  it('C′：跨源 Origin 仍按原契约 403，且不消费', async () => {
    const fixture = await startConsumingGetFixture()
    const crossOrigin = await rawRequest(fixture.port, 'GET', DESKTOP_LOOP_NOTIFY_SESSION_PATH, {
      origin: 'https://evil.example',
      cookie: fixture.proofCookie,
    })
    expect(crossOrigin.status).toBe(403)
    expect(JSON.parse(crossOrigin.body)).toEqual({ error: 'forbidden' })
    expect(fixture.consumes()).toBe(0)
    expect(fixture.pendingSessionId()).toBe(PENDING_SESSION_ID)
  })

  it('E：证明依赖未接线 ⇒ fail-closed 503，且不消费', async () => {
    const fixture = await startConsumingGetFixture({ wireProof: false })
    const answer = await rawRequest(fixture.port, 'GET', DESKTOP_LOOP_NOTIFY_SESSION_PATH, {
      cookie: fixture.proofCookie,
    })
    expect(answer.status).toBe(503)
    expect(JSON.parse(answer.body)).toEqual({
      error: 'browser session proof unavailable',
      hint: 'reopen the application window from its launch URL',
    })
    expect(fixture.consumes()).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * D：消费闸 ≡ 写面闸（方法视图不许漏字段）
 * ------------------------------------------------------------------ */

function fakeRequest(method: string, headers: IncomingMessage['headers']): IncomingMessage {
  return { method, headers } as IncomingMessage
}

function fakeResponse(): { res: ServerResponse, read: () => { code: number, body: string } } {
  let body = ''
  const res = {
    statusCode: 200,
    setHeader: () => {},
    end: (chunk?: string) => { body = chunk ?? '' },
  } as unknown as ServerResponse
  return {
    res,
    read: () => ({ code: (res as unknown as { statusCode: number }).statusCode, body }),
  }
}

describe('FIX-36：消费型证明闸与写面闸逐字同结论', () => {
  /** 这些 headers 都通过路由自己的 Origin 检查（缺 Origin 或等于渲染层 origin）。 */
  const refusedHeaders: readonly { readonly name: string, readonly headers: IncomingMessage['headers'] }[] = [
    { name: '无 cookie', headers: { host: HARNESS_AUTHORITY } },
    { name: '同源但签名伪造', headers: { host: HARNESS_AUTHORITY, cookie: `dsh-auth-${HARNESS_AUTHORITY}=v1.forged` } },
    { name: '别的 authority 签发的 cookie', headers: { host: HARNESS_AUTHORITY, cookie: proofCookieFor('127.0.0.1:9999') } },
    { name: '跨站标记', headers: { host: HARNESS_AUTHORITY, cookie: proofCookieFor(HARNESS_AUTHORITY), 'sec-fetch-site': 'cross-site' } },
    { name: '非回环 Host', headers: { host: 'evil.example', cookie: proofCookieFor('evil.example') } },
  ]

  it('每一组被拒的 headers 在两个闸门上给出逐字相同的状态码与响应体，且都不消费', async () => {
    for (const row of refusedHeaders) {
      const deps = proofDepsWithJudge()
      let consumed = 0
      const route = fakeResponse()
      await handleDesktopLoopNotifySessionRequest(
        fakeRequest('GET', row.headers),
        route.res,
        HARNESS_ORIGIN,
        () => { consumed += 1; return { sessionId: PENDING_SESSION_ID, requestedAt: PENDING_AT } },
        deps,
      )
      const post = fakeResponse()
      const accepted = acceptWriteProof(fakeRequest('POST', row.headers), post.res, deps)

      expect(accepted, row.name).toBe(false)
      expect(route.read(), row.name).toEqual(post.read())
      expect(consumed, row.name).toBe(0)
    }
  })

  it('持证明时两个闸门都放行（消费闸继续走 200，写面闸不写响应）', async () => {
    const deps = proofDepsWithJudge()
    let consumed = 0
    const route = fakeResponse()
    await handleDesktopLoopNotifySessionRequest(
      fakeRequest('GET', { host: HARNESS_AUTHORITY, cookie: proofCookieFor(HARNESS_AUTHORITY) }),
      route.res,
      HARNESS_ORIGIN,
      () => { consumed += 1; return { sessionId: PENDING_SESSION_ID, requestedAt: PENDING_AT } },
      deps,
    )
    expect(route.read()).toEqual({
      code: 200,
      body: `{"sessionId":"${PENDING_SESSION_ID}","requestedAt":${String(PENDING_AT)}}`,
    })
    expect(consumed).toBe(1)

    const post = fakeResponse()
    expect(acceptWriteProof(
      fakeRequest('POST', { host: HARNESS_AUTHORITY, cookie: proofCookieFor(HARNESS_AUTHORITY) }),
      post.res,
      proofDepsWithJudge(),
    )).toBe(true)
    expect(post.read()).toEqual({ code: 200, body: '' })
  })
})

/* ------------------------------------------------------------------ *
 * F：exact 路由的豁免表（每条要么挂证明，要么写明为什么不必）
 * ------------------------------------------------------------------ */

interface ExactRoutePolicy {
  /** 是否挂了持有性证明（消费 / 写面）。 */
  readonly proof: boolean
  /** 伪造请求用的方法（无 Origin、无 cookie）。 */
  readonly forgedMethod: 'GET' | 'POST'
  /** 未挂证明的路由：为什么不必（纯读、无状态变更、无本机可驱动的副作用）。 */
  readonly reason: string
  /** 只在特定条件（平台 / 素材存在）下注册：缺席不算陈旧。 */
  readonly conditional?: boolean
}

/**
 * desktop 注册的全部 exact 路由的唯一分类表。
 * `proof: false` 只允许出现在**纯读**面上，且必须给出理由。
 */
const EXACT_ROUTE_POLICY: ReadonlyMap<string, ExactRoutePolicy> = new Map<string, ExactRoutePolicy>([
  [DESKTOP_LOOP_NOTIFY_SESSION_PATH, {
    proof: true,
    forgedMethod: 'GET',
    reason: '消费待跳转会话（read-then-clear）＝写；FIX-36 前是唯一的例外。',
  }],
  [DESKTOP_UPDATE_PATH, {
    proof: false,
    forgedMethod: 'GET',
    reason: '纯读：回吐更新徽章快照（内存里的状态投影），不驱动任何动作、不落盘。',
  }],
  [DESKTOP_UPDATE_CHECK_PATH, { proof: true, forgedMethod: 'POST', reason: '触发一次联网检查（写）。' }],
  [DESKTOP_UPDATE_INSTALL_PATH, { proof: true, forgedMethod: 'POST', reason: '拉起已下载的安装包（写）。' }],
  [RENDERER_BOOT_REPORT_PATH, { proof: true, forgedMethod: 'POST', reason: '把 Loader 结果写进宿主诊断（写）。' }],
  [DESKTOP_TITLEBAR_DOUBLE_CLICK_PATH, { proof: true, forgedMethod: 'POST', reason: '驱动原生窗口动作（写）。' }],
  [BRAND_MANIFEST_PATH, {
    proof: false,
    forgedMethod: 'GET',
    reason: '纯读：随包静态资源的字节（no-store），无状态变更。',
  }],
  [BRAND_FAVICON_PATH, {
    proof: false,
    forgedMethod: 'GET',
    reason: '纯读：随包静态资源的字节（no-store），无状态变更。',
    conditional: true,
  }],
  [DESKTOP_DIRECTORY_PICKER_PATH, {
    proof: true,
    forgedMethod: 'POST',
    reason: '打开原生对话框并回吐所选路径（写）。',
    conditional: true,
  }],
])

interface RouteHarness {
  readonly routes: WebRoute[]
  readonly route: (path: string) => WebRoute | undefined
  readonly sessionOpenRequestHandler: () => ((sessionId: string) => void) | undefined
  readonly installNow: ReturnType<typeof vi.fn<() => void>>
  readonly checkNow: ReturnType<typeof vi.fn<() => void>>
  readonly rendererBoot: ReturnType<typeof vi.fn<(report: RendererBootReport) => void>>
  readonly titlebarDoubleClick: ReturnType<typeof vi.fn<() => void>>
  readonly pickDirectory: ReturnType<typeof vi.fn<() => Promise<string | null>>>
}

/** 真实 `apply()` + 真实路由注册；`connection` 服务按上游判定面替身注入。 */
function routeHarness(platform: 'darwin' | 'win32'): RouteHarness {
  const routes: WebRoute[] = []
  const fence = { requestRejection: upstreamShapedJudge }
  const installNow = vi.fn<() => void>()
  const checkNow = vi.fn<() => void>()
  const rendererBoot = vi.fn<(report: RendererBootReport) => void>()
  const titlebarDoubleClick = vi.fn<() => void>()
  const pickDirectory = vi.fn(async () => '/tmp/picked')
  let sessionOpenRequestHandler: ((sessionId: string) => void) | undefined
  const runtime = {
    platform,
    locale: 'en',
    productName: 'PicoAide Harness',
    updates: {
      isPackaged: true,
      canDownload: true,
      currentVersion: '2.0.0',
      checkNow,
      installNow,
      publishState: undefined,
    },
    schedule: () => async () => {},
    mountScheduled: async () => {},
    show: () => {},
    registerTrayItem: () => ({ refresh: () => {}, dispose: () => {} }),
    exportDiagnostics: async () => {},
    pickDirectory,
    reportRendererBoot: rendererBoot,
    performTitleBarDoubleClick: titlebarDoubleClick,
    setLocalePreference: () => {},
    setThemeSource: () => {},
    requestRestart: async () => {},
    prepareToQuit: () => {},
    setDeepLinkHandler: () => {},
    setSessionOpenRequestHandler: (handler: (sessionId: string) => void) => { sessionOpenRequestHandler = handler },
  }
  const ctx = {
    get: (name: string) => {
      if (name === 'desktopRuntime') return runtime
      if (name === 'appExit') return () => {}
      if (name === 'connection') return fence
      return undefined
    },
    webServer: {
      host: '127.0.0.1',
      port: HARNESS_PORT,
      register: (route: WebRoute) => { routes.push(route); return () => {} },
    },
    settings: {
      register: () => ({ get: () => undefined, watch: () => () => {}, update: async () => {}, replace: async () => {} }),
      get: () => undefined,
    },
    connection: { authenticatedUrl: (url: string) => url },
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    effect: (callback: () => unknown) => { const dispose = callback(); return () => { if (typeof dispose === 'function') dispose() } },
    on: () => () => {},
  }
  apply(ctx as unknown as Context, resolvedDesktopConfig({
    port: HARNESS_PORT,
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 640,
  }))
  return {
    routes,
    route: path => routes.find(candidate => candidate.kind === 'exact' && candidate.path === path),
    sessionOpenRequestHandler: () => sessionOpenRequestHandler,
    installNow,
    checkNow,
    rendererBoot,
    titlebarDoubleClick,
    pickDirectory,
  }
}

async function drive(routes: WebRoute[], path: string, method: 'GET' | 'POST'): Promise<{ code: number, body: string }> {
  const route = routes.find(candidate => candidate.kind === 'exact' && candidate.path === path)
  if (route === undefined) throw new Error(`no exact route for ${path}`)
  let body = ''
  const res = {
    statusCode: 200,
    setHeader: () => {},
    end: (chunk?: string) => { body = chunk ?? '' },
  } as unknown as ServerResponse
  // 伪造请求的原始形态：无 Origin、无 cookie。
  await route.handler(fakeRequest(method, { host: HARNESS_AUTHORITY }), res)
  return { code: res.statusCode, body }
}

describe('FIX-36：exact 路由豁免表（不得陈旧）', () => {
  it('每一条注册的 exact 路由都在表里，且表里非条件项都真的注册了', () => {
    const registered = new Set<string>()
    for (const platform of ['darwin', 'win32'] as const) {
      for (const route of routeHarness(platform).routes) {
        if (route.kind === 'exact') registered.add(route.path)
      }
    }

    // 未登记的新路由 ⇒ 这里会红（逼人先决定它挂不挂证明）。
    const unregistered = [...registered].filter(path => !EXACT_ROUTE_POLICY.has(path))
    expect(unregistered).toEqual([])
    // 表里的死条目（路由已删除）⇒ 也红。
    const stale = [...EXACT_ROUTE_POLICY.keys()].filter(path => !registered.has(path))
    expect(stale.filter(path => EXACT_ROUTE_POLICY.get(path)?.conditional !== true)).toEqual([])
  })

  it('表里每一行都自洽：未挂证明的必须写明理由，挂证明的必须真的挡住伪造请求', async () => {
    const harness = routeHarness('win32')
    for (const [path, policy] of EXACT_ROUTE_POLICY) {
      // 未挂证明的行必须写明"为什么不必"。
      if (!policy.proof) expect(policy.reason.length, path).toBeGreaterThan(0)
      const route = harness.route(path)
      if (route === undefined) {
        // 条件注册（平台 / 素材）：缺席不算陈旧，但只允许出现在声明了 conditional 的行上。
        expect(policy.conditional, `${path} 没注册却不是条件项`).toBe(true)
        continue
      }
      const answer = await drive(harness.routes, path, policy.forgedMethod)
      if (policy.proof) {
        expect([403, 503], `${path} 挂了证明 ⇒ 伪造请求必须被拒`).toContain(answer.code)
      } else {
        expect(answer.code, `${path} 是声明的纯读面，无证明也必须照常服务`).toBe(200)
      }
    }
  })

  it('挂证明的写面在伪造请求下不被驱动（动作计数为 0）', async () => {
    const harness = routeHarness('win32')
    // 先放一份待跳转会话进去：伪造请求若把它取走，持证明的轮询就拿不到了。
    harness.sessionOpenRequestHandler()?.(PENDING_SESSION_ID)

    expect((await drive(harness.routes, DESKTOP_LOOP_NOTIFY_SESSION_PATH, 'GET')).code).toBe(403)
    expect((await drive(harness.routes, DESKTOP_UPDATE_CHECK_PATH, 'POST')).code).toBe(403)
    expect((await drive(harness.routes, DESKTOP_UPDATE_INSTALL_PATH, 'POST')).code).toBe(403)
    expect((await drive(harness.routes, RENDERER_BOOT_REPORT_PATH, 'POST')).code).toBe(403)
    expect((await drive(harness.routes, DESKTOP_TITLEBAR_DOUBLE_CLICK_PATH, 'POST')).code).toBe(403)
    expect((await drive(harness.routes, DESKTOP_DIRECTORY_PICKER_PATH, 'POST')).code).toBe(403)

    expect(harness.checkNow).not.toHaveBeenCalled()
    expect(harness.installNow).not.toHaveBeenCalled()
    expect(harness.rendererBoot).not.toHaveBeenCalled()
    expect(harness.titlebarDoubleClick).not.toHaveBeenCalled()
    expect(harness.pickDirectory).not.toHaveBeenCalled()

    // 待跳转会话还在：持证明的同源轮询（渲染层形态）拿得到它。
    const proofRoute = harness.route(DESKTOP_LOOP_NOTIFY_SESSION_PATH)
    let body = ''
    const res = {
      statusCode: 200,
      setHeader: () => {},
      end: (chunk?: string) => { body = chunk ?? '' },
    } as unknown as ServerResponse
    await proofRoute?.handler(
      fakeRequest('GET', { host: HARNESS_AUTHORITY, cookie: proofCookieFor(HARNESS_AUTHORITY) }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(body)).toEqual({ sessionId: PENDING_SESSION_ID, requestedAt: expect.any(Number) })
  })
})

/* ------------------------------------------------------------------ *
 * G：渲染层形态（同源缺省 credentials ⇒ cookie 就是那份证明）
 * ------------------------------------------------------------------ */

describe('FIX-36：渲染层轮询的请求形态', () => {
  it('轮询是 GET 且不覆盖 credentials（浏览器缺省 same-origin ⇒ 自动带 dsh-auth-* cookie）', async () => {
    let seen: { readonly input: RequestInfo | URL, readonly init: RequestInit | undefined } | undefined
    const answer = await fetchLoopNotifySession((input, init) => {
      seen = { input, init }
      return Promise.resolve(Response.json({ sessionId: 'session-1', requestedAt: 1 }))
    })
    expect(answer).toEqual({ sessionId: 'session-1', requestedAt: 1 })
    expect(seen?.input).toBe(DESKTOP_LOOP_NOTIFY_SESSION_PATH)
    expect(seen?.init?.method).toBe('GET')
    // `credentials: 'omit'` 会让同源请求不带 cookie ⇒ 证明消失 ⇒ 正常轮询 403。
    expect(seen?.init?.credentials).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 * H：围栏替身与 pinned 上游判定面的漂移检测
 * ------------------------------------------------------------------ */

/** 仓库根（`packages/host/desktop/tests/` 往上三层）。 */
const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const UPSTREAM_CONNECTION_SRC = join(workspaceRoot, 'deepseek-harness', 'packages', 'client', 'connection', 'src')

describe('FIX-36：围栏替身仍与 pinned 上游同形（漂移检测）', () => {
  it('上游 requestRejection / Origin 规则 / cookie 名派生没有变', () => {
    // 这几条是上面 `upstreamShapedJudge` 的取值域来源：上游改了它们，替身必须重新对齐
    // （否则这条判据会在一个已经不成立的判定面上给出绿色）。
    const rpcHost = readFileSync(join(UPSTREAM_CONNECTION_SRC, 'rpc-host.ts'), 'utf8')
    expect(rpcHost).toContain('if (!isTrustedApiRequest(request, this.trustedHosts)) return 403')
    expect(rpcHost).toContain('return this.browserAuth.isAuthenticated(request) ? undefined : 401')

    const trust = readFileSync(join(UPSTREAM_CONNECTION_SRC, 'api-request-trust.ts'), 'utf8')
    expect(trust).toContain("if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false")
    expect(trust).toContain('if (origin === undefined) return true')
    expect(trust).toContain('return new URL(origin).host === hostUrl.host')

    const browserAuth = readFileSync(join(UPSTREAM_CONNECTION_SRC, 'browser-auth.ts'), 'utf8')
    expect(browserAuth).toContain("const COOKIE_PREFIX = 'dsh-auth-'")
    expect(browserAuth).toContain('payload.authority !== authority')
  })
})
