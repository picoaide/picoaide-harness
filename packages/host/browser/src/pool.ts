/**
 * TabPool (v4.2, 2026-09-07 定案：取消分组): ONE flat tab pool shared by
 * every session and the user — "AI 可以控制所有页面". Tabs are global; the
 * global serial queue serializes AI operations (one session drives at a
 * time), the global user gate pauses everything on 我来操作, and a flat tab
 * quota bounds the pool. A light ledger persists the tab list (url/title/
 * active) across restarts; views are recreated on demand (login state lives
 * in the per-user partition).
 * @module @picoaide/dsh-browser
 */

import { DEFAULT_HOST_LOCALE, hostCopy, type HostLocale } from 'dsh-plugin-desktop/host-locale'
import { browserError } from './errors.ts'
import type { BrowserError } from './errors.ts'
import { USER_GATE_TIMEOUT_MS } from './budgets.ts'

/** One tab's registry metadata (shell rendering + persistence). */
export interface PoolTabMeta {
  readonly tabId: number
  url: string
  title: string
}

/** Snapshot shape for the shell + AI state API. */
export interface PoolTabView {
  readonly id: number
  readonly url: string
  readonly title: string
  readonly loading: boolean
  readonly active: boolean
}

export interface PoolOptions {
  /** Flat tab cap (default 16). */
  maxTabs?: number
  /** Quota wait budget ms (default 60000). */
  waitTimeoutMs?: number
  /**
   * 用户接管（「我来操作」）后，agent 操作等待交还的上限（ms，缺省
   * {@link USER_GATE_TIMEOUT_MS}）。
   *
   * 2026-09-15 审计 P0-1：暂停本身是产品意图（"人操作时 loop 暂停"），但**无限期**
   * 等待会让模型回合永远挂着、无任何可见原因，用户只能手动停止回合。超时以明确
   * 错误结束这次工具调用（**不抢控制权**），让模型与客户端都能看到发生了什么。
   *
   * 2026-09-16（客户会话 session-88502514）：缺省值原本是 300s，**比浏览器工具的
   * 30s 预算还长**——于是这条明确错误永远来不及送达，模型只看到 timeout-policy 的
   * `tool call timed out after 30000ms`，把"用户正拿着控制权"误判成页面卡死。缺省值
   * 现在取自 budgets.ts，并且必须始终小于工具预算。
   */
  userGateTimeoutMs?: number
  /**
   * Locale provider for the user-gate refusals (model-facing AND echoed into
   * the activity panel the user reads). A provider, not a value: the language
   * can change while the app runs, and these messages are produced per call.
   */
  locale?: () => HostLocale
}

/**
 * 一次 tab 槽位预留的凭证（2026-09-15 P0 修复）：预留只能被**兑现**（registerTab
 * 消耗）或**退还**（releaseReservation）一次 —— 两者都幂等。此前预留只是个计数器，
 * "占位成功但导航失败"的路径会 `registerTab`（扣一次）后又在 catch 里
 * `releaseReservation`（再扣一次），把一次预留凭空抹掉：池子远未满也会让后续所有
 * 开页请求等到 60s 超时，只能重启客户端恢复（静默缩容）。
 */
export interface TabReservation {
  readonly id: number
}

const POOL_DEFAULTS = {
  maxTabs: 16,
  userGateTimeoutMs: USER_GATE_TIMEOUT_MS,
  waitTimeoutMs: 60_000,
  locale: (): HostLocale => DEFAULT_HOST_LOCALE,
} as const

/**
 * 用户持有控制权时，agent 调用被拒的统一文案（模型面 + 活动面板）：必须说清
 * **怎么解开**。
 *
 * 2026-09-16 现场（会话 session-88502514）：模型只看到 `tool call timed out after
 * 30000ms`，既不知道是用户拿着控制权，也没有"请用户点交给 AI"的指令，于是把
 * 浏览器判成卡死、连试十几次，最后绕道用户自己的 Chrome 取数。
 *
 * 按 locale 取值（调用点现取，不缓存）：这段文案既进模型上下文，也进用户看得见的
 * 活动时间线（`noteControlBlock` / 工具错误），所以它必须跟界面语言一致。
 */
function gateRefusal(locale: HostLocale): string {
  return hostCopy(
    locale,
    '用户正在操作浏览器（我来操作）—— 请在浏览器窗口点「交给 AI」交还控制权后重试',
    'The user is operating the browser (take-over) — click "Hand back to AI" in the browser window to return control, then retry',
  )
}

/** {@link gateRefusal} plus a trailing reason (both sides per locale). */
function gateRefusalWith(locale: HostLocale, reasonZh: string, reasonEn: string): string {
  return hostCopy(locale, `${gateRefusal('zh')}${reasonZh}`, `${gateRefusal('en')}${reasonEn}`)
}

