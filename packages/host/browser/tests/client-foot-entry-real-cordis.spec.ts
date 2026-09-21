/**
 * 真 Cordis 上下文里的「更多」行重发布（2026-09-21 二轮对抗审计 P1）。
 *
 * ## 为什么这条用例必须用**真的** Cordis
 *
 * 手写的 ctx 替身总是把 `picoFootMenu` 暴露在外层 scope 上，于是"订阅回调里读
 * `ctx.picoFootMenu`"看起来永远能跑。真 Cordis 4.0.2 不是这样：**读一个没有写进
 * `inject` 的服务会直接抛**（`cannot get property "picoFootMenu" without inject`）。
 * 后果是本插件最要紧的那条实时性失效：提示翻转时回调抛异常（被 store 的 try/catch
 * 吞掉、只留一条 warn），`touch()` 一次都没发生，「更多」行上那颗琥珀色圆点**永远不会
 * 实时亮起** —— 而这恰恰是"用户没盯着浏览器窗口"时唯一的可见提示。
 *
 * 因此这里的判据是行为：**提示翻转 ⇒ `touch()` 被调用**（而不是"订阅函数存在"）。
 *
 * ---- 变异验证 ----
 *   把订阅搬回外层 `ctx.effect(() => controlHint.subscribe(() => { ctx.picoFootMenu.touch() }))`
 *   ⇒ 本用例红（touches=0 + 一条 subscriber failed 警告）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

/** 一条提示载荷（宿主 `/api/pico/browser/state` 的形状）。 */
function stateResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

interface Fixture {
  root: Context
  /** 每次 `touch()` 的时间戳（用长度断言"被调用过几次"）。 */
  touches: number[]
  footEntries: unknown[]
}

/**
 * 搭一个**真** Cordis 组合：本插件按声明挂载（`inject: ['locale']`），
 * `picoFootMenu` 由**另一个 fiber** 提供。
 *
 * 两个细节缺一不可，否则夹具会把 bug 放过去（两次实测）：
 *  - 服务不能由根上下文自己 provide（自己提供的服务读起来永远合法）；
 *  - 本插件必须作为**带 inject 声明的 plugin fiber** 挂载 —— inject 边界是 per-fiber
 *    的，直接把根上下文传给 `apply()` 时那条边界不存在。
 * @param mod - 刚 import 进来的客户端半边模块。
 * @returns 根上下文与记录面。
 */
async function realCordis(mod: { inject: string[], apply: (ctx: Context) => void }): Promise<Fixture> {
  const touches: number[] = []
  const footEntries: unknown[] = []
  const root = new Context()
  root.provide('locale', {
    register: () => () => {},
    getLocale: () => ({ active: 'zh' }),
    subscribe: () => () => {},
  } as never)
  // 服务由另一个 fiber 提供（真组合里就是 `@picoaide/dsh-foot-menu` 那一行）。
  root.plugin({
    name: 'foot-menu-provider-stub',
    apply: (ctx: Context) => {
      ctx.provide('picoFootMenu', {
        add: (entry: unknown) => {
          footEntries.push(entry)
          return () => {}
        },
        touch: () => { touches.push(Date.now()) },
        snapshot: () => [...footEntries],
        subscribe: () => () => {},
      } as never)
    },
  } as never)
  // 本插件按自己的声明挂载：fiber 的 inject 边界因此真实存在。
  root.plugin({
    name: 'pico-browser-client',
    inject: [...mod.inject],
    apply: mod.apply,
  } as never)
  return { root, touches, footEntries }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('浏览器控制权提示 → 「更多」行重发布（真 cordis）', () => {
  it('提示翻转会真的 touch()，且订阅回调不抛（未 inject 的服务读取不会发生）', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.stubGlobal('fetch', vi.fn(async () => stateResponse({ controlled: true, awaitingRelease: true })))
      vi.resetModules()
      const mod = await import('../src/client/index.ts')
      const { touches } = await realCordis(mod)
      await vi.advanceTimersByTimeAsync(0)
      // 初值 {controlled:false, awaiting:false} → {true,true}：这是一次真实的取值变化。
      expect(touches.length, 'touch() 一次都没被调用 ⇒「更多」行的圆点不会实时出现').toBeGreaterThan(0)
      // 回调里读未 inject 的服务会抛；抛了就会被 store 记一条 subscriber failed。
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('提示持续翻转会持续 touch()（不是只在第一轮碰巧成功）', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let awaiting = true
      vi.stubGlobal('fetch', vi.fn(async () => stateResponse({ controlled: true, awaitingRelease: awaiting })))
      vi.resetModules()
      const mod = await import('../src/client/index.ts')
      const { touches } = await realCordis(mod)
      await vi.advanceTimersByTimeAsync(0)
      const afterFirst = touches.length
      expect(afterFirst).toBeGreaterThan(0)
      awaiting = false
      await vi.advanceTimersByTimeAsync(5_000)
      expect(touches.length).toBeGreaterThan(afterFirst)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
