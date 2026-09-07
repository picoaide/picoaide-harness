/**
 * BrowserRuntime v4.2 (2026-09-07 定案：取消分组，AI 可以控制所有页面):
 * ONE flat tab pool shared by every session and the user. AI operations run
 * serially under a global mutex with a whole-window user gate (我来操作);
 * a transparent interception mask blocks stray clicks while the AI drives;
 * the AI panel shows the live action stream. All v4 capabilities remain
 * (read-only eval, wait_for, fill_form, upload_file, programmatic downloads,
 * stores, crash rebuild, per-frame eval).
 * @module @picoaide/dsh-browser
 */

import { CdpSession } from './cdp.ts'
import { BROWSER_PARTITION, BROWSER_SHELL_TOOLBAR_HEIGHT, type ElectronAdapter, type NativeBrowserWindow, type NativeSession, type NativeView } from './electron-adapter.ts'
import { BrowserGuard, installPermissionGuard } from './guard.ts'
import { extractSnapshot, extractText } from './snapshot.ts'
import { captureScreenshot } from './shots.ts'
import { TabPool, type PoolTabView } from './pool.ts'
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
/** Op-log ring size. */
const OP_LOG_LIMIT = 200

interface BrowserTab {
  readonly id: number
  readonly view: NativeView
  readonly cdp: CdpSession
  /** The session that created this tab (oplog attribution). */
  readonly ownerSession: string
  url: string
  title: string
  loading: boolean
  disposers: Array<() => void>
}

interface EvalResult {
  result?: { value?: unknown; type?: string }
  exceptionDetails?: unknown
}

/** Wait-for condition spec. */
export interface WaitForOptions {
  condition: 'element-present' | 'element-visible' | 'text-appear' | 'url-change' | 'network-idle' | 'settled'
  selector?: string | undefined
  text?: string | undefined
  timeoutMs?: number | undefined
}

/** Shell/panel state projection (GET /api/pico/browser/state). */
export interface BrowserShellState {
  tabs: BrowserTabState[]
  window: BrowserWindowState
  controlled: boolean
  busy: boolean
  busyTool: string
  latestOp: BrowserOpLogEntry | null
}

/** State-change events emitted by the runtime (SSE stream). */
export type BrowserStreamEvent = 'state' | 'tab' | 'tab-meta' | 'busy' | 'takeover' | 'release' | 'ops'

/** Runtime dependencies wired by the plugin. */
export interface RuntimeDeps {
  pool?: TabPool
  store?: BrowserStore
  currentUsername?: () => string | null
}

/**
 * The embedded browser service (v4.2 single pool). Constructed by the plugin
 * with the real adapter; tests inject a mock adapter plus optional deps.
 */
export class BrowserRuntime {
  private readonly tabs = new Map<number, BrowserTab>()
  private nextTabId = 1
  private readonly ops: BrowserOpLogEntry[] = []
  private opSeq = 0
  private window: NativeBrowserWindow | null = null
  /** AI-drive interception overlay (transparent, z-top; click = 我来操作). */
  private mask: NativeView | null = null
  private readonly guard: BrowserGuard
  private windowResizeDisposer: (() => void) | null = null
  private windowClosedDisposer: (() => void) | null = null
  private disposed = false
  private partition: string
  private readonly listeners = new Set<(event: BrowserStreamEvent) => void>()
  private shellOrigin: string | undefined
  private lastAgentId = ''
  readonly pool: TabPool
  readonly store: BrowserStore

  constructor(
    private readonly adapter: ElectronAdapter,
    options: BrowserToolOptions = {},
    private readonly credentials?: CredentialResolver,
    partition?: string,
    deps: RuntimeDeps = {},
  ) {
    this.options = {
      maxTabs: options.maxTabs ?? 16,
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
    this.pool = deps.pool ?? new TabPool(options.maxTabs !== undefined ? { maxTabs: options.maxTabs } : {})
    if (deps.store !== undefined) this.store = deps.store
    else this.store = new BrowserStore({ dir: this.partition.replace(/[^a-zA-Z0-9_-]/g, '_') + '-store' })
    this.pool.onChange((event) => this.emitMapped(event))
  }

  private emitMapped(event: string): void {
    const mapped = (['tab', 'tab-meta', 'busy', 'takeover', 'release'] as const).includes(event as never)
      ? event as BrowserStreamEvent
      : 'state'
    if (mapped === 'busy' || mapped === 'takeover' || mapped === 'release') this.applyMask()
    this.emitAll(mapped)
  }

  private emitAll(event: BrowserStreamEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch { /* bus must never break */ }
    }
  }

