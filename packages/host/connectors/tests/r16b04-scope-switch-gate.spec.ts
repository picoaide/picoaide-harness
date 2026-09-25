/**
 * R16B-04（第十六轮审计泳道 B）:换号窗口内不得用**上一个账号**的凭据目录注册 MCP。
 *
 * 被判缺陷的窗口（本文件用一个**永不 settle 的 bootstrap fetch** 把它固定住）：
 *
 *   pico/session-changed(A→B)
 *     → runLifecycle(async () => {
 *         await teardownAll()          // 面板每张卡立刻变「未连接」= 邀请点击
 *         await syncServerDefs()       // ← 一次真实网络往返（最长 30s 预算）
 *         reconfigureUser()            // ← store 在这里才被换成 B 的作用域
 *         await restoreAll(epoch)
 *       })
 *
 * `POST /api/pico/connectors/:id/connect` 走的是 HTTP 路由，**不在**这条生命周期队列里，
 * 所以窗口内它读到的是 `store` 仍指向的 A 的凭据目录：token 模式的连接器会带着 A 的
 * `fields`/令牌直接 `registerMcp`，OAuth 模式的连接器会用 A 的 refresh token 去换票
 * —— 新账号的会话里跑着旧账号凭据的 MCP 传输。
 *
 * 判据（红/绿同一句）：窗口内那一发 connect **不得**产生任何注册；切换完成后
 * connect 必须恢复到**新账号作用域**的凭据上（防"闸门永不打开"的过度修复）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import {
  callRoute,
  createHarness,
  scopeDir,
  seedCredential,
  waitFor,
  type Harness,
} from './helpers/connector-harness.ts'
import type { ConnectorDef } from '../src/types.ts'

/** One deployment, two accounts on one machine ("同机两人共用"). */
const SERVER = 'https://harness.example.com'
const USER_A = 'user-a'
const USER_B = 'user-b'
/** The secret that must never reach B's session. */
const SECRET_A = 'SCOPE-A-SECRET'
const SECRET_B = 'SCOPE-B-SECRET'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** A manual-token stdio connector: its `fields` value is what leaks. */
function tokenDef(id = 'example-mcp'): ConnectorDef {
  return {
    id,
    name: 'Example',
    description: '',
    authMode: 'token',
    tokenFields: [{ key: 'API_KEY', label: 'API key', required: true }],
    mcp: [{ serverName: `${id}-srv`, transport: 'stdio', command: process.execPath, args: ['-e', ''] }],
  } as unknown as ConnectorDef
}

/**
 * An OAuth connector — the OTHER arm the finding names: without the gate,
 * `connect` starts an authorization flow that would present the previous
 * account's refresh token / client registration to the IdP and then write the
 * resulting credential into the previous account's directory.
 */
function oauthDef(id = 'oauth-mcp'): ConnectorDef {
  return {
    id,
    name: 'OAuth example',
    description: '',
    authMode: 'oauth',
    auth: {
      authorizeUrl: 'https://idp.example.com/oauth/authorize',
      tokenUrl: 'https://idp.example.com/oauth/token',
      clientId: '',
      redirectUri: 'http://127.0.0.1/callback',
      pkce: true,
      publicClient: true,
      discoveryUrl: 'https://idp.example.com/.well-known/oauth-authorization-server',
      scopes: 'offline_access',
    },
    mcp: [{ serverName: `${id}-srv`, transport: 'stdio', command: process.execPath, args: ['-e', ''] }],
  } as unknown as ConnectorDef
}

interface Bootstrap {
  /** Hang the next bootstrap round trip until {@link release} is called. */
  hang: () => void
  release: () => void
  calls: number
}

/** Controllable `fetch`: the ONLY outbound call this probe's def can produce. */
function controllableBootstrap(): Bootstrap {
  const bootstrap: Bootstrap = {
    calls: 0,
    hang: () => { hanging = true },
    release: () => { hanging = false; releasePending?.() },
  }
  let hanging = false
  let releasePending: (() => void) | undefined
  vi.stubGlobal('fetch', () => {
    bootstrap.calls += 1
    if (hanging) return new Promise<Response>((resolve) => { releasePending = () => { resolve(okBootstrap()) } })
    return Promise.resolve(okBootstrap())
  })
  return bootstrap
}

