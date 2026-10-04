/**
 * Sidebar control hint (2026-09-16, 三档化 2026-10-04).
 *
 * 现场（客户 v2.7.4，会话 session-88502514-b5ac-4e41-be91-765db8b96fc1）：AI 把
 * 控制权交给用户去登录，用户登录完在聊天里说"我已经登录"，但**没有点**浏览器
 * 窗口里那个「交给 AI」。此后 AI 的每次浏览器调用都被用户闸挡住，而唯一能解除
 * 的按钮只在浏览器窗口里 —— 用户回到聊天窗口后，界面上没有任何地方告诉他
 * "AI 正在等你交还控制权"。侧边栏这个入口是同一时刻唯一的可见提示位。
 *
 * 2026-10-04（用户报告「AI 打开浏览器操作之后，我的控制浏览器按钮就不见了」）：
 * 只认 `awaitingRelease` 会漏掉**最常见**的那条路径 —— AI 调 `browser_takeover`
 * 交权后**直接停下等人**（引导式登录就是这么走的：导航到登录页 → 交权 → 等用户），
 * 此时 `awaitingRelease` 还是 false（没有 agent 调用被拒过），聊天窗口里于是**零提示**。
 * 所以提示改成三档，判据是"控制权现在在谁手里"，而不是"有没有被拒过"：
 *
 *   - `none`    没有控制权争议（用户没在用浏览器）——**不许有任何提示**（防噪音底线）；
 *   - `holding` 用户持控制权（自己点的「我来操作」，或 AI 交权后停下）⇒ 信息级提示：
 *               "控制权在你手里：在浏览器窗口点「交给 AI」交还"；
 *   - `waiting` 用户持控制权**且**已有 agent 调用被拒 ⇒ 报警级提示（既有语义，
 *               一字不改）："AI 正在等你交还…"。
 *
 * 两档都指向浏览器窗口里同一个「交给 AI」按钮 —— 交还入口只有那一个（2026-09-11
 * 定案 A 方案），客户端这一侧只做提示，不新增任何控制权入口。
 *
 * @module @picoaide/dsh-browser/client
 */

/** 侧边栏轮询控制权状态的间隔（ms）。本机回环 GET，代价可忽略。 */
export const CONTROL_POLL_MS = 5_000

/** 提示状态（投影后的最小形状）。 */
export interface ControlHint {
  /** 用户持有控制权（我来操作 / AI 交权）。 */
  controlled: boolean
  /** AI 已经被用户闸挡住、正在等「交给 AI」。 */
  awaiting: boolean
}

/**
 * 提示档位（见模块头）。
 *
 * `holding` 与 `waiting` 的区别只有一个：AI 是否**真的**已经被拒过。它决定文案的
 * 级别（信息 / 报警），不决定"要不要提示"—— 那由 `controlled` 决定。
 */
export type ControlHintLevel = 'none' | 'holding' | 'waiting'

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

/**
 * 当前提示档位（唯一判定点：`showsWaitingHint` / `showsControlHint` 都从这里派生，
 * 任何调用点不得自己再拼一遍条件）。
 * @param hint - 投影后的提示状态。
 * @returns 档位。
 */
export function controlHintLevel(hint: ControlHint): ControlHintLevel {
  // awaiting 蕴含 controlled（被拒的前提就是用户持控制权），但**不假设**它：
  // 载荷是宿主给的，两者不一致时以 `awaiting`（更严重的那个）为准。
  if (hint.awaiting) return 'waiting'
  if (hint.controlled) return 'holding'
  return 'none'
}

/**
 * 是否展示"AI 在等你交还控制权"的**报警**（既有语义：只有 awaiting 才算 ——
 * 不能因为用户自己正当在用浏览器就说 AI 在等）。
 * @param hint - 投影后的提示状态。
 * @returns true = 报警级提示。
 */
export function showsWaitingHint(hint: ControlHint): boolean {
  return controlHintLevel(hint) === 'waiting'
}

/**
 * 是否需要给出控制权提示（2026-10-04：`controlled` 即提示，不再等第一次被拒）。
 * @param hint - 投影后的提示状态。
 * @returns true = 用户此刻持控制权（holding 或 waiting）。
 */
export function showsControlHint(hint: ControlHint): boolean {
  return controlHintLevel(hint) !== 'none'
}
