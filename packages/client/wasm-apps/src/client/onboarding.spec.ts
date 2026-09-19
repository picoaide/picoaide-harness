/**
 * 一次性引导卡的**持久判据**（§7.2：首次显示一次，关闭后不再出现）。
 *
 * 三条口径各自有用例：
 *  1. 没关过 ⇒ 显示；关过 ⇒ 不显示（唯一判据 `isOnboardingDismissed`）；
 *  2. 关闭写存储（同一个 store 的另一个实例也看得到 —— 下次启动不再显示）；
 *  3. **存储不可用/抛异常时按"没关过"**：宁可多显示一次，也不能因为存储异常把引导
 *     永久吃掉或打断渲染。
 *
 * ---- 变异验证 ----
 *   - `isOnboardingDismissed` 改成恒 `false` ⇒「关过就不再显示」红；
 *   - `dismissOnboarding` 不写存储 ⇒ 同上红；
 *   - 存储抛异常时让异常冒泡（去掉 try/catch）⇒「存储故障不打断」红。
 */
import { describe, expect, it } from 'vitest'
import {
  ONBOARDING_STORAGE_KEY,
  dismissOnboarding,
  isOnboardingDismissed,
  type OnboardingStore,
} from './onboarding.ts'

/** 内存存储（同一个对象模拟"同一台机器的 localStorage"）。 */
function memoryStore(seed: Record<string, string> = {}): OnboardingStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(seed))
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe('引导卡：首次显示一次，关闭后不再出现', () => {
  it('没关过 ⇒ 显示；关闭 ⇒ 不再显示（同一次运行）', () => {
    const store = memoryStore()
    expect(isOnboardingDismissed(store)).toBe(false)
    dismissOnboarding(store)
    expect(isOnboardingDismissed(store)).toBe(true)
    expect(store.values.get(ONBOARDING_STORAGE_KEY)).toBe('1')
  })

  it('关闭落盘 ⇒ 下次启动（新的 store 实例读同一份数据）也不显示', () => {
    const backing = new Map<string, string>()
    const first: OnboardingStore = { getItem: k => backing.get(k) ?? null, setItem: (k, v) => { backing.set(k, v) } }
    dismissOnboarding(first)
    const second: OnboardingStore = { getItem: k => backing.get(k) ?? null, setItem: (k, v) => { backing.set(k, v) } }
    expect(isOnboardingDismissed(second)).toBe(true)
  })

  it('值不是 "1"（被别的东西写了同一个键）按"没关过"处理', () => {
    expect(isOnboardingDismissed(memoryStore({ [ONBOARDING_STORAGE_KEY]: 'yes' }))).toBe(false)
  })
})

describe('存储不可用/故障时 fail-safe（多显示一次，不打断）', () => {
  it('没有存储（宿主无 localStorage）⇒ 显示，且关闭不抛', () => {
    expect(isOnboardingDismissed(null)).toBe(false)
    expect(() => { dismissOnboarding(null) }).not.toThrow()
  })

  it('存储读写抛异常 ⇒ 读按"没关过"、写被吞掉', () => {
    const broken: OnboardingStore = {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('QuotaExceededError') },
    }
    expect(isOnboardingDismissed(broken)).toBe(false)
    expect(() => { dismissOnboarding(broken) }).not.toThrow()
  })
})
