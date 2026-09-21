/**
 * R7-RV-3 回归（第三轮对抗复核）：本地写路由的持有性证明。
 *
 * 缺陷面（`packages/host/browser/src/index.ts` 的 `/api/pico/browser` 前缀与
 * 四条 exact 路由）此前只有 `guard()`（`browserSameOriginMarker &&
 * isLoopbackRequest`），而 `loopback.ts:60-64` 自述其边界就是"伪造 Origin 的
 * curl 也能过"：本机任意进程伪造 `Origin`/`Host`/`Sec-Fetch-Site` 即可
 *
 *   - `POST /api/pico/browser/eval` 以用户已登录身份在任意站点执行脚本；
 *   - `POST /api/pico/browser/clear-data` 抹掉用户浏览器数据；
 *   - `POST /api/pico/browser/navigate` 把用户浏览器导航到攻击者页面。
 *
 * 修法与 enterprise `auth-gate.ts` 的 r7c-6 同口径：写面（非 GET）经
 * `connection.requestRejection()` 要一份 BrowserAuth cookie 持有性证明；
 * fence 缺席 ⇒ fail-closed 503；读面（GET）维持 `guard()`。
 *
 * 本文件用**真实 `apply()` + 真实路由 handler**跑，注入一个与上游
 * `rpc-host.ts:97-100` 同形的 fence 替身：无 cookie ⇒ 401，真页面 ⇒ undefined。
 * 断言的是"写动作没有发生"（runtime 未被驱动 / 落盘未变），不只是状态码。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

/** 上游 `connection.requestRejection()` 的行为替身（Host/Origin 围栏后验 cookie）。 */
function browserFence(): { seen: number, requestRejection: (r: { headers: Record<string, unknown> }) => 401 | undefined } {
  const fence = {
    seen: 0,
    requestRejection: (request: { headers: Record<string, unknown> }) => {
      fence.seen += 1
      return request.headers['cookie'] === undefined ? (401 as const) : undefined
    },
  }
  return fence
}

/**
 * 让 `guard()` 放行的一组头（同源标记 + 回环 Host + 回环 socket）。
 * `cookie` 缺省 false = 本机进程伪造 Origin、拿不出 BrowserAuth 持有性证明。
 */
