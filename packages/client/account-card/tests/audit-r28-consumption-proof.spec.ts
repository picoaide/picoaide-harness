// @vitest-environment node
/**
 * `tests/audit-r28-consumption-proof.spec.ts` — 第二十八轮 FIX-42②（AB1-04）的端到端判据。
 *
 * ## 缺陷原形态（第二十八轮 AB1 审计，P2）
 *
 * `src/index.ts` 的 exact 路由 `GET /api/pico/account/usage?refresh=1` 是**消费型
 * GET**（立刻往返网关），而它的全部防护只有 `browserSameOriginMarker &&
 * isLoopbackRequest` —— `@picoaide/dsh-enterprise/loopback` 自己逐字写着
 * "a curl with a forged Origin passes this too"。AB1 真跑（真 apply + 真路由）：
 *
 * ```
 * [AB1] 伪造 Origin 裸 GET: status=200 gatewayCalls=1
 * [AB1] 5 次伪造 Origin 裸 GET ⇒ gatewayCalls=5      ← single-flight 只挡并发不挡速率
 * [AB1] 无头裸 GET: status=403 gatewayCalls=0        ← 对照腿：守卫不是恒真
 * ```
 *
 * ## 判据（真件；每一条都在下面实跑）
 *
 *  A. **伪造 Origin 的裸 GET（无 cookie）⇒ 403 + 零网关往返**；连发 5 次仍是 5×0
 *     （修前 5×1）。
 *  B. **对照腿**：持证明的同一发 ⇒ 200 + 恰好 1 次网关往返；无头裸 GET 仍 403
 *     （证明守卫不是恒真）。
 *  C. **纯读不硬挂**：不带 `?refresh` 的普通 GET 不要求证明（"GET 读面豁免"这条
 *     口径不退化）—— 这也是本仓"纯读路由不要硬挂"的口径。
 *  D. **等价腿**：同一组 headers 分别过本路由的**消费闸**与共享实现
 *     `acceptWriteProof()` 的**真实非 GET 路径**，结论（状态码 + 响应体）逐字相同
 *     —— 消费闸只是"非 GET 的方法视图"，不是第二份判定。
 *  E. **fence 缺席 ⇒ fail-closed 503**，且不退回同源标记。
 *
 * ## 变异验证（实跑过，逐条单独一次调用）
 *
 *  - 路由里去掉 `acceptConsumingProof`（回到修前形态）⇒ A 红（403→200、0→1，5 发 5 次）；
 *  - 把消费闸的失败分支改成"warn 后放行"（fail-open）⇒ A/E 红；
 *  - 把消费闸从"只看 headers 的方法视图"改成另写一份判定 ⇒ D 红。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { acceptWriteProof, type WriteProofDeps } from '@picoaide/dsh-enterprise/loopback'
import { apply } from '../src/index.ts'

/** 本机路由的 authority（真 socket：`127.0.0.1:<随机端口>`）。 */
let authority = ''
/** 上游 `browser-auth` 的 cookie 名（`dsh-auth-<authority>`）。 */
function proofCookie(host = authority): string {
  return `dsh-auth-${host}=v1.signature`
}

/**
 * 上游 `connection.requestRejection()` 的行为替身，逐条对齐 pinned 上游：
 * Host 栅栏（回环 authority）→ 403、`sec-fetch-site: cross-site` → 403、
 * Origin 存在时必须等于 Host（**缺席 Origin 放行**：同源 GET 在 Chromium 里没有
 * Origin）、cookie 名由 authority 派生且必须持本 authority 的那一枚 → 否则 401。
 */
function upstreamShapedJudge(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined {
  const headers = request.headers as Record<string, unknown>
  const host = headers['host']
  if (typeof host !== 'string' || !/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) return 403
  if (headers['sec-fetch-site'] === 'cross-site') return 403
  const origin = headers['origin']
  if (typeof origin === 'string' && new URL(origin).host !== host) return 403
  return headers['cookie'] === proofCookie(host) ? undefined : 401
}

interface Harness {
  /** 本机路由地址。 */
  base: string
  /** 网关收到的请求数（证明"有没有真的往返"）。 */
  gatewayCalls: () => number
  /** 关掉本机路由与假网关。 */
  close: () => Promise<void>
}

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
})

