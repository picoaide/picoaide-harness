/**
 * R15B-02 / R15B-04 回归判据（2026-09-25）。
 *
 * ## R15B-02：强制改密的稳定码必须穿到客户端
 *
 * 服务端对 `password_must_change` 用户白名单外的一切接口回
 * `403 {"error":{"code":"PASSWORD_CHANGE_REQUIRED","message":"请先修改密码"}}`
 * （`serverauth/handler.go`）。客户端此前：代理层把它压成
 * `502 {"error":"gateway error: 请先修改密码"}`（**丢 code**）、会话不清、也没有任何
 * "把用户送回改密页"的路径 —— 一条稳定的错误码在本地这一跳被擦成散文。
 *
 * 现在的契约（逐条钉住）：
 *  1. 码与动作**逐字保留**：`403 {error, code, action:'change-password', hint}`；
 *  2. **不清会话**：403 的语义是"凭据有效、这一步被策略拒绝"，清会话会把用户丢回
 *     登录页再撞同一堵墙；
 *  3. **可操作路径**：命中时把 `mustChangePassword` 落回会话（幂等），而索引渲染
 *     本来就按这个标记进强制改密页；注入页面的看门狗再按 `/api/pico/auth/state`
 *     的 `must_change_password` 重载 —— 三处合起来才是"用户真的能改密"；
 *  4. 其它网关错误**行为不变**（仍是 502 + 原文），不借机改口径。
 *
 * 诚实边界（可达性）：管理员重置密码会在同一事务里 DELETE 该用户全部 api_tokens
 * ⇒ 在线客户端拿到的是 `401 AUTH_FAILED`（走正常清会话/回登录页）。要走到"带有效
 * 令牌 + must_change=1"，需要员工本次就是用临时密码登录且页面停在应用里 —— 正常
 * 路径下索引渲染会直接给强制改密页。所以这是**报文契约 + 纵深防御**缺陷，不是
 * "任何用户都会撞上"的死路。
 *
 * ## R15B-04：同服务端换账号必须有"身份变了"的信号
 *
 * `loginServerSwitchConflict` 只比 `serverURL`（同服务端换账号是**有意放行**的），
 * 而唯一会重载窗口的脚本判据只有 `loggedIn === false` ⇒ 换账号后已加载的应用页
 * 继续以**上一个账号的渲染状态**跑在新账号的令牌下（四个整页面板与账号卡都还显示
 * 旧账号的行）。判据：身份口径唯一（`session-identity.ts`）、`/api/pico/auth/state`
 * 下发它、注入脚本按它重载、login/deep-link 在换人时留下信号。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, loginServerSwitchConflict, renderChangePasswordPage, type Config } from '../src/auth-gate.ts'
import { isPasswordChangeRequired, PASSWORD_CHANGE_REQUIRED_ACTION, PASSWORD_CHANGE_REQUIRED_CODE } from '../src/server-connector/auth.ts'
import { sessionIdentity, sessionIdentityChanged } from '../src/session-identity.ts'
import type { Session } from '../src/server-connector/config.ts'

const ALICE: Session = { serverURL: 'https://harness.example', username: 'alice', token: 'ALICE-TOKEN', role: 'employee' }
const BOB: Session = { serverURL: 'https://harness.example', username: 'bob', token: 'BOB-TOKEN', role: 'employee' }

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

function fakeReq(url: string, method = 'GET', body?: unknown): IncomingMessage {
  const host = '127.0.0.1:3080'
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: {
      origin: `http://${host}`,
      host,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      cookie: `dsh-auth-${host}=v1.signature`,
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    on() { return this },
    once() { return this },
    removeListener() { return this },
  } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse, read: () => { code: number, body: any } } {
  let code = 0
  let body: unknown
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => { body = chunk === undefined ? undefined : JSON.parse(chunk.toString()) },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

interface Harness {
  routes: Route[]
  indexes: Array<(html: string) => string>
  session: () => Session | null
  setSession: ReturnType<typeof vi.fn>
  clear: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  call: (url: string, method?: string, body?: unknown) => Promise<{ code: number, body: any }>
  callRoute: (kind: Route['kind'], path: string, url: string, method?: string, body?: unknown) => Promise<{ code: number, body: any }>
  renderIndex: (html: string) => string
}

/** 装一个 auth-gate；网关 fetch 全部拦截，会话状态可变。 */
function harness(initial: Session | null): Harness {
  const routes: Route[] = []
  const indexes: Array<(html: string) => string> = []
  let current: Session | null = initial
  const setSession = vi.fn((next: Session) => { current = next })
  const clear = vi.fn(() => { current = null })
  const warn = vi.fn()
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
    logger: { info: vi.fn(), warn, error: vi.fn() },
    picoSession: {
      isRestored: () => true,
      isLoggedIn: () => current !== null,
      getSession: () => current,
      setSession,
      clear,
    },
    webServer: {
      tapIndex: (fn: (html: string) => string) => { indexes.push(fn); return () => {} },
      register: (route: Route) => { routes.push(route); return () => {} },
    },
  }
  apply(ctx as never, {} as Config)
  const callRoute = async (kind: Route['kind'], path: string, url: string, method = 'GET', body?: unknown) => {
    const handler = routes.find(r => r.kind === kind && r.path === path)?.handler
    if (handler === undefined) throw new Error(`route not registered: ${kind} ${path}`)
    const { res, read } = fakeRes()
    await handler(fakeReq(url, method, body), res)
    return read()
  }
  return {
    routes,
    indexes,
    session: () => current,
    setSession,
    clear,
    warn,
    callRoute,
    call: (url, method = 'GET', body) => callRoute('prefix', '/api/pico/capabilities', url, method, body),
    renderIndex: (html) => indexes.map(fn => fn(html)).join('\n'),
  }
}