interface QueueTicket {
  resolve: () => void
  reject: (error: unknown) => void
  signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
  timer?: ReturnType<typeof setTimeout>
  settled: boolean
}

/** Serial promise-queue mutex honoring the global user gate. */
class PoolMutex {
  private tail: Promise<void> = Promise.resolve()

  /**
   * @param locale - locale provider for the gate refusals this queue throws
   * (called per throw, never captured).
   */
  constructor(private readonly locale: () => HostLocale) {}

  async run(
    work: () => Promise<void>,
    gate: () => boolean,
    signal?: AbortSignal,
    /** 用户闸等待预算（ms，<=0 表示不设限）。 */
    gateBudgetMs = 0,
  ): Promise<void> {
    const prev = this.tail
    // The tool deadline is armed when the model issues the call, so queue time
    // must count against the gate budget. Timing the budget from "after the
    // mutex admitted us" let a long predecessor eat most of the tool deadline
    // and the gate still waited its full budget afterwards — the deadline then
    // replaced the explicit `window-controlled` refusal with the generic
    // `tool call timed out after 30000ms` (2026-09-16 audit E2).
    const budgetStartedAt = Date.now()
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    try {
      // Waiting for the previous operation must be cancellable too: a wedged
      // predecessor used to block every later call forever (2026-09-08 P0-4).
      await raceAbort(prev, gate, signal, this.locale)
      while (gate()) {
        if (signal !== undefined && signal.aborted) {
          throw browserError('window-controlled', gateRefusalWith(
            this.locale(),
            '（这次调用已被停止）',
            ' (this call was stopped)',
          ))
        }
        // 2026-09-15 审计 P0-1：用户接管后不能无限期挂住模型回合。
        // 2026-09-16：预算必须短于工具预算，否则这段文案永远到不了模型面前。
        if (gateBudgetMs > 0 && Date.now() - budgetStartedAt >= gateBudgetMs) {
          const seconds = Math.round(gateBudgetMs / 1000)
          throw browserError('window-controlled', hostCopy(
            this.locale(),
            `browser: 等待用户交还浏览器超时（${String(seconds)}s）—— ${gateRefusal('zh')}`,
            `browser: timed out waiting for the user to hand back the browser (${String(seconds)}s) — ${gateRefusal('en')}`,
          ))
        }
        await sleep(120)
      }
      return await work()
    } finally {
      release()
    }
  }
}

/** Await a promise, rejecting as soon as `signal` aborts. The rejection code
 * mirrors the gate loop: an abort while the user holds the browser reports
 * `window-controlled`, otherwise the operation was merely queued (`interrupted`). */
function raceAbort(
  promise: Promise<void>,
  gate: () => boolean,
  signal: AbortSignal | undefined,
  locale: () => HostLocale,
): Promise<void> {
  if (signal === undefined) return promise
  const abortError = (): BrowserError => gate()
    ? browserError('window-controlled', `browser: ${gateRefusalWith(
      locale(),
      '（这次调用已被停止）',
      ' (this call was stopped)',
    )}`)
    : browserError('interrupted', 'browser: operation aborted while queued')
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      () => { if (!settled) { settled = true; signal.removeEventListener('abort', onAbort); resolve() } },
      (error: unknown) => { if (!settled) { settled = true; signal.removeEventListener('abort', onAbort); reject(error) } },
    )
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms))
    t.unref?.()
  })
}

/** TabPool (see module doc). */
export class TabPool {
  readonly options: Required<PoolOptions>
  private readonly tabs = new Map<number, PoolTabMeta>()
  private readonly mutex: PoolMutex
  private windowControlled = false
  private activeTabId: number | undefined
  private readonly listeners = new Set<(event: string) => void>()
  private busyTool = ''
  private busyDepth = 0
  private reserved = 0
  /** 尚未兑现/退还的预留令牌（所有权凭证，防止重复释放）。 */
  private readonly outstandingReservations = new Set<number>()
  private nextReservationId = 1
  /** Restored ledger ids whose view is not materialized yet. They appear in
   * `tabs` (the shell lists them) but must NOT consume a live-view slot until
   * they materialize (P2-26 quota semantics). */
  private readonly pendingIds = new Set<number>()
  private tabWaiters: QueueTicket[] = []
  disposed = false

  constructor(options: PoolOptions = {}) {
    this.options = { ...POOL_DEFAULTS, ...options }
    this.mutex = new PoolMutex(this.options.locale)
  }

