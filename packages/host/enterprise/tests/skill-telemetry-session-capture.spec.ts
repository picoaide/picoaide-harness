/**
 * 技能用量上报的**会话归属取自调用时刻**（第二十八轮 FIX-40 ③）。
 *
 * 被修的形态（原 `KNOWN_UNGUARDED_ENTRIES`、第二十九轮 FIX-44 ② 已迁到 `ENTRY_EXEMPTIONS`
 * 的那条"await 之后才读会话"）：两个观察点都是
 *
 *     void installedVersion(name).then(() => reportSkillCall(ctx.picoSession.getSession(), …))
 *
 * —— 会话是在 `installedVersion` 的 **await 续体里**才读的。于是"读版本文件期间用户换了
 * 账号/服务端"这条普通时序会把**上一账号**的技能调用记到**新账号**名下（`reportScope`
 * 的作用域与令牌全指向新账号）。版本读取是本地文件 IO，窗口窄但真实，且错记不可回溯。
 *
 * # 判据为什么必须打成确定性
 *
 * 修前的窗口只在"文件 IO 恰好跨过换账号那一刻"才出现 —— 靠 sleep / 抢占去撞它是**概率**
 * 判据（本仓已登记"判据结论不可复现"这一类假绿）。这里把 `node:fs/promises.readFile`
 * 换成一个**由用例控制何时落地**的 promise：观察点先跑（会话 = ALICE）→ 用例把会话切成
 * BOB → 再让读落地 → 断言这一笔上报记在 **ALICE** 名下。确定性、与机器负载无关。
 *
 * # 同一条断言也钉住"修前的形状"
 *
 * 第二个用例把修前的**形状**（在 `.then` 回调里读当前会话）作为负向对照跑同一条断言：
 * 它会记到 BOB 名下 ⇒ 证明这条判据真的能咬到那个形状（不是恒绿的存在性断言）。
 * 交付报告里的"修前红"另有实跑：同一份 spec 跑在 `git archive HEAD` 的
 * `skill-telemetry.ts` 上会红在第一个用例。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Session } from '../src/server-connector/config.ts'
// 等待预算集中表（唯一真源在桌面包的 tests/；跨包面由 wait-budget-contract.spec.ts 对拍）。
import { WAIT_BUDGETS } from '../../desktop/tests/wait-budgets.ts'

/** 两个服务端（保留命名空间的占位域名；stub 掉的 fetch 不解析它们）。 */
const HOST_A = 'https://harness.example.com'
const HOST_B = 'https://harness-b.example.com'

const ALICE: Session = { serverURL: HOST_A, username: 'alice', token: 'alice-token' }
const BOB: Session = { serverURL: HOST_B, username: 'bob', token: 'bob-token' }

/** 让 `installedVersion` 的 `readFile` 停在"已发出、未落地"。 */
let landRead: (() => void) | undefined

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn(() => new Promise<string>((resolve) => { landRead = () => resolve('9.9.9\n') })),
  }
})

/** 实际发生的上报（顺序即发生顺序）：记录服务端与令牌 —— 归属就写在这两处。 */
const posts: Array<{ url: string, authorization: string | undefined }> = []

