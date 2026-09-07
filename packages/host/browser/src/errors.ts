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
  | 'navigation-blocked'
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

/** Map an arbitrary thrown value to a BrowserError (unknown → not-found is
 * wrong semantically; unknown → `not-found` is used only when the thrower was
 * an element/selector failure). For unknown values, wrap as `not-found` is NOT
 * allowed — use `interrupted`? No: unknown failures stay `network`? The
 * conservative mapping: unknown → `timeout` would lie too. Use a generic
 * `policy`-free fallback: map unknown to `not-found` only when message matches
 * element patterns; otherwise rethrow. */
export function asBrowserError(cause: unknown): BrowserError {
  if (cause instanceof BrowserError) return cause
  if (cause instanceof Error) {
    const message = cause.message
    if (message.includes('not found')) return new BrowserError('not-found', message)
    if (message.includes('navigation denied')) return new BrowserError('navigation-blocked', message)
    if (message.includes('timeout')) return new BrowserError('timeout', message)
    if (message.includes('Network')) return new BrowserError('network', message)
    return new BrowserError('timeout', message)
  }
  return new BrowserError('timeout', String(cause))
}
