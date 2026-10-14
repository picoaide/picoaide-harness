/**
 * 夹具 `ctx.inject` 的**语义对拍**（2026-10-14 对抗审计 · 乙-1）。
 *
 * ## 为什么这条判据独立存在
 *
 * `tests/helpers/apply-full-composition.ts` 的假 ctx 是**本包三十个 spec 的公共地基**：
 * 它一旦比真 Cordis 宽（或窄），判据的绿/红就有一部分来自**夹具形状**而不是产品行为。
 * 审计用工作树里实际安装的 `@deepseek-ai/cordis@4.0.4` 实测了 `ctx.inject` 的 13 条语义，
 * 与夹具逐条对拍出 **6 处不一致**，并把"乙-1 未逐条构造对拍用例"列为未验证边界。
 *
 * 本文件把那 6 处里**已经补齐**的四处做成可执行的判据（另两处按文件头登记为"未覆盖"：
 * 微任务时序、子 Context / `impl.check()` —— 假 ctx 没有那两个面）：
 *
 *  1. **裸字符串**依赖：真 Cordis 抛 `TypeError: Reflect.has called on non-object`
 *     ⇒ 夹具必须 **fail-loud**，不能替真机兜底（那会藏"本地绿、真机红"）；
 *  2. **对象映射** `{name: config}`：真 Cordis 支持 ⇒ 夹具不得**静默不跑**；
 *  3. **回调返回的 disposer**：真 Cordis 收进子 fiber、卸载时调 ⇒ 夹具必须收集、可回收；
 *  4. **响应式**：服务后到 ⇒ 回调后来会跑；服务消失 ⇒ 回调被 unload 且其 disposer 被调。
 *
 * 判据判的是**夹具与真机的差**：所以每一条都写成"真机怎样 ⇒ 夹具必须怎样"，而不是
 * "夹具现在怎样"。第 5 条还钉住返回值的**形状**（真 Cordis 返 Fiber，不是回调返回值）。
 *
 * 本文件**不装** `tools`（刻意）：`registerAppRoutes` 的 `ctx.inject(['tools'], …)` 因此
 * 正好是"服务缺席"的一档，`skippedInjections` / `ranInjections` 两个读面必须自洽。
 */
import { describe, expect, it, vi } from 'vitest'
import { applyFullComposition, type FullComposition } from './helpers/apply-full-composition.ts'

/** 夹具注入面的最小可调用形状（`applyFullComposition` 包装后的那份）。 */
interface Injectable {
  get: (name: string) => unknown
  provide: (name: string, value: unknown) => unknown
  inject: (
    names: string | string[] | Record<string, unknown>,
    callback: (scope: unknown) => unknown,
  ) => { dispose: () => void, then: (resolve?: (value: unknown) => unknown) => unknown }
}

/**
 * 装一个够用的假 ctx 并装组合（与 `wasm-app-tools.spec.ts` 的 harness 同款形状的**最小**
 * 版本：这里只关心 `inject`/`provide` 这一对）。刻意**不给** `tools`。
 * @returns 包装后的 ctx 与装组合的返回面。
 */
function compose(): { ctx: Injectable, composition: FullComposition } {
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    provide: (name: string, value: unknown) => {
      ;(ctx as unknown as Record<string, unknown>)[`__svc_${name}`] = value
    },
    get: (name: string) => {
      const provided = (ctx as unknown as Record<string, unknown>)[`__svc_${name}`]
      if (provided !== undefined) return provided
      if (name === 'connection') return { requestRejection: () => undefined }
      return undefined
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    picoSession: {
      isRestored: () => true,
      isLoggedIn: () => false,
      getSession: () => null,
      setSession: vi.fn(),
      clear: vi.fn(),
    },
    webServer: { tapIndex: () => () => {}, register: () => () => {} },
  }
  const composition = applyFullComposition(ctx as never, {} as never)
  return { ctx: ctx as unknown as Injectable, composition }
}