function okBootstrap(): Response {
  return new Response(JSON.stringify({ connectors: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'r16b04-scope-'))
  vi.stubEnv('DSH_HOME', home)
  cleanups.push(async () => { await rm(home, { recursive: true, force: true }) })
  return home
}

/** Boot the real plugin with the product's own (account, server) scope resolution. */
async function boot(home: string, extraDefs: ConnectorDef[] = []): Promise<Harness> {
  const harness = createHarness([tokenDef(), ...extraDefs], home, {
    storeBaseDir: undefined,
    refreshSweepIntervalMs: 0,
    requestApproval: () => true,
  })
  cleanups.push(async () => { harness.dispose() })
  return harness
}

const apiKeyOf = (h: Harness, index: number): string | undefined =>
  h.configs[index]?.env?.API_KEY

/** Wait until teardown ran (every registration the plugin owns was disposed). */
async function waitForTeardown(h: Harness): Promise<void> {
  await waitFor(() => h.fibers.length > 0 && h.fibers.every(fiber => fiber.dispose.mock.calls.length > 0))
}

describe('R16B-04: the credential scope is a precondition of CONNECT, not a follow-up of the switch', () => {
  it('refuses connect inside the switch window instead of registering with the previous account\'s credential', async () => {
    const home = await tempHome()
    await seedCredential(scopeDir(USER_A, SERVER), 'example-mcp', {
      fields: { API_KEY: SECRET_A },
      updatedAt: Date.now(),
    })
    const bootstrap = controllableBootstrap()
    const harness = await boot(home, [oauthDef()])

    // A is logged in and its credential really reached A's MCP registration.
    harness.emitSession({ username: USER_A, serverURL: SERVER, token: 'token-a' })
    await waitFor(() => harness.configs.length === 1)
    expect(apiKeyOf(harness, 0)).toBe(SECRET_A)
    expect(harness.configs[0]?.env?.API_KEY).not.toBe(SECRET_B)

    // The switch: the bootstrap round trip is held open, so `reconfigureUser()`
    // has NOT run yet and `store` still resolves A's directory.
    bootstrap.hang()
    harness.emitSession({ username: USER_B, serverURL: SERVER, token: 'token-b' })
    await waitForTeardown(harness)

    // The panel's own view of the world right now: every card is "disconnected",
    // which is exactly the state that invites the click below.
    const listed = JSON.parse((await callRoute(harness, '/api/pico/connectors', 'GET')).body) as {
      connectors: Array<{ id: string; status: string; request: { authorizeUrl?: string } | null }>
    }
    expect(listed.connectors.find(entry => entry.id === 'example-mcp')?.status).toBe('disconnected')

    const produced = harness.configs.length
    const res = await callRoute(harness, '/api/pico/connectors/example-mcp/connect', 'POST')
    // The OAuth arm goes through the same gate: no authorization flow may start
    // (which is what would hand A's tokens/client to the IdP) either.
    const oauth = await callRoute(harness, '/api/pico/connectors/oauth-mcp/connect', 'POST')
    await new Promise(resolve => setTimeout(resolve, 250))

    expect(
      harness.configs.slice(produced).map(config => config.env?.API_KEY),
      'the window must not register an MCP transport with the PREVIOUS account\'s credential',
    ).toEqual([])
    // Structured, diagnosable refusal — not a 200 with a silent no-op, and not a
    // bare 500 the client renders as "HTTP 409".
    expect(res.status).toBe(409)
    const body = JSON.parse(res.body) as { error?: string; hint?: string }
    expect(body.error).toBeTruthy()
    expect(body.hint).toBeTruthy()
    expect(res.body).not.toContain(SECRET_A)
    expect(oauth.status, 'OAuth 模式的 connect 走同一条闸门').toBe(409)
    expect((JSON.parse(oauth.body) as { error?: string }).error).toBe(body.error)
    // The OAuth row never even got an authorize URL: the flow never started.
    const during = JSON.parse((await callRoute(harness, '/api/pico/connectors', 'GET')).body) as {
      connectors: Array<{ id: string; request: { authorizeUrl?: string } | null }>
    }
    expect(during.connectors.find(entry => entry.id === 'oauth-mcp')?.request?.authorizeUrl).toBeUndefined()

    // The switch is still parked: this is what makes the assertion above a
    // window assertion rather than a race the test happened to win.
    expect(bootstrap.calls).toBeGreaterThan(1)
    bootstrap.release()
  })

  it('lets connect through again once the new scope is installed, and binds it to the NEW account', async () => {
    const home = await tempHome()
    await seedCredential(scopeDir(USER_A, SERVER), 'example-mcp', {
      fields: { API_KEY: SECRET_A },
      updatedAt: Date.now(),
    })
    await seedCredential(scopeDir(USER_B, SERVER), 'example-mcp', {
      fields: { API_KEY: SECRET_B },
      updatedAt: Date.now(),
    })
    const bootstrap = controllableBootstrap()
    const harness = await boot(home)

    harness.emitSession({ username: USER_A, serverURL: SERVER, token: 'token-a' })
    await waitFor(() => harness.configs.length === 1)
    expect(apiKeyOf(harness, 0)).toBe(SECRET_A)

    bootstrap.hang()
    harness.emitSession({ username: USER_B, serverURL: SERVER, token: 'token-b' })
    await waitForTeardown(harness)
    expect((await callRoute(harness, '/api/pico/connectors/example-mcp/connect', 'POST')).status).toBe(409)

    // The round trip completes: `reconfigureUser()` runs and the restore pass
    // registers B's OWN credential. The gate must open again (an over-eager
    // gate that never reopens would be just as broken, quietly).
    const afterSwitch = harness.configs.length
    bootstrap.release()
    await waitFor(() => harness.configs.length > afterSwitch)
    expect(harness.configs.at(-1)?.env?.API_KEY).toBe(SECRET_B)

    const res = await callRoute(harness, '/api/pico/connectors/example-mcp/connect', 'POST')
    expect(res.status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 200))
    for (const config of harness.configs.slice(afterSwitch)) {
      expect(config.env?.API_KEY, 'every registration after the switch belongs to B').toBe(SECRET_B)
    }
  })
})
