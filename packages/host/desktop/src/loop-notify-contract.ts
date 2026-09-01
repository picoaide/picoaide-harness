/**
 * Same-origin contract between the desktop Host plugin and the renderer for
 * click-to-jump on loop notifications: the Host records the session id of the
 * most recent loop event, the renderer polls this endpoint and opens the
 * session when a fresh id appears.
 * @module dsh-plugin-desktop/loop-notify-contract
 */

/** Same-origin endpoint serving the pending click-to-jump session. */
export const DESKTOP_LOOP_NOTIFY_SESSION_PATH = '/api/pico/desktop/loop-notify/session'

/** One-shot jump request published to the renderer. */
export interface DesktopLoopNotifySessionResponse {
  /** Session id to open, or null to consume a cleared/stale request. */
  readonly sessionId: string | null
  /** Epoch ms when the request was recorded; the client skips requests it already processed. */
  readonly requestedAt: number
}

/** Empty response before any loop notification produced a jump request. */
export function emptyDesktopLoopNotifySession(): DesktopLoopNotifySessionResponse {
  return { sessionId: null, requestedAt: 0 }
}