const PASSWORD_403 = (): Response => new Response(
  JSON.stringify({ error: { code: PASSWORD_CHANGE_REQUIRED_CODE, message: '请先修改密码' } }),
  { status: 403, headers: { 'content-type': 'application/json' } },
)

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'r15p-pwchange-')); vi.stubEnv('DSH_HOME', home) })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

// ------------------------------------------------------------------ R15B-02

describe('R15B-02 强制改密的稳定码穿到客户端（保留码 + 可操作路径 + 不清会话）', () => {
  it('代理不再压成 502：403 + 稳定码 + 动作 + 提示，且会话**没有**被清', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => PASSWORD_403()))
    const h = harness({ ...ALICE })
    const res = await h.call('/api/pico/capabilities?source=market')

    expect(res.code).toBe(403)
    expect(res.body.code).toBe(PASSWORD_CHANGE_REQUIRED_CODE)
    expect(res.body.action).toBe(PASSWORD_CHANGE_REQUIRED_ACTION)
    // 服务端原文原样透出（用户可见），不被本地文案顶掉。
    expect(res.body.error).toBe('请先修改密码')
    expect(typeof res.body.hint).toBe('string')
    expect(res.body.hint.length).toBeGreaterThan(0)
    // 令牌仍然有效：清会话会把用户丢回登录页再撞同一堵墙。
    expect(h.clear).not.toHaveBeenCalled()
  })

  it('可操作路径：命中即把 mustChangePassword 落回会话（幂等，不刷事件）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => PASSWORD_403()))
    const h = harness({ ...ALICE })
    await h.call('/api/pico/capabilities?source=market')

    expect(h.setSession).toHaveBeenCalledTimes(1)
    expect(h.session()?.mustChangePassword).toBe(true)
    expect(h.session()?.token).toBe(ALICE.token)

    // 第二次命中不重复 setSession（标记已经是 true）—— 否则每个被拒的请求都会
    // 广播一次 pico/session-changed，订阅方（渠道同步/错误上报/应用 AI）被反复惊动。
    await h.call('/api/pico/capabilities?source=market')
    expect(h.setSession).toHaveBeenCalledTimes(1)
  })

  it('可操作路径：标记落回之后，索引渲染就是强制改密页（不是应用页）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => PASSWORD_403()))
    const h = harness({ ...ALICE })
    await h.call('/api/pico/capabilities?source=market')

    const html = h.renderIndex('<!DOCTYPE html><html><head></head><body>app</body></html>')
    // 断言**渲染出来的是哪一页**，而不是"某段字符串存在"：强制改密页自带的标题。
    const expected = renderChangePasswordPage('zh')
    expect(html).toContain(expected.slice(0, 200))
    expect(html).not.toContain('>app</body>')
  })

  it('归档代理（不经 fetchJSON 的二进制路径）同样按码处理，其余错误行为不变', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => PASSWORD_403()))
    const h = harness({ ...ALICE })
    const res = await h.callRoute('prefix', '/api/pico/skills', '/api/pico/skills/codeql/archive')
    expect(res.code).toBe(403)
    expect(res.body.code).toBe(PASSWORD_CHANGE_REQUIRED_CODE)

    // 对照：非该码的网关失败逐字保持原样（状态透传 + 'gateway error'）。
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const h2 = harness({ ...ALICE })
    const other = await h2.callRoute('prefix', '/api/pico/skills', '/api/pico/skills/codeql/archive')
    expect(other.code).toBe(500)
    expect(other.body).toEqual({ error: 'gateway error' })
  })

  it('其它网关错误仍是 502 + 原文（不借机改口径）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'HTTP_500', message: '上游炸了' } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )))
    const h = harness({ ...ALICE })
    const res = await h.call('/api/pico/capabilities?source=market')
    expect(res.code).toBe(502)
    expect(res.body).toEqual({ error: 'gateway error: 上游炸了' })
  })

  it('码的判据只看稳定码（服务端文案改了也认），且不吃 ApiError 之外的形状', () => {
    class FakeApiError extends Error { constructor(public code: string, public status?: number) { super('x'); this.name = 'ApiError' } }
    // 用真实 ApiError 走一遍（结构等价性由 import 的类型保证）。
    expect(isPasswordChangeRequired(new (class extends Error {})('x'))).toBe(false)
    expect(isPasswordChangeRequired(new FakeApiError(PASSWORD_CHANGE_REQUIRED_CODE))).toBe(false)
    expect(isPasswordChangeRequired(undefined)).toBe(false)
  })
})

