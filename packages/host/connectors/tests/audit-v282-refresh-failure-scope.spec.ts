/**
 * 2026-10-04 审计 C3-04 的**同族残余**：刷新**失败判决**的行投影必须带账号作用域。
 *
 * 长期规则（2026-09-23 定案，见 `audit-v282-refresh-scope.spec.ts` 的头注释）：凡描述
 * 「某账号凭据文件某代次」的事实，键必须含**账号作用域** —— 凭据 store 的解析目录
 * （`ConnectorStore.dir`）。`states` 是**当前**账号的行投影（列表路由把它与
 * `store.dir` 的凭据合起来渲染），所以**判决**也必须只写给它所归属的那个账号：
 *
 *  - **可达**：面板路由不是生命周期任务，会话切换不会被它挡住。用户点了「刷新」之后
 *    立刻切账号，刷新随后以**终态**失败（`invalid_grant`）—— 判决属于 A，行却按连接器
 *    id 写，于是 **B 的行被刷成「需要重新授权」**，而 B 的凭据完全健康。
 *  - **粘住**：列表路由（面板 2 s 轮询的读源）是只读投影、从不回写 `states`；失败分支
 *    没有「用当前作用域重新投影一次」的尾巴；后台扫掠对不需要续期的凭据直接 `continue`。
 *    ⇒ 直到用户手动刷新成功或下一次会话切换才恢复。
 *  - **同族还有一处**：同一个失败分支里的 `transient`（5xx）行写入同样是按 id 写的 ——
 *    跨作用域时会把 A 的 5xx 文案画到 B 的行上（而扫掠不会重访仍然新鲜的凭据，所以它
 *    同样会粘住）。
 *
 * 判据的形态与 `audit-v282-refresh-scope.spec.ts` 一致：全部落在**可观察的后果**上 ——
 * 面板列表路由（面板真正读的那个面）报的行状态/错误码、失败请求本身的回答、令牌端点
 * 被真的打了几次、以及**切回 A 之后**那条终态是否仍然生效（防止「一律不写」的假修法）。
 *
 * 握手点是**令牌端点的应答**：刷新在「请求已发出、应答未回」时被停住 —— 那一刻它已经
 * 越过时钟快路径、已进入单飞表、并已过了 `perform` 读凭据后的作用域复检，只差一个回答。
 * 会话切换发生在**这个窗口之内**，所以整个交错是确定性的（不是靠赢竞态、不是靠 sleep）。
 *
 * 反向对照（防「同账号也不写」的假修法）：`J1b`（同作用域终态 ⇒ 行**必须**变
 * `unauthorized`）与既有的 `audit-0923-refresh-terminal.spec.ts`（同作用域 5xx ⇒ 行
 * **必须**变 `error`，且行留在主动刷新集里）。
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { callRoute, createHarness, scopeDir, seedCredential, waitFor, type Harness } from './helpers/connector-harness.ts'
import type { ConnectorDef } from '../src/types.ts'

/** 同一个账号在两台部署上（R6-B-2 的真实拓扑）⇒ 两个作用域。 */
const USER = 'user-a'
const ID = 'example-mcp'
/** 凭据代次：死 grant 标记按它比对，用例要能自己说出用的是哪一代。 */
const GENERATION = 1_700_000_000_000

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/** A fresh DSH home, stubbed BEFORE anything resolves a scope (see audit-0924). */
async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'v282-failure-scope-'))
  vi.stubEnv('DSH_HOME', home)
  cleanups.push(async () => { await rm(home, { recursive: true, force: true }) })
  return home
}

async function originOf(server: Server): Promise<string> {
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as { port: number }).port)
  }))
  return `http://127.0.0.1:${String(port)}`
}

/**
 * One deployment origin: it answers the bootstrap catalogue the session switch
 * really fetches (`syncServerDefs`), so the switch is a real loopback round trip
 * (deterministic and fast) and `scopeDir(USER, origin)` is the production
 * resolver's own answer for that deployment.
 */