  onChange(listener: (event: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(event: string): void {
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch { /* bus must never break */ }
    }
  }

  // ------------------------------------------------------------- state

  get controlled(): boolean {
    return this.windowControlled
  }

  setUserControl(active: boolean): void {
    if (this.windowControlled === active) return
    this.windowControlled = active
    this.emit(active ? 'takeover' : 'release')
  }

  get activeTab(): number | undefined {
    return this.activeTabId
  }

  setActiveTab(tabId: number): void {
    if (!this.tabs.has(tabId)) {
      throw browserError('not-found', `browser: unknown tab ${tabId}`)
    }
    this.activeTabId = tabId
    this.emit('tab')
  }

  isBusy(): boolean {
    return this.busyTool !== ''
  }

  busyToolOf(): string {
    return this.busyTool
  }

  /**
   * Run one AI operation under the global serial mutex with the user-gate
   * check; marks the pool busy while running/queued.
   */
  async withOperation<T>(tool: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.busyDepth === 0) this.busyTool = tool
    this.busyDepth++
    this.emit('busy')
    try {
      let result!: T
      await this.mutex.run(
        async () => { result = await work() },
        () => this.windowControlled,
        signal,
        this.options.userGateTimeoutMs,
      )
      return result
    } finally {
      this.busyDepth--
      if (this.busyDepth === 0) this.busyTool = ''
      this.emit('busy')
    }
  }

  // ------------------------------------------------------------- tabs

  /** Live (materialized) tab count: restored-but-unmaterialized ledger
   * entries are listed but do not occupy a view slot yet. */
  private liveTabs(): number {
    let pending = 0
    for (const id of this.pendingIds) if (this.tabs.has(id)) pending++
    return this.tabs.size - pending
  }

  /** Reserve a tab slot (flat cap; waits FIFO, cancellable, timed). */
  async reserveTab(signal?: AbortSignal): Promise<TabReservation> {
    if (this.liveTabs() + this.reserved < this.options.maxTabs) {
      return this.grantReservation()
    }
    await new Promise<void>((resolve, reject) => {
      const ticket: QueueTicket = { resolve, reject, signal, onAbort: undefined, settled: false }
      if (signal !== undefined && signal.aborted) {
        reject(browserError('quota', 'browser: cancelled while waiting for a tab slot'))
        return
      }
      ticket.onAbort = () => {
        if (ticket.settled) return
        ticket.settled = true
        const idx = this.tabWaiters.indexOf(ticket)
        if (idx >= 0) this.tabWaiters.splice(idx, 1)
        reject(browserError('quota', 'browser: cancelled while waiting for a tab slot'))
      }
      if (signal !== undefined) signal.addEventListener('abort', ticket.onAbort, { once: true })
      const timer = setTimeout(() => {
        if (ticket.settled) return
        ticket.settled = true
        const idx = this.tabWaiters.indexOf(ticket)
        if (idx >= 0) this.tabWaiters.splice(idx, 1)
        reject(browserError('quota', `browser: timed out waiting for a tab slot (${Math.round(this.options.waitTimeoutMs / 1000)}s)`))
      }, this.options.waitTimeoutMs)
      timer.unref?.()
      ticket.timer = timer
      this.tabWaiters.push(ticket)
      this.pumpWaiters()
    })
    // pumpWaiters 已经为本票 `reserved++`，这里补发一次性令牌。
    return this.grantReservation({ alreadyCounted: true })
  }

  /** 发一张预留令牌（`alreadyCounted` = 计数已在 pumpWaiters 里加过）。 */
  private grantReservation(options: { alreadyCounted?: boolean } = {}): TabReservation {
    if (options.alreadyCounted !== true) this.reserved++
    const id = this.nextReservationId++
    this.outstandingReservations.add(id)
    return { id }
  }

  /** Fail-fast reservation (user paths): a token when a slot is free. */
  tryReserveTab(): TabReservation | undefined {
    if (this.liveTabs() + this.reserved >= this.options.maxTabs) return undefined
    return this.grantReservation()
  }

  private pumpWaiters(): void {
    while (this.liveTabs() + this.reserved < this.options.maxTabs && this.tabWaiters.length > 0) {
      const ticket = this.tabWaiters.shift()!
      ticket.settled = true
      if (ticket.timer !== undefined) clearTimeout(ticket.timer)
      if (ticket.onAbort !== undefined && ticket.signal !== undefined) ticket.signal.removeEventListener('abort', ticket.onAbort)
      this.reserved++
      ticket.resolve()
    }
  }

