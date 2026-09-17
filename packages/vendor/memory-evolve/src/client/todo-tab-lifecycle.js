import { createBadgeTab } from './tab-badge.js'

export const RUNTIME_CONFIG_CHANGED = 'dsh-memory-evolve:runtime-config-changed'

/**
 * Framework-free lifecycle for a conditional conversation tab.
 *
 * ME-1（2026-09-17 二审）：红点计数刷新**不再重注册条目** —— 旧 `refresh()`
 * 走 mount()（dispose + register），而上游 `conversation.view` 的条目身份就是
 * React key，换条目 = 正在显示的待办视图整棵重挂。计数现在交给 tab-badge.js
 * 的 createBadgeTab：label thunk 现读计数，变化只 poke 账本通知。
 *
 * @param {(getCount: () => number) => (() => void)} register 注册并返回 disposer。
 * @param {() => void} poke 计数变化时的 label 刷新通知。
 */
export function createTodoTabLifecycle(register, poke) {
  const badge = createBadgeTab(register, poke)
  let enabled = false
  return {
    setEnabled(next) {
      enabled = next === true
      if (enabled) badge.mount()
      else badge.dispose()
    },
    /** 计数变化：只刷新 label（poke），不重注册。 */
    setCount(next) {
      badge.setCount(next)
    },
    count: () => badge.count(),
    dispose() {
      enabled = false
      badge.dispose()
    },
    enabled: () => enabled,
  }
}