async function deployment(): Promise<string> {
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/client/v2/config/bootstrap')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not_found"}')
  })
  const origin = await originOf(server)
  cleanups.push(() => { server.close() })
  return origin
}

interface GatedIdp {
  readonly base: string
  /** How many token requests have ARRIVED (answered or still parked). */
  readonly hits: () => number
  readonly release: () => void
}

/**
 * A real loopback token endpoint that counts its requests and answers ONLY once
 * released: the verdict lands exactly when the case says it does.
 */
async function gatedIdp(answer: { status: number, body: Record<string, unknown> }): Promise<GatedIdp> {
  let hits = 0
  let open!: () => void
  const gate = new Promise<void>(resolve => { open = resolve })
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/token') && req.method === 'POST') {
      hits += 1
      req.resume()
      void gate.then(() => {
        res.writeHead(answer.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(answer.body))
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not_found"}')
  })
  const base = await originOf(server)
  cleanups.push(() => { server.close() })
  return { base, hits: () => hits, release: () => { open() } }
}

/** Static-endpoint OAuth definition (no discovery round trip) with one stdio MCP server. */
function def(tokenBase: string): ConnectorDef {
  return {
    id: ID,
    name: 'Example MCP',
    description: 'audit C3-04 residual (refresh failure verdict scope)',
    authMode: 'oauth',
    auth: {
      authorizeUrl: `${tokenBase}/authorize`,
      tokenUrl: `${tokenBase}/token`,
      clientId: 'c',
      redirectUri: 'http://127.0.0.1/callback',
      pkce: true,
    },
    mcp: [{ serverName: `${ID}-mcp`, transport: 'stdio', command: 'node', args: ['x.mjs'] }],
  }
}

/** Boot the real plugin with the product's own (account, server) scope resolution. */
function boot(defs: ConnectorDef[]): Harness {
  const harness = createHarness(defs, '', { storeBaseDir: undefined, refreshSweepIntervalMs: 0, requestApproval: () => true })
  cleanups.push(() => { harness.dispose() })
  return harness
}

/** A credential that needs no IdP round trip: neither restore nor sweep touches the wire. */
function healthyCredential(tag: string, withRefreshToken = true): Record<string, unknown> {
  return {
    accessToken: `at-${tag}`,
    ...(withRefreshToken ? { refreshToken: `rt-${tag}` } : {}),
    clientId: 'c',
    expiresAt: Date.now() + 3_600_000,
    updatedAt: GENERATION,
  }
}

interface Row {
  id: string
  status: string
  error?: string
  errorCode?: string
}

/** The connector row as the panel sees it (the plugin's own list route = 2 s poll source). */
async function rowOf(h: Harness): Promise<Row> {
  const body = JSON.parse((await callRoute(h, '/api/pico/connectors', 'GET')).body) as { connectors: Row[] }
  return body.connectors.find(entry => entry.id === ID) as Row
}

async function waitForRow(h: Harness, predicate: (row: Row) => boolean, timeoutMs = 15_000): Promise<Row> {
  const deadline = Date.now() + timeoutMs
  let last: Row | undefined
  while (Date.now() < deadline) {
    last = await rowOf(h)
    if (predicate(last)) return last
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`connector row never matched: ${JSON.stringify(last)}`)
}

/** The credential file of one scope — the bytes, not a re-encoding. */
async function scopeCredential(origin: string): Promise<{ accessToken?: string }> {
  return JSON.parse(await readFile(join(scopeDir(USER, origin), `${ID}.json`), 'utf8')) as { accessToken?: string }
}

const INVALID_GRANT = { status: 400, body: { error: 'invalid_grant', error_description: 'refresh token revoked' } }
const TRANSIENT = { status: 503, body: { error: 'temporarily_unavailable' } }

