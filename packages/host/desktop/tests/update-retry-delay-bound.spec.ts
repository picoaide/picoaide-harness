/**
 * R13-E-P3 回归：退避延时的 32 位上界必须施加在**抖动之后**。
 *
 * ## 缺陷形态（修复前，实测）
 *
 * `updates.ts` 的 Config 给每个延时字段钉的上界是 `MAX_TIMER_DELAY_MS = 2^31-1`，
 * 而真正交给 `setTimeout` 的是 `updateRetryDelayMs()` 的**抖动后**结果，抖动是
 * **对称**的（`base ± spread/2`）且 `retryJitterRatio` 的 schema 上界是 1。于是
 * "schema 自己允许的组合"（`delaysMs=[MAX]` + `jitterRatio=1`）会产出
 * `3221225471 = 1.5 × MAX`：
 *
 * ```text
 * TimeoutOverflowWarning: 3221225471 does not fit into a 32-bit signed integer.
 * Timeout duration was set to 1.
 * ```
 *
 * 计划中的"约 24.8 天后再试"因此变成**立刻重试**（实测 `actualWaitMs=15`）—— 而且
 * 全程静默：这条 warning 不进 UI 日志。只钉 schema 挡不住它是**结构性**的
 * （上界在抖动之前，抖动可以把任何值抬到 1.5 倍），所以钳制必须落在产出最终值的
 * 那个函数里。
 *
 * ## 判据
 *
 * 1. **量出来的**：对 4000 个种子扫一遍最大组合，断言最终值 ≤ `MAX_TIMER_DELAY_MS`
 *    **且**抖动没有被抹平（最小值明显低于上界 ⇒ 不是"把抖动关掉"换来的绿）。
 * 2. **能被打坏**：把同一个被断言的值乘 1.5 交给真 `setTimeout`，必须观察到
 *    `TimeoutOverflowWarning` —— 这条保证第 1 条的"没有 warning"不是恒真的空断言。
 * 3. **前提为真**：`Config` 确实接受那组极值（否则本用例在测一个不可达的配置）。
 */
import { describe, expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS, updateRetryDelayMs, type UpdateRetryPolicy } from '../src/desktop-update-contract.ts'
import { Config, type Config as UpdateConfig } from '../src/updates.ts'

/** schema 允许的最大组合：延时取上界、抖动比例取 1。 */
const EXTREME_POLICY: UpdateRetryPolicy = { maxAttempts: 2, delaysMs: [MAX_TIMER_DELAY_MS], jitterRatio: 1 }

/** 抖动是确定性的（FNV-1a over `${seed}#${attempt}`），扫种子即可覆盖它的取值域。 */
const SEEDS = Array.from({ length: 4_000 }, (_unused, index) => `probe-${String(index)}`)

/**
 * 真 `setTimeout` 观察窗：返回这段时间里 Node 打出的 warning。
 *
 * `process.emitWarning` 是**异步**投递的（`'warning'` 事件在下一个 tick 才到），所以
 * 断言前必须让出两个 `setImmediate`；`clearTimeout` 保证 24 天的定时器不会把事件循环
 * 挂住（这里只关心构造期的那条 warning）。
 * @param delays - 要交给 `setTimeout` 的延时（毫秒）。
 * @returns the warnings Node emitted while constructing those timers.
 */
async function warningsFor(delays: readonly number[]): Promise<string[]> {
  const seen: string[] = []
  const onWarning = (warning: Error): void => { seen.push(`${warning.name}: ${warning.message.split('\n')[0] ?? ''}`) }
  process.on('warning', onWarning)
  const timers = delays.map(delay => setTimeout(() => {}, delay))
  for (const timer of timers) clearTimeout(timer)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  await new Promise<void>(resolve => { setImmediate(resolve) })
  process.off('warning', onWarning)
  return seen
}

