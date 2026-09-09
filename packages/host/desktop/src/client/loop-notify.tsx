/**
 * Desktop loop-notify client: polls the Host click-to-jump route and opens
 * the session the user clicked in a native notification. The Host persists
 * the latest session id until the renderer consumes it; polling is a
 * light short-interval GET that mirrors the desktop update badge pattern.
 * @module dsh-plugin-desktop/loop-notify-client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DESKTOP_LOOP_NOTIFY_SESSION_PATH, type DesktopLoopNotifySessionResponse } from '../loop-notify-contract.ts'

/** Poll interval for the pending jump request, ms. */
const JUMP_POLL_MS = 2_000

/** Runtime `fetch`-compatible request boundary (test seam). */
export type LoopNotifyRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Brand a raw session id string (compile-time cast, no runtime cost). */
function brandSessionId(id: string): SessionId {
  return id as SessionId
}

/** Fetch the pending click-to-jump session request. */
export async function fetchLoopNotifySession(
  request: LoopNotifyRequest = window.fetch.bind(window),
): Promise<DesktopLoopNotifySessionResponse | null> {
  try {
    const response = await request(DESKTOP_LOOP_NOTIFY_SESSION_PATH, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) return null
    const value: unknown = await response.json()
    return isLoopNotifySession(value) ? value : null
  } catch {
    return null
  }
}

function isLoopNotifySession(value: unknown): value is DesktopLoopNotifySessionResponse {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.requestedAt === 'number'
    && (record.sessionId === null || typeof record.sessionId === 'string')
}

/**
 * One poll cycle: fetch the pending request, then hand it to the consumer.
 * A failed fetch is a no-op (next interval retries).
 */
async function pollLoopNotifySession(
  consume: (next: DesktopLoopNotifySessionResponse | null) => void,
): Promise<void> {
  consume(await fetchLoopNotifySession())
}

/**
 * sessionStorage key for the last consumed jump timestamp. The poller's
 * in-memory `seenAt` dies with the renderer; without persistence a reload
 * re-opens the session the user just visited (P2-24).
 */
export const LOOP_NOTIFY_SEEN_AT_KEY = 'pico.desktop.loop-notify.seenAt'

/** Read the persisted high-water mark (0 when storage is unavailable). */
export function readLoopNotifySeenAt(): number {
  try {
    const raw = globalThis.sessionStorage?.getItem(LOOP_NOTIFY_SEEN_AT_KEY)
    const value = raw === null || raw === undefined ? 0 : Number(raw)
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

/** Persist the high-water mark (best effort; private mode may throw). */
export function writeLoopNotifySeenAt(value: number): void {
  try {
    globalThis.sessionStorage?.setItem(LOOP_NOTIFY_SEEN_AT_KEY, String(value))
  } catch {
    // Storage unavailable — the Host-side consume still prevents re-delivery.
  }
}

/**
 * Register the click-to-jump poller. Runs inside `ctx.effect`; the poller
 * tracks the last processed timestamp (persisted in sessionStorage) so a
 * refresh-safe duplicate fetch never re-opens the same session.
 */
export function applyLoopNotifyClient(ctx: ClientContext): void {
  ctx.effect(() => {
    let cancelled = false
    let seenAt = readLoopNotifySeenAt()
    const markSeen = (requestedAt: number): void => {
      if (requestedAt <= seenAt) return
      seenAt = requestedAt
      writeLoopNotifySeenAt(seenAt)
    }
    const consume = (next: DesktopLoopNotifySessionResponse | null): void => {
      if (cancelled || next === null) return
      if (next.sessionId === null) {
        // The Host cleared the request (stale); remember the timestamp so an
        // older queued response cannot reopen a consumed session.
        markSeen(next.requestedAt)
        return
      }
      if (next.requestedAt <= seenAt) return
      markSeen(next.requestedAt)
      // The desktop package compiles client and Host faces into one program:
      // `ctx.sessions` merges to the Host `SessionStore` face here, while the
      // browser runtime actually provides the `ISessions` face with `open()`.
      // Read through the narrow consumer interface instead of fighting the
      // merge; the runtime object always carries `open`.
      ;(ctx.sessions as unknown as { open(id: SessionId): void }).open(brandSessionId(next.sessionId))
    }
    void pollLoopNotifySession(consume)
    const timer = window.setInterval(() => { void pollLoopNotifySession(consume) }, JUMP_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, 'desktop: loop-notify session jump poller')
}
