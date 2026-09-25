/**
 * Shared browser error vocabulary (v4): every tool/runtime failure carries a
 * stable machine code plus a human message. Codes are grouped:
 * - base taxonomy (network/timeout/not-found/...)
 * - isolation & policy (no-session/foreign-tab/...)
 * @module @picoaide/dsh-browser
 */

/** Machine-readable browser error codes (stable, model-facing). */
export type BrowserErrorCode =
  | 'network'
  | 'timeout'
  | 'not-found'
  // R15B-01（2026-09-25）：数字 target 锚定的那份模型面快照已经不适用（该 tab
  // 从没取过快照，或取过之后页面已经导航走）。这是**明确拒绝**，不是"按新页面
  // 重新解析"——后者会让模型点到自己从未见过的元素。
  | 'stale-snapshot'
  | 'navigation-blocked'
  // 2026-09-15 审计 F4：下面 6 个码在 v4.2 单池实现里**没有任何构造点**（组/血缘/
  // 会话隔离子系统已不存在），保留仅为不破坏已发布的类型面。新增代码不要再使用；
  // 需要"跨 tab/跨会话拒绝"时请用现有的 not-found / window-controlled / quota。
  | 'auth-expired'
  | 'interrupted'
  | 'no-session'
  | 'foreign-tab'
  | 'group-not-found'
  | 'group-archived'
  | 'group-quota'
  | 'quota'
  | 'window-controlled'
  | 'eval-policy'
  | 'policy'

/** Error carrier: stable code + human message (never contains secrets). */
export class BrowserError extends Error {
  readonly code: BrowserErrorCode

  constructor(code: BrowserErrorCode, message: string) {
    super(message)
    this.name = 'BrowserError'
    this.code = code
  }
}

/** Create a BrowserError with a code. */
export function browserError(code: BrowserErrorCode, message: string): BrowserError {
  return new BrowserError(code, message)
}
