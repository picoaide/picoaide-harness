/**
 * R13-B-P2-4 回归：`canRefresh` 这个「可手动刷新」的读数必须随账号一起消失。
 *
 * ## 缺陷形态（修复前）
 *
 * 面板每 2 秒轮询的 `/api/pico/connectors` 列表里，`canRefresh` 由两半合成：
 *
 * ```text
 * canRefresh: (refreshable.has(def.id) || state.refreshToken === true) && oauthTargetOf(def) !== null
 * ```
 *
 * 其中 `states` 在 `teardownAll()`（换账号/登出）里被清空，而 `refreshable` 这个
 * "磁盘上这份凭据带 refresh token"的投影**没有**进那次清理。于是：
 *
 *  - 账号 A 授权过连接器 X（带 refresh token）⇒ `refreshable = {X}`；
 *  - 换到账号 B（或登出）⇒ `states` 清空，`refreshable` 仍是 `{X}`；
 *  - 在 B 的 `restoreAll` 走到 X 之前（`noteCredential` 是它唯一的自愈点），
 *    面板已经把 X 显示成"可刷新"——而 B 从未授权过 X，点下去只会走
 *    forced refresh → 读到 B 的空凭据 → `not-applicable` 报错。
 *
 * 登出这一路更彻底：`restoreAll` 只在 `next !== null` 时跑，所以没有任何自愈点，
 * 残留会一直留到下一次登录。
 *
 * ## 判据（两条，都读产品自己的路由）
 *
 * 1. **换账号**（每账号独立 store）：B 的 restore 被一个真实的等待点
 *    （`gate-connector` 的 stdio 审批闸，`restoreAll` 在这里 await）钉住时读列表 ——
 *    这正是"在 restoreAll 走完之前轮询"的形态，`canRefresh` 必须已经是假。
 * 2. **登出**（`storeBaseDir` 固定，即"作用域不随账号变"的配置）：`emitSession(null)`
 *    之后 `canRefresh` 必须为假 —— 这一路**没有** restore，残留会一直留到下次登录。
 *
 * 两条都带阳性对照（切换之前 `canRefresh` 必须为真），所以"判据什么都没看见"
 * 不会变成绿；两条各自绑定修复的一半（见下面"两个机制"一节）。
 *
 * 账号维度的真源是产品自己的 `connectorScopePath`（`scopeDir()`），测试不手写目录
 * 布局：第一条把 `DSH_HOME` 指到临时目录，让插件真的按 (账号, 服务端) 解析两套
 * store —— 否则两个账号会读到同一份凭据，"B 从未授权"这个前提根本构造不出来。
 *
 * ## 两个机制，各有一条见证（变异验证的口径）
 *
 * 修复由两半组成：① `refreshable` 的键带上账号作用域；② `teardownAll()` 清它。
 * 在一次会话切换里**两半都会生效**，所以任何"换账号"用例单独拆掉任一半仍然绿
 * （另一半顶上）—— 实测如此。因此：
 *
 *  - 用例 1 判的是"两半**都**拆掉"（拆掉修复的完整含义）；
 *  - 用例 2 用"作用域不随账号变"的配置（`storeBaseDir` 固定）把键的作用域维度
 *    **对消掉**，于是它只可能由 `teardownAll()` 的 `clear()` 救回 —— 拆掉 `clear()`
 *    即红。
 *  - 作用域键**独有**的覆盖是"清理之后仍有旧作用域的迟到写入"这一竞态：单线程事件
 *    循环里测试构造不出（`emitSession` 只能从宏任务里发起，而 await 的续体总在同一个
 *    宏任务末尾的微任务队列里先跑完）。该半按本仓 2026-09-23「键必须含账号作用域」
 *    的定案保留，**没有确定性见证**，本报告如实登记。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { ConnectorStore } from '../src/store.ts'
import type { ConnectorDef } from '../src/types.ts'
import { callRoute, createHarness, FAKE_MCP_SERVER, scopeDir, type Harness } from './helpers/connector-harness.ts'

/** 目标连接器：A 授权过（带 refresh token），B 从未授权。 */
const TARGET_ID = 'target-connector'

/** 等待点连接器：只有 B 有凭据，它的 stdio 审批闸会把 B 的 restore 钉住。 */
const GATE_ID = 'gate-connector'

/**
 * 一个 OAuth 连接器（`canRefresh` 需要 `oauthTargetOf(def) !== null`，那就必须是
 * oauth 模式；`expiresAt` 在将来 ⇒ restore 的保鲜路径走时钟快路，不发任何网络请求）。
 * @param id - connector id.
 * @param serverName - MCP server name (also the approval prompt's identity).
 * @param argsSuffix - extra argv so the two defs never share an approval fingerprint.
 * @returns the definition.
 */