  onState(_event: BrowserStreamEvent, listener: () => void): () => void {
    const wrapper = (): void => listener()
    this.listeners.add(wrapper)
    return () => { this.listeners.delete(wrapper) }
  }

  onAny(listener: (event: BrowserStreamEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly options: Required<BrowserToolOptions>

  // ------------------------------------------------------------- accessors

  get windowState(): BrowserWindowState {
    return {
      created: this.window !== null && !this.window.isDestroyed(),
      visible: this.window !== null && !this.window.isDestroyed() && this.window.isVisible(),
    }
  }

  get opLog(): readonly BrowserOpLogEntry[] {
    return [...this.ops].reverse()
  }

  get controlled(): boolean {
    return this.pool.controlled
  }

  get isBusy(): boolean {
    return this.pool.isBusy()
  }

  get busyToolName(): string {
    return this.pool.busyToolOf()
  }

  currentTabId(): number | undefined {
    return this.pool.activeTab
  }

  /** Record the calling session id (oplog attribution). */
  setAgentContext(agentId: string | undefined): void {
    this.lastAgentId = agentId ?? ''
  }

  listTabs(): BrowserTabState[] {
    const active = this.pool.activeTab
    return [...this.tabs.values()].map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      visible: tab.id === active,
    }))
  }

  poolTabs(): PoolTabView[] {
    return this.pool.list()
  }

  shellState(): BrowserShellState {
    const active = this.pool.activeTab
    const tabs = [...this.tabs.values()].map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      visible: tab.id === active,
    }))
    void active
    return {
      tabs,
      window: this.windowState,
      controlled: this.pool.controlled,
      busy: this.pool.isBusy(),
      busyTool: this.pool.busyToolOf(),
      latestOp: this.ops.at(-1) ?? null,
    }
  }

  latestOp(): BrowserOpLogEntry | null {
    return this.ops.at(-1) ?? null
  }

  /**
   * Restore the persisted tab ledger (tabs reappear on demand; login state
   * lives in the per-user partition).
   */
  restoreLedger(): void {
    const ledger = this.store.getGroupLedger() as never
    if (ledger === undefined) return
    const tabLedger = ledger as { activeTabId?: number; tabs?: Array<{ tabId: number; url: string; title: string }>; savedAt?: number }
    this.pool.restoreLedger({
      version: 1,
      activeTabId: tabLedger.activeTabId,
      tabs: tabLedger.tabs ?? [],
      savedAt: tabLedger.savedAt ?? Date.now(),
    })
  }

  /** Persist the tab ledger (host wires this on every state change). */
  saveLedger(): void {
    this.store.saveGroupLedger(this.pool.snapshotLedger() as never)
  }

  /** Swap the partition used by NEW tab views (user switch). */
  setPartition(partition: string): void {
    this.partition = partition
  }

  // ------------------------------------------------------------ tab creation

  /** Set the loopback origin the shell/mask pages are served from. */
  setShellOrigin(origin: string): void {
    this.shellOrigin = origin
  }

  /**
   * Open a tab (agent path: serial + quota wait; user path: fail-fast quota).
   */
  async open(url: string | undefined, signal?: AbortSignal, user = false): Promise<BrowserTabState> {
    if (this.disposed) throw new Error('browser: runtime disposed')
    if (user) {
      if (!this.pool.tryReserveTab()) {
        throw browserError('quota', 'browser: tab limit reached — close a tab first')
      }
      return await this.createTab(url, signal)
    }
    await this.pool.reserveTab(signal)
    try {
      return await this.createTab(url, signal)
    } catch (error) {
      this.pool.releaseReservation()
      throw error
    }
  }

  private async createTab(url: string | undefined, signal?: AbortSignal): Promise<BrowserTabState> {
    const id = this.nextTabId++
    const view = this.adapter.createView(this.partition)
    const cdp = new CdpSession(view.webContents.cdp)
    try {
      await cdp.attach()
    } catch (cause) {
      try { view.destroy() } catch { /* teardown never throws */ }
      throw cause
    }
    const tab: BrowserTab = { id, view, cdp, ownerSession: this.lastAgentId, url: '', title: '', loading: false, disposers: [] }
    this.tabs.set(id, tab)
    this.pool.registerTab(id, '', '')

    try {
      const win = await this.ensureWindow(this.shellOrigin)
      const bounds = this.contentBounds()
      view.attach(win, bounds)
      this.relayout()

      view.webContents.on('did-start-loading', () => {
        tab.loading = true
        this.pool.updateTabMeta(id, tab.url, tab.title)
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
      }, this.downloadRecorder(), '', this.actor(), this.options.downloadDir))

      if (url !== undefined && url !== '') {
        await this.navigateInternal(id, url, 'domcontentloaded', 'ai')
      }
      this.updateTabState(tab)
      this.record('browser_open', id, url === undefined || url === '' ? 'new tab' : url)
      void signal
      return this.tabState(id)
    } catch (cause) {
      try {
        cdp.detach()
        view.destroy()
      } catch { /* teardown never throws */ }
      this.releaseTabDisposers(id)
      this.tabs.delete(id)
      this.pool.removeTab(id)
      throw cause
    }
  }

  releaseReservation(): void {
    this.pool.releaseReservation()
  }

  // ---------------------------------------------------------------- window

  private contentBounds(): { x: number; y: number; width: number; height: number } {
    const size = this.window?.getContentSize() ?? { width: 0, height: 0 }
    return {
      x: 0,
      y: BROWSER_SHELL_TOOLBAR_HEIGHT,
      width: Math.max(0, size.width),
      height: Math.max(0, size.height - BROWSER_SHELL_TOOLBAR_HEIGHT),
    }
  }

  /** Re-layout tabs (active one visible) + place the interception mask on top. */
  private relayout(): void {
    const bounds = this.contentBounds()
    const active = this.pool.activeTab
    let visibleTab: BrowserTab | undefined
    for (const tab of this.tabs.values()) {
      tab.view.setBounds(bounds)
      tab.view.setVisible(tab.id === active)
      if (tab.id === active) visibleTab = tab
    }
    if (visibleTab !== undefined && this.window !== null && !this.window.isDestroyed()) {
      visibleTab.view.moveToTop(this.window)
    }
    this.applyMask()
  }

  /** Mask shows while the AI drives (any session) and the user has NOT taken over. */
  private shouldMaskShow(): boolean {
    if (this.pool.controlled) return false
    return this.pool.isBusy()
  }

  private applyMask(): void {
    if (this.mask === null) return
    if (this.window === null || this.window.isDestroyed()) return
    this.mask.setBounds(this.contentBounds())
    this.mask.moveToTop(this.window)
    this.mask.setVisible(this.shouldMaskShow())
  }

  async ensureWindow(origin?: string): Promise<NativeBrowserWindow> {
    if (this.window !== null && !this.window.isDestroyed()) {
      this.window.show()
      return this.window
    }
    const win = this.adapter.createBrowserWindow()
    win.show()
    this.window = win
    const mask = this.adapter.createMaskView(this.partition)
    this.mask = mask
    mask.attach(win, this.contentBounds())
    if (origin !== undefined) {
      void win.loadURL(`${origin}/browser-shell`).catch((cause: unknown) => {
        void win.loadURL(`${origin}/browser-shell`).catch(() => {
          console.error('[dsh-browser] shell page failed to load', cause)
        })
      })
      void mask.webContents.loadURL(`${origin}/browser-mask`).catch((cause: unknown) => {
        void mask.webContents.loadURL(`${origin}/browser-mask`).catch(() => {
          console.error('[dsh-browser] mask page failed to load', cause)
        })
      })
    }
    this.applyMask()
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
      this.mask = null
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
    const tabEntry = this.tabs.get(tab)
    this.ops.push({
      seq: ++this.opSeq,
      time: Date.now(),
      tool,
      tab,
      group: '',
      session: tabEntry?.ownerSession ?? '',
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

  /** Resolve a tab id: explicit (must exist) or the pool's active tab. */
  resolveTab(tabId: number | undefined): number {
    if (tabId !== undefined) {
      if (!this.pool.has(tabId)) throw browserError('not-found', `browser: unknown tab ${tabId}`)
      return tabId
    }
    const active = this.pool.activeTab
    if (active === undefined) throw browserError('not-found', 'browser: no tab open — call browser_open first')
    return active
  }

  tabState(id: number): BrowserTabState {
    const tab = this.tab(id)
    return { id: tab.id, url: tab.url, title: tab.title, loading: tab.loading, visible: tab.id === this.pool.activeTab }
  }

  private updateTabState(tab: BrowserTab): void {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return
    tab.url = wc.getURL()
    tab.title = wc.getTitle() || tab.url || ''
    tab.loading = wc.isLoading()
    this.pool.updateTabMeta(tab.id, tab.url, tab.title)
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

  private actor(userActor = false): RecordActor {
    return userActor ? 'user' : 'ai'
  }

  /** Run one agent operation under the global serial mutex (user gate aware). */
  private async agentRun<T>(tool: string, body: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return await this.pool.withOperation(tool, body, signal)
  }

  // navigation family --------------------------------------------------------

  async navigate(tabId: number, url: string, waitUntil: BrowserWaitUntil = 'domcontentloaded', signal?: AbortSignal, user = false): Promise<void> {
    const body = async (): Promise<void> => {
      await this.navigateInternal(tabId, url, waitUntil, user ? 'user' : 'ai')
    }
    if (user) return await body()
    return await this.agentRun('browser_navigate', body, signal)
  }

  /** User path: navigate the pool's active tab (open one first if none). */
  async navigateUser(url: string): Promise<void> {
    const tab = this.pool.activeTab
    if (tab === undefined) {
      await this.open(url, undefined, true)
      return
    }
    await this.navigate(tab, url, 'domcontentloaded', undefined, true)
  }

  private async navigateInternal(id: number, url: string, waitUntil: BrowserWaitUntil, actor: RecordActor): Promise<void> {
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
      group: '',
    } as Omit<HistoryEntry, 'seq'>)
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

  async reload(tabId: number, signal?: AbortSignal, user = false): Promise<void> {
    const body = async (): Promise<void> => {
      const tab = this.tab(tabId)
      const wc = tab.view.webContents
      if (wc.isDestroyed()) return
      wc.reload()
      await this.waitForLoad(wc, 'domcontentloaded')(this.options.timeoutMs)
      this.updateTabState(tab)
    }
    if (user) return await body()
    return await this.agentRun('browser_reload', body, signal)
  }

  async goBack(tabId: number, signal?: AbortSignal, user = false): Promise<void> {
    const body = async (): Promise<void> => {
      const tab = this.tab(tabId)
      const wc = tab.view.webContents
      if (wc.isDestroyed()) return
      wc.goBack()
      await this.waitForLoad(wc, 'domcontentloaded')(this.options.timeoutMs)
      this.updateTabState(tab)
    }
    if (user) return await body()
    return await this.agentRun('browser_go_back', body, signal)
  }

  async goForward(tabId: number, signal?: AbortSignal, user = false): Promise<void> {
    const body = async (): Promise<void> => {
      const tab = this.tab(tabId)
      const wc = tab.view.webContents
      if (wc.isDestroyed()) return
      wc.goForward()
      await this.waitForLoad(wc, 'domcontentloaded')(this.options.timeoutMs)
      this.updateTabState(tab)
    }
    if (user) return await body()
    return await this.agentRun('browser_go_forward', body, signal)
  }

  /** Switch the pool's active tab. */
  async switchTab(tabId: number, user = false, signal?: AbortSignal): Promise<void> {
    const body = async (): Promise<void> => {
      this.pool.setActiveTab(tabId)
      this.relayout()
      this.record('browser_switch_tab', tabId, `switch to tab ${tabId}`)
    }
    if (user) return await body()
    return await this.agentRun('browser_switch_tab', body, signal)
  }

  async closeTab(tabId: number, user = false, signal?: AbortSignal): Promise<void> {
    const body = async (): Promise<void> => {
      this.destroyTab(tabId)
      this.relayout()
      this.record('browser_close_tab', tabId, `close tab ${tabId}`)
    }
    if (user) return await body()
    return await this.agentRun('browser_close_tab', body, signal)
  }

  private destroyTab(id: number): void {
    const tab = this.tabs.get(id)
    if (tab === undefined) return
    try {
      tab.cdp.detach()
      tab.view.detach()
      tab.view.destroy()
    } catch { /* teardown never throws */ }
    this.releaseTabDisposers(id)
    this.tabs.delete(id)
    this.pool.removeTab(id)
  }

  /** Close everything (session switch / shell 清除). */
  async closeAll(user = false): Promise<void> {
    const body = async (): Promise<void> => {
      for (const id of [...this.tabs.keys()]) this.destroyTab(id)
      this.pool.clear()
      this.relayout()
      this.record('browser_close', 0, 'close browser (all tabs)')
      this.hideWindow()
    }
    if (user) {
      const already = this.pool.controlled
      if (!already) this.pool.setUserControl(true)
      try {
        return await body()
      } finally {
        if (!already) this.pool.setUserControl(false)
      }
    }
    return await this.agentRun('browser_close', body)
  }

  // ----------------------------------------------------------- interactions

  async snapshot(tabId: number, signal?: AbortSignal): Promise<BrowserSnapshotElement[]> {
    const resolved = this.resolveTab(tabId)
    const elements = await this.agentRun('browser_get_snapshot', async () => {
      const tab = this.tab(resolved)
      return await extractSnapshot((m, p) => tab.cdp.send(m, p), this.options.snapshotLimit)
    }, signal)
    this.record('browser_get_snapshot', resolved, `snapshot: ${elements.length} elements`)
    return elements
  }

  async text(tabId: number, selector: string | undefined, signal?: AbortSignal): Promise<string> {
    const resolved = this.resolveTab(tabId)
    const text = await this.agentRun('browser_get_text', async () => {
      const tab = this.tab(resolved)
      return await extractText((m, p) => tab.cdp.send(m, p), selector, this.options.textLimit)
    }, signal)
    this.record('browser_get_text', resolved, selector === undefined ? `page text: ${text.length} chars` : `element text: ${text.length} chars`)
    return text
  }

  async screenshot(tabId: number, signal?: AbortSignal): Promise<string> {
    const resolved = this.resolveTab(tabId)
    const data = await this.agentRun('browser_screenshot', async () => {
      const tab = this.tab(resolved)
      return await captureScreenshot(tab.view.webContents, this.options.screenshotMaxWidth, this.options.screenshotQuality)
    }, signal)
    this.record('browser_screenshot', resolved, 'screenshot captured')
    return data
  }

  /** Read-only eval (v4 AST policy + masking). */
  async eval(tabId: number, expression: string, frame?: number, signal?: AbortSignal): Promise<string> {
    if (!this.options.evalEnabled) {
      throw browserError('policy', 'browser: browser_eval is disabled in this deployment')
    }
    validateEvalExpression(expression)
    const resolved = this.resolveTab(tabId)
    const result = await this.agentRun('browser_eval', async () => {
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
    if (frameIndex <= 0) return undefined
    try {
      interface FrameNode {
        frame?: { id?: string }
        childFrames?: FrameNode[]
      }
      const tree = await tab.cdp.send<{ frameTree?: FrameNode }>('Page.getFrameTree')
      const frames: string[] = []
      const walk = (node: FrameNode): void => {
        if (node.frame?.id !== undefined) frames.push(node.frame.id)
        for (const child of node.childFrames ?? []) walk(child)
      }
      if (tree.frameTree !== undefined) walk(tree.frameTree)
      const frameId = frames[frameIndex]
      if (frameId === undefined) throw browserError('not-found', `browser: frame ${frameIndex} does not exist`)
      const world = await tab.cdp.send<{ executionContextId?: number }>('Page.createIsolatedWorld', { frameId, worldName: 'picoaide-read' })
      return world.executionContextId
    } catch (error) {
      if (error instanceof BrowserError) throw error
      throw browserError('not-found', `browser: cannot reach frame ${frameIndex}`)
    }
  }

  async locateElement(tabId: number, selector: string, signal?: AbortSignal): Promise<{ x: number; y: number }> {
    const resolved = this.resolveTab(tabId)
    return await this.agentRun('browser_locate', async () => {
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

  async clickAt(tabId: number, point: { x: number; y: number }, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolveTab(tabId)
    await this.agentRun('browser_click', async () => {
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

  async typeInto(tabId: number, selector: string, text: string, clear = true, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolveTab(tabId)
    await this.agentRun('browser_type', async () => {
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

  async pressKey(tabId: number, key: string, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolveTab(tabId)
    await this.agentRun('browser_press', async () => {
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

  async selectOption(tabId: number, selector: string, value: string, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolveTab(tabId)
    await this.agentRun('browser_select', async () => {
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

  async scroll(tabId: number, deltaY: number, selector: string | undefined, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolveTab(tabId)
    await this.agentRun('browser_scroll', async () => {
      const tab = this.tab(resolved)
      const expression = selector === undefined || selector === ''
        ? `window.scrollBy({ top: ${Math.round(deltaY)}, behavior: 'instant' }); 'ok'`
        : `(() => { const el = document.querySelector(${JSON.stringify(String(selector))}); if (!el) return 'not found'; el.scrollIntoView({ block: 'center' }); return 'ok'; })()`
      await tab.cdp.send('Runtime.evaluate', { expression, returnByValue: true })
    }, signal)
    this.record('browser_scroll', resolved, selector === undefined || selector === '' ? `scroll ${Math.round(deltaY)}px` : `scroll to ${selector}`)
  }

  async fillCredentials(tabId: number, connectorId: string, signal?: AbortSignal): Promise<{ username: boolean; password: boolean }> {
    if (this.credentials === undefined) {
      throw browserError('policy', 'browser: credential injection is not available in this deployment')
    }
    const credential = await this.credentials(connectorId)
    if (credential === null) {
      throw browserError('not-found', `browser: no stored credentials for connector ${JSON.stringify(connectorId)}`)
    }
    const resolved = this.resolveTab(tabId)
    const outcome = await this.agentRun('browser_fill_credentials', async () => {
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

  /** Fill a form by field name/label/placeholder (batch). */
  async fillForm(tabId: number, fields: Array<{ field: string; value: string }>, submit: boolean, signal?: AbortSignal): Promise<{ filled: number; submitted: boolean }> {
    const resolved = this.resolveTab(tabId)
    const outcome = await this.agentRun('browser_fill_form', async () => {
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

  /** Upload files through CDP (no native dialog). */
  async uploadFile(tabId: number, paths: string[], signal?: AbortSignal): Promise<{ uploaded: number }> {
    const resolved = this.resolveTab(tabId)
    const outcome = await this.agentRun('browser_upload_file', async () => {
      const tab = this.tab(resolved)
      const doc = await tab.cdp.send<{ root?: { nodeId?: number } }>('DOM.getDocument')
      const rootId = doc.root?.nodeId
      if (rootId === undefined) throw browserError('not-found', 'browser: cannot resolve document')
      const query = await tab.cdp.send<{ nodeId?: number }>('DOM.querySelector', { nodeId: rootId, selector: 'input[type=file]' })
      if (query.nodeId === undefined) throw browserError('not-found', 'browser: no file input found on this page')
      await tab.cdp.send('DOM.setFileInputFiles', { nodeId: query.nodeId, files: paths })
      return { uploaded: paths.length }
    }, signal)
    this.record('browser_upload_file', resolved, `upload ${paths.length} file(s)`)
    return outcome
  }

  /** Wait for a page condition. */
  async waitFor(tabId: number, options: WaitForOptions, signal?: AbortSignal): Promise<{ ok: boolean; reason: string }> {
    const resolved = this.resolveTab(tabId)
    const timeout = options.timeoutMs ?? Math.min(this.options.timeoutMs, 30_000)
    const deadline = Date.now() + timeout
    return await this.agentRun('browser_wait_for', async () => {
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

  /** Wait-for CDP expression builder (pure, testable). */
  static waitExpression(options: WaitForOptions): string {
    return evalExpressionFor(options)
  }

  // -------------------------------------------------------------- user gate

  /** User takeover / release (whole window). */
  setUserControl(active: boolean): void {
    if (active) {
      this.pool.setUserControl(true)
      this.record('browser_takeover', 0, 'user took over the browser')
    } else {
      this.pool.setUserControl(false)
      this.record('browser_release', 0, 'user released browser control')
    }
  }

  // ------------------------------------------------------------- data (P1)

  addBookmark(tabId: number, title?: string): { id: number; url: string; title: string } {
    const resolved = this.resolveTab(tabId)
    const tab = this.tab(resolved)
    const entry = this.store.addBookmark({
      url: tab.url,
      title: title ?? tab.title,
      actor: this.actor(),
      group: '',
    })
    this.record('browser_bookmarks_add', resolved, `bookmark ${entry.title}`)
    return { id: entry.id, url: entry.url, title: entry.title }
  }

  listBookmarks(filter: { q?: string | undefined; limit?: number | undefined } = {}): ReturnType<BrowserStore['queryBookmarks']> {
    return this.store.queryBookmarks(filter)
  }

  removeBookmark(id: number): boolean {
    return this.store.removeBookmark(id)
  }

  history(filter: { q?: string | undefined; limit?: number | undefined } = {}): HistoryEntry[] {
    return this.store.queryHistory({ ...filter, group: undefined })
  }

  downloads(filter: { status?: DownloadEntry['status'] | undefined; limit?: number | undefined } = {}): DownloadEntry[] {
    return this.store.queryDownloads(filter)
  }

  removeDownload(id: number): boolean {
    return this.store.removeDownload(id)
  }

  /** Download recorder adapter for guard events. */
  private downloadRecorder(): { add: (entry: Omit<DownloadEntry, 'id' | 'createdAt'>) => number; update: (id: number, patch: Partial<Pick<DownloadEntry, 'status' | 'path' | 'size'>>) => void } {
    return {
      add: (entry) => this.store.addDownload(entry).id,
      update: (id, patch) => this.store.updateDownload(id, patch),
    }
  }

  async credentialsList(): Promise<Array<{ id: string; username?: string }>> {
    if (this.credentials === undefined) return []
    const list = (this.credentials as CredentialResolver & { list?: () => Promise<Array<{ id: string; username?: string }>> }).list
    return list !== undefined ? await list() : []
  }

  /** Trigger a programmatic download of a URL. */
  async downloadUrl(url: string, signal?: AbortSignal): Promise<void> {
    const active = this.pool.activeTab
    if (active === undefined) throw browserError('not-found', 'browser: no tab open in the browser')
    await this.agentRun('browser_download', async () => {
      const tab = this.tab(active)
      tab.view.webContents.downloadURL(url)
      this.store.addHistory({
        time: Date.now(), url, title: `download: ${url}`, actor: 'ai', group: '',
      } as Omit<HistoryEntry, 'seq'>)
    }, signal)
  }

  // --------------------------------------------------------------- data ops

  async clearData(all = false): Promise<void> {
    const seen = new Set<NativeSession>()
    for (const tab of this.tabs.values()) {
      const session = tab.view.webContents.session
      if (seen.has(session)) continue
      seen.add(session)
      if (all) {
        await session.clearStorageData()
        await session.clearCache()
      } else {
        await session.clearStorageData({ storages: ['localstorage', 'cachestorage', 'indexdb', 'websql', 'serviceworkers'] })
        await session.clearCache()
      }
    }
    this.record('browser_clear_data', 0, `clear browsing data (${all ? '全部' : '站点'})`)
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
    this.mask = null
    this.pool.dispose()
    this.listeners.clear()
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
      return `(() => location.href.length > 0)()`
    case 'network-idle':
      return `(() => performance.getEntriesByType('resource').length > 0 || true)()`
    case 'settled':
      return `(() => document.readyState === 'complete')()`
    default:
      return 'false'
  }
}

const NETWORK_IDLE_TICK_MS = 800

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
