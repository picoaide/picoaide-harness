/**
 * 连接器刷新内存态的**账号作用域**记账（2026-10-04 审计 C3-04 / C3-05 / C3-08）。
 *
 * 长期规则（2026-09-23 定案，本文件是它在刷新链路上的完整落地）：凡描述「某账号
 * 凭据文件某代次」的事实，键必须含**账号作用域** —— 凭据 store 的解析目录
 * （`ConnectorStore.dir`，与 `TokenRefresher` 的 `scopeAtStart` 同源），不得只按
 * 连接器 id；判定 / 记账 / 清账 / 复用共用一个键构造点
 * （`store.ts` 的 `credentialScopeKey`），且作用域与凭据取自**同一个** store 实例。
 * 禁止用「切账号时 clear()」代替作用域化。
 *
 * 三条被审命题（全部以**确定性握手**驱动，不靠赢得竞态、不靠固定 sleep）：
 *
 *  - **C3-04**：`latestRefresh` 只按 id 记账 ⇒ 旧账号的刷新结果被下一个账号的注册
 *    「追赶」采用（`registerMcp` 的 `catchUpEntryCredential`）。窗口是真实的：
 *    会话切换是 `teardownAll()`（清表）→ `await syncServerDefs()`（一次 bootstrap
 *    网络往返）→ `reconfigureUser()`（`store` 只在这里换成新账号）—— 窗口内完成的
 *    刷新会把旧账号的结果重新写进表里。本文件把那次 bootstrap 请求**停在闸门上**，
 *    精确制造这个窗口。
 *  - **C3-05**：`TokenRefresher.inflight` 只按 id ⇒ 新作用域的强制 401 刷新链到旧
 *    作用域在飞的那次运行，把「不满足」当成「已满足」（面板还会把别的账号的在飞
 *    状态报成本账号的 `refreshing`）。
 *  - **C3-08**：`perform` 的作用域判据只写在 CAS **失败**分支 ⇒ 新作用域存在**逐字段
 *    相同**的凭据副本时（本仓自己承认这是真实场景：provisioned/copied credential
 *    file），CAS 命中，旧账号的刷新结果被写进新账号的凭据文件。
 *
 * 判据的形态：全部落在**可观察的后果**上 —— 新账号的凭据文件字节、新账号的 provider
 * 真正交出的令牌（`authProvider.tokens()`，即传输层每请求读的那个视图）、令牌端点被
 * 真的打了几次、面板为该作用域报的 `refreshing`。
 *
 * 握手点选在**出站 fetch**：刷新在「请求已发出、应答未回」时被停住 —— 那一刻它已经
 * 越过时钟快路径、也已经进入单飞表，但还没有写任何地方。停在更靠后的位置（store 的
 * CAS 内部）不足以覆盖 C3-08：那时作用域判据已经跑过了。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { callRoute, createHarness, scopeDir, waitFor, type Harness } from './helpers/connector-harness.ts'
import { completeAuthorization, startRealMcpServer, type RealMcpServer } from './helpers/real-mcp-oauth-server.ts'
import { ConnectorStore, type ConnectorCredential } from '../src/store.ts'
import type { ConnectorDef } from '../src/types.ts'

/**
 * This suite observes connector outbound traffic through a `globalThis.fetch`
 * stub — the shape it always had. Since the DNS-rebinding fix (2026-10-04) the
 * production transport dials the policy's verified addresses itself
 * (`src/pinned-http.ts`) instead of handing the URL to the global fetch, so the
 * stub is installed as THAT transport's seam: the same observation, one level
 * lower. Every policy gate still runs here — the mock replaces the connection,
 * not the judgement — and the real transport is covered end to end by
 * `tests/audit-1004-pinned-address.spec.ts`, which does not mock it.
 */
vi.mock('../src/pinned-http.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pinned-http.ts')>()
  return {
    ...actual,
    sendPinned: async (target: { url: URL }, init: RequestInit) => globalThis.fetch(target.url.href, init),
  }
})


/** 两个（账号, 服务端）作用域：同一个账号在两台部署上（R6-B-2 的真实拓扑）。 */
const SERVER_A = 'https://harness-a.example.com'
const SERVER_B = 'https://harness-b.example.com'
const USER = 'user-a'
const ID = 'example-mcp'
const BOOTSTRAP_PATH = '/api/client/v2/config/bootstrap'
const TOKEN_PATH = '/oauth/token'