beforeEach(() => {
  posts.length = 0
  landRead = undefined
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    posts.push({ url: String(input), authorization: headers.authorization ?? headers.Authorization })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const EXEC = {
  name: 'skill',
  arguments: { name: 'codeql' },
  callId: 'c-session-1',
  rootCallId: 'c-session-1',
  token: Symbol('t'),
  signal: new AbortController().signal,
} as unknown as ToolExecution
const OK_RESULT: ToolExecutionResult = { isError: false, value: null, content: [] }

/**
 * 造一个"会话可切换"的假上下文，并返回两个观察点。
 * @param read - 取当前会话（用例可变）。
 * @returns 观察点与监听表。
 */
function drivenContext(read: () => Session | null): {
  handlers: Map<string, (...args: never[]) => void>
  ctx: Context
} {
  const handlers = new Map<string, (...args: never[]) => void>()
  const ctx = {
    picoSession: { getSession: read },
    on: (event: string, fn: (...args: never[]) => void) => { handlers.set(event, fn) },
  } as unknown as Context
  return { handlers, ctx }
}

describe('技能用量上报的会话归属（FIX-40 ③：观察点同步取会话）', () => {
  it('tools/result：读版本期间换账号 ⇒ 这一笔仍记在**发起时**那一代名下', async () => {
    let session: Session | null = ALICE
    const { handlers, ctx } = drivenContext(() => session)
    const { apply } = await import('../src/skill-telemetry.ts')
    apply(ctx)

    handlers.get('tools/result')!(EXEC as never, OK_RESULT as never)
    // 观察点已经跑完（会话 = ALICE），版本读取停在半空 —— 此刻换账号。
    session = BOB
    expect(landRead, '前提：版本读取必须真的被 await 挂住（否则判据构造不出来）').toBeTypeOf('function')
    landRead!()
    // 预算理由：观察的是进程内的异步链（skill/event → 会话读取 → telemetry 组装 → fetch 替身），
    // 现象本身毫秒级，预算买的是调度余量 ⇒ 状态传播档（现象下限 10s）。
    await expect.poll(() => posts.length, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS }).toBeGreaterThan(0)

    expect(posts, '恰一次上报').toHaveLength(1)
    expect(posts[0]!.url.startsWith(HOST_A), `上报必须落在 ALICE 的服务端，实际 ${posts[0]!.url}`).toBe(true)
    expect(posts[0]!.authorization, '令牌也必须是 ALICE 的').toContain(ALICE.token)
  })

  it('session/event（用户 /name 手势）：同一条归属判据', async () => {
    let session: Session | null = ALICE
    const { handlers, ctx } = drivenContext(() => session)
    const { apply } = await import('../src/skill-telemetry.ts')
    apply(ctx)

    handlers.get('session/event')!(
      {} as never,
      { type: 'user/message', data: { id: 'm-1', source: { kind: 'skill-invocation', name: 'codeql' } } } as never,
    )
    session = BOB
    landRead!()
    // 预算理由：观察的是进程内的异步链（skill/event → 会话读取 → telemetry 组装 → fetch 替身），
    // 现象本身毫秒级，预算买的是调度余量 ⇒ 状态传播档（现象下限 10s）。
    await expect.poll(() => posts.length, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS }).toBeGreaterThan(0)

    expect(posts, '恰一次上报').toHaveLength(1)
    expect(posts[0]!.url.startsWith(HOST_A), `上报必须落在 ALICE 的服务端，实际 ${posts[0]!.url}`).toBe(true)
    expect(posts[0]!.authorization).toContain(ALICE.token)
  })

  it('负向对照：修前的形状（在 .then 里读当前会话）会被同一条断言抓住', async () => {
    let session: Session | null = ALICE
    // 修前的形态逐字复刻：会话在 await 的续体里才读。
    const preFixShape = (): void => {
      void Promise.resolve()
        .then(async () => await (await import('../src/skill-telemetry.ts')).reportSkillCall(session, 'codeql', '9.9.9', 'c-legacy'))
    }
    session = ALICE
    preFixShape()
    session = BOB
    // 预算理由：观察的是进程内的异步链（skill/event → 会话读取 → telemetry 组装 → fetch 替身），
    // 现象本身毫秒级，预算买的是调度余量 ⇒ 状态传播档（现象下限 10s）。
    await expect.poll(() => posts.length, { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS }).toBeGreaterThan(0)

    expect(posts, '修前形状也会发出一次上报').toHaveLength(1)
    // 判据在这里必须**判红**：它记到了 BOB 名下 —— 与第一个用例的断言方向相反，
    // 证明"取调用时刻的会话"这条判据不是恒绿。
    expect(posts[0]!.url.startsWith(HOST_B), '修前形状会把这一笔记到新账号名下（判据必须能看见它）').toBe(true)
    expect(posts[0]!.authorization).toContain(BOB.token)
  })
})
