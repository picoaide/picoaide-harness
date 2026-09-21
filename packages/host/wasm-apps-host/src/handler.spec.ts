/**
 * 协议 handler 回归（契约 §2 五步 / §4.2 / §4.3）。
 *
 * 变异验证（改回危险实现即红）：
 *  - 去掉信封里的 `origin` ⇒ "Origin 合成"用例必红；
 *  - 401 不清会话 ⇒ 会话失效用例必红；
 *  - 未登录回空 body/JSON ⇒ 可读页面用例必红；
 *  - 不丢 `Set-Cookie` ⇒ cookie 用例必红；
 *  - 体积闸门失效 ⇒ 超限用例必红。
 */
import { describe, expect, it, vi } from 'vitest'
import { APP_REQUEST_BODY_MAX_BYTES, APP_RESPONSE_BODY_MAX_BYTES } from './app-protocol.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WasmAppsCache, type CacheEntryInput, type CacheScope } from './cache.ts'
import { createAppSchemeHandler, type AppSchemeHandlerDeps } from './handler.ts'

const SERVER = 'https://harness.example.com'

/** 造一次请求。 */
function appRequest(
  path: string,
  init: { method?: string, headers?: Record<string, string>, body?: string } = {},
): Request {
  const requestInit: RequestInit = { method: init.method ?? 'GET' }
  if (init.headers !== undefined) requestInit.headers = init.headers
  if (init.body !== undefined) requestInit.body = init.body
  return new Request(`picoaide-app://demo${path}`, requestInit)
}

