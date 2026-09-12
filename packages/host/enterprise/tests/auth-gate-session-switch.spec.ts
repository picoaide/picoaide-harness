import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, loginServerSwitchConflict, type Config } from '../src/auth-gate.ts'
import type { Session } from '../src/server-connector/config.ts'

/**
 * 审计 2026-09-12 P1-3 / FIX-18 回归。
 *
 * 缺陷:`POST /api/pico/auth/login` 在已登录时**无条件** `setSession`,可静默
 * 换掉整个会话(含换到攻击者服务端);而同一个动作在深链路径
 * (`deep-link.ts:112-116`)是显式拒绝的 —— 两条路径判定不一致。
 *
 * 修法:(1) 会话变更类路由要求**持有性证明** —— 复用上游 connection 服务的
 * BrowserAuth(Host/Origin 围栏 + `dsh-auth-*` cookie 验签),不新造机制;
 * (2) `setSession` 前加"已登录且换 server ⇒ 409,先登出"判定(与深链同款)。
 */

/** 让 guard() 放行的最小请求(同源标记 + 回环地址 + 回环 Host)。 */
function fakeRequest(body: unknown, method = 'POST'): IncomingMessage {
  const chunks = [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url: '/api/pico/auth/login',
    headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  } as unknown as IncomingMessage
}

function fakeResponse(): { res: ServerResponse, read: () => { code: number, body: any } } {
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

/** 取会话变更类 handler;fence 为 undefined 表示组合里没有 connection 服务。 */
function loginHandler(
  session: Session | null,
  fence?: { requestRejection: (req: { headers: unknown }) => 401 | 403 | undefined },
): { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>, setSession: ReturnType<typeof vi.fn>, warns: string[] } {
  const h = sessionHarness(session, fence)
  return { handler: h.handler, setSession: h.setSession, warns: h.warns }
}

/**
 * 会话变更类路由的公共 harness:注册**全部** auth-gate 路由(login/password/logout
 * 都要被测),fence 为 undefined 表示组合里没有 connection 服务。
 */
function sessionHarness(
  session: Session | null,
  fence?: { requestRejection: (req: { headers: unknown }) => 401 | 403 | undefined },
): {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  routes: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>
  setSession: ReturnType<typeof vi.fn>
  clear: ReturnType<typeof vi.fn>
  warns: string[]
} {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  const setSession = vi.fn()
  const clear = vi.fn()
  const warns: string[] = []
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection' ? fence : undefined),
    logger: { info: vi.fn(), warn: (m: string) => { warns.push(String(m)) }, error: vi.fn() },
    picoSession: {
      isRestored: () => true,
      isLoggedIn: () => session !== null,
      getSession: () => session,
      setSession,
      clear,
    },
    webServer: {
      tapIndex: () => () => {},
      register: (route: { path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
  }
  apply(ctx as never, {} as Config)
  const handler = routes.get('/api/pico/auth/login')
  expect(handler, 'auth-gate 必须注册 /api/pico/auth/login').toBeDefined()
  return { handler: handler!, routes, setSession, clear, warns }
}

const CURRENT: Session = { serverURL: 'https://harness.example', username: 'alice', token: 'tok-1' }

/** 真页面持有的 BrowserAuth cookie:持有性证明通过(用于验证围栏之外的产品逻辑)。 */
function acceptingFence(): { requestRejection: (req: { headers: unknown }) => undefined } {
  return { requestRejection: vi.fn(() => undefined) }
}

describe('loginServerSwitchConflict(纯函数)', () => {
  it('未登录时永不冲突', () => {
    expect(loginServerSwitchConflict(null, 'https://evil.example')).toBe(false)
  })

  it('同一服务端(含尾斜杠/空白差异)不算切换', () => {
    expect(loginServerSwitchConflict(CURRENT, 'https://harness.example')).toBe(false)
    expect(loginServerSwitchConflict(CURRENT, '  https://harness.example/  ')).toBe(false)
  })

  it('不同服务端 = 冲突(与 deep-link 的 F12 判定同款)', () => {
    expect(loginServerSwitchConflict(CURRENT, 'https://evil.example')).toBe(true)
    expect(loginServerSwitchConflict(CURRENT, 'https://harness.example.evil.com')).toBe(true)
  })

  it('空地址不抢答(交给 login() 报错)', () => {
    expect(loginServerSwitchConflict(CURRENT, '   ')).toBe(false)
  })
})

describe('POST /api/pico/auth/login:已登录时拒绝换服务端(FIX-18)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('已登录 + 换 server ⇒ 409 且绝不 setSession(改前:200 静默换会话)', async () => {
    // 改前该请求会真的去 login() 打网关并 setSession ⇒ 用 stub 让"静默换会话"
    // 可观测:若实现仍然走登录路径,setSession 就会被调用。
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ token: 'attacker-token', user: { role: 'user' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    // 这些用例考的是 409/200 判定本身 ⇒ 用"真页面持有 cookie"的围栏放行
    // (围栏缺席的口径由下一组用例覆盖)。
    const { handler, setSession, warns } = loginHandler(CURRENT, acceptingFence())
    const { res, read } = fakeResponse()
    await handler(fakeRequest({ server: 'https://evil.example', username: 'mallory', password: 'pw' }), res)
    expect(read().code).toBe(409)
    expect(read().body.error).toBe('already signed in to another server')
    expect(setSession).not.toHaveBeenCalled()
    expect(warns.some(w => w.includes('server switch while signed in'))).toBe(true)
  })

  it('已登录 + 同一 server(换账号/改密后重登)照常放行', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ token: 'fresh-token', user: { role: 'user' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    const { handler, setSession } = loginHandler(CURRENT, acceptingFence())
    const { res, read } = fakeResponse()
    await handler(fakeRequest({ server: 'https://harness.example/', username: 'alice', password: 'pw' }), res)
    expect(read().code).toBe(200)
    expect(setSession).toHaveBeenCalledTimes(1)
  })

  it('未登录 + 任意 server 照常放行(不误伤正常登录)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ token: 'tok', user: { role: 'user' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    const { handler, setSession } = loginHandler(null, acceptingFence())
    const { res, read } = fakeResponse()
    await handler(fakeRequest({ server: 'https://any.example', username: 'bob', password: 'pw' }), res)
    expect(read().code).toBe(200)
    expect(setSession).toHaveBeenCalledTimes(1)
  })
})

