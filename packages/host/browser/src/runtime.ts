/**
 * BrowserRuntime v4: the embedded agent-driven browser service. Owns the tab
 * pool (one WebContentsView per tab), the CDP sessions, per-session groups &
 * serial mutexes, the global user gate, navigation, interaction primitives,
 * guards, the audit op log and the local stores (bookmarks/history/downloads/
 * group ledger). Electron surfaces flow through the injected adapter; the
 * whole service is unit-testable headlessly.
 *
 * Group model (v4 §2-§6): tabs belong to a session group; a tool call always
 * resolves to the calling session's group; cross-group references are
 * rejected (foreign-tab); groups drive in parallel (per-group serial mutex)
 * until the user takes over the whole window (global gate).
 * @module @picoaide/dsh-browser
 */

import { CdpSession } from './cdp.ts'
import { BROWSER_PARTITION, BROWSER_SHELL_TOOLBAR_HEIGHT, type ElectronAdapter, type NativeBrowserWindow, type NativeSession, type NativeView } from './electron-adapter.ts'
import { BrowserGuard, installPermissionGuard } from './guard.ts'
import { extractSnapshot, extractText } from './snapshot.ts'
import { captureScreenshot } from './shots.ts'
import { GroupRegistry, type Group, type GroupView } from './registry.ts'
import { SessionLineage, type GroupKey } from './resolve.ts'
import { BrowserStore, type DownloadEntry, type HistoryEntry, type RecordActor } from './store.ts'
import { validateEvalExpression, wrapEvalExpression, serializeEvalResult } from './eval-policy.ts'
import { browserError, BrowserError } from './errors.ts'
import type {
  BrowserOpLogEntry,
  BrowserSnapshotElement,
  BrowserTabState,
  BrowserToolOptions,
  BrowserWaitUntil,
  BrowserWindowState,
  CredentialResolver,
} from './types.ts'

/** Default cooperative tool-call budget (ms). */
const DEFAULT_TIMEOUT_MS = 30_000
/** Default cap on waiting for Electron's loadURL promise (ms). */
const DEFAULT_LOAD_TIMEOUT_MS = 20_000
/** Maximum simultaneous tabs per group. */
const DEFAULT_MAX_TABS = 8
/** Op-log ring size. */
const OP_LOG_LIMIT = 200

interface BrowserTab {
  readonly id: number
  readonly groupKey: GroupKey
  readonly view: NativeView
  readonly cdp: CdpSession
  url: string
  title: string
  loading: boolean
  /** Per-tab guard disposers (released on close/failure). */
  disposers: Array<() => void>
}

/** One evaluation result from the page (CDP value). */
interface EvalResult {
  result?: { value?: unknown; type?: string }
  exceptionDetails?: unknown
}

/** Wait-for condition spec (v4 §7.1 wait_for). */
export interface WaitForOptions {
  condition: 'element-present' | 'element-visible' | 'text-appear' | 'url-change' | 'network-idle' | 'settled'
  selector?: string | undefined
  text?: string | undefined
  timeoutMs?: number | undefined
}

/** Runtime dependencies wired by the plugin (registry/store/lineage). */
export interface RuntimeDeps {
  registry?: GroupRegistry
  lineage?: SessionLineage
  store?: BrowserStore
  /** Greeting for the AI state: current user (audit + store tagging). */
  currentUsername?: () => string | null
}

/** Shell/panel state projection (v4 §5, GET /api/pico/browser/state). */
export interface BrowserShellState {
  groups: GroupView[]
  window: BrowserWindowState
  controlled: boolean
  foreground: GroupKey | undefined
}

/** State-change events emitted by the runtime (SSE stream). */
export type BrowserStreamEvent = 'state' | 'group' | 'tab' | 'tab-meta' | 'busy' | 'foreground' | 'takeover' | 'release' | 'ops'

/**
 * The embedded browser service (v4). Constructed by the plugin with the real
 * adapter; tests inject a mock adapter plus optional deps.
 */
export class BrowserRuntime {
  private readonly tabs = new Map<number, BrowserTab>()
  private nextTabId = 1
  private readonly ops: BrowserOpLogEntry[] = []
  private opSeq = 0
  private window: NativeBrowserWindow | null = null
  private readonly guard: BrowserGuard
  private windowResizeDisposer: (() => void) | null = null
  private windowClosedDisposer: (() => void) | null = null
  private disposed = false
  /** Partition name used for newly created tab views (per-user). */
  private partition: string
  private readonly listeners = new Set<(event: BrowserStreamEvent) => void>()
  private shellOrigin: string | undefined
  readonly registry: GroupRegistry
  readonly lineage: SessionLineage
  readonly store: BrowserStore

  constructor(
    private readonly adapter: ElectronAdapter,
    options: BrowserToolOptions = {},
    private readonly credentials?: CredentialResolver,
    partition?: string,
    deps: RuntimeDeps = {},
  ) {
    this.options = {
      maxTabs: options.maxTabs ?? DEFAULT_MAX_TABS,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      loadTimeoutMs: options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
      evalEnabled: options.evalEnabled ?? true,
      snapshotLimit: options.snapshotLimit ?? 200,
      textLimit: options.textLimit ?? 32 * 1024,
      screenshotMaxWidth: options.screenshotMaxWidth ?? 1280,
      screenshotQuality: options.screenshotQuality ?? 70,
      downloadDir: options.downloadDir ?? '.picoaide-downloads',
    }
    this.guard = new BrowserGuard(adapter)
    this.partition = partition ?? BROWSER_PARTITION
    this.registry = deps.registry ?? buildDefaultRegistry(options.maxTabs)
    this.lineage = deps.lineage ?? new SessionLineage()
    if (deps.store !== undefined) this.store = deps.store
    else this.store = new BrowserStore({ dir: this.partition.replace(/[^a-zA-Z0-9_-]/g, '_') + '-store' })
    this.currentUsername = deps.currentUsername ?? (() => null)
    this.registry.onChange((event) => this.emitEvents(event))
  }

  private emitEvents(event: string): void {
    const mapped = (['group', 'tab', 'tab-meta', 'busy', 'foreground', 'takeover', 'release'] as const).includes(event as never)
      ? event as BrowserStreamEvent
      : 'state'
    this.emitAll(mapped)
  }