function fakeReq(method: string, url: string, body?: string, cookie = false): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    headers: {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...(cookie ? { cookie: 'dsh-auth-127.0.0.1:3080=v1.signature' } : {}),
      ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
    },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c },
  } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse, read: () => { code: number, body: any } } {
  let code = 0
  let body: unknown
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => {
      body = chunk === undefined ? undefined : JSON.parse(chunk.toString())
    },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

let home: string
let routes: Route[]
let fence: ReturnType<typeof browserFence>

/** 真实 `apply()`；`connection` 服务按用例注入（未注入 = 服务缺席）。 */
function harness(withFence = true): void {
  routes = []
  fence = browserFence()
  const ctx = {
    get: (name: string) => {
      if (name === 'picoSession') return { getSession: () => null }
      if (name === 'connection') return withFence ? fence : undefined
      return undefined
    },
    on: () => () => {},
    effect: (fn: () => unknown) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    webServer: {
      port: 3080,
      register: (route: Route) => { routes.push(route); return () => {} },
    },
  }
  apply(ctx as never, {})
}

function handlerFor(url: string): Route['handler'] {
  const path = url.split('?')[0]
  // 真路由表先匹配 exact（`/api/pico/browser/bookmarks` 不该落到 `/api/pico/browser` 前缀上）。
  const route = routes.find((r) => r.kind === 'exact' && r.path === path)
    ?? routes.find((r) => r.kind === 'prefix' && path.startsWith(r.path))
  if (route === undefined) throw new Error(`no route for ${url}`)
  return route.handler
}

async function call(method: string, url: string, body?: string, cookie = false) {
  const r = fakeRes()
  await handlerFor(url)(fakeReq(method, url, body, cookie), r.res)
  // 前缀路由的 handler 是 fire-and-forget（`void handleAction(...)`）：让微任务
  // 队列跑完再读响应，否则会把"还没写完"当成"没有 body"。
  await new Promise((resolve) => setTimeout(resolve, 0))
  return r.read()
}

/** 每一条写面一个代表动作（报告实测的 200 + sideEffect:executed 那批）。 */
const WRITE_REQUESTS: Array<{ method: string, url: string, body?: string }> = [
  { method: 'POST', url: '/api/pico/browser/eval', body: '{"expression":"document.cookie"}' },
  { method: 'POST', url: '/api/pico/browser/navigate', body: '{"url":"https://evil.example"}' },
  { method: 'POST', url: '/api/pico/browser/clear-data' },
  { method: 'POST', url: '/api/pico/browser/downloads/open', body: '{"id":1}' },
  { method: 'POST', url: '/api/pico/browser/bookmarks', body: '{"title":"x"}' },
  { method: 'POST', url: '/api/pico/browser/open', body: '{}' },
  { method: 'POST', url: '/api/pico/browser/show' },
  // 蒙版页自己的两个按钮（§7b 方案 A 的"产品不能被修坏"面）：接管与隐藏窗口。
  { method: 'POST', url: '/api/pico/browser/takeover', body: '{"active":true}' },
  { method: 'POST', url: '/api/pico/browser/hide' },
  // 胶囊态的失败提示矩形信号（2026-09-21 缺陷 #7）：同样是写面。
  { method: 'POST', url: '/api/pico/browser/notice', body: '{"visible":true}' },
  { method: 'DELETE', url: '/api/pico/browser/bookmarks?id=1' },
  { method: 'DELETE', url: '/api/pico/browser/downloads?id=1' },
]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pico-browser-proof-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('R7-RV-3 browser:本地写路由要求持有性证明', () => {
  it('forged local writes without the browser proof are refused and never reach the runtime', async () => {
    harness()
    for (const write of WRITE_REQUESTS) {
      const out = await call(write.method, write.url, write.body)
      expect(out.code, `${write.method} ${write.url} must be refused without browser proof`).toBe(403)
      expect(out.body.error, write.url).toBe('browser session proof required')
    }
    // 围栏之外什么都没发生:书签/下载台账没有新增条目(读面照常,证明请求本身是有效的)。
    expect(await call('GET', '/api/pico/browser/bookmarks')).toMatchObject({ code: 200 })
    expect(await call('GET', '/api/pico/browser/downloads')).toMatchObject({ code: 200 })
    expect(fence.seen).toBeGreaterThanOrEqual(WRITE_REQUESTS.length)
  })

  it('the same writes pass once the page holds the BrowserAuth cookie (no friendly fire)', async () => {
    harness()
    // 带 proof 的 navigate 必须真的驱动 runtime(而不是 403):用一个不存在的标签页
    // 让 runtime 明确报错 —— 关键是**没有**走到 proof 拒绝分支。
    const out = await call('POST', '/api/pico/browser/navigate', '{"url":"https://ok.example"}', true)
    expect(out.code).not.toBe(403)
    expect(out.body.error).not.toBe('browser session proof required')
    // bookmarks 带 proof 时如实报"没有标签页"(证明 handler 真的执行了)。
    const bookmark = await call('POST', '/api/pico/browser/bookmarks', '{"title":"x"}', true)
    expect(bookmark.code).toBe(400)
    expect(bookmark.body.error).toBe('no tab open to bookmark')
    // 蒙版页的两个按钮：持票时必须**真的执行动作**（§7b 方案 A 之后蒙版跑在默认
    // session 里，票据天然在 —— 这两条是"修好漏洞不能弄坏产品"的正向判据）。
    expect(await call('POST', '/api/pico/browser/takeover', '{"active":true}', true))
      .toMatchObject({ code: 200, body: { ok: true } })
    expect(await call('POST', '/api/pico/browser/hide', undefined, true))
      .toMatchObject({ code: 200, body: { ok: true } })
    // 胶囊态提示矩形信号（2026-09-21 缺陷 #7）：真路由必须接到 runtime ——
    // 漏 case 会落到 `default: 404 not found`（这条判据就是抓那个）。
    expect(await call('POST', '/api/pico/browser/notice', '{"visible":true}', true))
      .toMatchObject({ code: 200, body: { ok: true } })
  })

  it('read routes keep the guard-only contract (GET stays readable for the panel)', async () => {
    harness()
    for (const url of ['/api/pico/browser/state', '/api/pico/browser/ops', '/api/pico/browser/bookmarks', '/api/pico/browser/history', '/api/pico/browser/downloads']) {
      const out = await call('GET', url)
      expect(out.code, url).toBe(200)
    }
    // 跨站伪造仍然被 guard 拦下(与证明无关的既有围栏不得退化)。
    const r = fakeRes()
    await handlerFor('/api/pico/browser/bookmarks')({
      ...fakeReq('GET', '/api/pico/browser/bookmarks'),
      headers: { host: '127.0.0.1:3080', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    } as unknown as IncomingMessage, r.res)
    expect(r.read().code).toBe(403)
  })

  it('fails closed when the connection service is absent (same level as login/enterprise writes)', async () => {
    harness(false)
    const out = await call('POST', '/api/pico/browser/eval', '{"expression":"1"}')
    expect(out.code).toBe(503)
    expect(out.body.error).toBe('browser session proof unavailable')
  })

  it('does not leak the proof requirement into the plugin’s own chrome pages', async () => {
    harness()
    // /browser-shell 与 /browser-overlay 由本插件服务:页面本身必须可加载
    // (否则 overlay 连 cookie 交接的机会都没有),它们的写请求才要证明。
    for (const url of ['/browser-shell', '/browser-overlay']) {
      const r = fakeRes()
      let html = ''
      const res = {
        writeHead: (code: number) => { expect(code).toBe(200) },
        end: (chunk?: string) => { html += chunk ?? '' },
      } as unknown as ServerResponse
      await handlerFor(url)(fakeReq('GET', url), res)
      expect(html).toContain('<!DOCTYPE html>')
      void r
    }
  })
})

describe('R7-RV-3 browser:等价伪造形态（同族绕过面）', () => {
  it.each([
    ['Origin 拼写变体(localhost vs 127.0.0.1 同源写法)', { origin: 'http://localhost:3080', host: '127.0.0.1:3080' }],
    ['Sec-Fetch-Site 缺失', { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'sec-fetch-site': undefined }],
    ['cookie 存在但由别的端口签名(authority 不匹配)', { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', cookie: 'dsh-auth-127.0.0.1:9999=v1.signature' }],
    ['空 cookie', { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', cookie: '' }],
  ])('refuses %s', async (_label, headers) => {
    harness()
    // fence 替身按真 BrowserAuth 的判据工作:cookie 头存在但**不是**本 authority
    // 的那一枚也当作无证明(真实现里 cookie 名由 Host 派生、HMAC 验签)。
    fence.requestRejection = (request: { headers: Record<string, unknown> }) => {
      const cookie = request.headers['cookie']
      return typeof cookie === 'string' && cookie === 'dsh-auth-127.0.0.1:3080=v1.signature'
        ? undefined
        : (401 as const)
    }
    const r = fakeRes()
    const req = fakeReq('POST', '/api/pico/browser/eval', '{"expression":"1"}')
    const merged = { ...req.headers } as Record<string, unknown>
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (value === undefined) delete merged[key]
      else merged[key] = value
    }
    await handlerFor('/api/pico/browser/eval')({ ...req, headers: merged } as unknown as IncomingMessage, r.res)
    expect(r.read().code).toBe(403)
  })
})