describe('applyFullComposition 的 ctx.inject：与真 Cordis 的语义差', () => {
  it('① 裸字符串依赖 fail-loud（真 Cordis 会抛 TypeError，夹具不替它兜底）', () => {
    const { ctx } = compose()
    const callback = vi.fn()
    // 真机现场：`Inject.resolve` 对非对象调 `Reflect.has` ⇒
    // `TypeError: Reflect.has called on non-object`（本仓实测）。
    expect(() => ctx.inject('tools' as never, callback)).toThrow(/Reflect\.has called on non-object/u)
    // 关键：**不能**静默接受（此前夹具把它包成 `['tools']` 支持了 ⇒ 比真机宽）。
    expect(callback).not.toHaveBeenCalled()
  })

  it('② 对象映射 {name: config} 按名取服务（此前静默不跑）', () => {
    const { ctx, composition } = compose()
    // 装组合时 `registerAppRoutes` 已经点过一次 `tools`（本 ctx 刻意没有它）—— 记基线。
    const base = [...composition.skippedInjections]
    const callback = vi.fn()
    ctx.inject({ tools: { mode: 'x' } } as never, callback)
    // 服务当天缺席 ⇒ 回调不跑，但缺的是**服务**，不是"映射形态没被认出来"
    // （旧夹具把 `{…}` 当 `[{…}]` 处理 ⇒ `get('[object Object]')` 恒 undefined ⇒ 静默不跑）。
    expect(callback).not.toHaveBeenCalled()
    expect(composition.skippedInjections).toEqual([...base, 'tools'])
    // 服务到齐 ⇒ 回调跑：映射形态与数组形态在这里必须行为一致。
    // （两条都补跑：应用宿主自己那条 `['tools']` 此前也悬着 —— 这正是响应式的现场。）
    ctx.provide('tools', { register: () => () => {} })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(composition.ranInjections).toEqual([['tools'], ['tools']])
  })

  it('③ 回调返回的 disposer 被收集，并可经句柄 / 组合两个出口回收', () => {
    const { ctx, composition } = compose()
    const disposed: string[] = []
    ctx.provide('solo', {})
    const handle = ctx.inject(['solo'], () => () => { disposed.push('handle') })
    const second = ctx.inject(['solo'], () => () => { disposed.push('composition') })
    // 真 Cordis：返回值被 `runner.collect()` 收进该子 fiber（`fiber.ts:356-368`）。
    // 夹具此前**直接丢弃** ⇒ 注销路径零覆盖。
    handle.dispose()
    expect(disposed).toEqual(['handle'])
    composition.disposeInjections()
    expect(disposed).toEqual(['handle', 'composition'])
    second.dispose()
  })

  it('④ 响应式：服务后到会跑；服务消失 ⇒ 回调被 unload 并调它的 disposer', () => {
    const { ctx, composition } = compose()
    const base = [...composition.skippedInjections]
    const disposed: number[] = []
    let runs = 0
    ctx.inject(['late'], () => {
      runs += 1
      const id = runs
      return () => { disposed.push(id) }
    })
    expect(runs).toBe(0)
    ctx.provide('late', {})       // 服务后来出现 ⇒ 真 Cordis 会跑
    expect(runs).toBe(1)
    ctx.provide('late', undefined) // 服务消失 ⇒ 真 Cordis unload 子 fiber 并调 disposer
    expect(disposed).toEqual([1])
    ctx.provide('late', {})        // 回来 ⇒ 再跑一次
    expect(runs).toBe(2)
    expect(composition.ranInjections).toEqual([['late'], ['late']])
    expect(composition.skippedInjections).toEqual([...base, 'late'])
  })

  it('⑤ 返回值是 Fiber 形状（dispose + thenable），不是回调的返回值', async () => {
    const { ctx } = compose()
    ctx.provide('fiber', {})
    const sentinel = (): void => {}
    const handle = ctx.inject(['fiber'], () => sentinel)
    expect(handle).not.toBe(sentinel)
    expect(typeof handle.dispose).toBe('function')
    expect(typeof handle.then).toBe('function')
    await expect(Promise.resolve(handle)).resolves.toBeUndefined()
  })

  it('⑥ 缺席的注入被显式交出来（`skippedInjections` / `ranInjections` 正负对照）', () => {
    const { composition } = compose()
    // 装组合时 `registerAppRoutes` 只点了一个 `tools`，而本 ctx 刻意没有它。
    expect(composition.skippedInjections).toEqual(['tools'])
    expect(composition.ranInjections).toEqual([])
  })
})
