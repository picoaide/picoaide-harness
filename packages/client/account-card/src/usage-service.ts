/**
 * Gateway usage snapshot service: fetches `GET /api/client/v2/auth/usage` with the
 * enterprise session token, keeps one in-memory snapshot, and coalesces
 * refreshes (debounce + single flight) so agent-loop-complete notifications
 * and manual refreshes never stack duplicate gateway calls.
 * @module @picoaide/dsh-account-card/usage-service
 */

import { fetchJSON } from '@picoaide/dsh-enterprise/server-connector/auth'
import type { Session } from '@picoaide/dsh-enterprise/server-connector/config'

/** Server `GET /api/client/v2/auth/usage` payload (fields used by the card). */
export interface UsagePayload {
  is_admin: boolean
  quota_tokens: number
  quota_money: number
  monthly_usage: number
  monthly_cost: number
  /** `null` = no token quota (unlimited) or zero quota (also unlimited). */
  remaining_tokens: number | null
  /** `null` = no money quota (unlimited) or zero quota (also unlimited). */
  remaining_money: number | null
  today_usage: number
  today_cost: number
  yesterday_usage: number
  yesterday_cost: number
  total_usage: number
  total_cost: number
  dept_budgets: { name: string; budget: number; used: number }[]
}

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

/** fetchJSON-compatible gateway caller (test-injectable). */
export type UsageFetcher = (serverURL: string, path: string, opts: { token?: string }) => Promise<UsagePayload>

const DEFAULT_DEBOUNCE_MS = 300

/**
 * Coalescing usage fetcher. `refresh()` debounces (bursts of loop-complete
 * notifications collapse into one call); `refreshNow()` bypasses the debounce
 * and is single-flight (concurrent callers share the in-flight request).
 * Failures keep the previous snapshot and flip `state` to `error`.
 */
export class UsageService {
  private snapshot: UsageSnapshot = EMPTY_SNAPSHOT
  private inflight: Promise<UsageSnapshot> | null = null
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

  /** Drop the cached snapshot immediately (logout/user switch). */
  clear(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.snapshot = EMPTY_SNAPSHOT
  }

  /**
   * Immediate single-flight refresh. Manual refresh buttons call this; the
   * returned promise resolves to the post-refresh snapshot.
   */
  async refreshNow(session: Session | null): Promise<UsageSnapshot> {
    if (session === null) return this.snapshot
    if (this.inflight !== null) return this.inflight
    this.snapshot = { ...this.snapshot, state: 'loading', error: null }
    this.inflight = (async (): Promise<UsageSnapshot> => {
      try {
        const data = await this.fetch(session.serverURL, '/api/client/v2/auth/usage', { token: session.token })
        this.snapshot = { data, fetchedAt: Date.now(), state: 'idle', error: null }
      } catch (cause) {
        // 401/auth-expired surfaces here too: the route layer maps it to a
        // 401 response so the card can hide; the previous snapshot is kept
        // so a transient network blip never blanks the balance.
        this.snapshot = {
          ...this.snapshot,
          state: 'error',
          error: cause instanceof Error ? cause.message : String(cause),
        }
      } finally {
        this.inflight = null
      }
      return this.snapshot
    })()
    return this.inflight
  }

  /** Cancel any pending debounced refresh (plugin teardown). */
  dispose(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }
}
