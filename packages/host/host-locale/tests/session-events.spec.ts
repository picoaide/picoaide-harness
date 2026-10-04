/**
 * `pico/session-changed` 订阅契约（唯一实现）的判据。
 *
 * 这段顺序的价值全在"恢复型启动"这条路径上：`SessionService.restore()` 在**构造期**就
 * 启动，它 emit 的那一刻可能早于消费方的 `apply()` —— 裸 `ctx.on` 于是要等到下一次
 * 登录/登出才生效（本仓已两次同根因）。所以判据必须是**行为**的：
 *
 *  ① 订阅**先**登记、再判补发（用一个"订阅那一刻才把 isRestored 置真"的替身把顺序钉死）；
 *  ② `isRestored() === true` ⇒ 立刻补发一次（错过的那次）；
 *  ③ `isRestored() === false` ⇒ **不**补发（那次 emit 还没发生，订阅已就位）；
 *  ④ 服务缺席 / 缺 `isRestored` ⇒ 补发一次"未登录"（消费方必须知道现在没有会话，
 *     而不是永远等一个不会来的事件），且哨兵是 **`null`** —— 与事件通道同一个值
 *     （C2-2：此前补发投 `undefined`，消费方只判 `=== null` 时会当成"已登录"）；
 *  ⑤ `probe` 覆盖（wasm-apps-host 的归一化读取）生效：补发的值取自它，而不是 `ctx.get`。
 *
 * 变异：把 `if (service?.isRestored === undefined || service.isRestored())` 改成恒真
 * （去掉判据）⇒ ③ 红；把订阅挪到补发之后 ⇒ ① 红；把 `?? null` 去掉（补发投
 * `undefined`）⇒ ④ 的三条与「两条通道同一个哨兵」红。
 */
import { describe, expect, it } from 'vitest'
import {
  PICO_SESSION_SERVICE,
  SESSION_CHANGED_EVENT,
  subscribeSessionChanges,
  type PicoSessionProbe,
  type SessionEventContext,
} from '../src/session-events.ts'

