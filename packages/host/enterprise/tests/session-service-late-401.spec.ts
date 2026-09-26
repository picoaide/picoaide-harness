/**
 * tests/session-service-late-401.spec.ts — R22-V1-N3 的仓内回归判据。
 *
 * ## 缺陷原形态（第二十二轮独立复审 V1-N3，修复方上一轮已认账 DEFERRED）
 *
 * `SessionService.clear()` 此前是**无条件**清：只看"当前是否持有会话"，不看"这次清
 * 是不是属于当前这一位"。而 auth-gate 里有 13 处"某次请求收到 401 `auth_expired`
 * ⇒ `ctx.picoSession.clear()`"。于是一个**迟到的 401**（旧令牌的在途请求在用户重新
 * 登录之后才失败）会：
 *
 *   内存会话 = null | 磁盘上**刚写下的新令牌**被删
 *
 * —— 用户"刚登录又被登出"，反复重登无效，且界面没有任何解释。
 *
 * ## 判据（双向，缺一条都会让修法失真）
 *
 *  1. **迟到 401 不得清**：真 `SessionService` + 真 auth-gate 路由，先让用旧令牌的
 *     请求挂住，期间完成新登录（新令牌真的落盘），再放行那个属于旧令牌的 401 ⇒
 *     内存里仍是新会话、盘上新令牌仍在，而且**没有**发出 `pico/session-changed(null)`
 *     （发了会让渲染层 tripwire 误判已登出而刷回登录页 —— 那是"不该登出却登出"）；
 *  2. **真失效必须清**：当前令牌收到同一个 401 ⇒ 会话被清、令牌文件被删、事件发出。
 *     这是"401 弹回登录页"那条链，修迟到方向时**绝不能**把它一起关掉；
 *  3. **分流是结构性的**：auth-gate 里由 `auth_expired` 触发的清空**全部**走
 *     `clearIfCurrent(该次请求的令牌)`，无条件 `clear()` 只剩**语义上就是登出**的
 *     两类（用户主动登出、改密后服务端已吊销全部令牌）。数量与相邻上下文都钉住，
 *     防止"只改了一处"或"又加回一处无条件清"。
 *
 * ## 变异验证（拆掉修复必红）
 *
 *  - 13 处 `clearIfCurrent(s.token)` 全改回 `clear()` ⇒ 第 1 组红；
 *  - `clearIfCurrent` 的令牌比对掏空成恒清 ⇒ 第 1 组红（第 2 组仍绿，正是"该登出
 *    必须登出"那一半）。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/auth-gate.ts'
import SessionService, { SESSION_CHANGED_EVENT } from '../src/session-service.ts'
import type { Session } from '../src/server-connector/config.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const AUTH_GATE_SRC = join(SRC, 'auth-gate.ts')

/** 递归列出 `src/` 下的全部 `.ts`（判据失去输入必须红：一个都没有 ⇒ 抛）。 */
function walkSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkSources(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  if (out.length === 0) throw new Error(`读不到任何源码（${dir}）—— 本用例不允许静默通过`)
  return out
}

const OLD: Session = { serverURL: 'https://harness.example', username: 'alice', token: 'OLD-TOKEN', role: 'employee' }
const NEW: Session = { serverURL: 'https://harness.example', username: 'alice', token: 'NEW-TOKEN', role: 'employee' }

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

