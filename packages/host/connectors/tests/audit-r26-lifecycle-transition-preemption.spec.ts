/**
 * FIX-31（第二十六轮审计发现项 Z2-1，2026-09-26）: a background lifecycle task
 * must not drop a queued session transition.
 *
 * ## 缺陷
 *
 * `runLifecycle` bumped ONE epoch on every enqueue (`if (epoch !== lifecycleEpoch)
 * return`), i.e. "only the newest enqueued task survives — it carries the full
 * desired state". That assumption holds for the boot restore and session changes
 * (`transition`), but `:3227`'s 60 s token sweep and `:3295`'s
 * credentials-changed rebuild are BACKGROUND tasks with a local action, not a
 * desired state. A sweep tick landing between "B's login enqueued" and "B's task
 * starts" therefore dropped B's task: `reconfigureUser()` — the only call site,
 * the only place the credential scope moves — never ran, `store` stayed on A,
 * `credentialScopeSwitching()` stayed true, and connect / disconnect / approve /
 * refresh all answered 409 with no in-product recovery, while A's MCP tools
 * stayed live under B's session.
 *
 * ## 判据（红/绿同一句）
 *
 * ① 会话切换必须完成：B 的凭据成为活 MCP 注册、闸门放行（`connect`/`disconnect`
 *    200 而不是 409）—— 进程不重启也必须能自愈；
 * ② 正向：后台任务照常工作（凭据变更重建仍然重建传输，不是"为了不再顶掉会话就把
 *    后台任务全停"）。
 *
 * ---- 变异验证（本次实跑，见 temp/r21/fix-31/probe）----
 *   - 背景任务也推进 epoch（`kind === 'transition' ? … : …` 改回 `++transitionEpoch`，
 *     即修前形态）⇒ 用例①红；
 *   - 干脆不排背景任务（`runLifecycle('background', …)` 提前 return）⇒ 用例②红。
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

const SERVER = 'https://harness.example.com'
const USER_A = 'user-a'
const USER_B = 'user-b'
const SECRET_A = 'SCOPE-A-SECRET'
const SECRET_B = 'SCOPE-B-SECRET'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

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

function okBootstrap(): Response {
  return new Response(JSON.stringify({ connectors: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** A `fetch` that only ever answers the bootstrap catalogue. */
function plainBootstrap(): void {
  vi.stubGlobal('fetch', () => Promise.resolve(okBootstrap()))
}

const sleep = async (ms: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)) }

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'fix31-lifecycle-'))
  vi.stubEnv('DSH_HOME', home)
  cleanups.push(async () => { await rm(home, { recursive: true, force: true }) })
  return home
}

function boot(
  home: string,
  sweepIntervalMs: number,
  requestApproval: (request: never) => boolean | Promise<boolean>,
): Harness {
  const harness = createHarness([tokenDef()], home, {
    storeBaseDir: undefined,
    refreshSweepIntervalMs: sweepIntervalMs,
    requestApproval,
  })
  cleanups.push(async () => { harness.dispose() })
  return harness
}

const dirOf = (user: string): string => scopeDir(user, SERVER)
const keysOf = (h: Harness): Array<string | undefined> => h.configs.map(config => config.env?.API_KEY)

async function seedBoth(): Promise<void> {
  await seedCredential(dirOf(USER_A), 'example-mcp', { fields: { API_KEY: SECRET_A }, updatedAt: Date.now() })
  await seedCredential(dirOf(USER_B), 'example-mcp', { fields: { API_KEY: SECRET_B }, updatedAt: Date.now() })
}