  private emitAll(event: BrowserStreamEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch { /* bus must never break */ }
    }
  }

  /** Subscribe to runtime state changes (shell push). */
  onState(event: BrowserStreamEvent, listener: () => void): () => void {
    const wrapper = (): void => { if (event === 'state') listener(); else listener() }
    this.listeners.add(wrapper)
    return () => { this.listeners.delete(wrapper) }
  }

  /** Subscribe to any event (SSE stream relay). */
  onAny(listener: (event: BrowserStreamEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private readonly currentUsername: () => string | null

  readonly options: Required<BrowserToolOptions>

  // ------------------------------------------------------------- accessors

  /** Current browser window state (created + visible). */
  get windowState(): BrowserWindowState {
    return {
      created: this.window !== null && !this.window.isDestroyed(),
      visible: this.window !== null && !this.window.isDestroyed() && this.window.isVisible(),
    }
  }

  /** Recent audit op log (newest first). */
  get opLog(): readonly BrowserOpLogEntry[] {
    return [...this.ops].reverse()
  }

  /** The user-gate state (whole-window takeover). */
  get controlled(): boolean {
    return this.registry.controlled
  }

  get foreground(): GroupKey | undefined {
    return this.registry.foreground
  }

  setForeground(key: GroupKey | undefined): void {
    this.registry.setForeground(key)
  }

  /** Current user id for entry tagging. */
  private actor(userActor = false): RecordActor {
    return userActor ? 'user' : 'ai'
  }

  // ----------------------------------------------------------- group helpers

  /** Resolve the group key for an agent call (subagent lineage aware). */
  groupKeyFor(agentId: string | undefined): GroupKey | undefined {
    if (agentId === undefined || agentId === '') return undefined
    return this.lineage.resolve(agentId)
  }

  /** Ensure the group backing this agent exists (no quota wait). */
  ensureGroup(agentId: string | undefined, label?: string): GroupKey {
    const key = this.groupKeyFor(agentId)
    if (key === undefined) throw browserError('no-session', 'browser: tool call has no agent identity')
    this.registry.ensure(key, label)
    return key
  }

  /** Public: resolve tab within a group, asserting ownership. */
  resolveTab(groupKey: GroupKey, tabId: number | undefined): number {
    if (tabId !== undefined) {
      this.registry.assertOwner(groupKey, tabId)
      return tabId
    }
    const active = this.registry.activeTabOf(groupKey)
    if (active === undefined) {
      throw browserError('group-not-found', 'browser: this session has no open tab — call browser_open first')
    }
    return active
  }

  /** List this group's tabs only (isolation, v4 §6). */
  listTabs(groupKey: GroupKey): BrowserTabState[] {
    const group = this.registry.get(groupKey)
    const activeId = group?.activeTabId
    return [...this.tabs.values()]
      .filter((tab) => tab.groupKey === groupKey)
      .map((tab) => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        loading: tab.loading,
        visible: tab.id === activeId,
      }))
  }

  /** State projection for the shell (all groups, filtered by nothing: the
   * shell is the user's overview surface). */
  shellState(): BrowserShellState {
    const now = Date.now()
    const groups: GroupView[] = this.registry.list().map((group) => {
      const activeId = group.activeTabId
      const tabs = [...this.tabs.values()]
        .filter((t) => t.groupKey === group.key)
        .map((t) => ({ id: t.id, url: t.url, title: t.title, loading: t.loading, active: t.id === activeId }))
      return {
        key: group.key,
        label: group.label,
        status: group.status,
        busy: this.registry.isBusy(group.key),
        busyTool: this.registry.busyToolOf(group.key),
        pending: false,
        foreground: this.registry.foreground === group.key,
        tabs,
      }
    })
    // Archived groups at the tail (registry.list already sorts active first).
    void now
    return {
      groups,
      window: this.windowState,
      controlled: this.registry.controlled,
      foreground: this.registry.foreground,
    }
  }

  /** Groups owned by one session (checks + restore helpers). */
  groupOf(key: GroupKey): Group | undefined {
    return this.registry.get(key)
  }

  /** Swap the partition used by NEW tab views (user switch). Existing tabs
   * keep their partition; callers close all groups first. */
  setPartition(partition: string): void {
    this.partition = partition
  }

  /** Close every group (user switch / shell 清除). */
  async closeAllGroups(): Promise<void> {
    for (const group of this.registry.list()) {
      const tabIds = this.registry.closeGroup(group.key)
      for (const id of tabIds) this.destroyTab(id)
    }
    this.relayout()
    this.record('browser_close', 0, 'close browser (all groups)')
  }

  // ------------------------------------------------------------ tab creation

  /**
   * Open a tab for a group (quota-aware). The first tab of a group makes the
   * group's active tab. `user=true` (shell) binds to the foreground group and
   * bypasses the agent mutex entirely.
   */
  async openFor(groupKey: GroupKey, url: string | undefined, signal?: AbortSignal, user = false): Promise<BrowserTabState> {
    if (this.disposed) throw new Error('browser: runtime disposed')
    const group = this.registry.get(groupKey)
    if (group === undefined) {
      if (user) this.registry.ensure(groupKey, undefined)
      else await this.registry.acquireGroup(groupKey, undefined, signal)
    } else if (group.status === 'archived' && !user) {
      throw browserError('group-archived', 'browser: this session was archived — reopen the session to continue')
    }
    // Tab slot (fail-fast for user paths; serial wait for agent paths).
    if (user) {
      if (!this.registry.tryReserveTab(groupKey)) {
        throw browserError('group-quota', 'browser: tab limit reached — close a tab first')
      }
      return await this.createTab(groupKey, url, signal)
    }
    await this.registry.reserveTab(groupKey, signal) // waits FIFO (60s budget) + cancellable
    try {
      return await this.createTab(groupKey, url, signal)
    } catch (error) {
      this.registry.releaseTabReservation(groupKey)
      throw error
    }
  }

  /** User path: open in the foreground group (or create the fallback boundless group). */
  async userOpen(url: string | undefined, signal?: AbortSignal): Promise<BrowserTabState> {
    const key = this.registry.foreground ?? this.mostRecentActiveKey()
    if (key === undefined) {
      const fallback = this.registry.ensure(`user-${this.currentUsername() ?? 'anonymous'}`, '我的')
      this.registry.setForeground(fallback.key)
      return await this.openFor(fallback.key, url, signal, true)
    }
    return await this.openFor(key, url, signal, true)
  }

  private mostRecentActiveKey(): GroupKey | undefined {
    const groups = this.registry.list()
    return groups.find((g) => g.status === 'active')?.key
  }

  private async createTab(groupKey: GroupKey, url: string | undefined, signal?: AbortSignal): Promise<BrowserTabState> {
    const id = this.nextTabId++
    const view = this.adapter.createView(this.partition)
    const cdp = new CdpSession(view.webContents.cdp)
    try {
      await cdp.attach()
    } catch (cause) {
      try { view.destroy() } catch { /* teardown never throws */ }
      throw cause
    }
    const tab: BrowserTab = { id, groupKey, view, cdp, url: '', title: '', loading: false, disposers: [] }
    this.tabs.set(id, tab)
    this.registry.registerTab(groupKey, id, '', '')

    try {
      const win = await this.ensureWindow(this.shellOrigin)
      if (this.registry.foreground === undefined) this.registry.setForeground(groupKey)
      const bounds = this.contentBounds()
      view.attach(win, bounds)
      // Visibility follows this group's foreground status + active tab.
      this.relayout()

      view.webContents.on('did-start-loading', () => {
        tab.loading = true
        this.registry.updateTabMeta(id, tab.url, tab.title)
        this.emitAll('tab')
      })
      view.webContents.on('did-stop-loading', () => {
        tab.loading = false
        this.updateTabState(tab)
      })
      view.webContents.on('did-navigate', () => this.updateTabState(tab))
      view.webContents.on('did-navigate-in-page', () => this.updateTabState(tab))
      view.webContents.on('page-title-updated', () => this.updateTabState(tab))
      const wc = view.webContents
      // Crash resilience: rebuild the tab at its URL.
      view.webContents.on('render-process-gone', () => {
        const target = tab.url
        this.record('browser_page_crash', id, 'page process gone — rebuilding')
        if (target !== '' && !wc.isDestroyed()) {
          void wc.loadURL(target).catch(() => {})
        }
      })

      const session = view.webContents.session
      tab.disposers.push(installPermissionGuard(session))
      tab.disposers.push(this.guard.installDownloadGuard(session, (summary) => {
        this.record('browser_download', id, summary)
      }, this.downloadRecorder(), groupKey, this.actor(), this.options.downloadDir))

      if (url !== undefined && url !== '') {
        await this.navigateInternal(id, url, 'domcontentloaded', 'ai')
      }
      this.updateTabState(tab)
      this.record('browser_open', id, url === undefined || url === '' ? 'new tab' : url)
      void signal
      return this.tabStateInternal(id)
    } catch (cause) {
      try {
        cdp.detach()
        view.destroy()
      } catch { /* teardown never throws */ }
      this.releaseTabDisposers(id)
      this.tabs.delete(id)
      this.registry.removeTab(id)
      throw cause
    }
  }

  /** Drop a group's tab reservation (creation failed). */
  releaseReservation(groupKey: GroupKey): void {
    this.registry.releaseTabReservation(groupKey)
  }

  // ---------------------------------------------------------------- window

  /** Set the loopback origin the shell pages are served from. */
  setShellOrigin(origin: string): void {
    this.shellOrigin = origin
  }

  private contentBounds(): { x: number; y: number; width: number; height: number } {
    const size = this.window?.getContentSize() ?? { width: 0, height: 0 }
    return {
      x: 0,
      y: BROWSER_SHELL_TOOLBAR_HEIGHT,
      width: Math.max(0, size.width),
      height: Math.max(0, size.height - BROWSER_SHELL_TOOLBAR_HEIGHT),
    }
  }

  /** Re-layout tab views: only the foreground group's active tab is visible. */
  private relayout(): void {
    const bounds = this.contentBounds()
    const foreground = this.registry.foreground
    let visibleTab: BrowserTab | undefined
    for (const tab of this.tabs.values()) {
      tab.view.setBounds(bounds)
      const active = foreground !== undefined && tab.groupKey === foreground && this.registry.activeTabOf(tab.groupKey) === tab.id
      tab.view.setVisible(active)
      if (active) visibleTab = tab
    }
    if (visibleTab !== undefined && this.window !== null && !this.window.isDestroyed()) {
      // Raise the visible tab above siblings (z-order follows attach order).
      visibleTab.view.moveToTop(this.window)
    }
  }

  async ensureWindow(origin?: string): Promise<NativeBrowserWindow> {
    if (this.window !== null && !this.window.isDestroyed()) {
      this.window.show()
      return this.window
    }
    const win = this.adapter.createBrowserWindow()
    this.window = win
    if (origin !== undefined) {
      void win.loadURL(`${origin}/browser-shell`).catch((cause: unknown) => {
        void win.loadURL(`${origin}/browser-shell`).catch(() => {
          console.error('[dsh-browser] shell page failed to load', cause)
        })
      })
    }
    this.windowResizeDisposer = win.onResize(() => { this.relayout() })
    this.windowClosedDisposer = win.onClosed(() => {
      for (const tab of this.tabs.values()) {
        try {
          tab.cdp.detach()
          tab.view.destroy()
        } catch {
          // Teardown must never throw.
        }
      }
      this.tabs.clear()
      this.windowResizeDisposer?.()
      this.windowClosedDisposer?.()
      this.windowResizeDisposer = null
      this.windowClosedDisposer = null
      this.window = null
    })
    return win
  }

  async showWindow(): Promise<void> {
    if (this.window === null || this.window.isDestroyed()) {
      await this.ensureWindow(this.shellOrigin)
      this.relayout()
      return
    }
    this.window.show()
    this.relayout()
  }

  hideWindow(): void {
    if (this.window === null || this.window.isDestroyed()) return
    this.window.hide()
  }

  // ------------------------------------------------------------------- state

  private record(tool: string, tab: number, summary: string, failed = false): void {
    const owner = this.tabs.get(tab)?.groupKey ?? ''
    this.ops.push({
      seq: ++this.opSeq,
      time: Date.now(),
      tool,
      tab,
      group: owner,
      actor: 'ai',
      summary: maskBrowserSummary(summary),
      failed,
    })
    if (this.ops.length > OP_LOG_LIMIT) this.ops.shift()
    this.emitAll('ops')
  }

  private tab(id: number): BrowserTab {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw browserError('not-found', `browser: unknown tab ${id}`)
    return tab
  }

  private tabStateInternal(id: number): BrowserTabState {
    const tab = this.tab(id)
    const active = this.registry.activeTabOf(tab.groupKey)
    return { id: tab.id, url: tab.url, title: tab.title, loading: tab.loading, visible: tab.id === active }
  }

  tabState(id: number): BrowserTabState {
    return this.tabStateInternal(id)
  }

  currentTabId(): number | undefined {
    return this.registry.foreground === undefined ? undefined : this.registry.activeTabOf(this.registry.foreground)
  }

  private updateTabState(tab: BrowserTab): void {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return
    tab.url = wc.getURL()
    tab.title = wc.getTitle() || tab.url || ''
    tab.loading = wc.isLoading()
    this.registry.updateTabMeta(tab.id, tab.url, tab.title)
    this.emitAll('tab-meta')
  }

  private releaseTabDisposers(id: number): void {
    const tab = this.tabs.get(id)
    if (tab === undefined) return
    for (const dispose of tab.disposers) {
      try { dispose() } catch { /* 守卫释放失败不阻断关闭 */ }
    }
    tab.disposers.length = 0
  }

  // ---------------------------------------------------------- agent ops (v4)

  /** Run one agent operation under the group mutex (user gate aware). */
  private async agentRun<T>(groupKey: GroupKey, tool: string, body: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let result!: T
    await this.registry.withGroup(groupKey, tool, async () => {
      result = await body()
    }, signal)
    return result
  }

  /** Cooperative wait for the page load milestone; never rejects on timeout. */
  private waitForLoad(wc: NativeView['webContents'], waitUntil: BrowserWaitUntil): (budgetMs: number) => Promise<void> {
    return async (budgetMs: number) => {
      const deadline = Date.now() + Math.max(0, budgetMs)
      await new Promise<void>((resolve) => {
        let settled = false
        const settle = (): void => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        }
        const cleanup = (): void => {
          wc.removeListener('dom-ready', onDomReady)
          wc.removeListener('did-finish-load', onFinish)
          clearTimeout(timer)
        }
        const onDomReady = (): void => {
          if (waitUntil === 'domcontentloaded') settle()
        }
        const onFinish = (): void => {
          if (waitUntil === 'load') settle()
          if (waitUntil === 'networkidle') {
            const idle = setTimeout(settle, 800)
            idle.unref?.()
          }
        }
        wc.on('dom-ready', onDomReady)
        wc.on('did-finish-load', onFinish)
        const timer = setTimeout(settle, Math.max(0, deadline - Date.now()))
        timer.unref?.()
        if (waitUntil !== 'domcontentloaded' && !wc.isLoading()) settle()
        if (waitUntil === 'domcontentloaded' && wc.isLoading() === false) settle()
      })
    }
  }

  // navigation family --------------------------------------------------------

  /** Navigate (group-aware; user path bypasses group mutex + gate). */
  async navigateFor(groupKey: GroupKey, tabId: number, url: string, waitUntil: BrowserWaitUntil = 'domcontentloaded', signal?: AbortSignal, user = false): Promise<void> {
    const resolved = user ? tabId : this.resolveTab(groupKey, tabId)
    const body = async (): Promise<void> => {
      await this.navigateInternal(resolved, url, waitUntil, user ? 'user' : 'ai')
    }
    if (user) return await body()
    return await this.agentRun(groupKey, 'browser_navigate', body, signal)
  }

  private async navigateInternal(id: number, url: string, waitUntil: BrowserWaitUntil, actor: RecordActor = 'ai'): Promise<void> {
    if (!this.guard.allowNavigation(url)) {
      throw browserError('navigation-blocked', `browser: navigation denied — ${url.slice(0, 200)}`)
    }
    const tab = this.tab(id)
    const wc = tab.view.webContents
    const started = Date.now()
    const outcome = await Promise.race([
      wc.loadURL(url).then(
        () => 'loaded' as const,
        () => 'failed' as const,
      ),
      sleep(this.options.loadTimeoutMs).then(() => 'pending' as const),
    ])
    if (outcome === 'failed') {
      if (!wc.isLoading() && wc.getURL() === '') {
        throw browserError('network', 'browser: navigation failed to load')
      }
    }
    if (waitUntil === 'networkidle') {
      const budget = Math.max(0, this.options.timeoutMs - (Date.now() - started))
      await sleep(Math.min(NETWORK_IDLE_TICK_MS, budget))
    }
    this.updateTabState(tab)
    this.record('browser_navigate', id, `navigate: ${url.slice(0, 200)}`)
    this.store.addHistory({
      time: Date.now(),
      url,
      title: tab.title,
      actor,
      group: tab.groupKey,
    } as Omit<HistoryEntry, 'seq'>)
  }

  async navigateUser(url: string): Promise<void> {
    const key = this.registry.foreground
    if (key === undefined) {
      await this.userOpen(url)
      return
    }
    const tab = this.registry.activeTabOf(key)
    if (tab === undefined) {
      await this.openFor(key, url, undefined, true)
      return
    }
    await this.navigateFor(key, tab, url, 'domcontentloaded', undefined, true)
  }

  async reloadFor(groupKey: GroupKey, tabId: number, signal?: AbortSignal, user = false): Promise<void> {
    const resolved = user ? tabId : this.resolveTab(groupKey, tabId)
    const body = async (): Promise<void> => {
      const tab = this.tab(resolved)
      const wc = tab.view.webContents
      if (wc.isDestroyed()) return
      wc.reload()
      await this.waitForLoad(wc, 'domcontentloaded')(this.options.timeoutMs)
      this.updateTabState(tab)
    }
    if (user) return await body()
    return await this.agentRun(groupKey, 'browser_reload', body, signal)
  }

  async goBackFor(groupKey: GroupKey, tabId: number, signal?: AbortSignal, user = false): Promise<void> {
    const resolved = user ? tabId : this.resolveTab(groupKey, tabId)
    const body = async (): Promise<void> => {
      const tab = this.tab(resolved)
      const wc = tab.view.webContents
      if (wc.isDestroyed()) return
      wc.goBack()
      await this.waitForLoad(wc, 'domcontentloaded')(this.options.timeoutMs)
      this.updateTabState(tab)
    }
    if (user) return await body()
    return await this.agentRun(groupKey, 'browser_go_back', body, signal)
  }

  async goForwardFor(groupKey: GroupKey, tabId: number, signal?: AbortSignal, user = false): Promise<void> {
    const resolved = user ? tabId : this.resolveTab(groupKey, tabId)
    const body = async (): Promise<void> => {
      const tab = this.tab(resolved)
      const wc = tab.view.webContents
      if (wc.isDestroyed()) return
      wc.goForward()
      await this.waitForLoad(wc, 'domcontentloaded')(this.options.timeoutMs)
      this.updateTabState(tab)
    }
    if (user) return await body()
    return await this.agentRun(groupKey, 'browser_go_forward', body, signal)
  }

  /** Switch the group's active tab (agent path). */
  async switchTabFor(groupKey: GroupKey, tabId: number, signal?: AbortSignal): Promise<void> {
    const body = async (): Promise<void> => {
      this.registry.setActiveTab(groupKey, tabId)
      this.relayout()
      this.record('browser_switch_tab', tabId, `switch to tab ${tabId}`)
    }
    return await this.agentRun(groupKey, 'browser_switch_tab', body, signal)
  }

  /** User path: switch foreground group (shell). */
  switchGroup(key: GroupKey): void {
    if (this.registry.get(key) === undefined) {
      throw browserError('group-not-found', 'browser: unknown session group')
    }
    this.registry.setForeground(key)
    this.relayout()
  }

  async closeTabFor(groupKey: GroupKey, tabId: number, signal?: AbortSignal, user = false): Promise<void> {
    const resolved = user ? tabId : this.resolveTab(groupKey, tabId)
    const body = async (): Promise<void> => {
      this.destroyTab(resolved)
      this.relayout()
      this.record('browser_close_tab', resolved, `close tab ${resolved}`)
    }
    if (user) return await body()
    return await this.agentRun(groupKey, 'browser_close_tab', body, signal)
  }

  private destroyView(id: number): void {
    const tab = this.tabs.get(id)
    if (tab === undefined) return
    try {
      tab.cdp.detach()
      tab.view.detach()
      tab.view.destroy()
    } catch { /* teardown never throws */ }
    this.releaseTabDisposers(id)
    this.tabs.delete(id)
  }

  private destroyTab(id: number): void {
    this.destroyView(id)
    this.registry.removeTab(id)
  }

  /** Close an entire group (user action / agent close_all group scope). */
  async closeGroup(key: GroupKey): Promise<void> {
    const tabIds = this.registry.closeGroup(key)
    for (const id of tabIds) this.destroyTab(id)
    this.relayout()
    this.record('browser_close_tab', 0, `close session group ${key.slice(0, 6)}`)
  }

  /** Archive a group (session ended): destroy views, keep ledger meta
   * (v4 §17-2: URLs stay in the registry for restoration). */
  async archiveFor(key: GroupKey): Promise<void> {
    const tabIds = this.registry.archive(key)
    for (const id of tabIds) this.destroyView(id)
    this.relayout()
    this.saveLedger()
  }

  /** Reactivate an archived group (session reopened). */
  async reactivateFor(key: GroupKey): Promise<void> {
    const group = this.registry.get(key)
    if (group === undefined) return
    this.registry.reactivate(key)
    // Recreate views from ledger meta.
    for (const meta of [...group.tabs.values()]) {
      const tabId = meta.tabId
      const view = this.adapter.createView(this.partition)
      const cdp = new CdpSession(view.webContents.cdp)
      await cdp.attach()
      const tab: BrowserTab = { id: tabId, groupKey: key, view, cdp, url: meta.url, title: meta.title, loading: false, disposers: [] }
      this.tabs.set(tabId, tab)
      const win = await this.ensureWindow(this.shellOrigin)
      view.attach(win, this.contentBounds())
      const session = view.webContents.session
      tab.disposers.push(installPermissionGuard(session))
      tab.disposers.push(this.guard.installDownloadGuard(session, (summary) => {
        this.record('browser_download', tabId, summary)
      }, this.downloadRecorder(), key, this.actor(), this.options.downloadDir))
      if (meta.url !== '') void view.webContents.loadURL(meta.url).catch(() => {})
    }
    this.registry.setForeground(key)
    this.relayout()
  }

  private saveLedger(): void {
    this.store.saveGroupLedger(this.registry.snapshotLedger())
  }

  /** Restore the persisted ledger at boot (archived groups reappear). */
  restoreLedger(): void {
    const ledger = this.store.getGroupLedger()
    if (ledger === undefined) return
    this.registry.restoreLedger(ledger)
  }

  // ----------------------------------------------------------- interactions

  async snapshotFor(groupKey: GroupKey, tabId: number, signal?: AbortSignal): Promise<BrowserSnapshotElement[]> {
    const resolved = this.resolveTab(groupKey, tabId)
    const elements = await this.agentRun(groupKey, 'browser_get_snapshot', async () => {
      const tab = this.tab(resolved)
      const result = await extractSnapshot((m, p) => tab.cdp.send(m, p), this.options.snapshotLimit)
      return result
    }, signal)
    this.record('browser_get_snapshot', resolved, `snapshot: ${elements.length} elements`)
    return elements
  }

  async textFor(groupKey: GroupKey, tabId: number, selector: string | undefined, signal?: AbortSignal): Promise<string> {
    const resolved = this.resolveTab(groupKey, tabId)
    const text = await this.agentRun(groupKey, 'browser_get_text', async () => {
      const tab = this.tab(resolved)
      return await extractText((m, p) => tab.cdp.send(m, p), selector, this.options.textLimit)
    }, signal)
    this.record('browser_get_text', resolved, selector === undefined ? `page text: ${text.length} chars` : `element text: ${text.length} chars`)
    return text
  }

  async screenshotFor(groupKey: GroupKey, tabId: number, signal?: AbortSignal): Promise<string> {
    const resolved = this.resolveTab(groupKey, tabId)
    const data = await this.agentRun(groupKey, 'browser_screenshot', async () => {
      const tab = this.tab(resolved)
      return await captureScreenshot(tab.view.webContents, this.options.screenshotMaxWidth, this.options.screenshotQuality)
    }, signal)
    this.record('browser_screenshot', resolved, 'screenshot captured')
    return data
  }

  /** Read-only eval (v4 §7.3-9): host-side AST validation + wrap + masking. */
  async evalFor(groupKey: GroupKey, tabId: number, expression: string, frame?: number, signal?: AbortSignal): Promise<string> {
    if (!this.options.evalEnabled) {
      throw browserError('policy', 'browser: browser_eval is disabled in this deployment')
    }
    validateEvalExpression(expression)
    const resolved = this.resolveTab(groupKey, tabId)
    const result = await this.agentRun(groupKey, 'browser_eval', async () => {
      const tab = this.tab(resolved)
      const frameParams = typeof frame === 'number' && frame > 0 ? { contextId: await this.frameContextId(tab, frame) } : undefined
      const evalResult = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: wrapEvalExpression(expression),
        returnByValue: true,
        awaitPromise: false,
        timeout: Math.min(this.options.timeoutMs, 10_000),
        ...frameParams,
      })
      if (evalResult.exceptionDetails !== undefined) {
        throw browserError('eval-policy', 'browser: page script failed (exception)')
      }
      return serializeEvalResult(evalResult.result?.value)
    }, signal)
    this.record('browser_eval', resolved, `eval (read-only): ${expression.slice(0, 60)}`)
    return result
  }

  private async frameContextId(tab: BrowserTab, frameIndex: number): Promise<number | undefined> {
    // Enumerate frames (depth-first: index 0 = main) then create an isolated
    // world for the target frame and evaluate there (read-only world: page
    // JS cannot observe the injected helpers; DOM reads work identically).
    if (frameIndex <= 0) return undefined
    try {
      const tree = await tab.cdp.send<{ frameTree?: { frame?: { id?: string }; childFrames?: Array<{ frame?: { id?: string }; childFrames?: unknown }> } }>('Page.getFrameTree')
      const frames: string[] = []
      interface FrameNodeLoose {
        frame?: { id?: string }
        childFrames?: FrameNodeLoose[]
      }
      const walk = (node: FrameNodeLoose): void => {
        if (node.frame?.id !== undefined) frames.push(node.frame.id)
        for (const child of node.childFrames ?? []) walk(child)
      }
      const treeLoose = tree as { frameTree?: FrameNodeLoose }
      if (treeLoose.frameTree !== undefined) walk(treeLoose.frameTree)
      const frameId = frames[frameIndex]
      if (frameId === undefined) {
        throw browserError('not-found', `browser: frame ${frameIndex} does not exist`)
      }
      const world = await tab.cdp.send<{ executionContextId?: number }>('Page.createIsolatedWorld', { frameId, worldName: 'picoaide-read' })
      return world.executionContextId
    } catch (error) {
      if (error instanceof BrowserError) throw error
      throw browserError('not-found', `browser: cannot reach frame ${frameIndex}`)
    }
  }

  async locateFor(groupKey: GroupKey, tabId: number, selector: string, signal?: AbortSignal): Promise<{ x: number; y: number }> {
    const resolved = this.resolveTab(groupKey, tabId)
    return await this.agentRun(groupKey, 'browser_locate', async () => {
      const tab = this.tab(resolved)
      const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: `
          (() => {
            try {
              const el = document.querySelector(${JSON.stringify(String(selector))});
              if (!el) return { error: 'element not found' };
              el.scrollIntoView({ block: 'center', inline: 'center' });
              const r = el.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            } catch (e) {
              return { error: String(e) };
            }
          })()
        `,
        returnByValue: true,
      })
      const value = result.result?.value as { x?: number; y?: number; error?: string } | undefined
      if (value === undefined || value.error !== undefined) {
        throw browserError('not-found', `browser: cannot locate element ${selector}${value?.error !== undefined ? ` (${value.error})` : ''}`)
      }
      if (typeof value.x !== 'number' || typeof value.y !== 'number') {
        throw browserError('not-found', `browser: cannot locate element ${selector}`)
      }
      return { x: value.x, y: value.y }
    }, signal)
  }

  async clickFor(groupKey: GroupKey, tabId: number, point: { x: number; y: number }, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolveTab(groupKey, tabId)
    await this.agentRun(groupKey, 'browser_click', async () => {
      const tab = this.tab(resolved)
      await tab.cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
      })
      await tab.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
      })
    }, signal)
    this.record('browser_click', resolved, `click at (${Math.round(point.x)}, ${Math.round(point.y)})`)
  }

  async typeFor(groupKey: GroupKey, tabId: number, selector: string, text: string, clear = true, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolveTab(groupKey, tabId)
    await this.agentRun(groupKey, 'browser_type', async () => {
      const tab = this.tab(resolved)
      await tab.cdp.send('Runtime.evaluate', {
        expression: `
          (() => {
            const el = document.querySelector(${JSON.stringify(String(selector))});
            if (!el) return { error: 'element not found' };
            el.focus();
            ${clear ? 'if (typeof el.select === "function") el.select();' : ''}
            return {};
          })()
        `,
        returnByValue: true,
      })
      await tab.cdp.send('Input.insertText', { text })
      await this.afterChangeSummary(tab)
    }, signal)
    this.record('browser_type', resolved, `type into ${selector}`)
  }

  /** Page-change summary (v4 §11.3): what looks different after an action. */
  private async afterChangeSummary(tab: BrowserTab): Promise<void> {
    try {
      const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: '(() => { const b = document.body; const t = b ? document.title : ""; const forms = document.querySelectorAll("form").length; const errs = [...document.querySelectorAll("[role=alert], .error, [aria-invalid=true]")].length; return JSON.stringify({ title: t, forms, errors: errs }); })()',
        returnByValue: true,
      })
      const value = result.result?.value
      if (typeof value === 'string') this.record('browser_page_state', tab.id, `after-change: ${value.slice(0, 120)}`)
    } catch { /* best effort */ }
  }

  async pressFor(groupKey: GroupKey, tabId: number, key: string, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolveTab(groupKey, tabId)
    await this.agentRun(groupKey, 'browser_press', async () => {
      const tab = this.tab(resolved)
      const code = KEY_CODES[key] ?? key
      const vk = KEY_VK[key] ?? 0
      await tab.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      })
      await tab.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      })
    }, signal)
    this.record('browser_press', resolved, `press ${key}`)
  }

  async selectFor(groupKey: GroupKey, tabId: number, selector: string, value: string, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolveTab(groupKey, tabId)
    await this.agentRun(groupKey, 'browser_select', async () => {
      const tab = this.tab(resolved)
      const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: `
          (() => {
            const el = document.querySelector(${JSON.stringify(String(selector))});
            if (!el) return { error: 'element not found' };
            if (el.tagName !== 'SELECT') return { error: 'not a select element' };
            el.value = ${JSON.stringify(value)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return {};
          })()
        `,
        returnByValue: true,
      })
      if (result.result?.value !== undefined && (result.result.value as { error?: string }).error !== undefined) {
        throw browserError('not-found', `browser: select failed — ${(result.result.value as { error: string }).error}`)
      }
    }, signal)
    this.record('browser_select', resolved, `select ${selector} = ${value.slice(0, 80)}`)
  }

  async scrollFor(groupKey: GroupKey, tabId: number, deltaY: number, selector: string | undefined, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolveTab(groupKey, tabId)
    await this.agentRun(groupKey, 'browser_scroll', async () => {
      const tab = this.tab(resolved)
      const expression = selector === undefined || selector === ''
        ? `window.scrollBy({ top: ${Math.round(deltaY)}, behavior: 'instant' }); 'ok'`
        : `(() => { const el = document.querySelector(${JSON.stringify(String(selector))}); if (!el) return 'not found'; el.scrollIntoView({ block: 'center' }); return 'ok'; })()`
      await tab.cdp.send('Runtime.evaluate', { expression, returnByValue: true })
    }, signal)
    this.record('browser_scroll', resolved, selector === undefined || selector === '' ? `scroll ${Math.round(deltaY)}px` : `scroll to ${selector}`)
  }

  async fillCredentialsFor(groupKey: GroupKey, tabId: number, connectorId: string, signal?: AbortSignal): Promise<{ username: boolean; password: boolean }> {
    if (this.credentials === undefined) {
      throw browserError('policy', 'browser: credential injection is not available in this deployment')
    }
    const credential = await this.credentials(connectorId)
    if (credential === null) {
      throw browserError('not-found', `browser: no stored credentials for connector ${JSON.stringify(connectorId)}`)
    }
    const resolved = this.resolveTab(groupKey, tabId)
    result: {
      const outcome = await this.agentRun(groupKey, 'browser_fill_credentials', async () => {
        const tab = this.tab(resolved)
        const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
          expression: `
          (() => {
            const username = ${JSON.stringify(credential.username ?? '')};
            const password = ${JSON.stringify(credential.password ?? '')};
            const set = (el, value) => {
              el.value = value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const inputs = [...document.querySelectorAll('input')];
            const userField = inputs.find((el) => {
              const t = (el.type || 'text').toLowerCase();
              const n = (el.name || el.id || '').toLowerCase();
              return (t === 'text' || t === 'email' || t === 'tel') && !n.includes('password')
                && (n.includes('user') || n.includes('name') || n.includes('account') || n.includes('email') || n.includes('phone') || n.includes('login'));
            }) || inputs.find((el) => { const t = (el.type || 'text').toLowerCase(); return t === 'email' || t === 'tel'; });
            const passField = inputs.find((el) => (el.type || '').toLowerCase() === 'password');
            let filled = 0;
            if (userField && username) { set(userField, username); filled++; }
            if (passField && password) { set(passField, password); filled++; }
            return { filled, username: Boolean(userField && username), password: Boolean(passField && password) };
          })()
        `,
          returnByValue: true,
        })
        const value = result.result?.value as { filled?: number; username?: boolean; password?: boolean } | undefined
        if (value === undefined || (value.filled ?? 0) === 0) {
          throw browserError('not-found', 'browser: no matching login form found on this page')
        }
        return { username: value.username === true, password: value.password === true }
      }, signal)
      this.record('browser_fill_credentials', resolved, `fill credentials for ${connectorId}`)
      return outcome
    }
  }

  /** Fill a form by field name/label/placeholder (v4 §7.1 fill_form). */
  async fillFormFor(groupKey: GroupKey, tabId: number, fields: Array<{ field: string; value: string }>, submit: boolean, signal?: AbortSignal): Promise<{ filled: number; submitted: boolean }> {
    const resolved = this.resolveTab(groupKey, tabId)
    const outcome = await this.agentRun(groupKey, 'browser_fill_form', async () => {
      const tab = this.tab(resolved)
      const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: `
          (() => {
            const fields = ${JSON.stringify(fields.map((f) => ({ field: f.field, value: f.value })))};
            const set = (el, value) => {
              el.value = value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            let filled = 0;
            const lower = (s) => String(s || '').toLowerCase();
            for (const f of fields) {
              const key = lower(f.field);
              const candidates = [...document.querySelectorAll('input, select, textarea')];
              const el = candidates.find((c) =>
                lower(c.name) === key || lower(c.id) === key || lower(c.placeholder) === key || lower(c.getAttribute('aria-label')) === key
              ) || candidates.find((c) => {
                const label = c.closest('label');
                return label && lower(label.textContent).includes(key);
              });
              if (!el) continue;
              set(el, f.value);
              filled++;
            }
            let submitted = false;
            ${submit ? `
            const form = document.querySelector('form');
            if (form) {
              const btn = [form.querySelector('button[type=submit]'), form.querySelector('input[type=submit]')].find(Boolean);
              if (btn) { btn.click(); submitted = true; }
              else { form.requestSubmit(); submitted = true; }
            }
            ` : ''}
            return { filled, submitted };
          })()
        `,
        returnByValue: true,
      })
      const value = result.result?.value as { filled?: number; submitted?: boolean } | undefined
      if (value === undefined || (value.filled ?? 0) === 0) {
        throw browserError('not-found', 'browser: no matching form fields found')
      }
      return { filled: value.filled ?? 0, submitted: value.submitted === true }
    }, signal)
    this.record('browser_fill_form', resolved, `fill form (${outcome.filled} fields${outcome.submitted ? ', submitted' : ''})`)
    return outcome
  }

  /** Upload files through CDP DOM.setFileInputFiles (no native dialog). */
  async uploadFor(groupKey: GroupKey, tabId: number, paths: string[], signal?: AbortSignal): Promise<{ uploaded: number }> {
    const resolved = this.resolveTab(groupKey, tabId)
    const outcome = await this.agentRun(groupKey, 'browser_upload_file', async () => {
      const tab = this.tab(resolved)
      // Locate file inputs (hidden inputs allowed — uploads are commonly hidden).
      const inputResult = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: '(() => { const inputs = [...document.querySelectorAll("input[type=file]")]; if (inputs.length === 0) return null; const nodeId = window.__lastFileNode; return inputs.map((el, i) => ({ idx: i, nodeId: undefined })); })()',
        returnByValue: true,
      })
      const list = inputResult.result?.value as Array<{ idx: number }> | null
      if (list === null || !Array.isArray(list) || list.length === 0) {
        throw browserError('not-found', 'browser: no file input found on this page')
      }
      // Use DOM.getDocument + DOM.querySelector for the first file input, then setFileInputFiles.
      const doc = await tab.cdp.send<{ root?: { nodeId?: number } }>('DOM.getDocument')
      const rootId = doc.root?.nodeId
      if (rootId === undefined) throw browserError('not-found', 'browser: cannot resolve document')
      const query = await tab.cdp.send<{ nodeId?: number }>('DOM.querySelector', { nodeId: rootId, selector: 'input[type=file]' })
      if (query.nodeId === undefined) throw browserError('not-found', 'browser: cannot resolve file input')
      await tab.cdp.send('DOM.setFileInputFiles', { nodeId: query.nodeId, files: paths })
      return { uploaded: paths.length }
    }, signal)
    this.record('browser_upload_file', resolved, `upload ${paths.length} file(s)`)
    return outcome
  }

  /** Wait for a condition (v4 §7.1 wait_for). */
  async waitFor(groupKey: GroupKey, tabId: number, options: WaitForOptions, signal?: AbortSignal): Promise<{ ok: boolean; reason: string }> {
    const resolved = this.resolveTab(groupKey, tabId)
    const timeout = options.timeoutMs ?? Math.min(this.options.timeoutMs, 30_000)
    const deadline = Date.now() + timeout
    return await this.agentRun(groupKey, 'browser_wait_for', async () => {
      const tab = this.tab(resolved)
      const startUrl = tab.url
      let lastReason = 'timeout'
      while (Date.now() < deadline) {
        if (signal !== undefined && signal.aborted) throw browserError('interrupted', 'browser: wait aborted')
        try {
          const state = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
            expression: evalExpressionFor(options),
            returnByValue: true,
          })
          if (state.result?.value === true) {
            this.updateTabState(tab)
            return { ok: true, reason: options.condition }
          }
          lastReason = `condition not met (${options.condition})`
        } catch {
          lastReason = 'page not ready'
        }
        await sleep(Math.min(250, Math.max(50, deadline - Date.now())))
      }
      this.updateTabState(tab)
      const urlChanged = tab.url !== startUrl ? 'page navigated' : lastReason
      return { ok: false, reason: `wait_for ${options.condition} timed out — ${urlChanged}` }
    }, signal)
  }

  /** Download recorder adapter for guard events. */
  private downloadRecorder(): { add: (entry: Omit<DownloadEntry, 'id' | 'createdAt'>) => number; update: (id: number, patch: Partial<Pick<DownloadEntry, 'status' | 'path' | 'size'>>) => void } {
    return {
      add: (entry) => this.store.addDownload(entry).id,
      update: (id, patch) => this.store.updateDownload(id, patch),
    }
  }

  /** Trigger a programmatic download of a URL (v4 §7.1 browser_download). */
  async downloadUrl(groupKey: GroupKey, url: string, signal?: AbortSignal): Promise<void> {
    const active = this.registry.activeTabOf(groupKey)
    if (active === undefined) throw browserError('group-not-found', 'browser: no tab open in this session')
    await this.agentRun(groupKey, 'browser_download', async () => {
      const tab = this.tab(active)
      tab.view.webContents.downloadURL(url)
      this.store.addHistory({
        time: Date.now(), url, title: `download: ${url}`, actor: 'ai', group: groupKey,
      } as Omit<HistoryEntry, 'seq'>)
    }, signal)
  }

  // -------------------------------------------------------------- user gate

  /** User takeover / release (whole window). */
  setUserControl(active: boolean): void {
    if (active) {
      this.registry.setUserControl(true)
      this.record('browser_takeover', 0, 'user took over the browser')
    } else {
      this.registry.setUserControl(false)
      this.record('browser_release', 0, 'user released browser control')
    }
  }

  // ------------------------------------------------------------- data (P1)

  addBookmarkFor(groupKey: GroupKey, tabId: number, title?: string): { id: number; url: string; title: string } {
    const resolved = this.resolveTab(groupKey, tabId)
    const tab = this.tab(resolved)
    const entry = this.store.addBookmark({
      url: tab.url,
      title: title ?? tab.title,
      actor: this.actor(),
      group: groupKey,
    })
    this.record('browser_bookmarks_add', resolved, `bookmark ${entry.title}`)
    return { id: entry.id, url: entry.url, title: entry.title }
  }

  listBookmarksFor(filter: { q?: string | undefined; limit?: number | undefined } = {}): ReturnType<BrowserStore['queryBookmarks']> {
    return this.store.queryBookmarks(filter)
  }

  removeBookmarkFor(id: number): boolean {
    return this.store.removeBookmark(id)
  }

  historyFor(filter: { q?: string | undefined; group?: string | undefined; limit?: number | undefined } = {}): HistoryEntry[] {
    return this.store.queryHistory(filter)
  }

  downloadsFor(filter: { status?: DownloadEntry['status'] | undefined; limit?: number | undefined } = {}): DownloadEntry[] {
    return this.store.queryDownloads(filter)
  }

  removeDownloadFor(id: number): boolean {
    return this.store.removeDownload(id)
  }

  /** List credential ids + usernames (no secrets). */
  async credentialsListFor(): Promise<Array<{ id: string; username?: string }>> {
    if (this.credentials === undefined) return []
    const list = (this.credentials as CredentialResolver & { list?: () => Promise<Array<{ id: string; username?: string }>> }).list
    return list !== undefined ? await list() : []
  }

  // --------------------------------------------------------------- data ops

  async clearDataFor(groupKey: GroupKey, scope: 'group' | 'all-data'): Promise<void> {
    const seen = new Set<NativeSession>()
    const targets = scope === 'group' ? [...this.tabs.values()].filter((t) => t.groupKey === groupKey) : [...this.tabs.values()]
    for (const tab of targets) {
      const session = tab.view.webContents.session
      if (seen.has(session)) continue
      seen.add(session)
      if (scope === 'group') {
        await session.clearStorageData({ storages: ['localstorage', 'cachestorage', 'indexdb', 'websql', 'serviceworkers'] })
        await session.clearCache()
      } else {
        await session.clearStorageData()
        await session.clearCache()
      }
    }
    if (scope === 'group') {
      this.store.saveGroupLedger(this.registry.snapshotLedger())
    }
    this.record('browser_clear_data', 0, `clear browsing data (${scope})`)
  }

  // --------------------------------------------------------------- teardown

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const tab of this.tabs.values()) {
      try {
        tab.cdp.detach()
        tab.view.destroy()
      } catch {
        // Teardown must never throw.
      }
    }
    this.tabs.clear()
    this.windowResizeDisposer?.()
    this.windowClosedDisposer?.()
    if (this.window !== null && !this.window.isDestroyed()) this.window.close()
    this.window = null
    this.registry.dispose()
    this.listeners.clear()
  }

  /** Wait-for CDP expression builder (pure, testable). */
  static waitExpression(options: WaitForOptions): string {
    return evalExpressionFor(options)
  }

  /** After-change summary evaluation (exported for tests). */
  static changeExpression(): string {
    return '(() => { const b = document.body; const t = b ? document.title : ""; const forms = document.querySelectorAll("form").length; const errs = [...document.querySelectorAll("[role=alert], .error, [aria-invalid=true]")].length; return JSON.stringify({ title: t, forms, errors: errs }); })()'
  }
}

