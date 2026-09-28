import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply } from '../src/index.ts'

interface RouteEntry {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

function request(partial: {
  method?: string
  url?: string
  remoteAddress?: string
  host?: string
  origin?: string
  secFetchSite?: string
  cookie?: string
}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (partial.host !== undefined) headers.host = partial.host
  if (partial.origin !== undefined) headers.origin = partial.origin
  if (partial.secFetchSite !== undefined) headers['sec-fetch-site'] = partial.secFetchSite
  if (partial.cookie !== undefined) headers.cookie = partial.cookie
  return {
    method: partial.method ?? 'GET',
    url: partial.url ?? '/api/pico/account/usage',
    headers,
    socket: { remoteAddress: partial.remoteAddress ?? '127.0.0.1' },
  } as unknown as IncomingMessage
}

/** 本机路由的 authority（与 `request()` 缺省 Host 一致）。 */
const AUTHORITY = 'localhost:43120'

/** 上游 `browser-auth` 的 cookie 名（`dsh-auth-<authority>`）。 */
function proofCookie(authority = AUTHORITY): string {
  return `dsh-auth-${authority}=v1.signature`
}

/**
 * 上游 `connection.requestRejection()` 的行为替身（与 desktop/cron 各 spec 里的
 * 同形桩一致）：Host 必须是回环 authority、跨站标记拒绝、Origin 存在时必须等于
 * Host、**必须持本 authority 的 `dsh-auth-*` cookie**。
 */
function browserFence(): { requestRejection: (r: { headers: Record<string, unknown> }) => 401 | 403 | undefined } {
  return {
    requestRejection: (r) => {
      const headers = r.headers
      const host = headers['host']
      if (typeof host !== 'string' || !/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) return 403
      if (headers['sec-fetch-site'] === 'cross-site') return 403
      const origin = headers['origin']
      if (typeof origin === 'string' && new URL(origin).host !== host) return 403
      return headers['cookie'] === proofCookie(host) ? undefined : 401
    },
  }
}

function response(): ServerResponse & { body: string } {
  const res = {
    body: '',
    statusCode: 200,
    writeHead: vi.fn((code: number) => { res.statusCode = code }),
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => { res.body = body ?? '' }),
  }
  return res as unknown as ServerResponse & typeof res
}

function ctxFixture(
  session: { username: string; token: string; serverURL: string } | null,
  options: { fence?: false } = {},
) {
  const events = new Map<string, Set<(payload: unknown) => void>>()
  let registered: RouteEntry | undefined
  const clear = vi.fn(() => { session = null })
  // 真 `SessionService.clearIfCurrent` 的语义（R23-W2-03）：令牌是唯一可用于判断
  // "这一次失败属于哪一代会话"的身份 —— 当前会话的令牌与请求令牌不同就**什么都不做**。
  const clearIfCurrent = vi.fn((token?: string) => {
    if (token === undefined || session === null || session.token !== token) return false
    clear()
    return true
  })
  const fence = browserFence()
  return {
    ctx: {
      picoSession: { getSession: () => session, clear, clearIfCurrent },
      // FIX-42②：持有性证明的 fence 来源。`{ fence: false }` = 服务缺席
      // （fail-closed 503 的那条腿）。
      get: (name: string) => (name === 'connection' && options.fence !== false ? fence : undefined),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      on: vi.fn((event: string, listener: (payload: unknown) => void) => {
        if (!events.has(event)) events.set(event, new Set())
        events.get(event)!.add(listener)
        return () => events.get(event)!.delete(listener)
      }),
      effect: vi.fn((fn: () => void | (() => void)) => {
        const captured = fn()
        // The register effect runs immediately; capture the route.
        void captured
        return () => {}
      }),
      webServer: {
        register: vi.fn((route: RouteEntry) => { registered = route }),
      },
    } as unknown as Context,
    getRoute: () => registered!,
    emit: (event: string, payload: unknown) => { for (const l of [...(events.get(event) ?? [])]) l(payload) },
    sessionCleared: clear,
    clearIfCurrent,
  }
}

