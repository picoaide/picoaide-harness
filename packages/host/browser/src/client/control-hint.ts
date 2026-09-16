/**
 * Sidebar control hint (2026-09-16).
 *
 * 现场（客户 v2.7.4，会话 session-88502514-b5ac-4e41-be91-765db8b96fc1）：AI 把
 * 控制权交给用户去登录，用户登录完在聊天里说"我已经登录"，但**没有点**浏览器
 * 窗口里那个「交给 AI」。此后 AI 的每次浏览器调用都被用户闸挡住，而唯一能解除
 * 的按钮只在浏览器窗口里 —— 用户回到聊天窗口后，界面上没有任何地方告诉他
 * "AI 正在等你交还控制权"。侧边栏这个入口是同一时刻唯一的可见提示位。
 *
 * 提示的判据只有一条：`/api/pico/browser/state` 的 `awaitingRelease`——即"真的
 * 有一次 agent 调用因为用户持有控制权被拒"。仅仅 `controlled` 不代表 AI 在等
 * （用户可能正当地在用浏览器，AI 也没有动作）。
 * @module @picoaide/dsh-browser/client
 */

/** 侧边栏轮询控制权状态的间隔（ms）。本机回环 GET，代价可忽略。 */
export const CONTROL_POLL_MS = 5_000

/** 提示状态（投影后的最小形状）。 */
export interface ControlHint {
  /** 用户持有控制权（我来操作）。 */
  controlled: boolean
  /** AI 已经被用户闸挡住、正在等「交给 AI」。 */
  awaiting: boolean
}

/** 无提示（默认值；未知载荷一律退回这里 —— 侧边栏不许凭空报警）。 */
export const NO_CONTROL_HINT: ControlHint = { controlled: false, awaiting: false }

/**
 * 把 `/api/pico/browser/state` 的载荷投影成提示状态。
 * @param payload - 路由返回值（任意形状；非对象/缺字段按"无提示"处理）。
 * @returns 提示状态。
 */
export function readControlHint(payload: unknown): ControlHint {
  if (typeof payload !== 'object' || payload === null) return NO_CONTROL_HINT
  const record = payload as { controlled?: unknown; awaitingRelease?: unknown }
  return {
    controlled: record.controlled === true,
    awaiting: record.awaitingRelease === true,
  }
}

/** 是否展示"AI 在等你交还控制权"的警示。 */
export function showsWaitingHint(hint: ControlHint): boolean {
  return hint.awaiting
}
