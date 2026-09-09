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

import { browserError } from './errors.ts'
import type { BrowserError } from './errors.ts'

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
}

export const POOL_DEFAULTS = {
  maxTabs: 16,
  waitTimeoutMs: 60_000,
} as const

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

  async run(work: () => Promise<void>, gate: () => boolean, signal?: AbortSignal): Promise<void> {
    const prev = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    try {
      // Waiting for the previous operation must be cancellable too: a wedged
      // predecessor used to block every later call forever (2026-09-08 P0-4).
      await raceAbort(prev, gate, signal)
      while (gate()) {
        if (signal !== undefined && signal.aborted) {
          throw browserError('window-controlled', 'browser: agent was stopped while you control the browser')
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
function raceAbort(promise: Promise<void>, gate: () => boolean, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return promise
  const abortError = (): BrowserError => gate()
    ? browserError('window-controlled', 'browser: agent was stopped while you control the browser')
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
  private readonly mutex = new PoolMutex()
  private windowControlled = false
  private activeTabId: number | undefined
  private readonly listeners = new Set<(event: string) => void>()
  private busyTool = ''
  private busyDepth = 0
  private reserved = 0
  /** Restored ledger ids whose view is not materialized yet. They appear in
   * `tabs` (the shell lists them) but must NOT consume a live-view slot until
   * they materialize (P2-26 quota semantics). */
  private readonly pendingIds = new Set<number>()
  private tabWaiters: QueueTicket[] = []
  disposed = false

  constructor(options: PoolOptions = {}) {
    this.options = { ...POOL_DEFAULTS, ...options }
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
      await this.mutex.run(async () => { result = await work() }, () => this.windowControlled, signal)
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
  async reserveTab(signal?: AbortSignal): Promise<void> {
    if (this.liveTabs() + this.reserved < this.options.maxTabs) {
      this.reserved++
      return
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
  }

  /** Fail-fast reservation (user paths): true when a slot is free. */
  tryReserveTab(): boolean {
    if (this.liveTabs() + this.reserved >= this.options.maxTabs) return false
    this.reserved++
    return true
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

  releaseReservation(): void {
    if (this.reserved > 0) this.reserved--
    this.pumpWaiters()
  }

  /** Register a created tab (consumes the reservation); a NEW tab becomes the
   * pool's active tab (browser convention; the shell/tools may switch). */
  registerTab(tabId: number, url: string, title: string): void {
    this.tabs.set(tabId, { tabId, url, title })
    // The view now exists: the restored entry consumes a live slot.
    this.pendingIds.delete(tabId)
    this.activeTabId = tabId
    this.releaseReservation()
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
    this.tabs.clear()
    this.pendingIds.clear()
    this.activeTabId = undefined
    this.reserved = 0
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