describe('FIX-31: background lifecycle tasks no longer drop a queued session transition', () => {
  it('① a sweep tick while B\'s login is queued must not strand A\'s scope: the switch completes and the gate reopens', async () => {
    const home = await tempHome()
    await seedBoth()
    plainBootstrap()
    // The stdio approval prompt is the parking point: A's task has already run
    // `reconfigureUser()` and is inside `restoreAll` waiting for the user.
    let answerApproval: (() => void) | undefined
    const approval = new Promise<boolean>((resolve) => { answerApproval = () => resolve(true) })
    // 300 ms = the production 60 s sweep timer, compressed. What matters is that
    // the platform's OWN timer enqueues a background task in the window.
    const harness = boot(home, 300, () => approval)

    // A logs in; its task installs A's scope and then parks on the approval.
    harness.emitSession({ username: USER_A, serverURL: SERVER, token: 'token-a' })
    await waitFor(() => harness.prompts.length >= 1)

    // B logs in: B's transition is queued behind A's parked task, and at least
    // one sweep tick lands before B's task can start.
    harness.emitSession({ username: USER_B, serverURL: SERVER, token: 'token-b' })
    await sleep(700)

    answerApproval?.()
    // The switch must complete on its own — no restart, no second login.
    await waitFor(() => keysOf(harness).includes(SECRET_B))

    const keys = keysOf(harness)
    const connect = await callRoute(harness, '/api/pico/connectors/example-mcp/connect', 'POST')
    await sleep(250)
    const disconnect = await callRoute(harness, '/api/pico/connectors/example-mcp/disconnect', 'POST')

    // (1) the LIVE registration belongs to B: it is the newest config, and A's
    // own registration was retired by the transition that now really ran
    // (`configs` is the append-only capture log, so the check on A is its
    // fiber's disposer, not an absence from the log).
    expect(keys.at(-1), 'B\'s credential is the live registration').toBe(SECRET_B)
    expect(
      harness.fibers.slice(0, -1).every(fiber => fiber.dispose.mock.calls.length > 0),
      'A\'s MCP registration must be retired once B is logged in',
    ).toBe(true)
    // (2) the credential-scope gate is open again: every write route answers.
    expect([connect.status, disconnect.status], '真 409 不得出现（闸门必须自愈）').toEqual([200, 200])
    expect(connect.body).not.toContain('切换')
    harness.dispose()
  })

  it('③ a superseded session transition leaves one diagnostic Host line', async () => {
    const home = await tempHome()
    await seedBoth()
    plainBootstrap()
    let answerApproval: (() => void) | undefined
    const approval = new Promise<boolean>((resolve) => { answerApproval = () => resolve(true) })
    const harness = boot(home, 0, () => approval)

    // A parks the queue; B's and C's transitions are enqueued behind it, so B's
    // is superseded before it ever runs (the shape that used to be silent).
    harness.emitSession({ username: USER_A, serverURL: SERVER, token: 'token-a' })
    await waitFor(() => harness.prompts.length >= 1)
    harness.emitSession({ username: USER_B, serverURL: SERVER, token: 'token-b' })
    harness.emitSession({ username: USER_A, serverURL: SERVER, token: 'token-a' })
    answerApproval?.()
    await waitFor(() => harness.warns.some(line => line.includes('transition superseded')))

    expect(harness.warns.join('\n')).toContain('superseded before it ran')
    harness.dispose()
  })

  it('② positive control: the credentials-changed rebuild still rebuilds the live transport', async () => {
    const home = await tempHome()
    await seedBoth()
    plainBootstrap()
    // The sweep timer is off here: this case is about the background path
    // itself, not about the race above.
    const harness = boot(home, 0, () => true)

    harness.emitSession({ username: USER_A, serverURL: SERVER, token: 'token-a' })
    await waitFor(() => keysOf(harness).includes(SECRET_A))

    // A refresh landed out of band (the SDK's own 401 self-heal, the heartbeat or
    // the panel button all end here): the new token must reach the live stdio
    // transport, which can only happen through a re-registration.
    const rotated = 'SCOPE-A-SECRET-ROTATED'
    await seedCredential(dirOf(USER_A), 'example-mcp', { fields: { API_KEY: rotated }, updatedAt: Date.now() + 1000 })
    const before = harness.configs.length
    harness.emit('pico/connector-credentials-changed', { id: 'example-mcp' })
    await waitFor(() => harness.configs.length > before)

    expect(keysOf(harness).at(-1), 'background rebuild must still work').toBe(rotated)
    harness.dispose()
  })
})
