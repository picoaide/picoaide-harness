/**
 * 画板持久化：整板快照写入 localStorage（防抖）。
 *
 * 2026-09-16：纯前端的"读回本地快照"路径（`loadCanvasState` / `parseState`）
 * 与其依赖的预置示例卡（`constants.ts` 的 `createSeedState`）一并删除——
 * 画板自 2026-08-14 起"只走后端"（CanvasView 只 import createDebouncedSaver，
 * 整板读写走宿主 API + rev 乐观锁），这三个函数全仓零调用点；留着等于留一份
 * 中文示例数据要翻译。`saveCanvasState` 仍是防抖保存的落点，保留。
 */
import { STORAGE_KEY } from './constants.ts'
import type { CanvasPersistState } from './types.ts'

export function saveCanvasState(state: CanvasPersistState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 配额满或隐私模式：静默失败，不打断拖拽
  }
}

/**
 * 防抖封装，组件卸载时要 cancel。
 *
 * schedule 支持两种载荷：
 *   - CanvasPersistState：localStorage 快照保存（纯前端降级模式）；
 *   - () => void 回调：后端模式（CanvasView 传 persistBackend 闭包，
 *     宿主 API 保存，带 rev 乐观锁）。
 */
export function createDebouncedSaver(ms: number): {
  schedule: (payload: CanvasPersistState | (() => void)) => void
  flush: (payload: CanvasPersistState | (() => void)) => void
  cancel: () => void
} {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  const run = (payload: CanvasPersistState | (() => void)): void => {
    if (typeof payload === 'function') {
      payload()
    } else {
      saveCanvasState(payload)
    }
  }
  return {
    schedule(payload) {
      cancel()
      timer = setTimeout(() => {
        timer = null
        run(payload)
      }, ms)
    },
    flush(payload) {
      cancel()
      run(payload)
    },
    cancel,
  }
}
