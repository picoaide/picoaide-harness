/**
 * 侧边栏控制权提示的**插件级 store**（2026-09-21 底部并道改造）。
 *
 * ## 为什么从组件里搬出来
 *
 * 这段轮询原本住在 `BrowserTrigger` 的 `useControlHint()` 里 —— 那时浏览器插件在
 * 侧边栏底部有自己的一整行，组件挂了轮询就活着。并道之后底部只剩
 * `@picoaide/dsh-foot-menu` 的「更多」行，条目只是**数据**（id / 文案 / 动作 /
 * attention），所以状态必须由插件自己持有：`apply` 里 `ctx.effect` 启停，条目用
 * `attention()` 读它，状态变化时 `ctx.picoFootMenu.touch()` 把「更多」行的圆点与
 * 浮层条目的琥珀色推给已经渲染的界面。
 *
 * 判据本身没有变（见 `control-hint.ts`）：读面是 GET（同源 + 回环 fence，无需写面
 * 证明），**失败一律保留上一次结果** —— 提示绝不能因为宿主暂时不可用而闪回"没有
 * 等待"。
 *
 * @module @picoaide/dsh-browser/client/control-hint-store
 */

import { CONTROL_POLL_MS, NO_CONTROL_HINT, readControlHint, type ControlHint } from './control-hint.ts'

/** 最近一次成功读取的提示（未 start 时是"无提示"）。 */
let hint: ControlHint = NO_CONTROL_HINT
/** 订阅者（`apply` 用 `ctx.picoFootMenu.touch()` 订阅）。 */
const listeners = new Set<() => void>()
/** 下一次轮询的定时器；`undefined` = 没有排队的轮询。 */
let timer: ReturnType<typeof setTimeout> | undefined
/** 是否正在轮询（`start()` 幂等、`dispose()` 后不再续排）。 */
let running = false
/**
 * 轮询链的世代号。
 *
 * `running` 一个布尔挡不住"在途读取"：`dispose()` 把 `running` 置 false，可它在途，
 * 于是 `start()` 之后 `running` 又是 true —— 旧链接着跑，同一个端点出现**两条**轮询链，
 * `dispose()` 也只能停掉它认识的那一条（2026-09-21 对抗审计 P2）。每一轮读取携带自己
 * 的世代号，`dispose()` / `start()` 都会递增；世代号不匹配的在途轮次直接退出、不再续排。
 */
let generation = 0

/** 当前提示状态（失败时是上一次成功读取的值）。 */
export function current(): ControlHint {
  return hint
}

/**
 * 订阅提示变化。
 * @param listener - 取值变化时调用（值不变时不调用）。
 * @returns 退订函数。
 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 开始轮询（幂等：已在轮询时是 no-op），并立即读一次。 */
export function start(): void {
  if (running) return
  running = true
  generation += 1
  void read(generation)
}

/** 停止轮询：作废在途的轮次，并清掉排队中的定时器（插件卸载）。 */
export function dispose(): void {
  running = false
  generation += 1
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }
}

/**
 * 读一次 `/api/pico/browser/state`，成功且**取值变化**时通知订阅者，然后排下一次。
 * @param gen - 本轮的世代号；与当前世代不符（`dispose()`/`start()` 之后）即作废。
 * @returns 本轮结束（无论成败）后 resolve。
 */
async function read(gen: number): Promise<void> {
  /** 本轮是否仍然有效（未被 dispose、也没有被新的一轮取代）。 */
  const live = (): boolean => running && gen === generation
  try {
    const response = await fetch('/api/pico/browser/state')
    if (response.ok) {
      const next = readControlHint(await response.json() as unknown)
      if (!live()) return
      if (next.controlled !== hint.controlled || next.awaiting !== hint.awaiting) {
        hint = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (cause) {
            // 一个订阅者抛错不能停掉轮询（它可能是别的插件已卸载的接线）。
            console.warn('[pico-browser] control-hint subscriber failed', cause)
          }
        }
      }
    }
  } catch { /* keep the last known hint */ }
  // 只有**仍然有效**的那一轮才能续排：作废的轮次在这里退出，否则同一个端点会出现
  // 两条（甚至更多）并行轮询链。
  if (!live()) return
  timer = setTimeout(() => { void read(gen) }, CONTROL_POLL_MS)
}