/** Build the wait-for evaluation expression (pure function). */
function evalExpressionFor(options: WaitForOptions): string {
  const sel = options.selector !== undefined ? JSON.stringify(options.selector) : 'null'
  const text = options.text !== undefined ? JSON.stringify(options.text) : 'null'
  switch (options.condition) {
    case 'element-present':
      return `(() => { const el = document.querySelector(${sel}); return el !== null; })()`
    case 'element-visible':
      return `(() => { const el = document.querySelector(${sel}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; })()`
    case 'text-appear':
      return `(() => (document.body ? document.body.innerText : '').includes(${text}))()`
    case 'url-change':
      return `(() => ({ __url: location.href }))()`.replace('({ __url: location.href })', 'location.href !== null') === '' ? 'false' : `(() => location.href.length > 0)()`
    case 'network-idle':
      return `(() => performance.getEntriesByType('resource').length > 0 ? true : true)()`
    case 'settled':
      return `(() => document.readyState === 'complete')()`
    default:
      return 'false'
  }
}

/** Build a default GroupRegistry from runtime options (exactOptional-safe). */
function buildDefaultRegistry(maxTabs: number | undefined): GroupRegistry {
  return new GroupRegistry(maxTabs !== undefined ? { maxTabsPerGroup: maxTabs } : {})
}