const USAGE_KEYS = {
  balance_money: 7,
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

/** 真 apply + 真路由 + 真 http server + 真网关（只替换网关那一侧的数据）。 */
async function harness(options: { fence?: false } = {}): Promise<Harness> {
  let calls = 0
  const gateway = createServer((_req, res) => {
    calls += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(USAGE_KEYS))
  })
  servers.push(gateway)
  await new Promise<void>((resolve) => { gateway.listen(0, '127.0.0.1', resolve) })
  const serverURL = `http://127.0.0.1:${String((gateway.address() as { port: number }).port)}`

  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void> | void) | null = null
  const local = createServer((req, res) => {
    if (handler === null) { res.writeHead(500); res.end('no handler'); return }
    void Promise.resolve(handler(req, res)).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end('handler threw') } })
  })
  servers.push(local)
  await new Promise<void>((resolve) => { local.listen(0, '127.0.0.1', resolve) })
  const port = (local.address() as { port: number }).port
  authority = `127.0.0.1:${String(port)}`

  const session = { serverURL, username: 'alice', token: 'token-alice' }
  const ctx = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    on: () => () => {},
    effect: (fn: () => unknown) => fn(),
    get: (name: string) => (name === 'connection' && options.fence !== false ? { requestRejection: upstreamShapedJudge } : undefined),
    picoSession: { getSession: () => session, clear: () => {}, clearIfCurrent: () => false },
    webServer: {
      register: (route: { path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void }) => {
        if (route.path === '/api/pico/account/usage') handler = route.handler
        return () => { handler = null }
      },
    },
  }
  apply(ctx as unknown as Context)

  return {
    base: `http://127.0.0.1:${String(port)}`,
    gatewayCalls: () => calls,
    close: async () => { /* afterEach 统一收 */ },
  }
}

interface Answer {
  status: number
  body: string
}

/** 打本机路由（真 socket）。`cookie` 缺省 = 不持证明。 */
async function hit(base: string, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  const response = await fetch(`${base}${path}`, { headers })
  return { status: response.status, body: await response.text() }
}