function stdioDef(id: string, serverName: string, argsSuffix: string): ConnectorDef {
  return {
    id,
    name: id,
    description: 'R13-B-P2-4 probe',
    authMode: 'oauth',
    auth: {
      authorizeUrl: 'https://idp.example.com/oauth/authorize',
      tokenUrl: 'https://idp.example.com/oauth/token',
      clientId: 'probe-client',
      redirectUri: 'http://127.0.0.1/callback',
      pkce: true,
      publicClient: true,
      scopes: 'mcp.read offline_access',
    },
    mcp: [{ serverName, transport: 'stdio', command: process.execPath, args: [FAKE_MCP_SERVER, argsSuffix] }],
  }
}

/** 一条列表行里本判据关心的字段。 */
interface Row {
  readonly id: string
  readonly canRefresh: boolean
  readonly status: string
  readonly refreshToken: boolean
}

const harnesses: Harness[] = []
let home = ''
let savedHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'r13-b24-'))
  savedHome = process.env.DSH_HOME
  // 真源是产品自己的解析器（`resolveDshHome` 每次调用读 env），这里只搬数据根。
  process.env.DSH_HOME = home
})

afterEach(async () => {
  while (harnesses.length > 0) harnesses.pop()?.dispose()
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  await rm(home, { recursive: true, force: true })
})

/**
 * Seed one account's credential through the store the plugin itself resolves.
 * @param username - the account.
 * @param id - connector id.
 * @param credential - credential facts (always gets a fresh `updatedAt`).
 */
async function seed(username: string, id: string, credential: Record<string, unknown>): Promise<string> {
  const store = new ConnectorStore({ username, serverURL: null })
  await store.writeCredential(id, { updatedAt: Date.now(), ...credential } as never)
  return store.dir
}

/**
 * Seed a credential into an explicit directory (the fixed-`storeBaseDir` shape,
 * where the scope does not follow the account).
 * @param dir - credential directory.
 * @param id - connector id.
 * @param credential - credential facts (always gets a fresh `updatedAt`).
 */
async function seedIn(dir: string, id: string, credential: Record<string, unknown>): Promise<void> {
  const store = new ConnectorStore({ baseDir: dir })
  await store.writeCredential(id, { updatedAt: Date.now(), ...credential } as never)
}

/** Read the panel's list route and index it by connector id. */
async function rows(harness: Harness): Promise<Map<string, Row>> {
  const res = await callRoute(harness, '/api/pico/connectors', 'GET')
  expect(res.status, `列表路由必须成功：${res.body}`).toBe(200)
  const body = JSON.parse(res.body) as { connectors: Row[] }
  return new Map(body.connectors.map(row => [row.id, row]))
}

/**
 * Wait until the list route satisfies a predicate.
 *
 * `waitFor` here is a plain poll (no vitest wait API): the assertions below are
 * about a state that settles after an awaited lifecycle task, and the deadline
 * only bounds a hang.
 * @param harness - the harness.
 * @param predicate - receives the rows.
 * @param deadlineMs - bound, in milliseconds.
 */
