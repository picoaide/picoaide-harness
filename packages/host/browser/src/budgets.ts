/**
 * Browser tool budgets — the ONE place where the registered tool deadline and
 * the internal wait budgets live together, because their **order** is a
 * product invariant (2026-09-16, extended 2026-09-23 R4-B-15).
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

/**
 * How long an agent `browser_open` waits for a free tab slot when the pool is
 * full (ms) — see {@link TabPool} `reserveTab`.
 *
 * 2026-09-17 审计 S01-1：这个等待**必须**短于工具预算。池子满时 `browser_open`
 * 会先等槽位，而等待比 deadline 长的话，模型只会看到笼统的
 * `tool call timed out after 30000ms`，池子自己那句可执行的
 * "tab limit reached — close a tab first" 永远送不出去（与 §用户闸 同一类事故）；
 * 更糟的是这次等待发生在**全局池锁内**，排在后面的其它浏览器调用会被一起拖过
 * 各自的 deadline。曾经是 60s（= 2×工具预算）。
 *
 * 取值 = 工具预算 − 用户闸预算 − 余量：闸门与槽位等待是同一次调用里先后发生的
 * 两段等待，必须**相加**留在预算内（5s + 10s = 15s，余下 15s 跑真正的开页）。
 */
export const TAB_SLOT_WAIT_TIMEOUT_MS = 5_000

/**
 * Margin kept between an internal wait and the registered tool deadline (ms).
 *
 * timeout-policy 在 deadline **到达时**替换整条结果，所以内部等待必须在它之前
 * 收手：留 1s 给结果投影、op-log 记录、账本落盘与回程。
 */
export const TOOL_DEADLINE_MARGIN_MS = 1_000

/**
 * Work time every agent operation keeps for itself when it queues behind
 * another browser operation (ms) — R4-B-15（2026-09-23 审计）。
 *
 * 排队曾经**完全没有预算**：`PoolMutex.run` 只把"等前一个操作"做成可取消
 * （P0-4），没有任何时间上限，于是 `browser_wait_for` 合法占用全局锁 40s 时，
 * 排在它后面的 30s 预算工具会在**排队中**越过自己的 deadline，上游
 * timeout-policy 把工具自己的诊断换成笼统的 `tool call timed out after 30000ms`
 * —— 与 2026-09-16 客户现场同一类事故（只是这次发生在锁上而不是闸门上）。
 *
 * 排队预算 = `deadline − now − 这个常量`：既不早于"本次调用还可能做完一件事"的
 * 时刻收手，也保证在上游 deadline 之前抛出可读的
 * `timed out waiting for the running browser operation`。
 */
export const QUEUE_MIN_WORK_MS = 1_000

/**
 * Upper bound for the page load raced INSIDE the critical section by
 * `browser_open` / `browser_navigate` (ms).
 *
 * 2026-09-23 审计 BR-3：`budgets.ts` 自述的不变量是"闸门 + 槽位 + 真正要跑的
 * 那一段都要**相加**留在工具预算内"，但真正跑开页的等待用的是
 * `DEFAULT_LOAD_TIMEOUT_MS = 20s`（各自独立的预算）⇒ 最坏情况
 * `browser_navigate` = 10s + 20s = 30s（== 预算，不是"显著短于"）、
 * `browser_open` = 10s + 5s + 20s = 35s（> 预算），上游 timeout-policy 照旧会把
 * 工具自己的、可执行的结果换成笼统的 `tool call timed out after 30000ms` ——
 * 正是这份文件存在的唯一理由（2026-09-16 客户现场）。
 *
 * 取值 = 工具预算 − 用户闸 − 槽位 − 余量（30 − 10 − 5 − 1 = 14s）。加载竞速到点
 * 只表示"这一次不继续等了"，页面仍在后台加载（`navigateInternal` 的 `pending`
 * 分支不报错），所以变短不改变功能语义，只把"等待"收回预算内。
 *
 * 运行期还会再按**剩余额度**收紧一次（`deadlineAt − now − 余量`）：排队/等闸/
 * 等槽位已经花掉的时间不会被重复花掉。两个判据都要满足，取最小值。
 */
export const NAVIGATE_LOAD_BOUND_MS =
  BROWSER_TOOL_TIMEOUT_MS - USER_GATE_TIMEOUT_MS - TAB_SLOT_WAIT_TIMEOUT_MS - TOOL_DEADLINE_MARGIN_MS
