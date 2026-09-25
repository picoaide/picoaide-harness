// @vitest-environment node
/**
 * 回归（R16B-01，第十六轮审计泳道 B，P1）：**同服务端换号后，本机路由不得交付
 * 上一个账号的余额。**
 *
 * 缺陷形态（修前实测）：`pico/session-changed` 只在 `next === null`（登出）时
 * `service.clear()`；换号（A→B，不经登出）只排一次 **300ms 尾随去抖**的
 * `service.refresh(B)`，而 `refreshNow()` 只把 `state` 置 `loading` 却**保留
 * `data`** ⇒ 去抖窗口内 `GET /api/pico/account/usage` 回 `200` + **A 的金额**，
 * 账户卡把它渲染在 B 的名字下（跨账号金额交付）。P2-22 那条守卫比较的是"请求开始
 * 时"与"刷新后"的会话 —— 换号后两边**都已经是 B**，抓不到"快照还是 A 取的"。
 *
 * 本用例**不 mock 被测层**：真 `http` server 装真路由 + 真 `apply()` + 真
 * `UsageService` + 真 `fetchJSON` 打到另一个真 http server 当"网关"（只替换网关
 * 那一侧的数据）。判据是**应有行为**，不是"代码长什么样"：
 *   ① 换号后到 B 的余额取回来之前，路由**不得**交付 A 的金额（401 或 `data=null`）；
 *   ② 换号后立刻走的手动 `?refresh=1` 也不得交付 A 的金额；
 *   ③ 交付出去的快照必须**盖着当前会话的身份章**（`sessionIdentity`，唯一实现）。
 *
 * ---- 变异验证（实跑过，逐条单独一次调用）----
 *   - 去掉 `UsageService.adopt()`（换号不丢 `data`）⇒ ① 红；
 *   - 去掉路由里的 `service.owns(s)` 守卫 ⇒ ① 红（`adopt` 仍在，但"另一账号的
 *     快照"这条兜底没了）；
 *   - 只在 `next === null` 时清快照（回到修前形态）⇒ ① 红。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionIdentity } from '@picoaide/dsh-enterprise/session-identity'
import { apply } from '../src/index.ts'

const USAGE_KEYS = {
  balance_money: 0,
  balance_activated: true,
  balance_enabled: true,
  balance_monthly: 0,
  balance_mode: 'add',
  is_admin: false,
  monthly_usage: 0,
  monthly_cost: 0,
  today_usage: 0,
  today_cost: 0,
  yesterday_usage: 0,
  yesterday_cost: 0,
  total_usage: 0,
  total_cost: 0,
}

interface ProbeSession {
  serverURL: string
  username: string
  token: string
}

interface Harness {
  /** 本机路由地址（`/api/pico/account/usage`）。 */
  base: string
  /** 假网关地址（会话里的 serverURL）。 */
  serverURL: string
  /** 当前会话（可变：换号就是改这里 + 触发 session-changed）。 */
  session: ProbeSession | null
  /** 触发一次会话变更事件（真插件注册的那个监听器）。 */
  emitSession: (session: ProbeSession | null) => void
  /** 网关侧每个 token 收到的请求次数（证明"确实打到了网关"）。 */
  gatewayHits: Map<string, number>
  close: () => Promise<void>
}

/** 起两个真 http server：一个当网关，一个装本机路由。 */
async function harness(): Promise<Harness> {
  const gatewayHits = new Map<string, number>()
  // ---- 网关（假数据，真 HTTP）----
  const gateway: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== '/api/client/v2/auth/usage') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no such path' } }))
      return
    }
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /u, '')
    gatewayHits.set(token, (gatewayHits.get(token) ?? 0) + 1)
    // alice 的余额 11，bob 的 22（分位）。
    const balance = token === 'token-alice' ? 11 : token === 'token-bob' ? 22 : 0
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ...USAGE_KEYS, balance_money: balance }))
  })
  await new Promise<void>((resolve) => { gateway.listen(0, '127.0.0.1', resolve) })
  const serverURL = `http://127.0.0.1:${String((gateway.address() as { port: number }).port)}`

  // ---- 本机路由（真插件注册的 handler）----
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void> | void) | null = null
  const local: Server = createServer((req, res) => {
    if (handler === null) { res.writeHead(500); res.end('no handler'); return }
    void Promise.resolve(handler(req, res)).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end('handler threw') } })
  })
  await new Promise<void>((resolve) => { local.listen(0, '127.0.0.1', resolve) })
  const localPort = (local.address() as { port: number }).port

  const state: Harness = {
    base: `http://127.0.0.1:${String(localPort)}`,
    serverURL,
    session: null,
    gatewayHits,
    emitSession: () => { throw new Error('not wired yet') },
    close: async () => {
      await new Promise<void>((resolve) => { local.close(() => { resolve() }) })
      await new Promise<void>((resolve) => { gateway.close(() => { resolve() }) })
    },
  }

  const listeners = new Map<string, (payload: unknown) => void>()
  const ctx = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    on: (event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
    effect: (fn: () => unknown) => fn(),
    get: () => undefined,
    picoSession: {
      getSession: () => state.session,
      clear: () => { state.session = null },
    },
    webServer: {
      register: (route: { path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void }) => {
        if (route.path === '/api/pico/account/usage') handler = route.handler
        return () => { handler = null }
      },
    },
  }
  apply(ctx as never)
  state.emitSession = (session) => {
    const listener = listeners.get('pico/session-changed')
    if (listener === undefined) throw new Error('the plugin did not register a session-changed listener')
    listener(session)
  }
  return state
}