interface InFlight {
  readonly h: Harness
  readonly idp: GatedIdp
  readonly from: string
  readonly to: string
  /** The panel route's answer — it resolves the moment the verdict lands. */
  readonly failure: Promise<{ status: number, body: string }>
}

/**
 * Drive the interleaving the finding is about: A's forced panel refresh reaches
 * the IdP (and is parked there) while the session moves to B, whose credential
 * is healthy and whose restore therefore needs no IdP round trip.
 * @param answer - the verdict the parked token endpoint will serve.
 * @param withRefreshToken - whether B's credential carries a refresh token. It
 * does by default (the topology the finding is about); `false` is the variant
 * that also completes on the PRE-fix tree, where a session switch with a
 * refreshable credential was still chained behind the previous account's
 * in-flight run (C3-05) — see `J1e`.
 * @returns the live pieces, with the failure answer still pending.
 */
async function refreshInFlightAcrossSwitch(
  answer: { status: number, body: Record<string, unknown> },
  withRefreshToken = true,
): Promise<InFlight> {
  await tempHome()
  const idp = await gatedIdp(answer)
  const from = await deployment()
  const to = await deployment()
  await seedCredential(scopeDir(USER, from), ID, healthyCredential('a'))
  await seedCredential(scopeDir(USER, to), ID, healthyCredential('b', withRefreshToken))

  const h = boot([def(idp.base)])
  h.emitSession({ username: USER, serverURL: from, token: 't-a' })
  await waitFor(() => h.configs.length === 1, 15_000)
  expect((await rowOf(h)).status, '前置：A 的行是 connected').toBe('connected')

  // A forced refresh leaves for the IdP and is parked there.
  const failure = callRoute(h, `/api/pico/connectors/${ID}/refresh`, 'POST')
  await waitFor(() => idp.hits() === 1, 15_000)

  // The session moves to B while that refresh is still unanswered (the panel
  // route is NOT a lifecycle task, so the transition is not queued behind it).
  h.emitSession({ username: USER, serverURL: to, token: 't-b' })
  await waitFor(() => h.configs.length === 2, 15_000)
  expect((await rowOf(h)).status, '前置：B 的行是 connected').toBe('connected')
  return { h, idp, from, to, failure }
}

