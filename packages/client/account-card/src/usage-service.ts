/**
 * Gateway usage snapshot service: fetches `GET /api/client/v2/auth/usage` with the
 * enterprise session token, keeps one in-memory snapshot, and coalesces
 * refreshes (debounce + single flight) so agent-loop-complete notifications
 * and manual refreshes never stack duplicate gateway calls.
 * @module @picoaide/dsh-account-card/usage-service
 */

import { AuthError, fetchJSON } from '@picoaide/dsh-enterprise/server-connector/auth'
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
  /**
   * 审计 2026-09-12 P1-5:令牌已失效(服务端 401 / AuthError kind
   * 'auth_expired')时为 true。消费方据此**不再展示旧余额**(旧快照是上一个
   * 有效令牌下取到的),路由层据此回 401 让渲染层隐藏卡片。
   *
   * 与普通网络错误的区别是关键:网络抖动保留旧快照是**想要**的行为
   * (别把余额闪成空白),而鉴权失败保留旧快照是**缺陷**(静默展示过期金额)。
   */
  authExpired: boolean
}

/** Empty snapshot shown before the first successful fetch. */
export const EMPTY_SNAPSHOT: UsageSnapshot = { data: null, fetchedAt: 0, state: 'idle', error: null, authExpired: false }

/** fetchJSON-compatible gateway caller (test-injectable). `signal` lets the
 * service abort a request that belongs to a session the user just left. */
export type UsageFetcher = (serverURL: string, path: string, opts: { token?: string; signal?: AbortSignal }) => Promise<UsagePayload>

const DEFAULT_DEBOUNCE_MS = 300

/** Identity of the account a request belongs to (server + user + token). */
function sessionKey(session: Session): string {
  return `${session.serverURL}\u0000${session.username ?? ''}\u0000${session.token}`
}

/**
 * Whether a failed usage fetch means "this token is no longer valid".
 *
 * `fetchJSON` raises `AuthError('auth_expired')` for HTTP 401 on the client
 * surface; the message fallback covers a few server shapes that answer 401
 * without the structured kind. Exported for the route layer and its tests.
 * @param cause - thrown value from the usage fetch.
 * @returns true when the session token must be treated as expired.
 */
export function isAuthExpired(cause: unknown): boolean {
  if (cause instanceof AuthError) return cause.kind === 'auth_expired'
  const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  return /\b401\b|auth_expired|未授权|登录已过期|Unauthorized/i.test(message)
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
  /**
   * 当前快照**属于哪个账号**（`sessionKey()`）。`null` = 还没有任何账号的快照。
   *
   * R16B-01（2026-09-25）：快照此前不带账号维度 —— 换号（同服务端 A→B）只排一次
   * 300ms 去抖的 `refresh()`，而 `refreshNow()` 只把 `state` 置 `loading` 却**保留
   * `data`**，于是去抖窗口内本机路由照样 `200` 交付 A 的余额，账户卡把它渲染在 B 的
   * 名字下（跨账号金额交付）。键一旦变化必须**立刻**丢数据，不能等去抖到期。
   */
  private snapshotKey: string | null = null
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
   * 这份快照（若已有）是否属于 `session`。
   *
   * 路由层据此**拒绝交付**：一份带数据的快照只能交给取它的那个账号。没有快照
   * （`snapshotKey === null`）不算"别人的" —— 那是"还没取到"，交空态是安全的。
   * @param session - 当前会话。
   * @returns true 表示可以交付这份快照。
   */
  owns(session: Session): boolean {
    return this.snapshotKey === null || this.snapshotKey === sessionKey(session)
  }

  /**
   * 撤回在途请求并作废它的写回资格（epoch 自增 ⇒ 迟到的结果写不进来）。
   * 判定与清账共用同一个键构造点：`snapshotKey` 与 `inflightKey` 都出自 `sessionKey()`。
   */
  private cancelInflight(): void {
    this.epoch++
    this.controller?.abort()
    this.controller = null
    this.inflight = null
    this.inflightKey = null
  }

  /**
   * 把快照的归属切到 `session` 的账号；**换了账号就立刻丢数据 + 撤回在途请求**。
   *
   * 同一个账号、同一枚令牌重复调用是 no-op。令牌换了（续期/重登）算新键 ⇒ 同样丢数据：
   * 新令牌下"旧令牌取到的余额"没有可验证的归属，留着才是缺陷。代价只是一次去抖 +
   * 一次往返期间显示空态（`…`），换掉的却是一个无法证伪的数字。
   * @param session - 本次刷新的账号。
   */
  private adopt(session: Session): void {
    const key = sessionKey(session)
    if (this.snapshotKey === key) return
    this.cancelInflight()
    this.snapshotKey = key
    // 回到空快照（`state:'idle'` + `data:null`）：这是"这个账号还没有取到余额"的
    // 既有契约（`index.spec.ts` 钉住它），渲染层据此显示 `…`。关键是 **`data` 立刻
    // 变 null** —— 去抖窗口内绝不留着上一个账号的金额。
    this.snapshot = EMPTY_SNAPSHOT
  }

  /**
   * Debounced refresh: safe to call on every agent-loop-complete notification
   * or session change. No-op when logged out.
   */
  refresh(session: Session | null): void {
    if (session === null) return
    // 先切归属再排队：换号后的数据丢弃**不经过去抖**（这是 R16B-01 的窗口）。
    this.adopt(session)
    const key = sessionKey(session)
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      // 排队期间又换了账号 ⇒ 这一发属于上一个账号，直接作废（否则会把刚切走的
      // 账号的键再 adopt 回来）。
      if (this.snapshotKey !== key) return
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
    this.cancelInflight()
    this.snapshotKey = null
    this.snapshot = EMPTY_SNAPSHOT
  }

  /**
   * Immediate single-flight refresh. Manual refresh buttons call this; the
   * returned promise resolves to the post-refresh snapshot.
   */
  async refreshNow(session: Session | null): Promise<UsageSnapshot> {
    if (session === null) return this.snapshot
    // 换号即作废旧快照与在途请求（`owns()` 与本行是同一个归属判据的两端）。
    this.adopt(session)
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
            ? { data: null, fetchedAt: Date.now(), state: 'error', error: 'unexpected usage payload', authExpired: false }
            : { data, fetchedAt: Date.now(), state: 'idle', error: null, authExpired: false }
        }
      } catch (cause) {
        // 审计 2026-09-12 P1-5:鉴权失败必须与网络抖动分开。
        //
        // 旧实现把两者都折成 `state:'error'` 且**保留旧快照**,注释还宣称
        // "the route layer maps it to a 401 so the card can hide" —— 该映射
        // 从未实现(grep `auth_expired` 零命中),于是令牌失效后账号卡继续
        // 静默展示上一个令牌下取到的余额。
        //
        // 现在:auth_expired/401 ⇒ 标记 authExpired 并**丢弃数据**(旧余额
        // 不可信);其余(网络/服务端 5xx)⇒ 保留旧快照(避免把余额闪成空白)。
        const expired = isAuthExpired(cause)
        if (epoch === this.epoch && this.inflight === request) {
          this.snapshot = expired
            ? {
                data: null,
                fetchedAt: this.snapshot.fetchedAt,
                state: 'error',
                error: cause instanceof Error ? cause.message : String(cause),
                authExpired: true,
              }
            : {
                ...this.snapshot,
                state: 'error',
                error: cause instanceof Error ? cause.message : String(cause),
                authExpired: false,
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
