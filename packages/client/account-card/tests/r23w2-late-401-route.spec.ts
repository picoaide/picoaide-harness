// @vitest-environment node
/**
 * tests/r23w2-late-401-route.spec.ts — R23-W2-03 的端到端回归判据。
 *
 * ## 缺陷原形态（第二十三轮独立复审 W2-03，P2）
 *
 * `packages/client/account-card/src/index.ts:112` 的余额路由在
 * `snapshot.authExpired` 分支里用**无条件** `clear()` 清会话 —— 而它的注释还把它当
 * "同款"引用（`与 bootstrap.ts / auth-gate.ts 同款`），那两处与 `wasm-apps.ts` 的两处
 * 在本轮之前都已经改成 `clearIfCurrent(那次请求的令牌)`。后果（本轮之前实测）：
 *
 * ```
 * ?refresh=1 往返期间同账号重登（新令牌）⇒ 清空调用=["clear"] | 当前会话=null
 * ```
 *
 * —— 用户**刚登录成功又被弹回登录页**，反复重登无效，且 `$DSH_HOME/session.json`
 * 被删。`?refresh=1` 是账户卡"刷新"按钮那条路径，往返窗口是真实存在的。
 *
 * ## 判据（双向 + 真件，缺一条都会让修法失真）
 *
 *  1. **迟到 401 不得清新会话**：真 `SessionService`（真令牌文件）+ 真 `apply()` +
 *     真路由注册 + 真 `fetchJSON` 链路。请求带旧令牌，`await refreshNow(s)` 期间
 *     同一账号同一服务端重新登录（新令牌**真的落盘**），随后旧令牌的 401 才回来 ⇒
 *     内存会话仍是新的、令牌文件里仍是新令牌、路由回 401（渲染层据此隐藏卡片）；
 *  2. **真失效必须清**：当前令牌收到同一个 401 ⇒ 会话被清、令牌文件被删
 *     （"401 弹回登录页"那条链，修迟到方向时绝不能把它一起关掉）；
 *  3. **同一账号/同一服务端的三个既有守卫全部放行**：这条用例刻意让
 *     `username`/`serverURL` 相同、`owns(s)` 仍为真 —— 否则 401 会从
 *     "session changed" 那条早退分支返回，测不到 `authExpired` 分支。
 *
 * 会话变更事件**不派发**（`ctx.on` 的监听器不会被触发）：这一次请求与重登之间的
 * 窗口远小于插件的 300ms 去抖刷新，判据面是路由自己而不是去抖器；派发反而会引入
 * 一个与本缺陷无关的定时器竞态。
 *
 * ## 变异验证（拆掉修复 ⇒ 本文件红）
 *
 *  - `ctx.picoSession.clearIfCurrent(s.token)` 改回 `clear()` ⇒ 第 1 组红
 *    （会话变 null、令牌文件消失）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import SessionService from '@picoaide/dsh-enterprise/session-service'
import type { Session } from '@picoaide/dsh-enterprise/server-connector/config'
import { apply } from '../src/index.ts'

const SERVER = 'https://harness.example.com'
const OLD: Session = { serverURL: SERVER, username: 'alice', token: 'OLD-TOKEN', role: 'employee' } as Session
const NEW: Session = { serverURL: SERVER, username: 'alice', token: 'NEW-TOKEN', role: 'employee' } as Session

interface RouteEntry {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

const dirs: string[] = []

function request(url: string): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120', 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage
}

function response(): ServerResponse & { body: string } {
  const res = {
    body: '',
    statusCode: 200,
    writeHead: vi.fn((code: number) => { res.statusCode = code }),
    end: vi.fn((body?: string) => { res.body = body ?? '' }),
  }
  return res as unknown as ServerResponse & typeof res
}

/** 轮询等待（`persist` 是异步的：先 await 动态 import，再写盘）。 */
async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
  throw new Error(`等待超时：${what}`)
}

