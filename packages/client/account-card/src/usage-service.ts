/**
 * Gateway usage snapshot service: fetches `GET /api/client/v2/auth/usage` with the
 * enterprise session token, keeps one in-memory snapshot, and coalesces
 * refreshes (debounce + single flight) so agent-loop-complete notifications
 * and manual refreshes never stack duplicate gateway calls.
 * @module @picoaide/dsh-account-card/usage-service
 */

import { fetchJSON } from '@picoaide/dsh-enterprise/server-connector/auth'
import type { Session } from '@picoaide/dsh-enterprise/server-connector/config'
import { parseUsagePayload, type UsagePayload } from './usage-contract.js'

// 契约(类型 + 键集合 + 运行时校验)统一在 usage-contract.ts —— 唯一真源。
export type { UsagePayload } from './usage-contract.js'
export { USAGE_PAYLOAD_KEYS, parseUsagePayload } from './usage-contract.js'

/** Refresh lifecycle of the snapshot. */
export type SnapshotState = 'idle' | 'loading' | 'error'

/** Current cached usage snapshot plus freshness metadata. */
export interface UsageSnapshot {
  data: UsagePayload | null
  /** Epoch ms of the last successful fetch; 0 = never fetched. */
  fetchedAt: number
  state: SnapshotState
  error: string | null
}

/** Empty snapshot shown before the first successful fetch. */
export const EMPTY_SNAPSHOT: UsageSnapshot = { data: null, fetchedAt: 0, state: 'idle', error: null }

/** fetchJSON-compatible gateway caller (test-injectable). `signal` lets the
 * service abort a request that belongs to a session the user just left. */
export type UsageFetcher = (serverURL: string, path: string, opts: { token?: string; signal?: AbortSignal }) => Promise<UsagePayload>

const DEFAULT_DEBOUNCE_MS = 300

/** Identity of the account a request belongs to (server + user + token). */
function sessionKey(session: Session): string {
  return `${session.serverURL}\u0000${session.username ?? ''}\u0000${session.token}`
}

/**
 * Coalescing usage fetcher. `refresh()` debounces (bursts of loop-complete
 * notifications collapse into one call); `refreshNow()` bypasses the debounce
 * and is single-flight (concurrent callers share the in-flight request).
 * Failures keep the previous snapshot and flip `state` to `error`.
 *
 * P2-22: a request is bound to the account that issued it. `clear()` (logout /
 * user switch) aborts the in-flight request and bumps an epoch, so its result
 * can never be written into the next account's snapshot, and a caller for a
 * DIFFERENT account never joins (or receives) the previous account's request.
 */
export class UsageService {
  private snapshot: UsageSnapshot = EMPTY_SNAPSHOT
  private inflight: Promise<UsageSnapshot> | null = null
  private inflightKey: string | null = null
  private controller: AbortController | null = null
  private epoch = 0
  private debounceTimer: NodeJS.Timeout | null = null
  private readonly debounceMs: number
  private fetch: UsageFetcher

  constructor(options: { debounceMs?: number; fetchFn?: UsageFetcher } = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.fetch = options.fetchFn ?? fetchJSON
  }

  /** Current snapshot (never throws). */
  get(): UsageSnapshot {
    return this.snapshot
  }

  /**
   * Debounced refresh: safe to call on every agent-loop-complete notification
   * or session change. No-op when logged out.
   */
  refresh(session: Session | null): void {
    if (session === null) return
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.refreshNow(session)
    }, this.debounceMs)
  }

  /** Drop the cached snapshot immediately (logout/user switch) and cancel any
   * in-flight request so its result cannot land in the next account's cache. */
  clear(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.epoch++
    this.controller?.abort()
    this.controller = null
    this.inflight = null
    this.inflightKey = null
    this.snapshot = EMPTY_SNAPSHOT
  }

  /**
   * Immediate single-flight refresh. Manual refresh buttons call this; the
   * returned promise resolves to the post-refresh snapshot.
   */
  async refreshNow(session: Session | null): Promise<UsageSnapshot> {
    if (session === null) return this.snapshot
    const key = sessionKey(session)
    if (this.inflight !== null) {
      // Same account: share the in-flight request (single flight).
      if (this.inflightKey === key) return this.inflight
      // Different account: never hand the previous account's request (or its
      // result) to this one — abort it and start a fresh request.
      this.controller?.abort()
      this.inflight = null
      this.inflightKey = null
    }
    const epoch = this.epoch
    const controller = new AbortController()
    this.controller = controller
    this.snapshot = { ...this.snapshot, state: 'loading', error: null }
    let request!: Promise<UsageSnapshot>
    request = (async (): Promise<UsageSnapshot> => {
      try {
        const raw = await this.fetch(session.serverURL, '/api/client/v2/auth/usage', {
          token: session.token,
          signal: controller.signal,
        })
        // 运行时校验:形状不符(旧服务端/字段改名/代理包了一层)时保持空态,
        // 不把 undefined 漏进渲染层。
        const data = parseUsagePayload(raw)
        // Epoch + ownership check: a logout/login during the request must not
        // write the previous account's data into the new snapshot, and a
        // superseded request (replaced by another account's) must not publish
        // its aborted error over the newer request's state (P2-22).
        if (epoch === this.epoch && this.inflight === request) {
          this.snapshot = data === null
            ? { data: null, fetchedAt: Date.now(), state: 'error', error: 'unexpected usage payload' }
            : { data, fetchedAt: Date.now(), state: 'idle', error: null }
        }
      } catch (cause) {
        // 401/auth-expired surfaces here too: the route layer maps it to a
        // 401 response so the card can hide; the previous snapshot is kept
        // so a transient network blip never blanks the balance.
        if (epoch === this.epoch && this.inflight === request) {
          this.snapshot = {
            ...this.snapshot,
            state: 'error',
            error: cause instanceof Error ? cause.message : String(cause),
          }
        }
      } finally {
        // Only the request that still owns the slot may clear it.
        if (this.inflight === request) {
          this.inflight = null
          this.inflightKey = null
          this.controller = null
        }
      }
      return this.snapshot
    })()
    this.inflight = request
    this.inflightKey = key
    return request
  }

  /** Cancel any pending debounced refresh (plugin teardown). */
  dispose(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.controller?.abort()
    this.controller = null
  }
}
