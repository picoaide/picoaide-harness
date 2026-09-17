export const RUNTIME_CONFIG_CHANGED = 'dsh-memory-evolve:runtime-config-changed'

/**
 * Framework-free lifecycle for a conditional conversation tab.
 *
 * 消费方是 `src/client/index.ts`，且本文件现在由 tsconfig 的 `allowJs` 读进类型
 * 程序，所以这里的 JSDoc 就是这条边界的类型契约（`register` 不再退化成隐式 any）。
 * @param {() => (() => void)} register - 挂载 tab，返回它的卸载函数。
 * @returns {{
 *   setEnabled: (next: boolean) => void,
 *   refresh: () => void,
 *   dispose: () => void,
 *   enabled: () => boolean,
 * }} 生命周期句柄。
 */
export function createTodoTabLifecycle(register) {
  let enabled = false
  let disposer
  const mount = () => {
    disposer?.()
    disposer = register()
  }
  return {
    setEnabled(next) {
      enabled = next === true
      if (!enabled) {
        disposer?.()
        disposer = undefined
      } else if (disposer === undefined) {
        mount()
      }
    },
    refresh() {
      if (enabled && disposer !== undefined) mount()
    },
    dispose() {
      enabled = false
      disposer?.()
      disposer = undefined
    },
    enabled: () => enabled,
  }
}
