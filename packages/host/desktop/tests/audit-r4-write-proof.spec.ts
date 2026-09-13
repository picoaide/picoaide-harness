/**
 * R4-RV3a 回归（第四轮收尾）：R7-RV-3 家族收口 —— desktop 写面的持有性证明。
 *
 * 缺陷面（`packages/host/desktop/src/desktop-update-route.ts:35-45` 的
 * `acceptRendererPost`）只在 `origin !== undefined && origin !== expectedOrigin`
 * 时拒绝 —— **不带 Origin 直接过**。`/api/pico/desktop/update/install` 与
 * `/update/check` 因此可被本机任意进程（伪造 Host/Origin/Sec-Fetch-Site，无任何
 * cookie）驱动：拉起已下载的安装包 / 触发一次联网检查；`/_dsh/desktop/renderer-boot`
 * 与 `pick-directory` 同族。
 *
 * 修法与 browser/connectors 第三轮的 `proofOfPossession` / `requireWriteProof`
 * 同形：写面（非 GET）经 `connection.requestRejection()` 要一份 BrowserAuth cookie；
 * fence 缺席 ⇒ fail-closed 503；读面（更新徽章 / 循环通知跳转）维持原判据。
 *
 * 本文件用**真实 `apply()` + 真实路由注册**跑（不是直接调 handler），fence 替身与
 * 上游 `rpc-host.ts:97-100` 同判据（Host/Origin 围栏 → 403，authority 绑定的 cookie
 * 验签 → 401）。断言的是"动作没有被驱动"（installNow/checkNow/reportRendererBoot/
 * pickDirectory 未被调用），不只是状态码。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, type Config as DesktopConfig } from '../src/index.ts'
import { DESKTOP_DIRECTORY_PICKER_PATH } from '../src/directory-picker-contract.ts'
import { DESKTOP_LOOP_NOTIFY_SESSION_PATH } from '../src/loop-notify-contract.ts'
import { DESKTOP_UPDATE_CHECK_PATH, DESKTOP_UPDATE_INSTALL_PATH, DESKTOP_UPDATE_PATH } from '../src/desktop-update-contract.ts'
import { handleDesktopUpdateCheckRequest, handleDesktopUpdateInstallRequest } from '../src/desktop-update-route.ts'
import { handleDesktopDirectoryPickerRequest } from '../src/directory-picker-route.ts'
import { handleRendererBootRequest } from '../src/renderer-boot.ts'
import { RENDERER_BOOT_REPORT_PATH } from '../src/renderer-boot-contract.ts'
import type { ConnectionTrustFence } from '../src/write-proof.ts'

const PORT = 43120
const AUTHORITY = `127.0.0.1:${String(PORT)}`
const REAL_COOKIE = `dsh-auth-${AUTHORITY}=v1.signature`

interface FenceDouble extends ConnectionTrustFence {
  seen: number
}

/**
 * 上游 `connection.requestRejection()` 的行为替身（`rpc-host.ts:97-100`）：
 * Host/Origin 围栏不通过 ⇒ 403；围栏通过但拿不出本 authority 的验签 cookie ⇒ 401。
 * cookie 名由 Host 派生，因此别的端口/别的拼写签发的 cookie 都不是证明。
 */
function browserFence(): FenceDouble {
  const fence = {
    seen: 0,
    requestRejection: (request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined => {
      fence.seen += 1
      const headers = request.headers as Record<string, unknown>
      const host = headers['host']
      if (typeof host !== 'string' || !/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) return 403
      if (headers['sec-fetch-site'] === 'cross-site') return 403
      const origin = headers['origin']
      if (typeof origin === 'string' && new URL(origin).host !== host) return 403
      return headers['cookie'] === `dsh-auth-${host}=v1.signature` ? undefined : 401
    },
  }
  return fence as FenceDouble
}

interface RequestOptions {
  body?: string
  /** 缺省 = 不带 cookie（本机任意进程伪造头的原始形态）。 */
  cookie?: string
  host?: string
  /** `null` = 不带 Origin（本缺陷的原始形态）。 */
  origin?: string | null
  contentType?: string | null
}

function fakeRequest(method: string, path: string, options: RequestOptions = {}): IncomingMessage {
  const host = options.host ?? AUTHORITY
  const headers: Record<string, string> = { host }
  const origin = options.origin === undefined ? `http://${host}` : options.origin
  if (origin !== null) headers['origin'] = origin
  if (options.cookie !== undefined && options.cookie !== '') headers['cookie'] = options.cookie
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType
  if (contentType !== null) headers['content-type'] = contentType
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body)]
  return {
    method,
    url: path,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk },
  } as unknown as IncomingMessage
}

