/**
 * R13-GC 修复泳道 —— B-P2-5：技能用量上报去重集合的**作用域 / 空 id / 上界**。
 *
 * 被修的形态（修复前）：`src/skill-telemetry.ts` 的模块级 `const reported =
 * new Set<string>()`，键是 `name@version#id` —— 既没有账号/会话维度，又永不清理，
 * 命中即在上报 POST **之前** `return false`。上游不回传 `tool_calls[].id` 时
 * callId 是空串，键坍缩成 `alpha@1.0.0#`，于是同进程内任何后续账号/会话调同一技能
 * 都被拦掉（服务端技能用量系统性少计），而集合本身无上界。
 *
 * 判据分工（每条都能被打坏，见各用例里的注释）：
 *  - 作用域（用例 1/6）：两个账号、两个服务端报同一三元组都必须**真的发出去**；
 *  - 空 id（用例 3/3b）：空白/缺失 id 每次都发；非空 id 仍按 id 去重（用例 2）；
 *  - 上界与 LRU（用例 4/4b）：长跑后的集合读数有界，且**最旧的确实被淘汰**、
 *    命中**确实被前移**；
 *  - 键不歧义（用例 7）：NUL 分段 ⇒ 名字里含 `@`/`#` 的不同三元组不会互相顶掉。
 *
 * fetch 的拦法：**stub 全局 `fetch`**，让真实的 `fetchJSON` / `gatewayFetch` 跑
 * 完整条路径（`fetchJSON` 是 `./server-connector/auth.ts` 导入的真实实现，mock 掉
 * 它就会绕开 URL 归一、鉴权头与超时这些真实行为）。断言的是**实际发生的 POST
 * 次数**，不是只看返回值。
 *
 * 测试期才有的读出口（`REPORTED_LIMIT` / `reportScope` / `reportKey` /
 * `__reportedSizeForTest`）用**动态 import** 取：修复前它们还不存在，静态 import 会
 * 让整份 spec 在导入期就失败（所有用例塌成同一条导入错误），看不出是哪条行为判据
 * 拦下的。`reportSkillCall` 修复前后都在，静态导入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportSkillCall } from '../src/skill-telemetry.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '../src/server-connector/config.ts'

/** 两个服务端（保留命名空间的占位域名；stub 掉的 fetch 不会真的解析它们）。 */
const HOST_A = 'https://harness.example.com'
const HOST_B = 'https://harness-b.example.com'

const fakeSession = (username: string, serverURL: string = HOST_A): Session =>
  ({ serverURL, username, token: `${username}-token` })

const ALICE = fakeSession('alice')
const BOB = fakeSession('bob')

/** 实际发生的上报请求（顺序即发生顺序）。 */
const posts: string[] = []

/** 动态 import 拿到的永远是同一个模块实例（同一 specifier，`reported` 是模块级 Map）。 */
const telemetry = async () => await import('../src/skill-telemetry.ts')