/** 一套"真 SessionService + 真 apply + 真路由"的宿主。 */
async function harness(): Promise<{ service: SessionService, tokenFile: string, route: () => RouteEntry }> {
  const dir = mkdtempSync(join(tmpdir(), 'r23w2-acct-'))
  dirs.push(dir)
  const tokenFile = join(dir, 'session.json')
  let registered: RouteEntry | undefined
  const ctx = {
    emit: () => { /* 不派发：见模块头（去抖刷新与本缺陷无关） */ },
    effect: (fn: () => unknown) => { fn() },
    get: () => undefined,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    reflect: { provide: vi.fn() },
    on: vi.fn(() => () => {}),
    webServer: {
      register: (route: RouteEntry) => {
        if (route.path === '/api/pico/account/usage') registered = route
        return () => { registered = undefined }
      },
    },
  } as unknown as Context
  const service = new SessionService(ctx, { tokenFile })
  ;(ctx as unknown as { picoSession: SessionService }).picoSession = service
  apply(ctx)
  return { service, tokenFile, route: () => registered! }
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 网关回复 401（`fetchJSON` 据此抛 `AuthError('auth_expired')`）。 */
function unauthorized(): Response {
  return new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: '登录已过期' } }), {
    status: 401, headers: { 'content-type': 'application/json' },
  })
}

describe('R23-W2-03：?refresh=1 往返期间同账号重登 ⇒ 迟到 401 不得清掉新会话', () => {
  it('旧令牌的 401 晚于新登录到达：会话与令牌文件都必须完好', async () => {
    const { service, tokenFile, route } = await harness()
    service.setSession(OLD)
    await waitFor(() => existsSync(tokenFile) && readFileSync(tokenFile, 'utf8').includes('OLD-TOKEN'), '旧令牌落盘')

    let relogged = false
    const fetchMock = vi.fn(async () => {
      if (!relogged) {
        relogged = true
        // 同一账号、同一服务端重新登录（新令牌）—— 三个既有守卫全部放行。
        service.setSession(NEW)
        await waitFor(() => readFileSync(tokenFile, 'utf8').includes('NEW-TOKEN'), '新令牌落盘')
      }
      return unauthorized()
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = response()
    await route().handler(request('/api/pico/account/usage?refresh=1'), res)

    expect(relogged, '重登必须发生在这次刷新往返之内（窗口成立）').toBe(true)
    expect(fetchMock).toHaveBeenCalled()
    expect(res.statusCode, '令牌失效照旧回 401（渲染层据此隐藏卡片）').toBe(401)
    expect(JSON.parse(res.body)).toEqual({ error: 'auth expired' })
    expect(service.getSession(), '刚建立的新会话不得被旧令牌的 401 清掉').toMatchObject({ token: 'NEW-TOKEN' })
    expect(existsSync(tokenFile), '$DSH_HOME/session.json 不得被删').toBe(true)
    expect(readFileSync(tokenFile, 'utf8'), '盘上必须仍是新令牌').toContain('NEW-TOKEN')
  }, 60_000)

  it('反向：当前令牌真的失效 ⇒ 必须清（会话、令牌文件一起）', async () => {
    const { service, tokenFile, route } = await harness()
    service.setSession(OLD)
    await waitFor(() => existsSync(tokenFile) && readFileSync(tokenFile, 'utf8').includes('OLD-TOKEN'), '令牌落盘')

    vi.stubGlobal('fetch', vi.fn(async () => unauthorized()))

    const res = response()
    await route().handler(request('/api/pico/account/usage?refresh=1'), res)

    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toEqual({ error: 'auth expired' })
    expect(service.getSession(), '当前令牌的 401 必须清会话（真失效方向不退化）').toBeNull()
    expect(existsSync(tokenFile), '真失效必须连盘上的令牌一起清').toBe(false)
  }, 60_000)
})

describe('R23-W2-03 判据来源：这一处调用点不得退回无条件 clear', () => {
  it('`account-card/src/index.ts` 只允许带令牌的 clearIfCurrent', async () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const code = source.split('\n').filter(line => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith('*') && !trimmed.startsWith('//')
    }).join('\n')
    expect(code, '本文件的会话清空必须带令牌').toContain('ctx.picoSession.clearIfCurrent(s.token)')
    expect(code, '不得再出现无条件 picoSession.clear()').not.toContain('picoSession.clear()')
  })
})