function fakeResponse(): { res: ServerResponse; read: () => { code: number; body: string } } {
  let body = ''
  const res = {
    statusCode: 200,
    setHeader: () => {},
    end: (chunk?: string) => { body = chunk ?? '' },
  } as unknown as ServerResponse
  return { res, read: () => ({ code: (res as unknown as { statusCode: number }).statusCode, body }) }
}

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface Harness {
  routes: Route[]
  fence: FenceDouble
  installNow: ReturnType<typeof vi.fn<() => void>>
  checkNow: ReturnType<typeof vi.fn<() => void>>
  rendererBoot: ReturnType<typeof vi.fn<(report: unknown) => void>>
  pickDirectory: ReturnType<typeof vi.fn<() => Promise<string | null>>>
}

/** 真实 `apply()`；`connection` 服务按用例注入（未注入 = 服务缺席）。 */
function harness(withFence = true, platform: 'darwin' | 'win32' = 'darwin'): Harness {
  const routes: Route[] = []
  const fence = browserFence()
  const installNow = vi.fn()
  const checkNow = vi.fn()
  const rendererBoot = vi.fn()
  const pickDirectory = vi.fn(async () => '/tmp/picked')
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
    setLocalePreference: () => {},
    setThemeSource: () => {},
    requestRestart: async () => {},
    prepareToQuit: () => {},
    setDeepLinkHandler: () => {},
    setSessionOpenRequestHandler: () => {},
  }
  const ctx = {
    get: (name: string) => {
      if (name === 'desktopRuntime') return runtime
      if (name === 'appExit') return () => {}
      if (name === 'connection') return withFence ? fence : undefined
      return undefined
    },
    webServer: {
      host: '127.0.0.1',
      port: PORT,
      register: (route: Route) => { routes.push(route); return () => {} },
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
  apply(ctx as unknown as Context, {
    productName: 'PicoAide Harness',
    windowTitle: 'PicoAide Harness',
    port: PORT,
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 640,
  } satisfies DesktopConfig)
  return { routes, fence, installNow, checkNow, rendererBoot, pickDirectory }
}

function handlerFor(routes: Route[], path: string): Route['handler'] {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`no route for ${path}`)
  return route.handler
}

async function call(routes: Route[], method: string, path: string, options: RequestOptions = {}): Promise<{ code: number; body: string }> {
  const out = fakeResponse()
  await handlerFor(routes, path)(fakeRequest(method, path, options), out.res)
  await new Promise(resolve => setTimeout(resolve, 0))
  return out.read()
}

const BOOT_REPORT = JSON.stringify({ status: 'failed', plugins: ['dsh-evil'], error: 'forged' })