describe('会话变更类路由的持有性证明(FIX-18)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('缺少 BrowserAuth cookie(本机伪造 Origin 的进程)⇒ 403 且不 setSession', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"token":"t","user":{}}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    // 上游 BrowserAuth:无 cookie ⇒ 401;这里映射为拒付。
    const fence = { requestRejection: vi.fn(() => 401 as const) }
    const { handler, setSession, warns } = loginHandler(null, fence)
    const { res, read } = fakeResponse()
    await handler(fakeRequest({ server: 'https://evil.example', username: 'm', password: 'p' }), res)
    expect(fence.requestRejection).toHaveBeenCalledTimes(1)
    expect(read().code).toBe(403)
    expect(read().body.error).toBe('browser session proof required')
    expect(setSession).not.toHaveBeenCalled()
    expect(warns.some(w => w.includes('without browser proof'))).toBe(true)
  })

  it('持有有效 cookie(真页面)⇒ 放行', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"token":"t","user":{}}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    const fence = { requestRejection: vi.fn(() => undefined) }
    const { handler, setSession } = loginHandler(null, fence)
    const { res, read } = fakeResponse()
    await handler(fakeRequest({ server: 'https://ok.example', username: 'u', password: 'p' }), res)
    expect(read().code).toBe(200)
    expect(setSession).toHaveBeenCalledTimes(1)
  })

  it('组合里没有 connection 服务 ⇒ 高危会话变更 fail-closed(三轮残留②)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"token":"t","user":{}}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    const { handler, setSession, warns } = loginHandler(null, undefined)
    const { res, read } = fakeResponse()
    await handler(fakeRequest({ server: 'https://ok.example', username: 'u', password: 'p' }), res)
    // 改前:200 + setSession(退回只有同源标记的 guard() = fail-open)。
    expect(read().code).toBe(503)
    expect(read().body.error).toBe('browser session proof unavailable')
    expect(setSession).not.toHaveBeenCalled()
    expect(warns.some(w => w.includes('connection service unavailable'))).toBe(true)
  })

  it('connection 缺席 + 已登录换 server ⇒ 503 拒绝(留下的不再是 fail-open 窗口)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"token":"attacker-token","user":{}}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    const { handler, setSession, warns } = loginHandler(CURRENT, undefined)
    const { res, read } = fakeResponse()
    await handler(fakeRequest({ server: 'https://evil.example', username: 'mallory', password: 'pw' }), res)
    expect(read().code).toBe(503)
    expect(setSession).not.toHaveBeenCalled()
    expect(warns.some(w => w.includes('fail-closed'))).toBe(true)
  })

  it('connection 在场时正常路径不回归:登录同 server / 登出 / 改密全部照常', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ token: 't', user: { role: 'user' } }),
    }))
    const fence = { requestRejection: vi.fn(() => undefined) }
    const h = sessionHarness(CURRENT, fence)

    // ① 登录(同一 server,换账号/重登)。
    const login = fakeResponse()
    await h.routes.get('/api/pico/auth/login')!(
      fakeRequest({ server: 'https://harness.example', username: 'alice', password: 'pw' }), login.res)
    expect(login.read().code).toBe(200)
    expect(h.setSession).toHaveBeenCalledTimes(1)

    // ② 改密(旧密码校验通过 ⇒ 服务端已吊销全部令牌 ⇒ 本地清会话)。
    const pwd = fakeResponse()
    await h.routes.get('/api/pico/auth/password')!(
      fakeRequest({ old_password: 'old12345678', new_password: 'new12345678' }), pwd.res)
    expect(pwd.read().code).toBe(200)
    expect(h.clear).toHaveBeenCalledTimes(1)

    // ③ 登出。
    const out = fakeResponse()
    await h.routes.get('/api/pico/auth/logout')!(fakeRequest({}), out.res)
    expect(out.read().code).toBe(200)
    expect(h.clear).toHaveBeenCalledTimes(2)

    // 三条都真的问过持有性证明(不是靠 guard() 蒙过去的)。
    expect(fence.requestRejection).toHaveBeenCalledTimes(3)
  })

  it('持有性证明校验器抛错 ⇒ 按拒绝处理(不泄漏成 500)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"token":"t","user":{}}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    const fence = { requestRejection: vi.fn(() => { throw new Error('host header missing') }) }
    const { handler, setSession, warns } = loginHandler(null, fence)
    const { res, read } = fakeResponse()
    await handler(fakeRequest({ server: 'https://ok.example', username: 'u', password: 'p' }), res)
    expect(read().code).toBe(403)
    expect(setSession).not.toHaveBeenCalled()
    expect(warns.some(w => w.includes('browser proof check failed'))).toBe(true)
  })
})