function fakeReq(url: string, host = '127.0.0.1:3080'): IncomingMessage {
  return {
    method: 'GET', url,
    headers: {
      origin: `http://${host}`, host, 'sec-fetch-site': 'same-origin',
      cookie: `dsh-auth-${host}=v1.signature`,
    },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse, read: () => { code: number, body: unknown } } {
  let code = 0
  let body: unknown
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => { body = chunk === undefined ? undefined : JSON.parse(chunk.toString()) },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

/** 起一套"真 SessionService + 真 auth-gate 路由"的宿主。 */
async function harness(prefix: string): Promise<{
  service: SessionService
  tokenFile: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
  emit: ReturnType<typeof vi.fn>
}> {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const tokenFile = join(dir, 'session.json')
  const routes: Route[] = []
  const emit = vi.fn()
  const ctx = {
    emit,
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection'
      ? { requestRejection: (request: { headers: Record<string, unknown> }) => (request.headers['cookie'] === undefined ? (401 as const) : undefined) }
      : undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    reflect: { provide: vi.fn() },
    on: vi.fn(() => () => {}),
    webServer: { tapIndex: () => () => {}, register: (route: Route) => { routes.push(route); return () => {} } },
  } as unknown as Context
  const service = new SessionService(ctx, { tokenFile })
  ;(ctx as unknown as { picoSession: SessionService }).picoSession = service
  apply(ctx as never, {} as Config)
  const handler = routes.find(r => r.kind === 'prefix' && r.path === '/api/pico/capabilities')?.handler
  if (handler === undefined) throw new Error('capabilities route not registered')
  return { service, tokenFile, handler, emit }
}

describe('R22-V1-N3 迟到 401：旧令牌的响应晚于"新登录"', () => {
  it('不得清掉新会话 / 不得删掉新令牌 / 不得发出"已登出"事件', async () => {
    const { service, tokenFile, handler, emit } = await harness('r22v1-late-401-')

    // ① 登录（旧令牌），并等它真的落盘。
    service.setSession(OLD)  // 旧令牌登录：它的响应稍后会被挂住并当作「迟到 401」放行
    // 等待真实副作用落地（文件 IO / 出站 fetch）：预算 10s 在现象下限之上，逐处理由见这里。
    await vi.waitFor(() => { expect(existsSync(tokenFile)).toBe(true) }, { timeout: 10_000 })

    // ② 起一个用**旧令牌**的请求，网关响应被挂住。
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const seenTokens: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: { headers?: Record<string, string> }) => {
      seenTokens.push(String(init?.headers?.['Authorization'] ?? ''))
      await gate
      return new Response(JSON.stringify({ error: { code: 'AUTH_FAILED', message: '令牌无效或已过期' } }),
        { status: 401, headers: { 'content-type': 'application/json' } })
    }))
    const { res, read } = fakeRes()
    const inFlight = Promise.resolve(handler(fakeReq('/api/pico/capabilities?source=market'), res))

    // ③ 在途期间完成**新登录**（新令牌落盘）。
    await vi.waitFor(() => { expect(seenTokens.length).toBeGreaterThan(0) }, { timeout: 10_000 })
    service.setSession(NEW)  // 在途期间换成新令牌：新会话必须活下来（本用例的主断言）
    // 等待真实副作用落地（文件 IO / 出站 fetch）：预算 10s 在现象下限之上，逐处理由见这里。
    await vi.waitFor(() => {
      expect(JSON.parse(readFileSync(tokenFile, 'utf8'))).toMatchObject({ token: 'NEW-TOKEN' })
    }, { timeout: 10_000 })
    emit.mockClear()

    // ④ 放行那个属于旧令牌的 401。
    release?.()
    await inFlight
    vi.unstubAllGlobals()

    const outcome = read()
    // eslint-disable-next-line no-console
    console.log('[R22 late-401] 请求用的令牌 =', seenTokens[0], '| HTTP =', outcome.code,
      '| 内存会话 =', JSON.stringify(service.getSession()), '| 令牌文件还在 =', existsSync(tokenFile))
    expect(seenTokens[0], '前置：这次请求确实带的是旧令牌').toContain('OLD-TOKEN')
    expect(outcome.code, '401 仍要如实回给这次请求').toBe(401)
    expect(service.getSession(), '旧令牌的 401 不得把刚建立的新会话清掉').toMatchObject({ token: 'NEW-TOKEN' })
    expect(existsSync(tokenFile), '旧令牌的 401 不得删掉新登录写下的令牌文件').toBe(true)
    expect(emit.mock.calls.filter(call => call[0] === SESSION_CHANGED_EVENT && call[1] === null),
      '不得发出"已登出"事件（渲染层 tripwire 会据此刷回登录页）').toEqual([])
  }, 60_000)

  it('反向：当前令牌收到 401 ⇒ 必须清（会话、令牌文件、登出事件三件一起）', async () => {
    const { service, tokenFile, handler, emit } = await harness('r22v1-live-401-')

    service.setSession(NEW)  // 当前令牌登录：它自己收到 401 时必须三件一起清
    // 等待真实副作用落地（文件 IO / 出站 fetch）：预算 10s 在现象下限之上，逐处理由见这里。
    await vi.waitFor(() => { expect(existsSync(tokenFile)).toBe(true) }, { timeout: 10_000 })

    const seenTokens: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: { headers?: Record<string, string> }) => {
      seenTokens.push(String(init?.headers?.['Authorization'] ?? ''))
      return new Response(JSON.stringify({ error: { code: 'AUTH_FAILED', message: '令牌无效或已过期' } }),
        { status: 401, headers: { 'content-type': 'application/json' } })
    }))
    const { res, read } = fakeRes()
    await handler(fakeReq('/api/pico/capabilities?source=market'), res)
    vi.unstubAllGlobals()

    expect(seenTokens[0], '前置：这次请求带的是当前令牌').toContain('NEW-TOKEN')
    expect(read().code).toBe(401)
    expect(service.getSession(), '当前令牌失效必须清会话').toBeNull()
    expect(existsSync(tokenFile), '当前令牌失效必须删掉盘上令牌').toBe(false)
    expect(emit.mock.calls.some(call => call[0] === SESSION_CHANGED_EVENT && call[1] === null),
      '必须发出登出事件（tripwire 据此回登录页）').toBe(true)
  }, 60_000)
})