describe('R4-RV3a desktop:写动作要求持有性证明', () => {
  it('refuses a forged install that omits Origin entirely (the original hole)', async () => {
    const h = harness()
    const out = await call(h.routes, 'POST', DESKTOP_UPDATE_INSTALL_PATH, { origin: null })
    expect(out.code).toBe(403)
    expect(h.installNow).not.toHaveBeenCalled()
  })

  it('refuses forged install/check that fake the same-origin headers', async () => {
    const h = harness()
    const install = await call(h.routes, 'POST', DESKTOP_UPDATE_INSTALL_PATH)
    expect(install.code).toBe(403)
    const check = await call(h.routes, 'POST', DESKTOP_UPDATE_CHECK_PATH, { origin: null })
    expect(check.code).toBe(403)
    expect(h.installNow).not.toHaveBeenCalled()
    expect(h.checkNow).not.toHaveBeenCalled()
    expect(h.fence.seen).toBeGreaterThanOrEqual(2)
  })

  it('drives install and check once the renderer holds the BrowserAuth cookie (no friendly fire)', async () => {
    const h = harness()
    const install = await call(h.routes, 'POST', DESKTOP_UPDATE_INSTALL_PATH, { cookie: REAL_COOKIE })
    expect(install.code).toBe(202)
    expect(JSON.parse(install.body)).toEqual({ accepted: true })
    expect(h.installNow).toHaveBeenCalledOnce()

    const check = await call(h.routes, 'POST', DESKTOP_UPDATE_CHECK_PATH, { cookie: REAL_COOKIE })
    expect(check.code).toBe(202)
    expect(h.checkNow).toHaveBeenCalledOnce()
  })

  it('gates the renderer boot report and the native picker with the same proof', async () => {
    const h = harness(true, 'win32')
    const forgedBoot = await call(h.routes, 'POST', RENDERER_BOOT_REPORT_PATH, { body: BOOT_REPORT, origin: null })
    expect(forgedBoot.code).toBe(403)
    expect(h.rendererBoot).not.toHaveBeenCalled()

    const realBoot = await call(h.routes, 'POST', RENDERER_BOOT_REPORT_PATH, { body: BOOT_REPORT, cookie: REAL_COOKIE })
    expect(realBoot.code).toBe(204)
    expect(h.rendererBoot).toHaveBeenCalledWith({ status: 'failed', plugins: ['dsh-evil'], error: 'forged' })

    const forgedPick = await call(h.routes, 'POST', DESKTOP_DIRECTORY_PICKER_PATH)
    expect(forgedPick.code).toBe(403)
    expect(h.pickDirectory).not.toHaveBeenCalled()

    const realPick = await call(h.routes, 'POST', DESKTOP_DIRECTORY_PICKER_PATH, { cookie: REAL_COOKIE })
    expect(realPick.code).toBe(200)
    expect(JSON.parse(realPick.body)).toEqual({ path: '/tmp/picked' })
  })

  it('keeps the read faces on their existing contract (badge and loop-notify stay readable)', async () => {
    const h = harness()
    const badge = await call(h.routes, 'GET', DESKTOP_UPDATE_PATH, { origin: null })
    expect(badge.code).toBe(200)
    expect(JSON.parse(badge.body).currentVersion).toBe('2.0.0')

    const notify = await call(h.routes, 'GET', DESKTOP_LOOP_NOTIFY_SESSION_PATH, { origin: null })
    expect(notify.code).toBe(200)
  })

  it('fails closed when the connection service is absent (no proof mechanism, no write)', async () => {
    const h = harness(false)
    const out = await call(h.routes, 'POST', DESKTOP_UPDATE_INSTALL_PATH, { cookie: REAL_COOKIE })
    expect(out.code).toBe(503)
    expect(JSON.parse(out.body).error).toBe('browser session proof unavailable')
    expect(h.installNow).not.toHaveBeenCalled()
    // 读面不因证明机制缺席而失效。
    expect((await call(h.routes, 'GET', DESKTOP_UPDATE_PATH)).code).toBe(200)
  })
})