/**
 * 真 Cordis 上下文:`proofOfPossession` 读的是 `ctx.get('connection')`,
 * 而上游 `connection` 服务名来自 `RpcHost extends Service` 的
 * `super(ctx, 'connection')`(rpc-host.ts:75)。这里用真 Context 提供该服务,
 * 证明**服务查找路径真的通**,而不是只有手搓 stub 才过。
 */
describe('connection 服务查找(真 Cordis Context)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('真 ctx.get("connection") 能取到服务并驱动持有性证明', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"token":"t","user":{}}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    const root = new Context()
    const rejection = vi.fn(() => 401 as const)
    root.provide('connection', { requestRejection: rejection })

    let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    const setSession = vi.fn()
    const ctx = root.extend({
      picoSession: {
        isRestored: () => true,
        isLoggedIn: () => false,
        getSession: () => null,
        setSession,
        clear: vi.fn(),
      },
      webServer: {
        tapIndex: () => () => {},
        register: (route: { path: string, handler: typeof handler }) => {
          if (route.path === '/api/pico/auth/login') handler = route.handler
          return () => {}
        },
      },
    } as never)
    apply(ctx as never, {} as Config)
    const { res, read } = fakeResponse()
    await handler!(fakeRequest({ server: 'https://evil.example', username: 'm', password: 'p' }), res)
    expect(rejection).toHaveBeenCalledTimes(1)
    expect(read().code).toBe(403)
    expect(setSession).not.toHaveBeenCalled()
  })
})

/** 非 desktop 组合(没有 connection 行的 web/base profile)下,`ctx.get` 必须是
 *  安全的 undefined 查询而不是抛错 —— 否则 apply() 当场炸掉整个插件;
 *  且高危会话变更必须 fail-closed(三轮残留②)。 */
describe('connection 缺席(真 Cordis Context)', () => {
  it('ctx.get("connection") 返回 undefined:登录/登出被拒绝,改密维持降级', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"token":"t","user":{}}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    const root = new Context()
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
    const setSession = vi.fn()
    const clear = vi.fn()
    const ctx = root.extend({
      picoSession: {
        isRestored: () => true, isLoggedIn: () => false, getSession: () => null,
        setSession, clear,
      },
      webServer: {
        tapIndex: () => () => {},
        register: (route: { path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
          routes.set(route.path, route.handler)
          return () => {}
        },
      },
    } as never)
    apply(ctx as never, {} as Config)

    // ① 登录(换 server ⇒ 高危):503,绝不 setSession。
    const login = fakeResponse()
    await routes.get('/api/pico/auth/login')!(
      fakeRequest({ server: 'https://ok.example', username: 'u', password: 'p' }), login.res)
    expect(login.read().code).toBe(503)
    expect(setSession).not.toHaveBeenCalled()

    // ② 登出(强制踢出 ⇒ 高危):503,绝不 clear。
    const logout = fakeResponse()
    await routes.get('/api/pico/auth/logout')!(fakeRequest({}), logout.res)
    expect(logout.read().code).toBe(503)
    expect(clear).not.toHaveBeenCalled()

    // ③ 改密:必须先交出旧密码 ⇒ 低危,维持既有降级(不把这条锁死)。
    const login2 = fakeResponse()
    await routes.get('/api/pico/auth/password')!(
      fakeRequest({ old_password: 'old-pass', new_password: 'new-pass' }), login2.res)
    expect(login2.read().code).toBe(401) // 未登录(本用例 session=null),不是 503
  })
})