describe('FIX-42②：account-card 的消费型 GET（?refresh=1）必须持持有性证明', () => {
  it('A. 伪造 Origin 的裸 GET（无 cookie）⇒ 403 且零网关往返；连发 5 次仍是 5×0', async () => {
    const h = await harness()
    const headers = { accept: 'application/json', Origin: h.base } // 伪造同源标记，无 cookie
    const first = await hit(h.base, '/api/pico/account/usage?refresh=1', headers)
    expect(first.status, '修前实测 status=200').toBe(403)
    expect(JSON.parse(first.body)).toEqual({
      error: 'browser session proof required',
      hint: 'reopen the application window from its launch URL',
    })
    expect(h.gatewayCalls(), '被拒的请求一次网关往返都不能发生').toBe(0)

    for (let i = 0; i < 4; i += 1) await hit(h.base, '/api/pico/account/usage?refresh=1', headers)
    expect(h.gatewayCalls(), '修前实测"连发 5 次 = 5 次网关往返"（single-flight 只挡并发不挡速率）').toBe(0)
  }, 30_000)

  it('B. 对照腿：同一发持证明 ⇒ 200 + 恰好 1 次往返；无头裸 GET 仍 403（守卫不是恒真）', async () => {
    const h = await harness()
    const forced = await hit(h.base, '/api/pico/account/usage?refresh=1', {
      accept: 'application/json', Origin: h.base, cookie: proofCookie(),
    })
    expect(forced.status).toBe(200)
    expect(h.gatewayCalls(), '持证明的手动刷新照常往返（正常路径不退化）').toBe(1)

    // 对照腿：把 Origin 去掉、cookie 也去掉 —— 回环 socket + 回环 Host 仍成立，
    // 但既没有同源标记也没有证明 ⇒ 必须拒。
    const bare = await hit(h.base, '/api/pico/account/usage?refresh=1')
    expect(bare.status, '对照组：守卫不是恒真').toBe(403)
    expect(h.gatewayCalls()).toBe(1)
  }, 30_000)

  it('C. 纯读不硬挂：不带 ?refresh 的普通 GET 不要求证明（GET 读面豁免）', async () => {
    const h = await harness()
    const read = await hit(h.base, '/api/pico/account/usage', { accept: 'application/json', Origin: h.base })
    expect(read.status, '纯读的缓存快照交付不硬挂证明').toBe(200)
    const body = JSON.parse(read.body) as { state: string, data: unknown }
    expect(body.state).toBe('idle')
    expect(body.data).toBeNull() // 还没取过：空态
    expect(h.gatewayCalls(), '普通 GET 不触网关（P1-9）').toBe(0)
  }, 30_000)

  it('D. 等价腿：消费闸与共享写面闸对同一组 headers 给出逐字相同的结论', async () => {
    const h = await harness()
    const deps: WriteProofDeps = { fence: () => ({ requestRejection: upstreamShapedJudge }), label: 'test' }
    // 这一组 headers 都**过得了路由自己的 `guard()`**（回环 socket + 回环 Host +
    // 同源标记 —— 标记由同源 `Origin` 满足，正是 AB1 那条攻击腿的形状），因此必然
    // 抵达证明闸；只有这样才能把"消费闸"与"共享写面闸"对拍。
    const sameOrigin = `http://${authority}`
    const rows: readonly { readonly name: string, readonly headers: Record<string, string> }[] = [
      { name: '伪造 Origin + 无 cookie（AB1 的攻击腿）', headers: { host: authority, origin: sameOrigin } },
      { name: '伪造 Origin + 伪造签名的 cookie', headers: { host: authority, origin: sameOrigin, cookie: `dsh-auth-${authority}=v1.forged` } },
      { name: '别的 authority 签发的 cookie', headers: { host: authority, origin: sameOrigin, cookie: proofCookie('127.0.0.1:9999') } },
      { name: '只有同源标记、连 Origin 都没有 cookie', headers: { host: authority, origin: sameOrigin, 'sec-fetch-site': 'same-origin' } },
    ]
    for (const row of rows) {
      // 消费闸：走真路由（方法是 GET，闸门内部用非 GET 视图）。
      const route = await hit(h.base, '/api/pico/account/usage?refresh=1', { ...row.headers, accept: 'application/json' })
      // 共享闸：走它自己的真实非 GET 路径，把响应写进桩里。
      let status = 0
      let body = ''
      const res = {
        set statusCode(code: number) { status = code },
        get statusCode() { return status },
        setHeader: () => {},
        end: (chunk?: string) => { body = chunk ?? '' },
      } as unknown as ServerResponse
      const allowed = acceptWriteProof({ method: 'POST', headers: row.headers } as unknown as IncomingMessage, res, deps)
      expect(allowed, row.name).toBe(false)
      expect({ status: route.status, body: route.body }, row.name).toEqual({ status, body })
      expect(h.gatewayCalls(), `${row.name}：被拒的请求不得往返网关`).toBe(0)
    }

    // 更早的那一道闸不混进这条等价腿：非回环 Host / 跨站标记在 `guard()` 就被拒
    // （`{"error":"forbidden"}`），与证明闸的响应体**不同** —— 这里如实钉住这个次序。
    const foreign = await hit(h.base, '/api/pico/account/usage?refresh=1', {
      host: 'evil.example', accept: 'application/json',
    })
    expect(foreign.status).toBe(403)
    expect(JSON.parse(foreign.body)).toEqual({ error: 'forbidden' })
    const crossed = await hit(h.base, '/api/pico/account/usage?refresh=1', {
      host: authority, origin: `http://${authority}`, 'sec-fetch-site': 'cross-site', accept: 'application/json',
    })
    expect(crossed.status).toBe(403)
    expect(JSON.parse(crossed.body)).toEqual({ error: 'forbidden' })

    // 持证明：两个闸门都放行（消费闸继续走 200，写面闸不写响应）。
    // 这一发的形状就是真渲染层：同源 GET 带 `sec-fetch-site: same-origin`、**不带
    // Origin**（Chromium 同源请求没有 Origin），并自动带上 `dsh-auth-*` cookie。
    const allowed = await hit(h.base, '/api/pico/account/usage?refresh=1', {
      host: authority,
      cookie: proofCookie(),
      'sec-fetch-site': 'same-origin',
      accept: 'application/json',
    })
    expect(allowed.status, '正常路径（渲染层手动刷新）不受影响').toBe(200)
    const res = { statusCode: 0, setHeader: () => {}, end: () => {} } as unknown as ServerResponse
    expect(acceptWriteProof(
      { method: 'POST', headers: { host: authority, cookie: proofCookie() } } as unknown as IncomingMessage,
      res,
      deps,
    )).toBe(true)
    expect(h.gatewayCalls()).toBe(1)
  }, 30_000)

  it('E. fence 缺席 ⇒ fail-closed 503（不退回同源标记）', async () => {
    const h = await harness({ fence: false })
    const answer = await hit(h.base, '/api/pico/account/usage?refresh=1', {
      accept: 'application/json', Origin: h.base, cookie: proofCookie(),
    })
    expect(answer.status).toBe(503)
    expect(JSON.parse(answer.body)).toEqual({
      error: 'browser session proof unavailable',
      hint: 'reopen the application window from its launch URL',
    })
    expect(h.gatewayCalls()).toBe(0)
  }, 30_000)
})
