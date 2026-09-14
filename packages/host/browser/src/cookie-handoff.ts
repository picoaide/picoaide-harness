/**
 * BrowserAuth 票据交接表：把应用 session 的持有性证明 cookie 反复镜像进**当前**
 * 浏览器分区，直到成功一次为止。
 *
 * 为什么不是「fence 缺席就直接返回」（2026-09-15 现场 P0 的根因）：
 * 本插件的 loader 行**早于** connection 行装载，而"恢复型启动"（开机即带着有效
 * 会话，最常见的启动路径）下两个本地页面在 boot prewarm 就加载完了、又没有任何
 * `pico/session-changed` 事件来兜底 —— 旧实现在那一刻 judge 到 `ctx.get('connection')`
 * 还是 undefined 就直接 return，**交接一次都没跑过**：蒙版页（「我来操作」的唯一
 * 入口）永远拿不到证明，整轮运行每次点击都被判 401（客户 v2.7.4-beta.3 日志里只有
 * `refused a local write without browser proof`、没有任何 handoff 行，实测复现）。
 *
 * 正确的口径：fence 只决定"要不要交"，**不决定"要不要排队"** —— 缺席时照样按
 * 退避重试，等 connection 行装载完再交。
 * @module @picoaide/dsh-browser/cookie-handoff
 */

/** 交接表的依赖（全部注入，便于确定性单测）。 */
export interface CookieHandoffDeps {
  /** 交互证明闸（upstream connection 服务）当前是否可用。 */
  fenceAvailable: () => boolean
  /** 执行一次交接；`true` = 目标分区里已经有票，停表。 */
  mirror: () => Promise<boolean>
  /** 重排一次尝试，返回句柄（供 {@link CookieHandoffDeps.cancel} 取消）。 */
  schedule: (run: () => void, delayMs: number) => unknown
  /** 取消已排队的尝试。 */
  cancel: (handle: unknown) => void
  /** 交接抛错时的告警（缺省静默）。 */
  warn?: (message: string, cause: unknown) => void
  /** 首次尝试前的延迟（毫秒，缺省 1000）。 */
  initialDelayMs?: number
  /** 退避上限（毫秒，缺省 30000）。 */
  maxDelayMs?: number
}

/**
 * 退避重试的票据交接表。
 *
 * 状态机只有两件事：`start()` 起表（幂等：先停旧表）、`stop()` 停表；每次尝试
 * 要么成功停表，要么按 1s→2s→…→30s 退避重排。
 */
export class CookieHandoff {
  private handle: unknown
  private delayMs: number
  private stopped = true

  constructor(private readonly deps: CookieHandoffDeps) {
    this.delayMs = deps.initialDelayMs ?? 1000
  }

  /** 当前是否排着下一次尝试（诊断/测试用）。 */
  get pending(): boolean {
    return !this.stopped && this.handle !== undefined
  }

  /** 起表（重复调用从头开始；切用户、清数据后都要重来一次）。 */
  start(): void {
    this.stop()
    this.stopped = false
    this.delayMs = this.deps.initialDelayMs ?? 1000
    this.attempt()
  }

  /** 停表（插件卸载 / 用户切换前）。 */
  stop(): void {
    this.stopped = true
    if (this.handle !== undefined) {
      this.deps.cancel(this.handle)
      this.handle = undefined
    }
  }

  private attempt(): void {
    this.handle = undefined
    if (this.stopped) return
    if (!this.deps.fenceAvailable()) {
      // 本部署可能根本不要票据（headless loader / 单测），但 connection 也可能
      // 只是比本行晚装载 —— 两者只能用"再试一次"区分，绝不能一次判死。
      this.retry()
      return
    }
    void this.deps.mirror().then((mirrored) => {
      if (mirrored || this.stopped) return
      this.retry()
    }).catch((cause: unknown) => {
      this.deps.warn?.('pico-browser: browser-auth cookie handoff failed', cause)
      if (!this.stopped) this.retry()
    })
  }

  private retry(): void {
    this.delayMs = Math.min(this.delayMs * 2, this.deps.maxDelayMs ?? 30_000)
    this.handle = this.deps.schedule(() => { this.attempt() }, this.delayMs)
  }
}