describe('R4-RV3a desktop:等价伪造形态（同族绕过面）', () => {
  it('refuses the localhost spelling with a cookie signed for 127.0.0.1', async () => {
    const h = harness()
    const out = await call(h.routes, 'POST', DESKTOP_UPDATE_INSTALL_PATH, {
      host: `localhost:${String(PORT)}`,
      origin: `http://localhost:${String(PORT)}`,
      cookie: REAL_COOKIE,
    })
    expect(out.code).toBe(403)
    expect(h.installNow).not.toHaveBeenCalled()
  })

  it('refuses cookies signed for another port or with a forged signature', async () => {
    const h = harness()
    for (const cookie of [
      `dsh-auth-127.0.0.1:9999=v1.signature`,
      `dsh-auth-${AUTHORITY}=v1.forged`,
      'dsh-auth-127.0.0.1:43120=',
    ]) {
      const out = await call(h.routes, 'POST', DESKTOP_UPDATE_INSTALL_PATH, { cookie })
      expect(out.code, cookie).toBe(403)
    }
    expect(h.installNow).not.toHaveBeenCalled()
  })

  it('does not let a real cookie rescue a cross-origin Origin', async () => {
    const h = harness()
    const out = await call(h.routes, 'POST', DESKTOP_UPDATE_INSTALL_PATH, {
      origin: 'https://attacker.example',
      cookie: REAL_COOKIE,
    })
    expect(out.code).toBe(403)
    expect(h.installNow).not.toHaveBeenCalled()
  })

  it('does not let a non-POST verb through the write routes', async () => {
    const h = harness()
    expect((await call(h.routes, 'GET', DESKTOP_UPDATE_INSTALL_PATH)).code).toBe(405)
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const out = await call(h.routes, method, DESKTOP_UPDATE_INSTALL_PATH)
      expect([403, 405], method).toContain(out.code)
    }
    expect(h.installNow).not.toHaveBeenCalled()
  })

  it('rejects a forged boot report before it can reach the Host diagnostics', async () => {
    const h = harness()
    const out = await call(h.routes, 'POST', RENDERER_BOOT_REPORT_PATH, {
      body: JSON.stringify({ status: 'healthy' }),
      origin: null,
      contentType: 'application/json',
    })
    expect(out.code).toBe(403)
    expect(h.rendererBoot).not.toHaveBeenCalled()
  })
})

describe('R4-RV3a desktop:直接调用 handler 也不能绕过证明', () => {
  it('fails closed for a caller that wires no proof, and runs once one is wired', async () => {
    const origin = `http://${AUTHORITY}`
    // 未接线（proof=undefined）：503 fail-closed，动作不被驱动。
    const installNow = vi.fn()
    const install = fakeResponse()
    await handleDesktopUpdateInstallRequest(
      fakeRequest('POST', DESKTOP_UPDATE_INSTALL_PATH, { origin: null }),
      install.res,
      origin,
      installNow,
      undefined,
    )
    expect(install.read().code).toBe(503)
    expect(installNow).not.toHaveBeenCalled()

    // 接了 fence 但服务缺席（`() => undefined`）：同样 503。
    const checkNow = vi.fn()
    const check = fakeResponse()
    await handleDesktopUpdateCheckRequest(
      fakeRequest('POST', DESKTOP_UPDATE_CHECK_PATH),
      check.res,
      origin,
      checkNow,
      { fence: () => undefined, label: 'test' },
    )
    expect(check.read().code).toBe(503)
    expect(checkNow).not.toHaveBeenCalled()

    const boot = vi.fn()
    const bootRes = fakeResponse()
    await handleRendererBootRequest(
      fakeRequest('POST', RENDERER_BOOT_REPORT_PATH, { body: JSON.stringify({ status: 'healthy' }), origin: null }),
      bootRes.res,
      origin,
      boot,
      undefined,
    )
    expect(bootRes.read().code).toBe(503)
    expect(boot).not.toHaveBeenCalled()

    const pick = vi.fn(async () => '/tmp/picked')
    const pickRes = fakeResponse()
    await handleDesktopDirectoryPickerRequest(
      fakeRequest('POST', DESKTOP_DIRECTORY_PICKER_PATH),
      pickRes.res,
      origin,
      pick,
      undefined,
    )
    expect(pickRes.read().code).toBe(503)
    expect(pick).not.toHaveBeenCalled()

    // 反向：同一 handler 在证明通过时照常执行（不是把写面整体打死）。
    const okInstall = vi.fn()
    const ok = fakeResponse()
    await handleDesktopUpdateInstallRequest(
      fakeRequest('POST', DESKTOP_UPDATE_INSTALL_PATH),
      ok.res,
      origin,
      okInstall,
      { fence: () => ({ requestRejection: () => undefined }), label: 'test' },
    )
    expect(ok.read().code).toBe(202)
    expect(JSON.parse(ok.read().body)).toEqual({ accepted: true })
    expect(okInstall).toHaveBeenCalledOnce()
  })
})