describe('R22-V1-N3 分流是结构性的：auth_expired 走 clearIfCurrent，登出/改密才无条件清', () => {
  it('13 处 auth_expired 清空全部带令牌；剩下 2 处无条件 clear 是登出与改密', () => {
    const lines = readFileSync(AUTH_GATE_SRC, 'utf8').split('\n')
    const clearAll = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.includes('ctx.picoSession.clear()'))
    const clearIfCurrent = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.includes('ctx.picoSession.clearIfCurrent('))

    expect(clearIfCurrent.length, '13 处 auth_expired 清空必须全部走 clearIfCurrent').toBe(13)
    expect(clearAll.length, '无条件 clear 只允许"语义上就是登出"的那两处').toBe(2)
    for (const site of clearIfCurrent) {
      expect(site.line, 'clearIfCurrent 必须带上本次请求用的令牌').toContain('clearIfCurrent(s.token)')
      const window = lines.slice(Math.max(0, site.index - 8), site.index + 1).join('\n')
      expect(window, `第 ${site.index + 1} 行：clearIfCurrent 必须紧跟在 auth_expired 分支里`).toContain('auth_expired')
    }
    for (const site of clearAll) {
      const window = lines.slice(Math.max(0, site.index - 40), site.index + 1).join('\n')
      const isLogout = window.includes("'/api/client/v2/auth/logout'")
      const isPasswordChange = window.includes('changePassword(')
      expect(isLogout || isPasswordChange,
        `第 ${site.index + 1} 行的无条件 clear 不是登出也不是改密 —— 新加的"因 401 而清"必须走 clearIfCurrent`).toBe(true)
    }
  })

  it('全仓再没有"因 401 而清"的无条件 clear（同族收口：auth-gate 之外的调用面也钉住）', () => {
    // 只改 auth-gate 那 13 处是不够的：同一个签名还出现在 wasm-apps 的每一条出站
    // 路径（`forwardAuthAware` + 分片上传）与 bootstrap 的设置同步上 —— 它们的请求
    // 也带一份**可能已经过期**的会话，也会在用户重登之后才拿到 401。判据因此扫**整个
    // `src/`**：无条件 `picoSession.clear()` 只允许出现在 auth-gate 的登出/改密两处。
    const offenders: string[] = []
    for (const file of walkSources(SRC)) {
      const rel = relative(SRC, file)
      if (rel === 'auth-gate.ts') continue // 上面那条逐点钉住了它的两处无条件清
      const text = readFileSync(file, 'utf8')
      text.split('\n').forEach((line, index) => {
        // 只认**代码行**（注释里提到这个符号不算）。
        if (!line.includes('picoSession.clear()')) return
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return
        offenders.push(`${rel}:${index + 1}`)
      })
    }
    expect(offenders, '因 401/会话失效而清会话必须走 clearIfCurrent（带本次请求的令牌）').toEqual([])

    // 正面：三处同族调用面都真的换成了带令牌的判据。
    const wasmApps = readFileSync(join(SRC, 'wasm-apps.ts'), 'utf8')
    expect(wasmApps, 'wasm 出站路径必须带令牌判定').toContain('ctx.picoSession.clearIfCurrent(session.token)')
    const bootstrap = readFileSync(join(SRC, 'bootstrap.ts'), 'utf8')
    expect(bootstrap, 'bootstrap 的会话同步必须带令牌判定').toContain('ctx.picoSession.clearIfCurrent(session.token)')
  })
})
