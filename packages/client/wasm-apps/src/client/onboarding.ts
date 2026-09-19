/**
 * 应用中心的**一次性引导卡**（设计总纲 §7.2「一次性引导（冻结，产品第四轮）」）。
 *
 * 口径：首次打开应用中心显示一次引导卡（**应用是什么 / 怎么让 AI 做一个 / 怎么分享**），
 * 关闭后不再出现。本模块只负责"关过没有"这一件事：
 *
 *  - 判据落在一处（{@link isOnboardingDismissed}），面板与用例共用；
 *  - 存储是**可注入**的（{@link OnboardingStore}），默认用渲染进程的 `localStorage`
 *    —— 它就在客户端 `userData` 之下，与 §7.2"记在 `<userData>`"同一落点；
 *  - 存储不可用（无 `localStorage` 的宿主、被禁用、抛异常）时**一律按"没关过"**处理：
 *    宁可多显示一次引导，也不能因为存储异常把引导永久吃掉；
 *  - 任何存储实现抛出的异常都被吞掉（引导卡不该有能力打断面板渲染）。
 *
 * @module @picoaide/dsh-wasm-apps/client/onboarding
 */

/** 引导卡的存储键（值 `'1'` = 已关闭）。 */
export const ONBOARDING_STORAGE_KEY = 'picoaide.wasm-apps.onboarding.v1'

/** 读/删所需的存储子集（`localStorage` 满足它）。 */
export interface OnboardingStore {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/**
 * 默认存储：渲染进程的 `localStorage`（客户端 UI 的 origin 属于 `userData`）。
 * @returns 存储实现；宿主没有可用 `localStorage` ⇒ `null`（按"没关过"处理）。
 */
export function defaultOnboardingStore(): OnboardingStore | null {
  try {
    const storage = (globalThis as { localStorage?: OnboardingStore }).localStorage
    return storage === undefined || storage === null ? null : storage
  } catch {
    // 某些宿主在属性访问时就抛（隐私模式/沙箱）：按不可用处理。
    return null
  }
}

/**
 * 引导卡是否已被关闭过。
 * @param store - 存储实现（缺省 {@link defaultOnboardingStore}）。
 * @returns true = 已关闭过（不再显示）。
 */
export function isOnboardingDismissed(store: OnboardingStore | null = defaultOnboardingStore()): boolean {
  if (store === null) return false
  try {
    return store.getItem(ONBOARDING_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * 记下"引导卡已关闭"（关闭按钮的唯一副作用）。
 * @param store - 存储实现（缺省 {@link defaultOnboardingStore}）。
 */
export function dismissOnboarding(store: OnboardingStore | null = defaultOnboardingStore()): void {
  if (store === null) return
  try {
    store.setItem(ONBOARDING_STORAGE_KEY, '1')
  } catch {
    // 存储写失败 = 下次还会显示一次引导：可接受（不抛穿渲染树）。
  }
}