/** 最小假上下文：记录订阅顺序、可注入服务。 */
function contextOf(service?: PicoSessionProbe | undefined): SessionEventContext & {
  listeners: Array<(session: unknown) => void>
  subscribed: boolean
  emit(session: unknown): void
} {
  const listeners: Array<(session: unknown) => void> = []
  const state = {
    listeners,
    subscribed: false,
    on(event: string, listener: (session: unknown) => void): () => void {
      expect(event).toBe(SESSION_CHANGED_EVENT)
      listeners.push(listener)
      state.subscribed = true
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    get(name: string): unknown {
      expect(name).toBe(PICO_SESSION_SERVICE)
      return service
    },
    emit(session: unknown): void {
      for (const listener of [...listeners]) listener(session)
    },
  }
  return state
}

describe('pico/session-changed 订阅契约（宿主侧唯一实现）', () => {
  it('事件名与服务注册名是契约的一部分', () => {
    expect(SESSION_CHANGED_EVENT).toBe('pico/session-changed')
    expect(PICO_SESSION_SERVICE).toBe('picoSession')
  })

  it('订阅先于补发：补发时监听已经就位（恢复期的 emit 不会漏）', () => {
    const seen: unknown[] = []
    // 这个替身的关键在 `isRestored()`：它在**订阅**发生时把"已经错过的事件"补上。
    const ctx = contextOf({
      isRestored: () => ctx.subscribed,
      getSession: () => ({ username: 'alice' }),
    })
    subscribeSessionChanges(ctx, (session) => { seen.push(session) })
    // 顺序证据：补发的那一刻 `subscribed` 已经是 true（把两行调换即红）。
    expect(ctx.subscribed).toBe(true)
    expect(seen).toEqual([{ username: 'alice' }])
    // 之后的事件照常送达。
    ctx.emit({ username: 'bob' })
    expect(seen).toEqual([{ username: 'alice' }, { username: 'bob' }])
  })

  it('恢复仍在飞行（isRestored=false）⇒ 不补发；那次 emit 稍后照常送达', () => {
    let restored = false
    const seen: unknown[] = []
    const ctx = contextOf({ isRestored: () => restored, getSession: () => ({ username: 'alice' }) })
    subscribeSessionChanges(ctx, (session) => { seen.push(session) })
    expect(seen, '还没恢复就补发 ⇒ 既重复又可能给出半截状态').toEqual([])
    restored = true
    ctx.emit({ username: 'alice' })
    expect(seen).toEqual([{ username: 'alice' }])
  })

  it('服务缺席 / 缺 isRestored ⇒ 补发一次"未登录"，而不是永远等事件', () => {
    const absent: unknown[] = []
    subscribeSessionChanges(contextOf(undefined), (session) => { absent.push(session) })
    // C2-2：哨兵只有一个 —— `null`。此前这里投的是 `undefined`，而事件通道
    // （`SessionService` 的 `pico/session-changed`）一直投 `null` ⇒ 同一个订阅按
    // **到达方式**给出两种"没有会话"，而消费方（enterprise 三处）只判 `=== null`。
    expect(absent, '未登录哨兵必须是 null，不是 undefined').toEqual([null])
    expect(absent[0]).not.toBeUndefined()
    const partial: unknown[] = []
    subscribeSessionChanges(contextOf({ getSession: () => ({ username: 'x' }) }), (session) => { partial.push(session) })
    expect(partial).toEqual([{ username: 'x' }])
  })

  it('`getSession` 自身返回 undefined（防御档）也归一到 null', () => {
    const seen: unknown[] = []
    subscribeSessionChanges(contextOf({ isRestored: () => true, getSession: () => undefined }), (session) => { seen.push(session) })
    expect(seen).toEqual([null])
  })

  it('两条投递通道给出同一个哨兵：事件 null 与补发 null 不可区分', () => {
    // 判别力就在这里：把补发那一侧改回 `undefined`，下面第一条断言立刻红 ——
    // 消费方无法只判 `=== null`（这正是 C2-2 的现场）。
    const replayed: unknown[] = []
    subscribeSessionChanges(contextOf({ isRestored: () => true, getSession: () => null }), (session) => { replayed.push(session) })
    const ctx = contextOf({ isRestored: () => false })
    const delivered: unknown[] = []
    subscribeSessionChanges(ctx, (session) => { delivered.push(session) })
    ctx.emit(null)
    expect(replayed).toEqual([null])
    expect(delivered).toEqual([null])
    expect(replayed[0]).toStrictEqual(delivered[0])
  })

  it('probe 覆盖生效：补发的值取自它（wasm-apps-host 的归一化读取）', () => {
    const seen: unknown[] = []
    const ctx = contextOf({ isRestored: () => true, getSession: () => ({ username: 'from-ctx-get' }) })
    subscribeSessionChanges(
      ctx,
      (session) => { seen.push(session) },
      () => ({ isRestored: () => true, getSession: () => ({ username: 'from-probe' }) }),
    )
    expect(seen).toEqual([{ username: 'from-probe' }])
  })

  it('结构替身（只挂 `picoSession` 属性、没有 `get`）也认：补发一次真实会话', () => {
    // 本仓 enterprise 的用例大量用这种替身（`{ on, emit, picoSession }`）。真实上下文的
    // 探测顺序是"有 `get` 就只用它"，替身没有 `get` ⇒ 回落到属性面（否则补发会拿到
    // undefined，白标/模型目录那两条"恢复型启动"判据会假红）。
    const listeners: Array<(session: unknown) => void> = []
    const seen: unknown[] = []
    const ctx = {
      on: (_event: string, listener: (session: unknown) => void): (() => void) => {
        listeners.push(listener)
        return () => { listeners.splice(listeners.indexOf(listener), 1) }
      },
      picoSession: { isRestored: () => true, getSession: () => ({ username: 'stub-user' }) },
    }
    subscribeSessionChanges(ctx, (session) => { seen.push(session) })
    expect(seen).toEqual([{ username: 'stub-user' }])
  })

  it('取消订阅之后不再收到事件', () => {
    const seen: unknown[] = []
    const ctx = contextOf({ isRestored: () => false })
    const off = subscribeSessionChanges(ctx, (session) => { seen.push(session) })
    ctx.emit({ username: 'alice' })
    off()
    ctx.emit({ username: 'bob' })
    expect(seen).toEqual([{ username: 'alice' }])
  })
})