describe('update retry delay · 抖动后的 32 位上界（R13-E-P3）', () => {
  it('前提：schema 接受"延时=上界 + 抖动=1"这组极值（本用例不是在一个不可达配置上断言）', () => {
    const parsed = Config({
      checkRetryDelaysMs: [MAX_TIMER_DELAY_MS],
      transferRetryDelaysMs: [MAX_TIMER_DELAY_MS],
      retryJitterRatio: 1,
    } as UpdateConfig)
    expect(parsed.checkRetryDelaysMs).toEqual([MAX_TIMER_DELAY_MS])
    expect(parsed.transferRetryDelaysMs).toEqual([MAX_TIMER_DELAY_MS])
    expect(parsed.retryJitterRatio).toBe(1)
  })

  it('抖动之后仍然有界：最大组合产出 ≤ MAX_TIMER_DELAY_MS，且抖动没有被抹平', () => {
    const values = SEEDS.map(seed => updateRetryDelayMs(EXTREME_POLICY, 1, seed))
    const max = Math.max(...values)
    const min = Math.min(...values)
    // 核心断言：超过 2^31-1 的延时会被 setTimeout 静默钳成 1ms（见文件头）。
    expect(
      max,
      `抖动后的最大延时 ${String(max)} 越过 ${String(MAX_TIMER_DELAY_MS)} —— setTimeout 会把它钳成 1ms`,
    ).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS)
    // 非空转：判据必须真的走到上界附近，否则它证明不了任何东西。
    expect(max, '判据没扫到上界附近 ⇒ 它在空转').toBe(MAX_TIMER_DELAY_MS)
    // 反向：不许用"把抖动关掉/一律取最小值"来换绿 —— 对称抖动必须仍在。
    expect(min, '抖动被抹平了（最小值不该等于上界）').toBeLessThan(MAX_TIMER_DELAY_MS)
    expect(min, '抖动幅度被压小了：上界 + ratio=1 时最小值应接近一半').toBeGreaterThan(MAX_TIMER_DELAY_MS / 2 - 1)
    for (const value of values) expect(Number.isSafeInteger(value), `非整数延时 ${String(value)}`).toBe(true)
  })

  it('没有抖动（ratio=0）与超上界输入也都有界', () => {
    const noJitter: UpdateRetryPolicy = { maxAttempts: 2, delaysMs: [MAX_TIMER_DELAY_MS], jitterRatio: 0 }
    expect(updateRetryDelayMs(noJitter, 1, 'probe')).toBe(MAX_TIMER_DELAY_MS)
    // 上界同时是"任何输入都不能越过的天花板"（`updateRetryDelayMs` 是导出函数，
    // 调用方不必是 schema 校验过的 Config）。
    const overBound: UpdateRetryPolicy = { maxAttempts: 2, delaysMs: [MAX_TIMER_DELAY_MS * 4], jitterRatio: 1 }
    for (const seed of SEEDS.slice(0, 200)) {
      expect(updateRetryDelayMs(overBound, 1, seed)).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS)
    }
    expect(updateRetryDelayMs({ maxAttempts: 2, delaysMs: [-1], jitterRatio: 1 }, 1, 'probe'), '负延时必须归零').toBe(0)
  })

  it('真 setTimeout 上判据能被打坏：同一个值 ×1.5 必须打出 TimeoutOverflowWarning', async () => {
    const values = SEEDS.map(seed => updateRetryDelayMs(EXTREME_POLICY, 1, seed))
    const max = Math.max(...values)
    // 阳性对照：修复前的返回值（= 1.5 × MAX）必须被 Node 判为溢出。
    const control = await warningsFor([max * 1.5])
    expect(
      control.join('|'),
      '阳性对照没有触发 TimeoutOverflowWarning —— 本判据的"无 warning"是恒真的空断言，必须重新设计',
    ).toContain('TimeoutOverflowWarning')
    // 判据本体：修复后的每一个值都不能让 Node 打 warning（≥24 天的定时器仍合法）。
    const observed = await warningsFor([...values.slice(0, 500), MAX_TIMER_DELAY_MS])
    expect(observed, `修复后的延时仍让 Node 报溢出：${observed.join('|')}`).toEqual([])
  })
})
