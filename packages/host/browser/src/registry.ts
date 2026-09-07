/**
 * GroupRegistry (v4 §2/§4/§9/§10): owns session groups — metadata, the
 * per-group serially ordered mutex, the global user gate (window takeover),
 * quota queues (FIFO with timeouts and cancellation), lifecycle transitions
 * (active → archived → recycled) and the persist hook for the group ledger.
 * Physical tab views stay in the runtime; this module only tracks tab ids per
 * group plus their nav metadata (url/title) for the shell + persistence.
 *
 * Concurrency model (parallel driving):
 * - per-group serial queue (one session's tools execute in call order);
 * - user gate: while the user has taken over, every group's next operation
 *   waits at its queue head (in-flight operations complete, never interrupt);
 * - tab/group quota waits are FIFO and cancellable via AbortSignal.
 * @module @picoaide/dsh-browser
 */

import { browserError } from './errors.ts'
import type { BrowserErrorCode } from './errors.ts'
import type { GroupKey } from './resolve.ts'

/** Lifecycle states of a group. */
export type GroupStatus = 'active' | 'archived'

/** Per-tab registry metadata (shell rendering + persistence). */
export interface GroupTabMeta {
  readonly tabId: number
  url: string
  title: string
}

/** One session group. */
export interface Group {
  readonly key: GroupKey
  label: string
  status: GroupStatus
  readonly createdAt: number
  lastActiveAt: number
  /** Active tab id within this group (its own "current tab"). */
  activeTabId: number | undefined
  readonly tabs: Map<number, GroupTabMeta>
}

/** Snapshot shape for the shell + AI state API (v4 §5). */
export interface GroupView {
  readonly key: GroupKey
  readonly label: string
  readonly status: GroupStatus
  readonly busy: boolean
  readonly busyTool: string
  readonly pending: boolean
  readonly foreground: boolean
  readonly tabs: Array<{ id: number; url: string; title: string; loading: boolean; active: boolean }>
}

export interface RegistryOptions {
  maxGroups?: number
  maxTabsPerGroup?: number
  maxTabsTotal?: number
  waitTimeoutMs?: number
  /** Archived-group retention before recycling (ms). */
  archiveRetentionMs?: number
}

/** Defaults align with the design quota table (v4 §9). */
export const REGISTRY_DEFAULTS = {
  maxGroups: 4,
  maxTabsPerGroup: 8,
  maxTabsTotal: 16,
  waitTimeoutMs: 60_000,
  archiveRetentionMs: 24 * 60 * 60 * 1000,
} as const

/** One wait ticket in a FIFO quota queue (cancellable). */
interface QueueTicket<T> {
  resolve: (value: T) => void
  reject: (error: unknown) => void
  signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
  groupKey: GroupKey | undefined
  settled: boolean
  timer?: ReturnType<typeof setTimeout>
}

/** Promise-queue mutex with the global-user-gate hook. */
class GroupMutex {
  private tail: Promise<void> = Promise.resolve()

  /** Run `work` serially within the group; waits while the user gate is on. */
  async run(work: () => Promise<void>, gate: () => boolean, signal?: AbortSignal): Promise<void> {
    const prev = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await prev
    try {
      while (gate()) {
        if (signal !== undefined && signal.aborted) throw browserError('window-controlled', 'browser: agent was stopped while you control the browser')
        await sleep(120)
      }
      return await work()
    } finally {
      release()
    }
  }
}

/** Wait for release or abort (no busy-poll: resolves on aborted signal). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms))
    t.unref?.()
  })
}

/** GroupRegistry (see module doc). */
export class GroupRegistry {
  readonly options: Required<RegistryOptions>
  private readonly groups = new Map<GroupKey, Group>()
  private readonly mutexes = new Map<GroupKey, GroupMutex>()
  private readonly busy = new Map<GroupKey, { tool: string }>()
  private readonly pendingTabs = new Map<GroupKey, number>()
  private readonly groupWaiters: Array<QueueTicket<Group>> = []
  private readonly tabWaiters: Array<QueueTicket<void>> = []
  private windowControlled = false
  private foregroundKey: GroupKey | undefined
  private readonly listeners = new Set<(event: string) => void>()
  private readonly recycleTimers = new Map<GroupKey, ReturnType<typeof setTimeout>>()
  private disposed = false
  /** Persist hook (wired by the host): receives the serialized group ledger. */
  saveLedger: ((ledger: GroupLedger) => void) | undefined

  constructor(options: RegistryOptions = {}) {
    this.options = { ...REGISTRY_DEFAULTS, ...options }
  }