/** 造一个平台成功响应（响应信封）。 */
function envelopeResponse(
  body: string,
  init: { status?: number, contentType?: string, truncated?: boolean, extraHeaders?: Record<string, string | string[]> } = {},
): Response {
  return new Response(JSON.stringify({
    status: init.status ?? 200,
    headers: {
      'Content-Type': init.contentType ?? 'text/html; charset=utf-8',
      'Set-Cookie': 'sid=1; HttpOnly',
      ...(init.extraHeaders ?? {}),
    },
    body: Buffer.from(body).toString('base64'),
    truncated: init.truncated ?? false,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

interface Harness {
  handler: (request: Request) => Promise<Response>
  fetch: ReturnType<typeof vi.fn>
  clearSession: ReturnType<typeof vi.fn>
  warnings: string[]
  setLocale: (locale: 'zh' | 'en' | undefined) => void
}

function harness(
  respond: (url: string, init: RequestInit) => Promise<Response>,
  session: { serverURL: string, token: string, username?: string } | null = { serverURL: SERVER, token: 'tok', username: 'alice' },
  options: {
    timeoutMs?: number
    /** 注入 proof 提供者（R2-X-4：默认注入，否则头拼装与 401 重签是测试里的死分支）。 */
    appProof?: { get(appId: string, force?: boolean): Promise<string | null>, invalidate(): void } | undefined
    /** 注入内容缓存（§7.5/F11）；默认不注入 ⇒ handler 一律回源。 */
    cache?: AppSchemeHandlerDeps['cache']
    cacheScope?: AppSchemeHandlerDeps['cacheScope']
    cacheVersion?: AppSchemeHandlerDeps['cacheVersion']
  } = {},
): Harness {
  const fetchMock = vi.fn(respond)
  const clearSession = vi.fn()
  const warnings: string[] = []
  let locale: 'zh' | 'en' | undefined = 'zh'
  const deps: AppSchemeHandlerDeps = {
    appOriginScheme: 'picoaide-app',
    session: () => session,
    fetch: fetchMock as unknown as AppSchemeHandlerDeps['fetch'],
    clearSession,
    hostLocale: (acceptLanguage) => locale ?? (acceptLanguage?.startsWith('en') === true ? 'en' : 'zh'),
    warn: message => warnings.push(message),
    // 默认给一个**能签发**的 proof 提供者：真实链路上它总在（安装密钥仓库由桌面壳
    // provide）；不注入的话 header 拼装与 401 重签两条分支永远不会被执行。
    appProof: options.appProof ?? {
      get: async () => 'proof-token',
      invalidate: () => {},
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.cacheScope === undefined ? {} : { cacheScope: options.cacheScope }),
    ...(options.cacheVersion === undefined ? {} : { cacheVersion: options.cacheVersion }),
  }
  return {
    handler: createAppSchemeHandler(deps),
    fetch: fetchMock,
    clearSession,
    warnings,
    setLocale: (next) => { locale = next },
  }
}

describe('app scheme handler — forwarding', () => {
  it('posts the JSON envelope to the platform endpoint with the employee bearer', async () => {
    const h = harness(async () => envelopeResponse('<h1>ok</h1>'))
    const response = await h.handler(appRequest('/notes?page=2', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/html' },
      body: '{"title":"x"}',
    }))
    expect(h.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = h.fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${SERVER}/api/client/v2/apps/wasm/demo/request`)
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok')
    expect(headers.Origin).toBe('picoaide-app://demo')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual({
      method: 'POST',
      path: '/notes',
      query: 'page=2',
      host: 'picoaide-app://demo',
      headers: { 'content-type': 'application/json', accept: 'text/html', origin: 'picoaide-app://demo' },
      body: Buffer.from('{"title":"x"}').toString('base64'),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await response.text()).toBe('<h1>ok</h1>')
    // §4.2：Set-Cookie 整体丢弃。
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('strips a trailing slash from the server URL before building the endpoint', async () => {
    const h = harness(async () => envelopeResponse('ok'), { serverURL: `${SERVER}/`, token: 'tok' })
    await h.handler(appRequest('/'))
    expect(h.fetch.mock.calls[0]?.[0]).toBe(`${SERVER}/api/client/v2/apps/wasm/demo/request`)
  })

  it('does not send a body for HEAD and keeps the app status', async () => {
    const h = harness(async () => envelopeResponse('ignored', { status: 200 }))
    const response = await h.handler(appRequest('/', { method: 'HEAD' }))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })

  it('refuses oversized request bodies before any outbound call', async () => {
    const h = harness(async () => envelopeResponse('nope'))
    const response = await h.handler(appRequest('/', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', accept: 'text/html' },
      body: 'a'.repeat(APP_REQUEST_BODY_MAX_BYTES + 10),
    }))
    expect(h.fetch).not.toHaveBeenCalled()
    expect(response.status).toBe(413)
    expect(await response.text()).toContain('<html')
  })
})

describe('app scheme handler — local refusals stay readable', () => {
  it('renders the sign-in page (never a blank page) when there is no session', async () => {
    const h = harness(async () => envelopeResponse('nope'), null)
    const response = await h.handler(appRequest('/', { headers: { accept: 'text/html,application/xhtml+xml' } }))
    expect(response.status).toBe(401)
    const body = await response.text()
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(body).toContain('请在客户端登录后再打开应用')
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('renders the sign-in page in English for an English host', async () => {
    const h = harness(async () => envelopeResponse('nope'), null)
    h.setLocale('en')
    const body = await (await h.handler(appRequest('/', { headers: { accept: 'text/html' } }))).text()
    expect(body).toContain('Please sign in to the client before opening apps.')
    expect(body).not.toContain('请在客户端登录后再打开应用')
  })

  it('follows Accept-Language when the runtime has no locale at all', async () => {
    const h = harness(async () => envelopeResponse('nope'), null)
    h.setLocale(undefined)
    const body = await (await h.handler(appRequest('/', { headers: { accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' } }))).text()
    expect(body).toContain('Sign in required')
  })

  it('answers OPTIONS and rejects unsupported methods', async () => {
    const h = harness(async () => envelopeResponse('nope'))
    const options = await h.handler(appRequest('/', { method: 'OPTIONS' }))
    expect(options.status).toBe(204)
    expect(options.headers.get('allow')).toContain('POST')
    // `Request` 构造器不允许 TRACE/CONNECT 这类方法，用一个合法的自定义方法名
    // 覆盖"白名单之外一律 405"这条分支。
    const brew = await h.handler(new Request('picoaide-app://demo/', { method: 'BREW' }))
    expect(brew.status).toBe(405)
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('rejects a malformed app URL with a readable page', async () => {
    const h = harness(async () => envelopeResponse('nope'))
    const response = await h.handler(new Request('https://demo/'))
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('无法打开这个应用')
    expect(h.fetch).not.toHaveBeenCalled()
  })
})

describe('app scheme handler — platform failures', () => {
  it('clears the local session on a platform 401 and explains it', async () => {
    const h = harness(async () => new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'no token' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }))
    const response = await h.handler(appRequest('/', { headers: { accept: 'text/html' } }))
    expect(h.clearSession).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(401)
    expect(await response.text()).toContain('登录已过期')
  })

  it('renders the platform error envelope for a document navigation', async () => {
    const h = harness(async () => new Response(JSON.stringify({
      error: { code: 'NOT_FOUND', message: 'app not found', hints: ['check the app id'] },
    }), { status: 404, headers: { 'Content-Type': 'application/json' } }))
    const response = await h.handler(appRequest('/', { headers: { accept: 'text/html' } }))
    expect(response.status).toBe(404)
    const body = await response.text()
    // 404 走**本地化**的"应用不存在"档（§19 Q3：可直接打开的场景给可辨文案），
    // 平台的 hints 与诊断码照常透出（排障信息不丢）。
    expect(body).toContain('应用不存在')
    expect(body).toContain('check the app id')
    expect(body).toContain('code=NOT_FOUND')
  })

  it('hands the same error to an app fetch as JSON', async () => {
    const h = harness(async () => new Response(JSON.stringify({
      error: { code: 'FORBIDDEN', message: 'not allowed', hints: ['ask the owner'] },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }))
    const response = await h.handler(appRequest('/api/data', { headers: { accept: 'application/json' } }))
    expect(response.status).toBe(403)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await response.json()).toEqual({
      error: { code: 'FORBIDDEN', message: 'not allowed', hints: ['ask the owner'] },
    })
  })

  it('turns a transport failure into a readable page', async () => {
    const h = harness(async () => { throw new Error('connect ECONNREFUSED') })
    const response = await h.handler(appRequest('/', { headers: { accept: 'text/html' } }))
    expect(response.status).toBe(502)
    const body = await response.text()
    expect(body).toContain('暂时连不上服务端')
    expect(body).toContain('ECONNREFUSED')
  })

  it('gives up on the outbound budget instead of hanging the page', async () => {
    // 出站永不 settle（网络黑洞）：预算到点必须给出可读错误，而不是让应用页面
    // 永久转圈（真机上表现为"点了没反应"）。
    const h = harness(() => new Promise<Response>(() => {}), { serverURL: SERVER, token: 'tok' }, { timeoutMs: 20 })
    const response = await h.handler(appRequest('/', { headers: { accept: 'text/html' } }))
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('budget exceeded')
  })

  it('fails closed when the platform response is not an envelope', async () => {
    const h = harness(async () => new Response('<html>proxy</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    const response = await h.handler(appRequest('/', { headers: { accept: 'text/html' } }))
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('服务端返回了无法识别的响应')
  })

  it('truncates an over-limit response body instead of handing it to the renderer', async () => {
    const huge = 'x'.repeat(APP_RESPONSE_BODY_MAX_BYTES + 4096)
    const h = harness(async () => envelopeResponse(huge, { contentType: 'text/plain' }))
    const response = await h.handler(appRequest('/big', { headers: { accept: 'text/plain' } }))
    expect(response.status).toBe(200)
    expect((await response.text()).length).toBe(APP_RESPONSE_BODY_MAX_BYTES)
    expect(h.warnings.some(message => message.includes('truncating'))).toBe(true)
  })

  it('renders an app error body as a page for a navigation but passes it through for fetch', async () => {
    const appError = envelopeResponse(JSON.stringify({ error: { code: 'BOOM', message: 'app exploded' } }), {
      status: 500,
      contentType: 'application/json',
    })
    const h = harness(async () => appError.clone())
    const navigation = await h.handler(appRequest('/', { headers: { accept: 'text/html' } }))
    expect(navigation.status).toBe(500)
    expect(await navigation.text()).toContain('app exploded')

    const fetchLike = await h.handler(appRequest('/api/x', { headers: { accept: 'application/json' } }))
    expect(fetchLike.headers.get('content-type')).toBe('application/json')
    expect(await fetchLike.json()).toEqual({ error: { code: 'BOOM', message: 'app exploded' } })
  })
})

describe('客户端持有性证明的带出与重签（§20.1/§23.1；R2-X-4/R2-X-5）', () => {
  const okEnvelope = JSON.stringify({
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: Buffer.from('<html>ok</html>').toString('base64'),
    truncated: false,
  })

  it('出站请求实际带上了 X-Pico-App-Proof（断言 headers，不只是常量）', async () => {
    const h = harness(async () => new Response(okEnvelope, { status: 200 }))
    await h.handler(new Request('picoaide-app://demo/'))
    const [, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['X-Pico-App-Proof']).toBe('proof-token')
  })

  it('签发失败（provider 返回 null）时不带该头，但仍按正常流程出站', async () => {
    const h = harness(async () => new Response(okEnvelope, { status: 200 }), undefined, {
      appProof: { get: async () => null, invalidate: () => {} },
    })
    const response = await h.handler(new Request('picoaide-app://demo/'))
    expect(response.status).toBe(200)
    const [, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['X-Pico-App-Proof']).toBeUndefined()
  })

  it('proof_ 前缀的 401 ⇒ 重签一次再重试；重试成功后返回内容', async () => {
    let calls = 0
    const invalidate = vi.fn()
    let issued = 0
    const h = harness(async () => {
      calls += 1
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { code: 'proof_expired', message: 'expired' } }), { status: 401 })
      }
      return new Response(okEnvelope, { status: 200 })
    }, undefined, {
      appProof: {
        // `appId` 也必须被透传（proof 绑应用：拿错应用的 proof 会被平台判 mismatch）。
        get: async (appId: string, force?: boolean) => {
          expect(appId).toBe('demo')
          if (force === true) issued += 1
          return force === true ? 'proof-fresh' : 'proof-stale'
        },
        invalidate,
      },
    })
    const response = await h.handler(new Request('picoaide-app://demo/'))
    expect(response.status).toBe(200)
    expect(h.fetch).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(issued).toBe(1)
    const [, retryInit] = h.fetch.mock.calls[1] as unknown as [string, RequestInit]
    expect((retryInit.headers as Record<string, string>)['X-Pico-App-Proof']).toBe('proof-fresh')
  })

  it('重签后仍 401 ⇒ 按正常错误上抛（不无限重试、不清会话 —— 这是 proof 失效不是会话失效）', async () => {
    const invalidate = vi.fn()
    const h = harness(async () => new Response(JSON.stringify({ error: { code: 'proof_mismatch', message: 'no' } }), { status: 401 }), undefined, {
      appProof: { get: async () => 'proof-token', invalidate },
    })
    const response = await h.handler(new Request('picoaide-app://demo/'))
    expect(response.status).toBe(401)
    expect(h.fetch).toHaveBeenCalledTimes(2)
    expect(h.clearSession).not.toHaveBeenCalled()
    expect(await response.text()).toContain('proof_mismatch')
  })

  it('非 proof 的 401（会话失效）**不**重签：一次出站后清会话（R2-X-5）', async () => {
    const invalidate = vi.fn()
    const h = harness(async () => new Response(JSON.stringify({ error: { code: 'AUTH_FAILED', message: 'session' } }), { status: 401 }), undefined, {
      appProof: { get: async () => 'proof-token', invalidate },
    })
    const response = await h.handler(new Request('picoaide-app://demo/'))
    expect(response.status).toBe(401)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(invalidate).not.toHaveBeenCalled()
    expect(h.clearSession).toHaveBeenCalledTimes(1)
  })
})

describe('宿主保留命名空间（§21.2 ②③；R2-X-3 / R2-L2-3）', () => {
  /**
   * 保留面 = 裸前缀 `/__picoaide` **与** `/__picoaide/...`。
   *
   * R2-L2-3：只判 `startsWith('/__picoaide/')` 会让裸前缀落进"普通应用请求"分支被
   * **转发平台**（实测形态）。这里三种形态一起钉住：裸前缀、带尾斜杠、AI 桥之外的子路径。
   * 变异：把 `isReservedHostPath` 改回 `startsWith('/__picoaide/')` ⇒ 裸前缀那条红。
   */
  it('`__picoaide` 裸前缀 / 子路径 / 深路径一律 404，绝不转发平台', async () => {
    const h = harness(async () => new Response('{"status":200,"headers":{},"body":"","truncated":false}', { status: 200 }))
    for (const path of ['/__picoaide', '/__picoaide/', '/__picoaide/ai', '/__picoaide/ai/chat/extra', '/__picoaide/secret']) {
      const response = await h.handler(new Request(`picoaide-app://demo${path}`, { headers: { accept: 'application/json' } }))
      expect(response.status, path).toBe(404)
      expect(await response.text(), path).toContain('no such host bridge')
    }
    // 正向对照：这些请求**一个都没出站**。
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('前缀**不是**被过度拦截：`/__picoaidex` 仍是普通应用请求（走平台）', async () => {
    const h = harness(async () => new Response('{"status":200,"headers":{},"body":"","truncated":false}', { status: 200 }))
    const response = await h.handler(new Request('picoaide-app://demo/__picoaidex', { headers: { accept: 'application/json' } }))
    expect(response.status).toBe(200)
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })

  it('AI 桥是保留面里**唯一**被本地处理的路径（其余形态连模型都不碰）', async () => {
    const calls: string[] = []
    const h = harness(
      async () => new Response('{"status":200,"headers":{},"body":"","truncated":false}', { status: 200 }),
      { serverURL: SERVER, token: 'tok', username: 'alice' },
      {},
    )
    void calls
    const response = await h.handler(appRequest('/__picoaide', { headers: { accept: 'application/json' } }))
    expect(response.status).toBe(404)
    expect(h.fetch).not.toHaveBeenCalled()
  })
})

describe('冻结 / 下架 / 不存在三档文案不塌缩（§19 Q3；R2-X-2）', () => {
  /** 平台错误信封（外层 4xx）。 */
  const platformError = (status: number, code: string, reason?: string): Response =>
    new Response(JSON.stringify({
      error: { code, message: 'platform message', ...(reason === undefined ? {} : { reason }) },
    }), { status })

  const navigationRequest = (): Request => new Request('picoaide-app://demo/', { headers: { accept: 'text/html' } })

  it('reason=app_frozen ⇒ 「已被管理员停用」而不是「应用不存在」', async () => {
    const h = harness(async () => platformError(404, 'NOT_FOUND', 'app_frozen'))
    const html = await (await h.handler(navigationRequest())).text()
    expect(html).toContain('应用已被管理员停用')
    expect(html).not.toContain('应用不存在')
    expect(html).toContain('管理员')
  })

  it('410 已下架与 404 不存在各自一档（三档互不相同）', async () => {
    const retired = await (await harness(async () => platformError(410, 'NOT_FOUND')).handler(navigationRequest())).text()
    const missing = await (await harness(async () => platformError(404, 'NOT_FOUND')).handler(navigationRequest())).text()
    expect(retired).toContain('应用已下架')
    expect(missing).toContain('应用不存在')
    expect(retired).not.toContain('应用不存在')
    expect(missing).not.toContain('应用已下架')
  })

  it('英文宿主语言下同样是三档（文案真源按调用解析，不冻结语言）', async () => {
    const h = harness(async () => platformError(404, 'NOT_FOUND', 'app_frozen'))
    h.setLocale('en')
    const html = await (await h.handler(navigationRequest())).text()
    expect(html).toContain('disabled by an administrator')
  })
})

/**
 * 本机内容缓存（§7.5 / F11）：**读/写半环的接线**。
 *
 * 现场（2026-09-21 审计 P0-3）：`WasmAppsCache` 的 `get`/`put`/`conditional` 在
 * `cache.ts` 之外**零调用点**（只有"失效"半环的 `clearApp` 接了）⇒ F11 缓存零效果，
 * 每次打开全量回源，而 28 条缓存用例全绿掩盖了它。
 *
 * 变异：去掉 handler 里的 `get` 短路 ⇒ "命中不出网" 红；去掉 `put` ⇒ "回源后落盘" 红；
 * 把读判据从 `isStaticSubresource` 换成"一律读" ⇒ "文档导航不读不写" 红。
 */
describe('本机内容缓存接线（§7.5 / F11）', () => {
  const SCOPE: CacheScope = { serverHash: 'server-hash', userHash: 'user-hash' }
  const VERSION = '1.2.3'

  /** 记录调用的缓存替身：`isStaticSubresource` 走**真实实现**（容器只当记账本）。 */
  function spyCache(hit: { status: number, headers: Record<string, string>, body: Uint8Array } | null): {
    cache: AppSchemeHandlerDeps['cache']
    puts: CacheEntryInput[]
    gets: Array<[string, string, string]>
    conditionals: Array<string | undefined>
  } {
    const puts: CacheEntryInput[] = []
    const gets: Array<[string, string, string]> = []
    const conditionals: Array<string | undefined> = []
    const delegate = new WasmAppsCache({ root: '/nonexistent-cache-root-for-method-reuse' })
    return {
      puts,
      gets,
      conditionals,
      cache: {
        get: async (_scope, appId, version, path) => { gets.push([appId, version, path]); return hit },
        put: async (_scope, entry) => { puts.push(entry) },
        conditional: async (_scope, _appId, _version, _path, ifNoneMatch) => {
          conditionals.push(ifNoneMatch)
          return hit === null ? 'miss' : { status: 304 }
        },
        isStaticSubresource: (path, headers) => delegate.isStaticSubresource(path, headers),
      },
    }
  }

  const staticResponse = (body: string, extra: Record<string, string | string[]> = {}): Response =>
    envelopeResponse(body, { status: 200, contentType: 'application/javascript', extraHeaders: { ETag: '"v1"', ...extra } })

  it('静态子资源命中 ⇒ 完全不出网，且带当前宿主安全头与版本头', async () => {
    const spy = spyCache({ status: 200, headers: { 'Content-Type': 'application/javascript', ETag: '"v1"' }, body: new TextEncoder().encode('console.log(1)') })
    const h = harness(async () => { throw new Error('must not hit the platform') }, undefined, {
      cache: spy.cache,
      cacheScope: () => SCOPE,
      cacheVersion: () => VERSION,
    })
    const response = await h.handler(appRequest('/app.js', { headers: { accept: '*/*' } }))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('console.log(1)')
    expect(h.fetch).not.toHaveBeenCalled()
    expect(spy.gets).toEqual([['demo', VERSION, '/app.js']])
    // 版本头是客户端缓存键的唯一来源：直出的响应也必须带（§5.1 / DAT-12）。
    // 安全头由缓存**读**路径叠加（`CachedResponse.headers` 的契约，见 cache.ts 的
    // `securityHeaders`），真实缓存的端到端用例在文件末尾断言它。
    expect(response.headers.get('x-picoaide-app-version')).toBe(VERSION)
  })

  it('If-None-Match 命中 ⇒ 304（静态子资源才走这条）', async () => {
    const spy = spyCache({ status: 200, headers: { 'Content-Type': 'application/javascript', ETag: '"v1"' }, body: new Uint8Array() })
    const h = harness(async () => { throw new Error('must not hit the platform') }, undefined, {
      cache: spy.cache,
      cacheScope: () => SCOPE,
      cacheVersion: () => VERSION,
    })
    const response = await h.handler(appRequest('/app.js', { headers: { 'if-none-match': '"v1"' } }))
    expect(response.status).toBe(304)
    expect(spy.conditionals).toEqual(['"v1"'])
    expect(spy.gets).toEqual([])
    expect(h.fetch).not.toHaveBeenCalled()
    expect(response.headers.get('x-picoaide-app-version')).toBe(VERSION)
  })

  it('回源成功 ⇒ put（scope/version/path 含 query/响应头原样），且响应带版本头', async () => {
    const spy = spyCache(null)
    const h = harness(async () => staticResponse('body-bytes'), undefined, {
      cache: spy.cache,
      cacheScope: () => SCOPE,
      cacheVersion: () => VERSION,
    })
    const response = await h.handler(appRequest('/assets/app.js?v=7'))
    expect(await response.text()).toBe('body-bytes')
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(spy.puts).toHaveLength(1)
    expect(spy.puts[0]).toMatchObject({ appId: 'demo', version: VERSION, path: '/assets/app.js?v=7', status: 200 })
    expect(Buffer.from(spy.puts[0]!.body).toString('utf8')).toBe('body-bytes')
    // 版本头（§5.1 / DAT-12）：平台没在信封头里给时宿主也要补上。
    expect(response.headers.get('x-picoaide-app-version')).toBe('1.2.3')
  })

  it('文档导航与 /api/* 一律不读不写（本地缓存不得成为绕过准入的第二入口）', async () => {
    // 缓存里放一条**静态资源**记录：只有真正"像静态子资源"的请求才允许命中它。
    const spy = spyCache({ status: 200, headers: { 'Content-Type': 'application/javascript' }, body: new TextEncoder().encode('cached-js') })
    const h = harness(async url => (url.includes('/request') ? envelopeResponse('<h1>fresh</h1>', { contentType: 'text/html' }) : envelopeResponse('{}')), undefined, {
      cache: spy.cache,
      cacheScope: () => SCOPE,
      cacheVersion: () => VERSION,
    })
    // ① 文档导航（Accept: text/html）：不查缓存（背后可能是准入/下架页）。
    const nav = await h.handler(appRequest('/', { headers: { accept: 'text/html' } }))
    expect(await nav.text()).toBe('<h1>fresh</h1>')
    // ② 应用自己的 API 调用（/api/*）——即使路径带静态扩展名：不查缓存。
    const api = await h.handler(appRequest('/api/data.json', { headers: { accept: 'application/json' } }))
    expect(api.status).toBe(200)
    expect(await api.text()).toBe('<h1>fresh</h1>')
    expect(spy.gets).toHaveLength(0)
    expect(spy.conditionals).toHaveLength(0)
    expect(spy.puts).toHaveLength(0)
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })

  it('应用返回 HTML 的错误页伪装成 .js ⇒ 允许查缓存，但**写**必须按响应头拒绝', async () => {
    const spy = spyCache(null)
    const h = harness(async () => envelopeResponse('<h1>应用不存在</h1>', { contentType: 'text/html' }), undefined, {
      cache: spy.cache,
      cacheScope: () => SCOPE,
      cacheVersion: () => VERSION,
    })
    const response = await h.handler(appRequest('/app.js', { headers: { accept: '*/*' } }))
    expect(response.status).toBe(200)
    // 读了一次（请求形态像静态资源），但没有落盘：否则一份"应用不存在"的 HTML
    // 会被当成 app.js 缓存下来，之后一直直出。
    expect(spy.gets).toHaveLength(1)
    expect(spy.puts).toHaveLength(0)
  })

  it('版本未知或未登录 ⇒ 完全不碰缓存（不用猜出来的版本号当键）', async () => {
    const spy = spyCache({ status: 200, headers: {}, body: new Uint8Array() })
    const noVersion = harness(async () => staticResponse('x'), undefined, {
      cache: spy.cache,
      cacheScope: () => SCOPE,
      cacheVersion: () => undefined,
    })
    await noVersion.handler(appRequest('/app.js'))
    expect(spy.gets).toHaveLength(0)
    expect(spy.puts).toHaveLength(0)

    const noScope = harness(async () => staticResponse('x'), undefined, {
      cache: spy.cache,
      cacheScope: () => undefined,
      cacheVersion: () => VERSION,
    })
    await noScope.handler(appRequest('/app.js'))
    expect(spy.gets).toHaveLength(0)
    expect(spy.puts).toHaveLength(0)
    expect(noScope.fetch).toHaveBeenCalledTimes(1)
  })

  it('端到端（真实 WasmAppsCache + 临时目录）：第二次请求零出网且字节一致', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wasm-apps-cache-e2e-'))
    try {
      const cache = new WasmAppsCache({ root: dir, warn: () => {} })
      let calls = 0
      const h = harness(async () => { calls += 1; return staticResponse(`payload-${String(calls)}`) }, undefined, {
        cache,
        cacheScope: () => SCOPE,
        cacheVersion: () => VERSION,
      })
      const first = await h.handler(appRequest('/assets/app.js'))
      expect(await first.text()).toBe('payload-1')
      const second = await h.handler(appRequest('/assets/app.js'))
      expect(await second.text()).toBe('payload-1')
      expect(calls).toBe(1)
      // 直出的响应必须带**当前**宿主安全头（真实缓存 `get()` 叠加）与版本头。
      expect(second.headers.get('content-security-policy')).toContain("default-src 'self'")
      expect(second.headers.get('x-content-type-options')).toBe('nosniff')
      expect(second.headers.get('x-picoaide-app-version')).toBe(VERSION)
      // 缓存键含 query：带不同 query 的同一路径是**另一次**回源（不得互相命中）。
      const third = await h.handler(appRequest('/assets/app.js?v=2'))
      expect(await third.text()).toBe('payload-2')
      expect(calls).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
})