describe('C3-04 残余：刷新失败判决的行投影必须带账号作用域', () => {
  it('J1a：A 的强制刷新在飞时切到 B、A 以 invalid_grant 终结 ⇒ B 的行必须仍是 connected', async () => {
    const { h, idp, to, failure } = await refreshInFlightAcrossSwitch(INVALID_GRANT)

    idp.release()
    const res = await failure

    // 判决没有被吞掉：这条请求属于 A，调用方仍拿到终态回答。
    expect(res.status, 'A 的这次刷新确实是失败').toBe(409)
    expect((JSON.parse(res.body) as { errorCode?: string }).errorCode, 'A 的请求仍拿到 auth-required').toBe('auth-required')

    const after = await rowOf(h)
    expect(
      after.status,
      `J1a：当前作用域是 B（凭据健康），行却被 A 的终态刷成 status=${after.status}`
        + ` errorCode=${String(after.errorCode)} error=${String(after.error)}`,
    ).toBe('connected')
    expect(after.errorCode, 'J1a：B 的行不得带 A 的 auth-required').toBeUndefined()
    expect(after.error, 'J1a：B 的行不得带 A 的失败文案').toBeUndefined()
    expect((await scopeCredential(to)).accessToken, '前置：B 的凭据一直是健康的').toBe('at-b')
  }, 45_000)

  it('J1b 反向对照：同作用域的终态失败 ⇒ 行**必须**被刷成 unauthorized（防「一律不写」的假修法）', async () => {
    await tempHome()
    const idp = await gatedIdp(INVALID_GRANT)
    const origin = await deployment()
    await seedCredential(scopeDir(USER, origin), ID, healthyCredential('a'))
    const h = boot([def(idp.base)])
    h.emitSession({ username: USER, serverURL: origin, token: 't-a' })
    await waitFor(() => h.configs.length === 1, 15_000)
    expect((await rowOf(h)).status, '前置：行是 connected').toBe('connected')

    const failure = callRoute(h, `/api/pico/connectors/${ID}/refresh`, 'POST')
    await waitFor(() => idp.hits() === 1, 15_000)
    idp.release()
    const res = await failure
    expect(res.status).toBe(409)

    const after = await waitForRow(h, row => row.status === 'unauthorized')
    expect(after.errorCode, 'J1b：同账号的终态必须带上稳定错误码').toBe('auth-required')
    expect(after.error, 'J1b：同账号的终态必须带上失败文案').toBeTruthy()
  }, 45_000)

  it('J1c：那条终态属于 A —— 切回 A 时行必须重新变成 unauthorized，且不再出示死 refresh token', async () => {
    const { h, idp, from, failure } = await refreshInFlightAcrossSwitch(INVALID_GRANT)
    idp.release()
    await failure
    expect((await rowOf(h)).status, '前置：B 的行没被 A 的判决污染').toBe('connected')
    const hitsAfterVerdict = idp.hits()

    // 回到 A（同一个账号 + 同一台部署 ⇒ 同一个作用域）。
    h.emitSession({ username: USER, serverURL: from, token: 't-a' })
    const back = await waitForRow(h, row => row.status === 'unauthorized')
    expect(back.errorCode, 'J1c：A 的终态必须仍然生效').toBe('auth-required')
    expect(
      idp.hits(),
      'J1c：死 grant 标记必须已按 A 的作用域记账 —— 恢复 A 时不得再把死 refresh token 出示给 IdP',
    ).toBe(hitsAfterVerdict)
  }, 45_000)

  it('J1d 同族：跨作用域的 transient（5xx）不得把 B 的行画成 error', async () => {
    const { h, idp, failure } = await refreshInFlightAcrossSwitch(TRANSIENT)

    idp.release()
    const res = await failure
    expect(res.status, 'transient 仍是 409').toBe(409)
    expect((JSON.parse(res.body) as { errorCode?: string }).errorCode, 'transient 不带终态错误码').toBeUndefined()

    const after = await rowOf(h)
    expect(after.status, `J1d：B 的行被 A 的 5xx 画成了 status=${after.status} error=${String(after.error)}`).toBe('connected')
    expect(after.error, 'J1d：B 的行不得带 A 的失败文案').toBeUndefined()
  }, 45_000)

  /**
   * 归属复核（PRE-EXISTING）：把 B 的凭据换成**不带 refresh token** 的那一种，
   * 切换就不需要刷新、也就不会被上一作用域在飞的那次运行链住（那是 C3-05，本单
   * 之外）。本用例因此在**修复前**的树上也能跑到底 —— 它证明真正把 B 的行刷错的
   * 是 `applyRefreshFailure` 里那行按 id 写的 `setState`，而不是本轮某项修复引入的。
   */
  it('J1e 归属复核：B 的凭据不带 refresh token 时切换不被 C3-05 挡住 ⇒ 修复前也该红（B 的行仍是 connected）', async () => {
    const { h, idp, to, failure } = await refreshInFlightAcrossSwitch(INVALID_GRANT, false)

    idp.release()
    const res = await failure
    expect(res.status).toBe(409)

    const after = await rowOf(h)
    expect(
      after.status,
      `J1e：B 的行被 A 的终态刷成 status=${after.status} errorCode=${String(after.errorCode)}`
        + `（这条在修复前的树上同样成立 ⇒ PRE-EXISTING）`,
    ).toBe('connected')
    expect(after.errorCode, 'J1e：B 的行不得带 A 的 auth-required').toBeUndefined()
    expect((await scopeCredential(to)).accessToken, '前置：B 的凭据一直是健康的').toBe('at-b')
  }, 45_000)
})
