/**
 * C2-2（2026-10 审计）：`pico/session-changed` 的两次投递必须给出**同一个**"没有会话"
 * 哨兵，且 `channel-sync` 不得静默吞掉同步失败。
 *
 * 缺陷形态（审计探针 `probe/session-undefined.probe.spec.ts`，跑 HEAD 真实模块）：
 *   ```
 *   {"seen":[null],"firstIsNull":false,"firstIsUndefined":true}   # JSON.stringify 把 undefined 印成 null
 *   ```
 * 叶子包 `@picoaide/dsh-host-locale/session-events` 在"探测不到 `picoSession`"这一档
 * 回调 `undefined`，而事件通道（`SessionService` 的 `pico/session-changed`）一直投
 * `null`；enterprise 的包装层 `subscribeSession` 公开签名却是 `Session | null`，三处
 * 消费方（`bootstrap` / `channel-sync` / `error-reporting`）**只判 `=== null`** ⇒ 收到
 * `undefined` 时走进"已登录"分支、在字段读取上抛错。`channel-sync` 那次的失败还会被
 * 它的 `.catch(() => undefined)` 整份吞掉（界面停在随包品牌，日志里一个字都没有）。
 *
 * 判据分三层（都是**行为**，不是"源码里出现过某个标识符"）：
 *  ① 契约：真 `subscribeSession`（→ 叶子包唯一实现）+ "没有会话服务"的结构替身 ⇒
 *     回调收到 `null`，且**不是** `undefined`；
 *  ② 消费方行为：真 `bootstrap.apply()` 在同一替身上必须走"未登录"分支
 *     （三个命名空间被 `replace(…, {})` 清回组装缺省）且**不**报错；收到 `undefined`
 *     时它会去打网关、失败、只留一条 `pico bootstrap sync failed`（这一条即红）；
 *  ③ 失败出口：`channel-sync` 的非预期同步失败必须在 logger 上留下可检索的一行
 *     （旧实现 `.catch(() => undefined)` ⇒ 一条都没有）。
 *
 * 变异（逐条实跑见 `temp/audit-v282/fixes/C2-P2-batch.md`）：
 *  - 去掉叶子包的 `?? null`（补发投 `undefined`）⇒ ① 与 ② 红；
 *  - 把 `channel-sync` 的 `.catch(reportFailure)` 改回 `.catch(() => undefined)` ⇒ ③ 红。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyBootstrap } from '../src/bootstrap.ts'
import { apply as applyChannelSync } from '../src/channel-sync.ts'
import { subscribeSession } from '../src/session-service.ts'
import { GATEWAY_LLM_ROW_ID } from '../src/gateway-contract.ts'
import type { Session } from '../src/server-connector/config.ts'

const SESSION: Session = { serverURL: 'https://harness.example', username: 'alice', token: 'tok-1' }

/**
 * 「还没装配 enterprise 面」的结构替身（叶子包 JSDoc 点名的第三档）：
 * 只有 `on`，**没有** `get`、**没有** `picoSession` 属性 ⇒ `probeSession()` = undefined。
 *
 * 这一档在真实装配里出现在"host 起了、`picoSession` 服务还没注册"的窗口（以及本仓
 * 大量结构替身用例）；叶子包明确要求"也回调一次，让消费方知道现在没有会话"。
 */
function ctxWithoutSessionService(): {
  ctx: Context
  emitSession: (session: unknown) => void
  listeners: Array<(session: unknown) => void>
} {
  const listeners: Array<(session: unknown) => void> = []
  const ctx = {
    on: (_event: string, listener: (session: unknown) => void) => {
      listeners.push(listener)
      return () => { listeners.splice(listeners.indexOf(listener), 1) }
    },
  } as unknown as Context
  return { ctx, listeners, emitSession: (session) => { for (const l of [...listeners]) l(session) } }
}

describe('C2-2 ①：订阅契约的"没有会话"哨兵只有一个（null）', () => {
  it('探测不到 picoSession ⇒ 补发 `null`，不是 `undefined`', () => {
    const { ctx } = ctxWithoutSessionService()
    const seen: unknown[] = []
    subscribeSession(ctx, (session) => { seen.push(session) })
    expect(seen, '补发必须发生（消费方不能永远等一个不会来的事件）').toHaveLength(1)
    expect(seen[0], 'enterprise 包装层的签名是 `Session | null`，实现必须只投这一种哨兵').toBeNull()
    expect(seen[0], '`undefined` 正是 C2-2：消费方按 `=== null` 判，会当成"已登录"').not.toBeUndefined()
  })
})