const servers: RealMcpServer[] = []
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()?.()
  while (servers.length > 0) await servers.pop()?.close()
})

function def(origin: string): ConnectorDef {
  return {
    id: ID, name: '示例 MCP 智能体', description: 'audit', authMode: 'oauth',
    auth: {
      authorizeUrl: `${origin}/oauth/authorize`, tokenUrl: `${origin}/oauth/token`, clientId: '',
      redirectUri: 'http://127.0.0.1/callback', pkce: true, publicClient: true,
      discoveryUrl: `${origin}/mcp`, scopes: 'mcp.read offline_access',
    },
    mcp: [{ serverName: ID, transport: 'streamable-http', url: `${origin}/mcp` }],
  }
}

/** A fresh DSH home, stubbed BEFORE anything resolves a scope (see audit-0924). */
async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'v282-refresh-scope-'))
  vi.stubEnv('DSH_HOME', home)
  cleanups.push(async () => { await rm(home, { recursive: true, force: true }) })
  return home
}

/** Boot the real plugin with the product's own (account, server) scope resolution. */
function boot(defs: ConnectorDef[]): Harness {
  const harness = createHarness(defs, '', { storeBaseDir: undefined, refreshSweepIntervalMs: 0, requestApproval: () => true })
  cleanups.push(() => { harness.dispose() })
  return harness
}

/** The credential file of one (account, server) scope — the bytes, not a re-encoding. */
async function scopeFileBytes(username: string, serverURL: string): Promise<string> {
  return await readFile(join(scopeDir(username, serverURL), `${ID}.json`), 'utf8')
}

async function readScopeCredential(username: string, serverURL: string): Promise<ConnectorCredential | null> {
  return await new ConnectorStore({ baseDir: scopeDir(username, serverURL) }).readCredential(ID)
}

/** The MCP config the plugin registered LAST, with its SDK provider face. */
type LiveConfig = {
  serverName: string
  authProvider?: { tokens: () => Promise<{ access_token?: string, refresh_token?: string } | undefined> }
}

function lastConfig(h: Harness): LiveConfig {
  const config = h.configs.at(-1)
  if (config === undefined) throw new Error('no MCP config registered')
  return config as unknown as LiveConfig
}

async function awaitAuthorizeUrl(h: Harness, id: string): Promise<string> {
  const deadline = Date.now() + 15_000
  let url: string | undefined
  while (Date.now() < deadline && url === undefined) {
    const res = await callRoute(h, `/api/pico/connectors/${id}/state`, 'GET')
    url = (JSON.parse(res.body) as { request?: { authorizeUrl?: string } | null }).request?.authorizeUrl
    if (url === undefined) await new Promise(r => setTimeout(r, 20))
  }
  if (url === undefined) throw new Error('no authorize URL')
  return url
}

/** How many refresh grants have ARRIVED at the fixture's token endpoint so far. */
const refreshGrants = (server: RealMcpServer): number =>
  server.stats.grants.filter(grant => grant === 'refresh_token').length

/** The `refreshing` flag the panel's list route reports for the CURRENT scope. */
async function panelRefreshing(h: Harness): Promise<boolean> {
  const body = JSON.parse((await callRoute(h, '/api/pico/connectors', 'GET')).body) as
    { connectors: Array<{ id: string, refreshing?: boolean }> }
  return body.connectors.find(entry => entry.id === ID)?.refreshing === true
}

/**
 * One REAL interactive authorization against the fixture, whose credential file
 * is then copied **byte for byte** into every scope a case needs.
 *
 * Byte-for-byte matters: C3-08's trigger is a field-for-field identical copy
 * (same `updatedAt`), which is exactly what a provisioned/copied credential file
 * is — the same shape this plugin's own dead-grant note calls a real scenario.
 * Re-encoding the JSON here would give every copy a different `updatedAt` and
 * quietly remove the case's teeth.
 * @param server - the fixture authorization server / MCP endpoint.
 * @param dirs - credential directories that receive the same bytes.
 * @returns the credential every scope now holds.
 */