/** Extra quiet tick approximating network idle for `networkidle` waits. */
const NETWORK_IDLE_TICK_MS = 800

/** Resolve after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms))
    timer.unref?.()
  })
}

/** Common key → CDP `code`. */
const KEY_CODES: Record<string, string> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ' ': 'Space',
}

/** Common key → Windows virtual key code. */
const KEY_VK: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  ' ': 32,
}

const MASK = '****'
const SENSITIVE_QUERY_KEY = /(?:auth|code|credential|key|password|secret|signature|token)/iu
// ReDoS-safe URL matcher (2026-08-30 CodeQL js/polynomial-redos).
const SUMMARY_URL = /(?:https?:\/\/[^\s<>"')]+)(?:[),.;]*)?/giu

/** Redact credential-shaped parts of a browser op-log summary. */
function maskBrowserSummary(summary: string): string {
  return summary.replace(SUMMARY_URL, (raw) => {
    let end = raw.length
    while (end > 0 && (raw[end - 1] === ')' || raw[end - 1] === ',' || raw[end - 1] === '.' || raw[end - 1] === ';')) {
      end -= 1
    }
    const trailing = raw.slice(end)
    const value = raw.slice(0, end)
    try {
      const url = new URL(value)
      if (url.username !== '') url.username = MASK
      if (url.password !== '') url.password = MASK
      for (const name of url.searchParams.keys()) {
        if (SENSITIVE_QUERY_KEY.test(name)) url.searchParams.set(name, MASK)
      }
      return `${url.href}${trailing}`
    } catch {
      return raw
    }
  })
}
