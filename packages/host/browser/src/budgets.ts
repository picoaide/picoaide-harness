/**
 * Browser tool budgets — the ONE place where the registered tool deadline and
 * the user-gate wait budget live together, because their **order** is a
 * product invariant (2026-09-16).
 *
 * 现场（客户 v2.7.4 / macOS，会话 session-88502514-b5ac-4e41-be91-765db8b96fc1）：
 * AI 在 20:30:18 用 `browser_takeover` 把控制权交给用户去登录，用户登录完只在
 * 聊天里说"我已经登录"、没有点同一个按钮上的「交给 AI」。此后 agent 的每一次
 * 浏览器调用都排在用户闸门后面等——闸门预算是 300s，而**工具预算是 30s**，于是
 * 上游 timeout-policy 先把整个调用换成了 `tool call timed out after 30000ms`，
 * 2026-09-15 P0-1 特意加的明确错误（`window-controlled`「等待用户交还浏览器超时」）
 * 一次都没能冒出来。会话里 13 次超时全部落在走闸门的工具上，纯读元数据的
 * `browser_list_tabs`/`browser_bookmarks_list` 反而 0 秒返回——模型据此误判为
 * "页面/CDP 卡死"，白跑 25 分钟后绕道用户自己的 Chrome 取数。
 *
 * 因此：闸门等待必须**显著短于**工具预算，剩下的余量留给闸门打开后真正要跑的
 * 那一段（attach / loadURL / CDP / 截图回落）。任何一侧改数都要保持这个不等式。
 * @module @picoaide/dsh-browser/budgets
 */

/**
 * Cooperative tool-call budget registered for every `browser_*` tool (ms).
 *
 * 上游 `guard/timeout-policy` 在这个 deadline 到达时**替换**工具结果，工具自己
 * 抛出的错误再清楚也来不及送达模型——所以任何"内部等待"都必须短于它。
 */
export const BROWSER_TOOL_TIMEOUT_MS = 30_000

/**
 * Share of the tool budget the operation itself must keep in reserve (ms).
 *
 * 闸门打开后还要跑完这次操作：导航自身有 20s 的加载上限、截图有 8s 原生预算
 * + 5s 渲染器回落，所以余量不能只剩几秒。
 */
export const USER_GATE_RESERVE_MS = 20_000

/**
 * How long an agent browser operation waits for the user to hand control back
 * before ending the call with an explicit `window-controlled` error (ms).
 *
 * 等待本身是产品意图（"人操作时 loop 暂停"），但必须有预算，而且这个预算必须
 * 小于 {@link BROWSER_TOOL_TIMEOUT_MS}——否则模型与用户看到的都只是笼统的
 * `tool call timed out after 30000ms`，真正的"用户正拿着控制权"被吞掉。
 */
export const USER_GATE_TIMEOUT_MS = BROWSER_TOOL_TIMEOUT_MS - USER_GATE_RESERVE_MS

/**
 * Longest condition wait `browser_wait_for` accepts (ms).
 *
 * The tool's own deadline must cover the user-gate budget + this wait + margin;
 * registering it at exactly this value left zero margin, so a gate wait plus a
 * full condition wait hit the deadline and the explicit "condition not met"
 * result was replaced by the generic timeout (2026-09-16 audit R2-E4).
 */
export const WAIT_FOR_MAX_MS = 40_000

/** Registered deadline of `browser_wait_for`: gate + max wait + 5s margin. */
export const BROWSER_WAIT_FOR_DEADLINE_MS = USER_GATE_TIMEOUT_MS + WAIT_FOR_MAX_MS + 5_000