describe('account-card host apply', () => {
  it('registers the usage route under the local API prefix', () => {
    const { ctx } = ctxFixture(null)
    apply(ctx)
    expect(ctx.webServer.register).toHaveBeenCalled()
  })

  it('403s cross-origin requests (no data leak even when logged in)', async () => {
    const { ctx, getRoute } = ctxFixture({ username: 'u', token: 't', serverURL: 'https://gw' })
    apply(ctx)
    const res = response()
    await getRoute().handler(request({ host: 'example.com' }), res)
    expect(res.statusCode).toBe(403)
  })

  it('rejects non-GET methods with 405', async () => {
    const { ctx, getRoute } = ctxFixture(null)
    apply(ctx)
    const res = response()
    await getRoute().handler(request({ method: 'POST', host: 'localhost:43120', origin: 'http://localhost:43120' }), res)
    expect(res.statusCode).toBe(405)
  })

  it('returns 401 when not logged in', async () => {
    const { ctx, getRoute } = ctxFixture(null)
    apply(ctx)
    const res = response()
    await getRoute().handler(request({ host: 'localhost:43120', origin: 'http://localhost:43120' }), res)
    expect(res.statusCode).toBe(401)
  })

  it('serves the cached snapshot for a guarded logged-in GET', async () => {
    const { ctx, getRoute } = ctxFixture({ username: 'u', token: 't', serverURL: 'https://gw.example' })
    apply(ctx)
    const res = response()
    await getRoute().handler(request({ host: 'localhost:43120', origin: 'http://localhost:43120' }), res)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { state: string; data: unknown }
    expect(body.state).toBe('idle')
    expect(body.data).toBeNull() // no fetch yet: snapshot is empty
  })

  it('refreshes on session change and clears on logout', () => {
    const { ctx, emit } = ctxFixture(null)
    apply(ctx)
    // First a session login — the service is created inside apply; the
    // refresh path is debounced (300ms default), so we only assert the
    // clear-on-logout behavior observable through the snapshot shape.
    emit('pico/session-changed', null)
    emit('agent/status', { status: 'idle' })
    // No throw is the contract here; detailed coalescing lives in usage-service.test.ts.
    expect(ctx.on).toHaveBeenCalledWith('pico/session-changed', expect.any(Function))
    expect(ctx.on).toHaveBeenCalledWith('agent/status', expect.any(Function))
  })

  // 审计 2026-09-12 P1-5(回归):令牌失效后路由层必须回 401 并清会话,
  // 而不是像改前那样 200 + 旧余额(account-card 注释承诺过该映射,但从未实现)。
  it('令牌失效(?refresh=1 时网关 401)⇒ 401 + 清会话,不再交付旧余额', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: '登录已过期' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { ctx, getRoute, sessionCleared, clearIfCurrent } = ctxFixture({ username: 'u', token: 'expired', serverURL: 'https://gw.example' })
      apply(ctx)
      const res = response()
      await getRoute().handler(
        request({
          url: '/api/pico/account/usage?refresh=1',
          host: AUTHORITY,
          origin: `http://${AUTHORITY}`,
          cookie: proofCookie(),
        }),
        res,
      )
      expect(fetchMock).toHaveBeenCalled()
      expect(res.statusCode).toBe(401)
      expect(JSON.parse(res.body)).toEqual({ error: 'auth expired' })
      // R23-W2-03：清会话必须**带上这次请求用的令牌**（当前令牌就是它 ⇒ 真失效照样清）。
      expect(clearIfCurrent, '真失效方向不得退化，且判据必须是带令牌的那一个').toHaveBeenCalledWith('expired')
      expect(sessionCleared).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // ── FIX-42②（AB1-04）：`?refresh=1` 是**消费型 GET**（立刻往返网关），必须持
  //    持有性证明。修前它的全部防护只有 `guard()`（回环 + 同源标记），而 `loopback.ts`
  //    自述"a curl with a forged Origin passes this too" ⇒ 本机任意进程可无限触发。
  it('?refresh=1 缺持有性证明 ⇒ 403 且**一次网关往返都不发生**（伪造 Origin 的裸 GET）', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ balance_money: 1 }), { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { ctx, getRoute } = ctxFixture({ username: 'u', token: 't', serverURL: 'https://gw.example' })
      apply(ctx)
      const res = response()
      // 伪造 Origin（同源标记满足）+ 无 cookie —— 修前实测 status=200 / gatewayCalls=1。
      await getRoute().handler(
        request({ url: '/api/pico/account/usage?refresh=1', host: AUTHORITY, origin: `http://${AUTHORITY}` }),
        res,
      )
      expect(res.statusCode, '缺证明的消费型 GET 必须被拒').toBe(403)
      expect(JSON.parse(res.body)).toEqual({
        error: 'browser session proof required',
        hint: 'reopen the application window from its launch URL',
      })
      expect(fetchMock, '被拒的请求不得往返网关').not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('持证明的 ?refresh=1 照常往返网关（正常路径不退化）', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        balance_money: 5, balance_activated: true, balance_enabled: true, balance_monthly: 0, balance_mode: 'add',
        is_admin: false, monthly_usage: 0, monthly_cost: 0, today_usage: 0, today_cost: 0,
        yesterday_usage: 0, yesterday_cost: 0, total_usage: 0, total_cost: 0,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { ctx, getRoute } = ctxFixture({ username: 'u', token: 't', serverURL: 'https://gw.example' })
      apply(ctx)
      const res = response()
      await getRoute().handler(
        request({
          url: '/api/pico/account/usage?refresh=1',
          host: AUTHORITY,
          origin: `http://${AUTHORITY}`,
          cookie: proofCookie(),
        }),
        res,
      )
      expect(res.statusCode).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('纯读 GET（不带 ?refresh）不要求证明 —— "GET 读面豁免"这条口径不退化', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { ctx, getRoute } = ctxFixture({ username: 'u', token: 't', serverURL: 'https://gw.example' })
      apply(ctx)
      const res = response()
      await getRoute().handler(
        request({ host: AUTHORITY, origin: `http://${AUTHORITY}` }),
        res,
      )
      expect(res.statusCode, '纯读的缓存快照交付不硬挂证明').toBe(200)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fence 缺席 ⇒ fail-closed 503（不退回同源标记）', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { ctx, getRoute } = ctxFixture({ username: 'u', token: 't', serverURL: 'https://gw.example' }, { fence: false })
      apply(ctx)
      const res = response()
      await getRoute().handler(
        request({
          url: '/api/pico/account/usage?refresh=1',
          host: AUTHORITY,
          origin: `http://${AUTHORITY}`,
          cookie: proofCookie(),
        }),
        res,
      )
      expect(res.statusCode).toBe(503)
      expect(JSON.parse(res.body)).toEqual({
        error: 'browser session proof unavailable',
        hint: 'reopen the application window from its launch URL',
      })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