describe('C2-2 ②：消费方在"没有会话"这一档走未登录分支（不是去打网关）', () => {
  it('bootstrap：三个命名空间被清回组装缺省，且不报错', async () => {
    const replace = vi.fn(async () => undefined)
    const update = vi.fn(async () => undefined)
    const error = vi.fn()
    const { ctx } = ctxWithoutSessionService()
    Object.assign(ctx as unknown as Record<string, unknown>, {
      settings: { replace, update },
      logger: { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    })
    const fetchSpy = vi.fn()
    const original = globalThis.fetch
    vi.stubGlobal('fetch', fetchSpy)
    try {
      applyBootstrap(ctx)
      // 现象：进程内异步状态传播 —— `apply()` 里那一次补发是**同步**触发的，但它内部的
      // `sync()` 是 async（三次 `settings.replace` 各带一个 await），所以断言必须等它跑完；
      // vitest 缺省的 1s 在 CI 4 vCPU 负载下不够（R11-B-02），故显式给 10s（有界：三条
      // replace 是纯内存 stub，不会真的耗到 10s）。
      await vi.waitFor(
        () => { expect(replace, '未登录必须清回组装缺省（旧行为：当成已登录 → 去打网关）').toHaveBeenCalledTimes(3) },
        { timeout: 10_000 },
      )
      expect(replace).toHaveBeenCalledWith('agent-default-model', {})
      expect(replace).toHaveBeenCalledWith(GATEWAY_LLM_ROW_ID, {})
      expect(replace).toHaveBeenCalledWith('web-search-deepseek', {})
      expect(update, '未登录分支不得写任何会话派生内容').not.toHaveBeenCalled()
      expect(fetchSpy, '未登录分支不得出网').not.toHaveBeenCalled()
      expect(error, '未登录不是错误：不得留下 `pico bootstrap sync failed`').not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = original
      vi.unstubAllGlobals()
    }
  })
})

describe('C2-2 ③：channel-sync 的同步失败不得被静默吞掉', () => {
  it('非预期失败（`pico/channel-changed` 的消费方抛错）必须留下可检索的一行日志', async () => {
    const error = vi.fn()
    const listeners: Array<(session: unknown) => void> = []
    const ctx = {
      on: (_event: string, listener: (session: unknown) => void) => {
        listeners.push(listener)
        return () => { listeners.splice(listeners.indexOf(listener), 1) }
      },
      // 界面出口抛错 = 真实的"某个消费方在 emit 里抛了"（Cordis 同步派发会把它
      // 传播回 emit 调用者）。它落在 `sync` 的两条预期失败（服务端不可达 / 迟到响应）
      // 之外，所以必须由最外层 `.catch` 记账。
      emit: () => { throw new Error('channel listener blew up') },
      logger: { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    } as unknown as Context
    applyChannelSync(ctx)
    expect(listeners, '订阅必须已登记（否则下面的触发是空跑）').toHaveLength(1)
    listeners[0]!(null)
    // 现象：`sync()` 是 async（listener → void sync(session).catch(reportFailure)），
    // 所以 logger 的那一行不在本次同步调用栈里，只能等它落地；vitest 缺省的 1s 在 CI
    // 4 vCPU 负载下不够（R11-B-02），显式给 10s（stub 的 logger.error 是同步 mock，
    // 正常一轮微任务即到）。
    await vi.waitFor(
      () => { expect(error, '旧实现 `.catch(() => undefined)` 在这里一条日志都没有').toHaveBeenCalled() },
      { timeout: 10_000 },
    )
    expect(error.mock.calls[0]?.[0], '日志必须可检索（稳定前缀）').toContain('channel-sync: session sync failed')
    expect(error.mock.calls[0]?.[1], '原始原因必须一起留下').toBeInstanceOf(Error)
  })
})

/**
 * 反向对照：哨兵归一**不得**把真实会话吃掉（否则 ①② 可能靠"永远投 null"假绿）。
 */
describe('C2-2 反向对照：真实会话照常投递', () => {
  it('服务存在且已恢复 ⇒ 收到的是那一份会话（不是 null）', () => {
    const listeners: Array<(session: unknown) => void> = []
    const ctx = {
      on: (_event: string, listener: (session: unknown) => void) => {
        listeners.push(listener)
        return () => { listeners.splice(listeners.indexOf(listener), 1) }
      },
      picoSession: { isRestored: () => true, getSession: () => SESSION },
    } as unknown as Context
    const seen: unknown[] = []
    subscribeSession(ctx, (session) => { seen.push(session) })
    expect(seen).toEqual([SESSION])
  })
})
