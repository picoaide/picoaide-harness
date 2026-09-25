/**
 * 「员工会话变化」订阅契约的**唯一实现**（宿主侧）。
 *
 * ## 为什么它必须是一份共享实现
 *
 * `pico/session-changed` 有三个消费方（enterprise 的一整套同步插件、wasm-apps-host 的
 * 窗口/缓存作用域、desktop 的应用 AI 执行面），而**裸 `ctx.on` 会漏掉最常见的那次事件**：
 * `SessionService.restore()` 在**构造期**就启动（`void this.restore().finally(…)`），
 * 它 emit 的那一刻可能早于任何插件的 `apply()` —— 于是"重启后带着有效会话"这条路径上，
 * 消费方要等到下一次登录/登出才生效（本仓已记录两次同根因事故：2026-09-05 的
 * inputModalities、2026-09-10 的渠道 logo）。
 *
 * 正确形态只有一条：**先订阅，再补一次"已经恢复完成"的状态**（判据用 `isRestored()`，
 * 它在 `restore()` 的 `finally` 里置位，而事件在那之前 emit ⇒ `true` = 已错过、`false` =
 * 后续必然收到；两个方向都不重不漏）。这段顺序此前在仓里有**三份拷贝**
 * （`enterprise/session-service.ts`、`wasm-apps-host/session.ts`、desktop 的
 * `updates.ts`），本模块是它的收口：前两者的公共入口都改为委托到这里。
 *
 * ## 为什么住在叶子包
 *
 * 构建图是 `desktop → wasm-apps-host → browser → connectors → 叶子包`，而 enterprise 依赖
 * desktop ⇒ desktop 不可能 import enterprise 的 `subscribeSession`（会成环）。把这个契约
 * 放进**零依赖叶子包**（与 2026-09-23 的 `loopback.ts` 四份合一同一手法）后，三方都能用
 * 同一份实现，且环不会以新形状绕回来。
 *
 * ⚠️ 本模块**不得** import `@deepseek-ai/cordis`：叶子包的零依赖不变量是构建图的锚
 * （见本包 `tsdown.config.ts`）。所以上下文按**结构最小面**声明（`on` + `get`），
 * 与 `@deepseek-ai/cordis` 的宽签名逐个字段兼容。
 *
 * @module @picoaide/dsh-host-locale/session-events
 */

/** 会话变化事件名（enterprise `SESSION_CHANGED_EVENT` 逐字一致）。 */
export const SESSION_CHANGED_EVENT = 'pico/session-changed'

/** `picoSession` 服务的结构探测面（本模块只关心这两项）。 */
export interface PicoSessionProbe {
  /** 持久化会话是否已经恢复完成（`restore()` 的 `finally` 里置位）。 */
  isRestored?: () => boolean
  /** 当前会话（未登录 ⇒ `null`）。 */
  getSession?: () => unknown
}

/**
 * 订阅所需的**上下文最小面**。
 *
 * 两个签名都刻意取宽（与 cordis 自己的 `on(name: string|symbol, …)` / `get(name: string)`
 * 兼容）：叶子包不能 import cordis，而消费方传进来的就是真实的 `Context`。
 *
 * `get` 是**可选**的：真实 Cordis 上下文一定有它，但本仓不少用例用结构替身
 * （`{ on, emit, picoSession }`）驱动这条契约，替身只挂服务属性、没有注册表。
 */
export interface SessionEventContext {
  /** 注册事件监听，返回取消订阅函数。 */
  on(event: string, listener: (...args: any[]) => unknown): () => void
  /** 探测服务（缺席 ⇒ `undefined`）。 */
  get?(name: string): unknown
  /** Cordis 把服务同时挂成上下文的属性（结构替身常用这一面）。 */
  picoSession?: PicoSessionProbe
}

/** `picoSession` 服务的注册名（`SessionService` 的 `super(ctx, 'picoSession')`）。 */
export const PICO_SESSION_SERVICE = 'picoSession'

/**
 * 探测当前会话服务（两种上下文形态都认，见 {@link SessionEventContext}）。
 *
 * **顺序有讲究**：有 `get` 就只用它 —— 真实 Cordis 上下文在服务尚未注册时读属性
 * （`ctx.picoSession`）不是"返回 undefined"那么无害，而 `get` 明确返回 undefined。
 * 只有在 `get` 整个缺席（结构替身）时才回落到属性面。
 * @param ctx - 上下文。
 * @returns 会话服务（或缺席）。
 */
function probeSession(ctx: SessionEventContext): PicoSessionProbe | undefined {
  if (typeof ctx.get === 'function') return ctx.get(PICO_SESSION_SERVICE) as PicoSessionProbe | undefined
  return ctx.picoSession
}

/**
 * 订阅会话变化，并补发"已经恢复完成"的那一次状态（见模块头注释）。
 *
 * 补发规则（三条，与历史三份拷贝逐条对齐）：
 *
 *  - 探测到的服务**已完成恢复**（`isRestored() === true`）⇒ 立即用当前会话回调一次；
 *  - 服务**不存在**或没有 `isRestored`（纯桌面冒烟、还没装配 enterprise 面）⇒ 也回调一次
 *    并给出 `undefined`/"未登录" —— 消费方必须知道"现在没有会话"，而不是永远等一个
 *    不会来的事件；
 *  - 否则（恢复仍在飞行）⇒ **不**回调：那次事件还没发，订阅已经就位。
 *
 * @param ctx - 上下文（只需 `on`，外加 `get` 或 `picoSession` 之一）。
 * @param listener - 收到会话（或未登录状态）时的回调。**必须幂等**：它可能被立即调用一次。
 * @param probe - 探测 `picoSession`（缺省 = {@link probeSession}；wasm-apps-host 用它注入
 *   自己的归一化读取）。
 * @returns 取消订阅的函数。
 */
export function subscribeSessionChanges<S = unknown>(
  ctx: SessionEventContext,
  listener: (session: S) => void,
  probe: () => PicoSessionProbe | undefined = () => probeSession(ctx),
): () => void {
  const off = ctx.on(SESSION_CHANGED_EVENT, listener)
  const service = probe()
  if (service?.isRestored === undefined || service.isRestored()) {
    listener(service?.getSession?.() as S)
  }
  return off
}