async function seedScopes(server: RealMcpServer, dirs: string[]): Promise<ConnectorCredential> {
  const seedDir = await mkdtemp(join(tmpdir(), 'v282-seed-'))
  cleanups.push(async () => { await rm(seedDir, { recursive: true, force: true }) })
  const seed = createHarness([def(server.origin)], seedDir, { refreshSweepIntervalMs: 0 })
  cleanups.push(() => { seed.dispose() })
  await callRoute(seed, `/api/pico/connectors/${ID}/connect`, 'POST')
  await completeAuthorization(await awaitAuthorizeUrl(seed, ID))
  await waitFor(() => seed.configs.length === 1, 15_000)
  const bytes = await readFile(join(seedDir, `${ID}.json`), 'utf8')
  const credential = JSON.parse(bytes) as ConnectorCredential
  expect(credential.accessToken, '前置：种子必须是真的 access token').toBeTruthy()
  expect(credential.refreshToken, '前置：种子必须带 refresh token').toBeTruthy()
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${ID}.json`), bytes)
  }
  return credential
}

/**
 * Wrap `globalThis.fetch` with one read/write handshake:
 *
 *  - `parkFirstTokenRequest()` stops the FIRST token-endpoint request until
 *    `release()` — the refresh is provably on the wire (request issued, answer
 *    outstanding) before it can write or publish anything, and every LATER token
 *    request goes straight through, which is what makes "the new scope ran its
 *    OWN refresh" observable as an arriving request;
 *  - `parkBootstrapFetch()` stops the next bootstrap catalogue request — the real
 *    network round trip the session-change transition awaits between
 *    `teardownAll()` and `reconfigureUser()`.
 *
 * Both are installed on `globalThis.fetch` because that is the base the connector
 * fence hands the SDK (`createMcpOutboundFetch({ base: (input, init) =>
 * globalThis.fetch(input, init) })`), so an OAuth request really is intercepted.
 */
function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

function parkFirstTokenRequest(): { entered: Promise<void>, release: () => void } {
  const original = globalThis.fetch
  let releaseGate!: () => void
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  let markEntered!: () => void
  const entered = new Promise<void>(resolve => { markEntered = resolve })
  let parked = false
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!parked && urlOf(input).includes(TOKEN_PATH)) {
      parked = true
      markEntered()
      await gate
    }
    return await original(input as RequestInfo, init as RequestInit)
  }) as typeof fetch
  cleanups.push(() => { globalThis.fetch = original })
  return { entered, release: () => { releaseGate() } }
}

function parkBootstrapFetch(): { entered: Promise<void>, release: () => void } {
  const original = globalThis.fetch
  let releaseGate!: () => void
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  let markEntered!: () => void
  const entered = new Promise<void>(resolve => { markEntered = resolve })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (urlOf(input).includes(BOOTSTRAP_PATH)) {
      markEntered()
      await gate
      return new Response(JSON.stringify({ connectors: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return await original(input as RequestInfo, init as RequestInit)
  }) as typeof fetch
  cleanups.push(() => { globalThis.fetch = original })
  return { entered, release: () => { releaseGate() } }
}

/**
 * Park the FIRST credential compare-and-update **inside the store**, i.e. after
 * the scope recheck has already passed and before the write runs.
 *
 * That is the "session switch lands inside the credential write" window: the
 * write still belongs to the account the refresh read from (it is pinned to that
 * store instance), while the session has already moved on — so what the refresh
 * PUBLISHES must stay inside its own account.
 */
function parkFirstCasWrite(): { entered: Promise<void>, release: () => void } {
  const original = ConnectorStore.prototype.updateCredentialIfUnchanged
  let releaseGate!: () => void
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  let markEntered!: () => void
  const entered = new Promise<void>(resolve => { markEntered = resolve })
  let parked = false
  vi.spyOn(ConnectorStore.prototype, 'updateCredentialIfUnchanged').mockImplementation(async function (
    this: ConnectorStore,
    ...args: Parameters<ConnectorStore['updateCredentialIfUnchanged']>
  ) {
    if (!parked) {
      parked = true
      markEntered()
      await gate
    }
    return await original.apply(this, args)
  })
  return { entered, release: () => { releaseGate() } }
}

describe('C3-04: a refresh result is keyed by (account scope, connector id)', () => {
  it('the next account\'s registration must not catch up to the previous account\'s refresh', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    await tempHome()
    // Scope A and scope B hold the SAME credential bytes (a copied file).
    const seeded = await seedScopes(server, [scopeDir(USER, SERVER_A), scopeDir(USER, SERVER_B)])

    const h = boot([def(server.origin)])
    h.emitSession({ username: USER, serverURL: SERVER_A })
    await waitFor(() => h.configs.length === 1, 15_000)

    // A's refresh is on the wire, stopped before the token endpoint answers.
    const token = parkFirstTokenRequest()
    const refreshed = callRoute(h, `/api/pico/connectors/${ID}/refresh`, 'POST')
    await token.entered

    // The session moves to the NEXT account. Its transition parks inside
    // `syncServerDefs()`'s bootstrap round trip — the exact window in which the
    // store is still A's while the session already names B.
    const bootstrap = parkBootstrapFetch()
    h.emitSession({ username: USER, serverURL: SERVER_B, token: 'session-token-b' })
    await bootstrap.entered

    // The in-flight refresh COMPLETES inside that window: it is still A's
    // account, so it legitimately publishes under A (and A's file is rewritten).
    token.release()
    expect((await refreshed).status).toBe(200)
    const refreshedA = await readScopeCredential(USER, SERVER_A)
    expect(refreshedA?.accessToken, '前置：A 的刷新必须真的产生了新令牌').not.toBe(seeded.accessToken)

    // Let the switch finish: B's restore reads B's own credential and registers.
    bootstrap.release()
    await waitFor(() => h.configs.length === 2, 15_000)

    // THE GUARD: B's transport must carry B's own credential. Before the fix
    // `latestRefresh` was keyed by the connector id alone, so this registration
    // found A's result (a newer `updatedAt`), adopted it, and B's provider —
    // i.e. what B's endpoint is about to be sent — held A's access token.
    const live = lastConfig(h)
    expect(live.serverName, '前置：最后注册的是 B 的传输').toBe(ID)
    const tokens = await live.authProvider?.tokens()
    expect(tokens?.access_token, 'B 的 provider 必须拿 B 盘上的令牌').toBe(seeded.accessToken)
    expect(tokens?.access_token, '绝不能是 A 的刷新结果').not.toBe(refreshedA?.accessToken)
    expect((await readScopeCredential(USER, SERVER_B))?.accessToken).toBe(seeded.accessToken)
  }, 40_000)
})

describe('C3-05: the single-flight slot is keyed by (account scope, connector id)', () => {
  it('a forced refresh in the new scope is never satisfied by the old scope\'s in-flight run', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    await tempHome()
    await seedScopes(server, [scopeDir(USER, SERVER_A), scopeDir(USER, SERVER_B)])

    const h = boot([def(server.origin)])
    h.emitSession({ username: USER, serverURL: SERVER_A })
    await waitFor(() => h.configs.length === 1, 15_000)

    // A's forced refresh is stopped on the wire: past the clock fast path, past
    // every local judgement, registered in the single-flight map, unanswered.
    const token = parkFirstTokenRequest()
    const aRefresh = callRoute(h, `/api/pico/connectors/${ID}/refresh`, 'POST')
    await token.entered
    const grantsWhileAParked = refreshGrants(server)

    try {
      // The session moves to B while A's run is STILL in flight.
      h.emitSession({ username: USER, serverURL: SERVER_B })
      await waitFor(() => h.configs.length === 2, 15_000)

      // The panel speaks for the CURRENT scope: another account's in-flight run
      // is not this account's refresh. Keyed by the connector id alone this read
      // `true` — the row claimed "refreshing" for a refresh that will never touch
      // this account's credential.
      expect(await panelRefreshing(h), 'B 的行不得显示 A 的刷新状态').toBe(false)

      // B's own forced refresh must reach the authorization server. Before the
      // fix it found A's in-flight entry (same connector id), chained onto it and
      // answered with A's outcome — zero token-endpoint requests for B, and the
      // 401 hook fell back to the SDK's own refresh path (a SECOND refresh owner
      // for one grant).
      const bRefresh = callRoute(h, `/api/pico/connectors/${ID}/refresh`, 'POST')
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline && refreshGrants(server) === grantsWhileAParked) {
        await new Promise(r => setTimeout(r, 20))
      }
      expect(
        refreshGrants(server),
        'B 的强制刷新必须走自己的运行（打自己的令牌请求），而不是复用 A 的在飞结果',
      ).toBeGreaterThan(grantsWhileAParked)

      token.release()
      await aRefresh
      await bRefresh
    } finally {
      token.release()
    }
  }, 40_000)
})

describe('C3-08: the scope judgement is enforced on the write, not only on a CAS miss', () => {
  it('a refresh that outlives a session switch writes into no other scope, even a byte-identical copy', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    await tempHome()
    const seeded = await seedScopes(server, [scopeDir(USER, SERVER_A), scopeDir(USER, SERVER_B)])
    const bytesB = await scopeFileBytes(USER, SERVER_B)

    const h = boot([def(server.origin)])
    h.emitSession({ username: USER, serverURL: SERVER_A })
    await waitFor(() => h.configs.length === 1, 15_000)

    // A's forced refresh is stopped on the wire — the audit's scenario: the
    // refresh is in flight when the account changes, and the next scope's
    // credential file is a field-for-field identical copy.
    const token = parkFirstTokenRequest()
    const refreshed = callRoute(h, `/api/pico/connectors/${ID}/refresh`, 'POST')
    await token.entered

    try {
      h.emitSession({ username: USER, serverURL: SERVER_B })
      await waitFor(() => h.configs.length === 2, 15_000)

      // Release: the refresh resumes against a store that is no longer its own.
      token.release()
      await refreshed

      // THE GUARD: the switched-to scope's file must be untouched, byte for
      // byte, and its live transport must still hold its own token. Before the
      // fix the CAS was resolved against "the store that is current now", the
      // identical copy satisfied it (same fields, same `updatedAt`), one
      // account's tokens were written into the other's file and published from
      // there.
      expect(await scopeFileBytes(USER, SERVER_B), 'B 的凭据文件必须逐字节不动').toBe(bytesB)
      const storedB = await readScopeCredential(USER, SERVER_B)
      expect(storedB?.accessToken).toBe(seeded.accessToken)
      expect(storedB?.refreshToken).toBe(seeded.refreshToken)
      expect((await lastConfig(h).authProvider?.tokens())?.access_token, 'B 的传输仍必须拿 B 的令牌')
        .toBe(seeded.accessToken)
      // A's own file is untouched as well: the run was refused before any write,
      // not written and then un-published.
      expect((await readScopeCredential(USER, SERVER_A))?.accessToken).toBe(seeded.accessToken)
    } finally {
      token.release()
    }
  }, 40_000)
})

describe('C3-04 (publish): a refresh reaches only its own account\'s live transports', () => {
  it('a session switch inside the credential write hands nothing to the next account\'s transport', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    await tempHome()
    const seeded = await seedScopes(server, [scopeDir(USER, SERVER_A), scopeDir(USER, SERVER_B)])
    const bytesB = await scopeFileBytes(USER, SERVER_B)

    // The declared "leave empty to auto-fill the bearer" header (R9-D-1): it puts
    // the access token into the transport's LIVE header record, which is what
    // makes "did this refresh write into the next account's transport?" readable
    // without a network round trip.
    const declared = def(server.origin)
    declared.mcp = [{ ...declared.mcp[0]!, headers: { 'X-Probe-Key': '' } }]

    const h = boot([declared])
    h.emitSession({ username: USER, serverURL: SERVER_A })
    await waitFor(() => h.configs.length === 1, 15_000)

    // Parked inside the write: the account recheck has passed, the write has not.
    const cas = parkFirstCasWrite()
    const refreshed = callRoute(h, `/api/pico/connectors/${ID}/refresh`, 'POST')
    await cas.entered

    try {
      h.emitSession({ username: USER, serverURL: SERVER_B })
      await waitFor(() => h.configs.length === 2, 15_000)
      const liveB = lastConfig(h) as unknown as { headers?: Record<string, string> }
      expect(liveB.headers?.['X-Probe-Key'], '前置：B 的活头记录里带的是 B 自己的令牌')
        .toBe(`Bearer ${seeded.accessToken}`)

      cas.release()
      await refreshed

      // The refresh completed for A (it is A's own store instance) — and that is
      // exactly why the publish must stay inside A: B's transport still holds
      // B's token, its record was not re-rendered from A's credential, and B's
      // file is untouched.
      expect((await readScopeCredential(USER, SERVER_A))?.accessToken, 'A 拿到的是自己的新令牌')
        .not.toBe(seeded.accessToken)
      expect((await lastConfig(h).authProvider?.tokens())?.access_token, 'B 的 provider 仍是 B 的令牌')
        .toBe(seeded.accessToken)
      expect((await lastConfig(h) as unknown as { headers?: Record<string, string> }).headers?.['X-Probe-Key'],
        'B 的活头记录不得被 A 的令牌改写').toBe(`Bearer ${seeded.accessToken}`)
      expect(await scopeFileBytes(USER, SERVER_B)).toBe(bytesB)
    } finally {
      cas.release()
    }
  }, 40_000)
})