interface UsageAnswer {
  status: number
  body: { data?: unknown, error?: string, identity?: string }
}

/** 打本机路由（真 socket；Host/Origin 都是 loopback 同源 ⇒ 过守卫）。 */
async function getUsage(base: string, force = false): Promise<UsageAnswer> {
  const response = await fetch(`${base}/api/pico/account/usage${force ? '?refresh=1' : ''}`, {
    headers: { Origin: base, accept: 'application/json' },
  })
  const text = await response.text()
  let body: UsageAnswer['body']
  try { body = JSON.parse(text) as UsageAnswer['body'] } catch { body = { error: text } }
  return { status: response.status, body }
}

const sleep = async (ms: number): Promise<void> => { await new Promise<void>((resolve) => { setTimeout(resolve, ms) }) }

let current: Harness | null = null
afterEach(async () => { if (current !== null) { await current.close(); current = null } })

/** 余额的可判定读法：路由回 200 且 data 里的 balance_money。 */
function balanceOf(result: UsageAnswer): number | 'none' {
  const data = result.body.data
  if (result.status !== 200 || data === null || typeof data !== 'object') return 'none'
  const value = (data as { balance_money?: unknown }).balance_money
  return typeof value === 'number' ? value : 'none'
}

describe('R16B-01：换号后本机路由不得交付上一个账号的余额', () => {
  it('A→B 换号后（300ms 去抖窗口内）GET 不得回 A 的金额；去抖到期后交付 B 的', async () => {
    const h = await harness()
    current = h

    // 1) 登录 alice：拿一次余额（真 HTTP 到网关）。
    h.session = { serverURL: h.serverURL, username: 'alice', token: 'token-alice' }
    h.emitSession(h.session)
    await sleep(600)
    const alice = await getUsage(h.base)
    expect(balanceOf(alice), 'alice 自己的余额应当能取到（前置条件）').toBe(11)
    expect(alice.body.identity, '交付的快照必须盖着 alice 的身份章').toBe(sessionIdentity(h.session))
    expect(h.gatewayHits.get('token-alice')).toBe(1)

    // 2) 同服务端换号到 bob（不经登出）—— R15B-04 明确允许的路径。
    h.session = { ...h.session, username: 'bob', token: 'token-bob' }
    h.emitSession(h.session)

    // 3) 在 300ms 去抖窗口内（+100ms）读本机路由：账户卡 10s 轮询与"刷新"按钮
    //    都会走的同一跳。**不得**回 alice 的金额。
    await sleep(100)
    const during = await getUsage(h.base)
    expect(
      balanceOf(during),
      '换号后到 B 的余额取回来之前，路由交付了 A 的余额（应为 401 或 data=null）',
    ).not.toBe(11)

    // 4) 同一个窗口内的手动刷新（`?refresh=1` 会立刻往返网关）同样不得交付 A 的。
    h.session = { ...h.session, username: 'carol', token: 'token-carol' }
    h.emitSession(h.session)
    const forced = await getUsage(h.base, true)
    expect(balanceOf(forced), '换号后立刻手动刷新，交付了上一个账号的余额').toBe(0)

    // 5) 去抖到期后自愈（证明缺陷曾经是窗口性的，不是永久性的）。
    await sleep(700)
    const after = await getUsage(h.base)
    expect(balanceOf(after), 'carol 自己的余额最终应当取到').toBe(0)
    expect(h.gatewayHits.get('token-carol') ?? 0).toBeGreaterThan(0)

    // 6) 回到 bob：他的余额是 22，且身份章必须跟着变。
    h.session = { serverURL: h.serverURL, username: 'bob', token: 'token-bob' }
    h.emitSession(h.session)
    await sleep(700)
    const bob = await getUsage(h.base)
    expect(balanceOf(bob), 'bob 自己的余额最终应当取到').toBe(22)
    expect(bob.body.identity, '身份章必须跟着换号走').toBe(sessionIdentity(h.session))
  }, 30_000)

  /**
   * 事件**迟到/没到**的那一半：`pico/session-changed` 的回调要排队（它先
   * `teardownAll` 再 `syncServerDefs` 再 `reconfigureUser`，中间是一次网络往返），
   * 而 HTTP 路由不在那条队列里。所以"会话服务已经指向 B、事件还没跑完"是一个真实
   * 窗口 —— 此时快照仍是 A 的，路由必须靠 `service.owns(s)` 自己拒绝，不能指望
   * "换号任务已经把快照作废了"。
   */
  it('会话服务已切到 B 而 session-changed 尚未到达 ⇒ 路由仍不得交付 A 的快照', async () => {
    const h = await harness()
    current = h

    h.session = { serverURL: h.serverURL, username: 'alice', token: 'token-alice' }
    h.emitSession(h.session)
    await sleep(600)
    expect(balanceOf(await getUsage(h.base)), '前置条件：alice 的余额已缓存').toBe(11)

    // 只切会话服务，**不发事件**（模拟事件还在生命周期队列里排队）。
    h.session = { serverURL: h.serverURL, username: 'bob', token: 'token-bob' }

    const during = await getUsage(h.base)
    expect(during.status, '这份快照属于 alice，对 bob 必须拒绝交付').toBe(401)
    expect(balanceOf(during)).toBe('none')
  }, 30_000)
})