  /** Subscribe to state changes (shell push). Returns a disposer. */
  onChange(listener: (event: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(event: string): void {
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch { /* listener must never break the bus */ }
    }
  }

  /** The user gate state (whole-window takeover, v4 §4.4). */
  get controlled(): boolean {
    return this.windowControlled
  }

  setUserControl(active: boolean): void {
    if (this.windowControlled === active) return
    this.windowControlled = active
    this.emit(active ? 'takeover' : 'release')
  }

  /** The group currently shown in the window content area (user-chosen). */
  get foreground(): GroupKey | undefined {
    return this.foregroundKey
  }

  setForeground(key: GroupKey | undefined): void {
    if (this.foregroundKey === key) return
    this.foregroundKey = key
    this.emit('foreground')
  }

  /** List all groups (active first, then archived). */
  list(): Group[] {
    return [...this.groups.values()].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1
      return b.lastActiveAt - a.lastActiveAt
    })
  }

  get(key: GroupKey): Group | undefined {
    return this.groups.get(key)
  }

  /** Create (or return existing) group without quota wait. */
  ensure(key: GroupKey, label?: string): Group {
    let group = this.groups.get(key)
    if (group === undefined) {
      group = {
        key,
        label: label ?? `会话 ${key.slice(0, 6)}`,
        status: 'active',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        activeTabId: undefined,
        tabs: new Map(),
      }
      this.groups.set(key, group)
      this.mutexes.set(key, new GroupMutex())
      this.emit('group')
    } else if (label !== undefined && label.trim() !== '' && group.label.startsWith('会话 ')) {
      group.label = label.trim()
      this.emit('group')
    }
    this.touch(key)
    return group
  }

  /**
   * Acquire a group slot, waiting FIFO when `maxGroups` is reached.
   * Aborting the signal removes the ticket. The caller must `ensure` the
   * returned key only via this path (it serializes group creation).
   */
  async acquireGroup(key: GroupKey, label: string | undefined, signal?: AbortSignal): Promise<Group> {
    const existing = this.groups.get(key)
    if (existing !== undefined) {
      if (existing.status === 'archived') throw browserError('group-archived', 'browser: this session was archived — reopen the session to continue')
      this.touch(key)
      return existing
    }
    const active = this.countActive()
    if (active < this.options.maxGroups) {
      return this.ensure(key, label)
    }
    // FIFO wait under the quota cap.
    return await new Promise<Group>((resolve, reject) => {
      const ticket: QueueTicket<Group> = {
        resolve, reject, signal, onAbort: undefined, groupKey: key, settled: false,
      }
      if (signal !== undefined && signal.aborted) {
        reject(browserError('group-quota', 'browser: cancelled while waiting for a group slot'))
        return
      }
      ticket.onAbort = () => {
        if (ticket.settled) return
        ticket.settled = true
        const idx = this.groupWaiters.indexOf(ticket)
        if (idx >= 0) this.groupWaiters.splice(idx, 1)
        reject(browserError('group-quota', 'browser: cancelled while waiting for a group slot'))
      }
      if (signal !== undefined) signal.addEventListener('abort', ticket.onAbort, { once: true })
      const timer = setTimeout(() => {
        if (ticket.settled) return
        ticket.settled = true
        const idx = this.groupWaiters.indexOf(ticket)
        if (idx >= 0) this.groupWaiters.splice(idx, 1)
        if (ticket.onAbort !== undefined && ticket.signal !== undefined) ticket.signal.removeEventListener('abort', ticket.onAbort)
        reject(browserError('group-quota', `browser: timed out waiting for a group slot (${Math.round(this.options.waitTimeoutMs / 1000)}s)`))
      }, this.options.waitTimeoutMs)
      timer.unref?.()
      ticket.timer = timer
      this.groupWaiters.push(ticket)
      this.pumpGroupWaiters()
    })
  }

  private pumpGroupWaiters(): void {
    while (this.countActive() < this.options.maxGroups && this.groupWaiters.length > 0) {
      const ticket = this.groupWaiters.shift()!
      ticket.settled = true
      if (ticket.timer !== undefined) clearTimeout(ticket.timer)
      if (ticket.onAbort !== undefined && ticket.signal !== undefined) {
        ticket.signal.removeEventListener('abort', ticket.onAbort)
      }
      const group = this.ensure(ticket.groupKey!)
      ticket.resolve(group)
    }
  }

  private countActive(): number {
    let n = 0
    for (const group of this.groups.values()) if (group.status === 'active') n++
    return n
  }

  /**
   * Reserve a tab slot in a group (per-group cap + global cap). Returns a
   * token's group bookkeeping slot: caller must `registerTab` afterwards;
   * on failure call `releaseTabReservation`.
   */
  async reserveTab(key: GroupKey, signal?: AbortSignal): Promise<void> {
    const group = this.groups.get(key)
    if (group === undefined || group.status !== 'active') {
      throw browserError('group-not-found', 'browser: this session has no browser group')
    }
    if (this.tabCount() < this.options.maxTabsTotal && (group.tabs.size + (this.pendingTabs.get(key) ?? 0)) < this.options.maxTabsPerGroup) {
      this.pendingTabs.set(key, (this.pendingTabs.get(key) ?? 0) + 1)
      return
    }
    await new Promise<void>((resolve, reject) => {
      const ticket: QueueTicket<void> = {
        resolve: () => {
          this.pendingTabs.set(key, (this.pendingTabs.get(key) ?? 0) + 1)
          resolve()
        },
        reject, signal, onAbort: undefined, groupKey: key, settled: false,
      }
      if (signal !== undefined && signal.aborted) {
        reject(browserError('group-quota', 'browser: cancelled while waiting for a tab slot'))
        return
      }
      ticket.onAbort = () => {
        if (ticket.settled) return
        ticket.settled = true
        const idx = this.tabWaiters.indexOf(ticket)
        if (idx >= 0) this.tabWaiters.splice(idx, 1)
        reject(browserError('group-quota', 'browser: cancelled while waiting for a tab slot'))
      }
      if (signal !== undefined) signal.addEventListener('abort', ticket.onAbort, { once: true })
      const timer = setTimeout(() => {
        if (ticket.settled) return
        ticket.settled = true
        const idx = this.tabWaiters.indexOf(ticket)
        if (idx >= 0) this.tabWaiters.splice(idx, 1)
        reject(browserError('group-quota', `browser: timed out waiting for a tab slot (${Math.round(this.options.waitTimeoutMs / 1000)}s)`))
      }, this.options.waitTimeoutMs)
      timer.unref?.()
      ticket.timer = timer
      this.tabWaiters.push(ticket)
      this.pumpTabWaiters()
    })
  }

  private pumpTabWaiters(): void {
    if (this.tabCount() >= this.options.maxTabsTotal) return
    for (let i = 0; i < this.tabWaiters.length; i++) {
      const ticket = this.tabWaiters[i]!
      const group = this.groups.get(ticket.groupKey!)
      if (group === undefined) {
        ticket.settled = true
        this.tabWaiters.splice(i, 1)
        i--
        if (ticket.timer !== undefined) clearTimeout(ticket.timer)
        ticket.reject(browserError('group-not-found', 'browser: group disappeared while waiting'))
        continue
      }
      if ((group.tabs.size + (this.pendingTabs.get(group.key) ?? 0)) < this.options.maxTabsPerGroup) {
        ticket.settled = true
        this.tabWaiters.splice(i, 1)
        i--
        if (ticket.timer !== undefined) clearTimeout(ticket.timer)
        if (ticket.onAbort !== undefined && ticket.signal !== undefined) ticket.signal.removeEventListener('abort', ticket.onAbort)
        ticket.resolve()
      }
    }
  }

  /** Drop a tab reservation (creation failed). */
  releaseTabReservation(key: GroupKey): void {
    const pending = this.pendingTabs.get(key)
    if (pending !== undefined && pending > 1) this.pendingTabs.set(key, pending - 1)
    else this.pendingTabs.delete(key)
    this.pumpTabWaiters()
  }

  /** Fail-fast reservation (user/shell paths): returns true when a slot was
   * taken, false when quotas are exhausted (never waits). */
  tryReserveTab(key: GroupKey): boolean {
    const group = this.groups.get(key)
    if (group === undefined || group.status !== 'active') return false
    if (this.tabCount() >= this.options.maxTabsTotal) return false
    if ((group.tabs.size + (this.pendingTabs.get(key) ?? 0)) >= this.options.maxTabsPerGroup) return false
    this.pendingTabs.set(key, (this.pendingTabs.get(key) ?? 0) + 1)
    return true
  }

  private tabCount(): number {
    let n = 0
    for (const group of this.groups.values()) n += group.tabs.size
    return n
  }

  /** Register a created tab in a group (consumes the reservation). */
  registerTab(key: GroupKey, tabId: number, url: string, title: string): void {
    const group = this.groups.get(key)
    if (group === undefined) throw browserError('group-not-found', 'browser: group vanished before tab creation')
    group.tabs.set(tabId, { tabId, url, title })
    if (group.activeTabId === undefined) group.activeTabId = tabId
    this.releaseTabReservation(key)
    this.touch(key)
    this.emit('tab')
  }

  /** Update nav metadata for a tab (runtime event: did-navigate etc.). */
  updateTabMeta(tabId: number, url: string, title: string): void {
    for (const group of this.groups.values()) {
      const meta = group.tabs.get(tabId)
      if (meta !== undefined) {
        meta.url = url
        meta.title = title
        this.emit('tab-meta')
        return
      }
    }
  }

  /** Remove a tab; the group is deleted when its last tab closes (v4 §17-8). */
  removeTab(tabId: number): GroupKey | undefined {
    for (const [key, group] of this.groups) {
      if (group.tabs.has(tabId)) {
        group.tabs.delete(tabId)
        if (group.activeTabId === tabId) {
          group.activeTabId = [...group.tabs.keys()].at(-1)
        }
        this.touch(key)
        if (group.tabs.size === 0 && group.status === 'active') {
          this.pumpTabWaiters()
          this.pumpGroupWaiters()
          this.closeGroup(key)
          return key
        }
        this.pumpTabWaiters()
        this.emit('tab')
        return key
      }
    }
    return undefined
  }

  setActiveTab(key: GroupKey, tabId: number): void {
    const group = this.groups.get(key)
    if (group === undefined || !group.tabs.has(tabId)) {
      throw browserError('foreign-tab', `browser: tab ${tabId} does not belong to this session`)
    }
    group.activeTabId = tabId
    this.touch(key)
    this.emit('tab')
  }

  /** Assert tab ownership (`foreign-tab` when not). Returns the owner group. */
  assertOwner(key: GroupKey, tabId: number): Group {
    const group = this.groups.get(key)
    if (group === undefined) {
      throw browserError('group-not-found', 'browser: this session has no browser group')
    }
    if (group.status === 'archived') {
      throw browserError('group-archived', 'browser: this session was archived — reopen the session to continue')
    }
    if (!group.tabs.has(tabId)) {
      throw browserError('foreign-tab', `browser: tab ${tabId} does not belong to this session`)
    }
    return group
  }

  /** Default tab id for a group (its active tab); undefined when empty. */
  activeTabOf(key: GroupKey): number | undefined {
    return this.groups.get(key)?.activeTabId
  }

  /** Helpers for shell permission checks: whether a tab belongs to a group. */
  tabOwner(tabId: number): GroupKey | undefined {
    for (const [key, group] of this.groups) {
      if (group.tabs.has(tabId)) return key
    }
    return undefined
  }

  /**
   * Run `work` under the group's serial mutex with the user-gate check.
   * Marks the group busy (`busyTool`) while running/queued.
   */
  async withGroup(key: GroupKey, tool: string, work: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    const group = this.groups.get(key)
    if (group === undefined) throw browserError('group-not-found', 'browser: this session has no browser group')
    if (group.status === 'archived') throw browserError('group-archived', 'browser: this session was archived — reopen the session to continue')
    const mutex = this.mutexes.get(key) ?? (() => { const m = new GroupMutex(); this.mutexes.set(key, m); return m })()
    this.busy.set(key, { tool })
    this.emit('busy')
    try {
      await mutex.run(work, () => this.windowControlled, signal)
    } finally {
      if (this.busy.delete(key)) this.emit('busy')
    }
  }

  /** Whether a group currently has an operation in flight/queued. */
  isBusy(key: GroupKey): boolean {
    return this.busy.has(key)
  }

  busyToolOf(key: GroupKey): string {
    return this.busy.get(key)?.tool ?? ''
  }

  /** Archive a group (session ended): destroy tabs later by the runtime via
   * the returned tab id list; view resources are the runtime's to drop. */
  archive(key: GroupKey): number[] {
    const group = this.groups.get(key)
    if (group === undefined) return []
    if (group.status === 'archived') return [...group.tabs.keys()]
    group.status = 'archived'
    this.touch(key)
    this.scheduleRecycle(key)
    this.pumpGroupWaiters()
    this.emit('group')
    return [...group.tabs.keys()]
  }

  /** Reactivate an archived group (session reopened). */
  reactivate(key: GroupKey): boolean {
    const group = this.groups.get(key)
    if (group === undefined) return false
    if (group.status === 'archived') {
      group.status = 'active'
      const timer = this.recycleTimers.get(key)
      if (timer !== undefined) clearTimeout(timer)
      this.recycleTimers.delete(key)
      this.emit('group')
    }
    return true
  }

  /** Manually close a group (user action / archive cap): drops metadata and
   * returns the tab ids so the runtime destroys the views. */
  closeGroup(key: GroupKey): number[] {
    const group = this.groups.get(key)
    if (group === undefined) return []
    const tabs = [...group.tabs.keys()]
    const timer = this.recycleTimers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    this.recycleTimers.delete(key)
    this.groups.delete(key)
    this.mutexes.delete(key)
    this.busy.delete(key)
    if (this.foregroundKey === key) this.foregroundKey = undefined
    this.pumpGroupWaiters()
    this.pumpTabWaiters()
    this.emit('group')
    return tabs
  }

  /** Touch a group (activity timestamp) + recycle pending when archived. */
  touch(key: GroupKey): void {
    const group = this.groups.get(key)
    if (group === undefined) return
    group.lastActiveAt = Date.now()
    if (group.status === 'archived') this.scheduleRecycle(key)
  }

  private scheduleRecycle(key: GroupKey): void {
    const group = this.groups.get(key)
    if (group === undefined || group.status !== 'archived') return
    const timer = this.recycleTimers.get(key)
    if (timer !== undefined) return
    const t = setTimeout(() => {
      this.recycleTimers.delete(key)
      const g = this.groups.get(key)
      if (g !== undefined && g.status === 'archived') {
        // Keep metadata (URLs) 24h per design; drop at retention end.
        this.closeGroup(key)
        this.emit('recycle')
      }
    }, this.options.archiveRetentionMs)
    t.unref?.()
    this.recycleTimers.set(key, t)
  }

  /** Force-recycle an archived group (timer fired). */
  recycleExpired(key: GroupKey): void {
    this.closeGroup(key)
  }

  /** Ledger serialization (persist hook, v4 §17-1). */
  snapshotLedger(): GroupLedger {
    return {
      version: 1,
      groups: [...this.groups.values()].map((g) => ({
        key: g.key,
        label: g.label,
        status: g.status,
        createdAt: g.createdAt,
        lastActiveAt: g.lastActiveAt,
        activeTabId: g.activeTabId,
        tabs: [...g.tabs.values()].map((t) => ({ tabId: t.tabId, url: t.url, title: t.title })),
      })),
      savedAt: Date.now(),
    }
  }

  /** Restore a ledger (app restart): archived groups reappear; active groups
   * become archived-until-reopened (v4 §10). Returns tab ids to recreate (empty
   * for archives — views are dropped at archive time; the runtime recreates
   * only for active groups on demand via open). */
  restoreLedger(ledger: GroupLedger): void {
    if (ledger === undefined || !Array.isArray(ledger.groups)) return
    for (const item of ledger.groups) {
      if (typeof item.key !== 'string') continue
      const group = this.groups.get(item.key)
      if (group !== undefined) continue
      const tabs = new Map<number, GroupTabMeta>()
      for (const t of item.tabs ?? []) tabs.set(t.tabId, { tabId: t.tabId, url: t.url ?? '', title: t.title ?? '' })
      const g: Group = {
        key: item.key,
        label: item.label ?? `会话 ${item.key.slice(0, 6)}`,
        status: 'archived',
        createdAt: item.createdAt ?? Date.now(),
        lastActiveAt: item.lastActiveAt ?? Date.now(),
        activeTabId: item.activeTabId,
        tabs,
      }
      this.groups.set(g.key, g)
      this.mutexes.set(g.key, new GroupMutex())
      if (g.status === 'archived') this.scheduleRecycle(g.key)
    }
    this.emit('group')
  }

  /** Dispose timers + waiters (plugin teardown). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.recycleTimers.values()) clearTimeout(timer)
    this.recycleTimers.clear()
    for (const ticket of [...this.groupWaiters, ...this.tabWaiters]) {
      ticket.settled = true
      ticket.reject(browserError('interrupted', 'browser: registry disposed'))
    }
    this.groupWaiters.length = 0
    this.tabWaiters.length = 0
    this.listeners.clear()
  }
}

/** Serializable group ledger (persisted with the browser store). */
export interface GroupLedger {
  version: 1
  groups: Array<{
    key: GroupKey
    label: string
    status: GroupStatus
    createdAt: number
    lastActiveAt: number
    activeTabId: number | undefined
    tabs: Array<{ tabId: number; url: string; title: string }>
  }>
  savedAt: number
}

export type { BrowserErrorCode }

/** Helper: is a group archived? (used by runtime/tools). */
export function isArchived(group: Group): boolean {
  return group.status === 'archived'
}