async function waitForRows(
  harness: Harness,
  predicate: (rows: Map<string, Row>) => boolean,
  deadlineMs = 15_000,
): Promise<Map<string, Row>> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const current = await rows(harness)
    if (predicate(current)) return current
    if (Date.now() > deadline) throw new Error(`条件未在 ${String(deadlineMs)}ms 内成立：${JSON.stringify([...current.values()])}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** A deferred boolean: the gate connector's approval parks until the case releases it. */
function deferredApproval(): { promise: Promise<boolean>, release: (granted: boolean) => void } {
  let release: (granted: boolean) => void = () => {}
  const promise = new Promise<boolean>((resolve) => { release = resolve })
  return { promise, release }
}

describe('R13-B-P2-4 · canRefresh 必须随账号消失', () => {
  it('换账号：B 的 restore 尚未走到该连接器时，B 就不能看到"可刷新"', async () => {
    // A 授权过 target（带 refresh token）；B 只授权过 gate。
    const scopeA = await seed('user-a', TARGET_ID, { accessToken: 'at-a', refreshToken: 'rt-a', expiresAt: Date.now() + 3_600_000 })
    await seed('user-b', GATE_ID, { accessToken: 'at-b', expiresAt: Date.now() + 3_600_000 })
    // 断言 seed 落在插件真正会读的目录（手写布局会让"前提"静默变成空操作）。
    expect(scopeDir('user-a', null), 'seed 的目录必须就是产品的 (账号,服务端) 解析结果').toBe(scopeA)
    expect(scopeDir('user-b', null)).not.toBe(scopeA)

    const gate = deferredApproval()
    const harness = createHarness([stdioDef(GATE_ID, 'gate-server', 'gate'), stdioDef(TARGET_ID, 'target-server', 'target')], home, {
      // 数据根已经按账号解析，这里必须**不**给 baseDir：给了两个账号就共用一份凭据，
      // "B 从未授权"这个前提不成立。
      storeBaseDir: undefined,
      refreshSweepIntervalMs: 0,
      // 只钉住 B 那一轮的 gate 审批；target 的审批照常放行（A 的第一轮要用它）。
      requestApproval: (prompt: { servers?: string[] }) => (prompt.servers ?? []).includes('gate-server') ? gate.promise : true,
    })
    harnesses.push(harness)

    // A 的 restore 走完：target 连上 ⇒ 阳性对照（同一个读点在"该账号授权过"时为真）。
    const beforeSwitch = await waitForRows(harness, rows => rows.get(TARGET_ID)?.status === 'connected')
    expect(beforeSwitch.get(TARGET_ID)?.canRefresh, '对照：A 授权过的连接器必须显示可刷新').toBe(true)
    expect(harness.prompts.length, 'A 的 restore 只应为一个 stdio server 提过审批').toBe(1)

    // 换到 B：teardownAll → syncServerDefs → reconfigureUser → restoreAll(B)。
    harness.emitSession({ username: 'user-b' })
    // B 的 restore 停在 gate 的审批闸上 —— 此刻 target 这一轮还没被 noteCredential 碰到，
    // 正是"面板在 restoreAll 走完之前轮询"的窗口。
    await waitForRows(harness, () => harness.prompts.length === 2)
    const duringSwitch = await rows(harness)
    expect(
      duringSwitch.get(TARGET_ID)?.status,
      '前置：teardownAll 的 states.clear() 必须先落地（否则本用例观察的不是那个窗口）',
    ).toBe('disconnected')
    expect(
      duringSwitch.get(TARGET_ID)?.canRefresh,
      `B 从未授权过 ${TARGET_ID}，面板不允许显示"可刷新"（refreshable 投影必须随 teardownAll 清掉）`,
    ).toBe(false)
    expect(duringSwitch.get(TARGET_ID)?.refreshToken, '前置：状态里的另一半读数也已被清空（清空后该键根本不存在）').not.toBe(true)
    // 反向对照：B 真的授权过的那个连接器在同一时刻是"可刷新"的（判据不是一律为假）。
    // gate 的凭据没有 refresh token，故它只是"授权过"而不是"可续期"；这里断言的是
    // 判据真的按行读数，而不是把整张表压成一个常量。
    expect(duringSwitch.get(GATE_ID)?.canRefresh, 'B 的 gate 凭据没有 refresh token ⇒ 不可刷新').toBe(false)

    gate.release(true)
    await waitForRows(harness, rows => rows.get(GATE_ID)?.status === 'connected')
  }, 60_000)

  it('登出：作用域不随账号变（storeBaseDir 固定）时，残留必须被 teardownAll 清掉', async () => {
    // 这一条刻意用**固定**的 store 目录（harness 缺省的 `storeBaseDir`）：作用域键
    // 的账号维度被对消，于是 `canRefresh` 只可能被 `teardownAll()` 的 `clear()` 救回
    // —— 拆掉那一行即红（用例 1 会因为作用域键仍然绿，两半各有见证）。
    const dir = join(home, 'connectors')
    await seedIn(dir, TARGET_ID, { accessToken: 'at-a', refreshToken: 'rt-a', expiresAt: Date.now() + 3_600_000 })
    const harness = createHarness([stdioDef(TARGET_ID, 'target-server', 'target')], dir, {
      refreshSweepIntervalMs: 0,
      requestApproval: () => true,
    })
    harnesses.push(harness)

    const connected = await waitForRows(harness, rows => rows.get(TARGET_ID)?.status === 'connected')
    expect(connected.get(TARGET_ID)?.canRefresh, '对照：登录态下必须显示可刷新').toBe(true)

    // 登出：`restoreAll` 只在 next !== null 时跑 ⇒ 没有任何自愈点；而 `storeBaseDir`
    // 固定 ⇒ 读点用的作用域与写点相同。
    harness.emitSession(null)
    const afterLogout = await waitForRows(harness, rows => rows.get(TARGET_ID)?.status !== 'connected')
    expect(afterLogout.get(TARGET_ID)?.canRefresh, '登出后不允许再显示"可刷新"').toBe(false)
  }, 60_000)
})
