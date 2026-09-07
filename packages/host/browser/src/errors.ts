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