  /**
   * 退还一次预留。带令牌时**幂等**：已被 registerTab 兑现（或已退过一次）的令牌
   * 再退是 no-op —— 这正是 2026-09-15 P0 的修复点。
   */
  releaseReservation(reservation?: TabReservation): void {
    if (reservation !== undefined) {
      if (!this.outstandingReservations.delete(reservation.id)) return
    } else if (this.outstandingReservations.size > 0) {
      // 无令牌的旧调用点（含测试）：退最早的一张，保持既有语义。
      const oldest = this.outstandingReservations.values().next().value
      if (oldest !== undefined) this.outstandingReservations.delete(oldest)
    }
    if (this.reserved > 0) this.reserved--
    this.pumpWaiters()
  }

  /** Register a created tab (consumes the reservation); a NEW tab becomes the
   * pool's active tab (browser convention; the shell/tools may switch). */
  registerTab(tabId: number, url: string, title: string, reservation?: TabReservation): void {
    this.tabs.set(tabId, { tabId, url, title })
    // The view now exists: the restored entry consumes a live slot.
    this.pendingIds.delete(tabId)
    this.activeTabId = tabId
    // 兑现这次预留：带令牌时只兑现自己的那张（幂等），不带令牌时沿用旧语义。
    this.releaseReservation(reservation)
    this.emit('tab')
  }

  updateTabMeta(tabId: number, url: string, title: string): void {
    const meta = this.tabs.get(tabId)
    if (meta === undefined) return
    meta.url = url
    meta.title = title
    this.emit('tab-meta')
  }

  /** Remove a tab; returns the ids left (the active tab shifts). */
  removeTab(tabId: number): void {
    this.tabs.delete(tabId)
    this.pendingIds.delete(tabId)
    if (this.activeTabId === tabId) {
      this.activeTabId = [...this.tabs.keys()].at(-1)
    }
    this.pumpWaiters()
    this.emit('tab')
  }

  has(tabId: number): boolean {
    return this.tabs.has(tabId)
  }

  get(tabId: number): PoolTabMeta | undefined {
    return this.tabs.get(tabId)
  }

  /** All tabs (insertion order); `active` mirrors the pool's active tab. */
  list(): PoolTabView[] {
    return [...this.tabs.values()].map((m) => ({
      id: m.tabId,
      url: m.url,
      title: m.title,
      loading: false,
      active: m.tabId === this.activeTabId,
    }))
  }

  /** Ledger: tab list + active tab (persisted; views recreated on demand). */
  snapshotLedger(): TabLedger {
    return {
      version: 1,
      activeTabId: this.activeTabId,
      tabs: [...this.tabs.values()].map((m) => ({ tabId: m.tabId, url: m.url, title: m.title })),
      savedAt: Date.now(),
    }
  }

  restoreLedger(ledger: TabLedger): void {
    if (ledger === undefined || !Array.isArray(ledger.tabs)) return
    for (const item of ledger.tabs) {
      if (typeof item.tabId !== 'number' || this.tabs.has(item.tabId)) continue
      this.tabs.set(item.tabId, { tabId: item.tabId, url: item.url ?? '', title: item.title ?? '' })
      this.pendingIds.add(item.tabId)
    }
    if (ledger.activeTabId !== undefined && this.tabs.has(ledger.activeTabId)) {
      this.activeTabId = ledger.activeTabId
    } else {
      this.activeTabId = [...this.tabs.keys()].at(-1)
    }
    this.emit('tab')
  }

  clear(): void {
    // 池子没了 = 没人"持有"这个浏览器了（2026-09-16 P1）。
    //
    // 关闭浏览器（用户路径）、窗口被销毁、切换会话/分区、清数据都会走到这里；
    // 与 2026-09-15 P1-1 修的会话切换路径同一口径：结束"用户持有"状态只走
    // setUserControl（会发 release，蒙版/胶囊/客户端提示据此复位）。不复位的话
    // `controlled` 会永久为 true：蒙版不再上锁、用户闸对 agent 变成静默超时，
    // 而唯一的「交给 AI」按钮随窗口一起没了。
    this.setUserControl(false)
    this.tabs.clear()
    this.pendingIds.clear()
    this.activeTabId = undefined
    this.reserved = 0
    this.outstandingReservations.clear()
    for (const ticket of this.tabWaiters) {
      ticket.settled = true
      if (ticket.timer !== undefined) clearTimeout(ticket.timer)
      ticket.reject(browserError('interrupted', 'browser: tab pool cleared'))
    }
    this.tabWaiters = []
    this.emit('tab')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clear()
    this.listeners.clear()
  }
}

/** Serializable tab ledger (persisted with the browser store). */
export interface TabLedger {
  version: 1
  activeTabId: number | undefined
  tabs: Array<{ tabId: number; url: string; title: string }>
  savedAt: number
}