beforeEach(() => {
  posts.length = 0
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    posts.push(String(input))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('技能用量上报去重键（R13-GC / B-P2-5）', () => {
  it('用例1 作用域：同一服务端、不同账号 ⇒ 两次都上报', async () => {
    const a = await reportSkillCall(ALICE, 'alpha', '1.0.0', 'call-1')
    const b = await reportSkillCall(BOB, 'alpha', '1.0.0', 'call-1')
    console.log('[用例1] A 上报结果 =', a, ' B 上报结果 =', b, ' 实际 POST 次数 =', posts.length)
    expect(a, 'A 的上报发出').toBe(true)
    expect(b, 'B 的同技能同 id 调用也必须发出（修复前被 A 的条目拦在 POST 之前）').toBe(true)
    expect(posts.length, '两次真实 POST').toBe(2)

    // 反向对照：修复前的键形状 `${name}@${version ?? ''}#${id}` **不消费 session**，
    // 两个账号算出来必然逐字相同 —— 这就是 B 被拦掉的原因。新键构造点把
    // "服务端 + 账号"两段放在前面，两者必须不同。
    const legacyKey = (name: string, version: string | undefined, id: string): string => `${name}@${version ?? ''}#${id}`
    const legacyForAlice = legacyKey('alpha', '1.0.0', 'call-1')
    const legacyForBob = legacyKey('alpha', '1.0.0', 'call-1')
    expect(legacyForBob, '旧键形状与账号无关 ⇒ A/B 逐字相同（B 因此被去重）').toBe(legacyForAlice)
    const { reportKey, reportScope } = await telemetry()
    expect(reportScope(ALICE), '作用域必须区分账号').not.toBe(reportScope(BOB))
    expect(reportKey(ALICE, 'alpha', '1.0.0', 'call-1'), '新键必须区分账号')
      .not.toBe(reportKey(BOB, 'alpha', '1.0.0', 'call-1'))
  })

  it('用例2 同一作用域内真的去重：同三元组第二次不发', async () => {
    const r1 = await reportSkillCall(ALICE, 'beta', '1.0.0', 'call-2')
    const r2 = await reportSkillCall(ALICE, 'beta', '1.0.0', 'call-2')
    console.log('[用例2] 第一次 =', r1, ' 第二次 =', r2, ' 实际 POST 次数 =', posts.length)
    expect([r1, r2]).toEqual([true, false])
    expect(posts.length, '同一调用只有一次 POST').toBe(1)
    // serverURL 尾部斜杠只是写法差异 ⇒ 归一后必须还是同一个作用域（否则同一账号重复计数）。
    const trailingSlash = { ...ALICE, serverURL: `${HOST_A}/` }
    const r3 = await reportSkillCall(trailingSlash, 'beta', '1.0.0', 'call-2')
    expect(r3, '仅尾斜杠不同 ⇒ 仍算同一次调用').toBe(false)
    expect(posts.length).toBe(1)
  })

  it('用例3 空 id：每次都发（不参与去重）', async () => {
    const empty = await reportSkillCall(ALICE, 'gamma', '1.0.0', '')
    const emptyAgain = await reportSkillCall(ALICE, 'gamma', '1.0.0', '')
    const spaces = await reportSkillCall(ALICE, 'gamma', '1.0.0', '   ')
    console.log('[用例3] 三次结果 =', [empty, emptyAgain, spaces], ' 实际 POST 次数 =', posts.length)
    expect([empty, emptyAgain, spaces]).toEqual([true, true, true])
    expect(posts.length, '空 id 的两次真实调用 + 一次纯空格 = 三次 POST').toBe(3)
  })

  it('用例3b 可达路径：tools/result 的 callId 为空/缺失时每次都发', async () => {
    const { apply } = await telemetry()
    const handlers = new Map<string, (...args: unknown[]) => void>()
    const ctx = {
      picoSession: { getSession: () => ALICE },
      on: (event: string, fn: (...args: unknown[]) => void) => {
        if (!handlers.has(event)) handlers.set(event, fn)
      },
    } as unknown as Context
    apply(ctx)
    const onResult = handlers.get('tools/result')
    expect(onResult, 'apply 注册了 tools/result 观察者').toBeTypeOf('function')

    const exec = (callId: unknown) => ({
      name: 'skill',
      arguments: { name: 'epsilon' },
      callId,
      rootCallId: callId,
      token: Symbol('t'),
      signal: new AbortController().signal,
    })
    const ok = { isError: false, value: null, content: [] }
    // 上游 chat-completions 适配器在不回传 tool_calls[].id 时给的是空串；
    // 事件字段缺失时 String(undefined) 会变成字面量 "undefined" —— 两种都必须当作"无 id"
    // （否则同一技能的所有"缺 id 调用"会坍缩成同一个键，仍然只发一次）。
    onResult!(exec(''), ok)
    onResult!(exec(''), ok)
    onResult!(exec(undefined), ok)
    onResult!(exec(undefined), ok)
    onResult!(exec('call-real-3b'), ok)
    onResult!(exec('call-real-3b'), ok)
    await new Promise((resolve) => setTimeout(resolve, 80))
    console.log('[用例3b] 实际 POST 次数 =', posts.length)
    expect(posts.length, '空/缺失 id 四次都发；有 id 的两次仍只发一次').toBe(5)
  })

  it('用例4 长跑不涨：集合读数有界，且最旧的确实被淘汰', async () => {
    const total = 2000
    for (let i = 0; i < total; i += 1) await reportSkillCall(ALICE, 'bulk', '1.0.0', `bulk-${i}`)
    expect(posts.length, '每个不同 id 都真的发出').toBe(total)
    const { REPORTED_LIMIT, __reportedSizeForTest } = await telemetry()
    const size = __reportedSizeForTest()
    console.log('[用例4] 插入', total, '个不同 id 后集合读数 =', size, ' 上限 =', REPORTED_LIMIT)
    expect(size, '读出口不是恒零（否则下面的"有界"是恒真断言）').toBeGreaterThan(0)
    expect(size, '不能等于插入条数（无界集合的形态）').toBeLessThan(total)
    expect(size, '不得超过模块声明的上限').toBeLessThanOrEqual(REPORTED_LIMIT)
    // 行为判据（不依赖读数）：最旧的条目已被淘汰 ⇒ 再报它是"新的一次调用"。
    const oldest = await reportSkillCall(ALICE, 'bulk', '1.0.0', 'bulk-0')
    expect(oldest, '最旧的条目被淘汰 ⇒ 再次上报真的发出').toBe(true)
  })

  it('用例4b LRU 次序：命中要前移，淘汰的是真正最旧的一条', async () => {
    const { REPORTED_LIMIT } = await telemetry()
    // 常量若被改成 Infinity/极大值，这轮填充也不能把用例挂死（同步死循环无法被超时打断）。
    const fill = Math.min(REPORTED_LIMIT, 1024)
    for (let i = 0; i < fill; i += 1) await reportSkillCall(ALICE, 'lru', '1.0.0', `lru-${i}`)
    const touched = await reportSkillCall(ALICE, 'lru', '1.0.0', 'lru-0')
    expect(touched, '命中即去重（不重发）').toBe(false)
    await reportSkillCall(ALICE, 'lru', '1.0.0', 'lru-new')
    const promoted = await reportSkillCall(ALICE, 'lru', '1.0.0', 'lru-0')
    const trulyOldest = await reportSkillCall(ALICE, 'lru', '1.0.0', 'lru-1')
    console.log('[用例4b] 上限 =', REPORTED_LIMIT, ' 被前移的 lru-0 再报 =', promoted,
      ' 真正最旧的 lru-1 再报 =', trulyOldest)
    expect(promoted, 'lru-0 命中过 ⇒ 被前移到最新，不该被淘汰').toBe(false)
    expect(trulyOldest, 'lru-1 才是淘汰对象 ⇒ 再次上报真的发出').toBe(true)
  })

  it('用例5 未登录：不发送（既有契约不变）', async () => {
    const ok = await reportSkillCall(null, 'alpha', '1.0.0', 'call-1')
    console.log('[用例5] 未登录上报结果 =', ok, ' 实际 POST 次数 =', posts.length)
    expect(ok).toBe(false)
    expect(posts.length).toBe(0)
  })

  it('用例6 服务端段：同账号、不同 serverURL ⇒ 两次都发', async () => {
    const carolA = fakeSession('carol', HOST_A)
    const carolB = fakeSession('carol', HOST_B)
    const a = await reportSkillCall(carolA, 'delta', '1.0.0', 'call-6')
    const b = await reportSkillCall(carolB, 'delta', '1.0.0', 'call-6')
    console.log('[用例6] 两个服务端结果 =', [a, b], ' 实际 POST 次数 =', posts.length)
    expect([a, b]).toEqual([true, true])
    expect(posts.length, '两个服务端各自一次 POST').toBe(2)
    const { reportKey, reportScope } = await telemetry()
    expect(reportScope(carolA), '作用域必须区分服务端').not.toBe(reportScope(carolB))
    expect(reportKey(carolA, 'delta', '1.0.0', 'call-6')).not.toBe(reportKey(carolB, 'delta', '1.0.0', 'call-6'))
  })

  it('用例7 键分段：名字/版本里含 @ 或 # 的不同三元组不会互相顶掉', async () => {
    // 旧键形状是裸拼接 `${name}@${version}#${id}`：('a','b@c','d') 与 ('a@b','c','d')
    // 都拼成 `a@b@c#d` ⇒ 后者被前者去重。NUL 分段后两者必须各自上报。
    const first = await reportSkillCall(ALICE, 'a', 'b@c', 'd')
    const second = await reportSkillCall(ALICE, 'a@b', 'c', 'd')
    console.log('[用例7] 结果 =', [first, second], ' 实际 POST 次数 =', posts.length)
    expect([first, second]).toEqual([true, true])
    expect(posts.length).toBe(2)
    const { reportKey } = await telemetry()
    expect(reportKey(ALICE, 'a', 'b@c', 'd')).not.toBe(reportKey(ALICE, 'a@b', 'c', 'd'))
  })
})