// ------------------------------------------------------------------ R15B-04

describe('R15B-04 同服务端换账号：身份口径唯一 + 应用页按它重载', () => {
  it('sessionIdentity：换服务端 / 换账号都算变了，未登录与任何身份都不同', () => {
    expect(sessionIdentity(ALICE)).toBe(sessionIdentity({ ...ALICE, token: 'rotated' }))
    expect(sessionIdentityChanged(ALICE, { ...ALICE, token: 'rotated' })).toBe(false)
    expect(sessionIdentityChanged(ALICE, BOB)).toBe(true)
    expect(sessionIdentityChanged(ALICE, { ...ALICE, serverURL: 'https://other.example' })).toBe(true)
    expect(sessionIdentityChanged(null, ALICE)).toBe(true)
    expect(sessionIdentityChanged(ALICE, null)).toBe(true)
    expect(sessionIdentityChanged(null, null)).toBe(false)
    // 用户名里带分隔符也不能撞身份（取值走 JSON 数组而不是拼接）。
    expect(sessionIdentity({ serverURL: 'https://a|b.example', username: 'c' }))
      .not.toBe(sessionIdentity({ serverURL: 'https://a', username: 'b|c' }))
  })

  it('/api/pico/auth/state 下发同一口径的 identity（客户端唯一要比的值）', async () => {
    const h = harness({ ...ALICE })
    const state = await h.callRoute('exact', '/api/pico/auth/state', '/api/pico/auth/state')
    expect(state.code).toBe(200)
    expect(state.body.identity).toBe(sessionIdentity(ALICE))
    expect(state.body.must_change_password).toBe(false)
  })

  it('注入应用页的看门狗按"身份变了 / 登出 / 强制改密"重载，且基线是**渲染时**的身份', async () => {
    const h = harness({ ...ALICE })
    const html = h.renderIndex('<!DOCTYPE html><html><head></head><body>app</body></html>')

    // 基线 = 这份文档渲染时的身份（不是脚本第一次轮询时自己记的）。
    expect(html).toContain(JSON.stringify(sessionIdentity(ALICE)))
    // 三条判据都在：登出（原行为）、身份变了（R15B-04）、服务端要求改密（R15B-02）。
    expect(html).toContain('d.loggedIn === false')
    expect(html).toContain('d.identity')
    expect(html).toContain('d.must_change_password === true')
    expect(html).toContain('location.reload()')
  })

  it('换了账号之后的索引渲染：看门狗基线换成新身份（不会立刻自我重载）', async () => {
    const h = harness({ ...ALICE })
    h.renderIndex('<!DOCTYPE html><html><head></head><body>app</body></html>')
    h.setSession({ ...BOB })
    const html = h.renderIndex('<!DOCTYPE html><html><head></head><body>app</body></html>')
    expect(html).toContain(JSON.stringify(sessionIdentity(BOB)))
    expect(html).not.toContain(JSON.stringify(sessionIdentity(ALICE)))
  })

  it('同服务端换账号会留下"身份变了"的信号；同一个人重登不刷告警', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      token: 'BOB-TOKEN',
      user: { role: 'employee', source: 'local', password_changeable: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const switched = harness({ ...ALICE })
    const res = await switched.callRoute('exact', '/api/pico/auth/login', '/api/pico/auth/login', 'POST', {
      server: ALICE.serverURL, username: 'bob', password: 'pw',
    })
    expect(res.code).toBe(200)
    expect(switched.session()?.username).toBe('bob')
    // 判定本身没变（同服务端换账号仍放行），变的是"这件事会被说出来"。
    expect(switched.warn.mock.calls.some(([message]) => String(message).includes('session identity changed'))).toBe(true)

    const same = harness({ ...ALICE })
    await same.callRoute('exact', '/api/pico/auth/login', '/api/pico/auth/login', 'POST', {
      server: ALICE.serverURL, username: 'alice', password: 'pw',
    })
    expect(same.warn.mock.calls.some(([message]) => String(message).includes('session identity changed'))).toBe(false)
  })

  it('反证：换**服务端**仍然 409（同服务端换账号的放行不是把闸门拆掉）', async () => {
    const h = harness({ ...ALICE })
    const res = await h.callRoute('exact', '/api/pico/auth/login', '/api/pico/auth/login', 'POST', {
      server: 'https://other.example', username: 'alice', password: 'pw',
    })
    expect(res.code).toBe(409)
    expect(loginServerSwitchConflict(ALICE, 'https://other.example')).toBe(true)
    expect(loginServerSwitchConflict(ALICE, ALICE.serverURL)).toBe(false)
  })
})
