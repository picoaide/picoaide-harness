/**
 * BrowserRuntime v4.2 (2026-09-07 定案：取消分组，AI 可以控制所有页面):
 * ONE flat tab pool shared by every session and the user. AI operations run
 * serially under a global mutex with a whole-window user gate (我来操作);
 * a transparent interception mask blocks stray clicks while the AI drives;
 * the AI panel shows the live action stream. All v4 capabilities remain
 * (eval guardrail, wait_for, fill_form, upload_file, programmatic downloads,
 * stores, crash rebuild, per-frame eval).
 * @module @picoaide/dsh-browser
 */

import { CdpSession } from './cdp.ts'
import { BROWSER_PARTITION, BROWSER_SHELL_TOOLBAR_HEIGHT, type ElectronAdapter, type NativeBrowserWindow, type NativeSession, type NativeView } from './electron-adapter.ts'
import { BrowserGuard, installPermissionGuard } from './guard.ts'
import { extractSnapshot, extractText } from './snapshot.ts'
import { captureScreenshot } from './shots.ts'
import { TabPool } from './pool.ts'
import { BrowserStore, type DownloadEntry, type HistoryEntry, type RecordActor } from './store.ts'
import { validateEvalExpression, wrapEvalExpression, serializeEvalResult } from './eval-policy.ts'
import { browserError, BrowserError } from './errors.ts'
import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
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
  favicon: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
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
  /** Overlay UI mode (capsule/panel/menu/viewer, or 'mask' while AI drives). */
  ui: { mode: OverlayMode | 'mask' }
}

/** State-change events emitted by the runtime (SSE stream). */
export type BrowserStreamEvent = 'state' | 'tab' | 'tab-meta' | 'busy' | 'takeover' | 'release' | 'ops'

/** Overlay UI modes (user-facing surfaces; the effective mode is forced to
 * 'mask' while the AI drives). */
export type OverlayMode = 'capsule' | 'panel' | 'menu' | 'viewer'

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
  /** AI-control overlay view (transparent, z-top): hosts the AI indicator
   * capsule, the activity panel, the ⋮ menu, the viewers and the busy-mask
   * pill. Its bounds follow the current UI mode (`overlayBounds`). */
  private overlay: NativeView | null = null
  /** User-chosen overlay mode (capsule/panel/menu/viewer); the effective mode
   * is forced to 'mask' while the AI drives (busy && !controlled). */
  private overlayMode: OverlayMode = 'capsule'
  /** Ledger tabs registered but not yet materialized into views (lazy
   * restore: the browser window must not pop up at app boot). */
  private pendingLedgerTabs: Array<{ tabId: number; url: string; title: string }> = []
  private materializing = false
  private materializeEpoch = 0
  private readonly guard: BrowserGuard
  private windowResizeDisposer: (() => void) | null = null
  private windowClosedDisposer: (() => void) | null = null
  private disposed = false
  private partition: string
  private readonly listeners = new Set<(event: BrowserStreamEvent) => void>()
  private shellOrigin: string | undefined
  private lastAgentId = ''
  readonly pool: TabPool
  store: BrowserStore

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
    if (mapped === 'busy' || mapped === 'takeover' || mapped === 'release') this.applyOverlay()
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

  /** Record the calling session id (oplog attribution).
   *
   * NOTE: this runs BEFORE the operation acquires the global mutex, so the
   * value is only a hint — `agentRun` snapshots it at call time and restores
   * it inside the critical section (a queued tool must never attribute its
   * ops to another agent that called `setAgentContext` in the meantime). */
  setAgentContext(agentId: string | undefined): void {
    this.lastAgentId = agentId ?? ''
  }

  /** Drop the op log (user switch / logout): a new account must never see the
   * previous account's browsing trail (host names, paths, token-bearing URLs).
   * The sequence counter resets too so the UI's "newest op" logic cannot keep
   * a stale high-water mark. */
  clearOps(): void {
    this.ops.length = 0
    this.opSeq = 0
    this.emitAll('ops')
  }

  listTabs(): BrowserTabState[] {
    return [...this.tabs.values()].map((tab) => this.projectTabState(tab))
  }

  shellState(): BrowserShellState {
    const tabs = [...this.tabs.values()].map((tab) => this.projectTabState(tab))
    return {
      tabs,
      window: this.windowState,
      controlled: this.pool.controlled,
      busy: this.pool.isBusy(),
      busyTool: this.pool.busyToolOf(),
      latestOp: this.ops.at(-1) ?? null,
      ui: { mode: this.effectiveOverlayMode() },
    }
  }

  latestOp(): BrowserOpLogEntry | null {
    return this.ops.at(-1) ?? null
  }

  /**
   * Restore the persisted tab ledger (lazy, Chrome-like session restore):
   * registry metadata is repopulated immediately; VIEWS are materialized on
   * first browser use (`ensureWindow`/`showWindow`) — restoring must never
   * pop the window at app boot or on a session switch.
   */
  restoreLedger(): void {
    const ledger = this.store.getGroupLedger()
    if (ledger === undefined) return
    const ledgerTabs = ledger.tabs ?? []
    this.pool.restoreLedger({
      version: 1,
      activeTabId: ledger.activeTabId,
      tabs: ledgerTabs,
      savedAt: ledger.savedAt ?? Date.now(),
    })
    let maxId = 0
    for (const item of ledgerTabs) {
      if (typeof item.tabId === 'number') maxId = Math.max(maxId, item.tabId)
    }
    this.nextTabId = Math.max(this.nextTabId, maxId + 1)
    this.pendingLedgerTabs = ledgerTabs
      .filter((item): item is { tabId: number; url: string; title: string } => typeof item.tabId === 'number')
      .map((item) => ({ tabId: item.tabId, url: item.url ?? '', title: item.title ?? '' }))
    this.relayout()
  }

  /** Materialize pending ledger tabs into real views (idempotent). Triggered
   * when the browser actually opens. Each restored tab goes through the SAME
   * serial mutex and tab-slot reservation as an agent `browser_open` (P2-26):
   * restoring must never bypass `maxTabs` or interleave with a live operation.
   * Restored tabs are attributed to `'restore'` (not `'ai'`) so they neither
   * steal the agent's attribution nor surface the window. A session switch /
   * closeAll bumps the epoch, cancelling any in-flight materialization so a
   * previous user's tabs can never resurrect under the new user's partition. */
  materializePendingTabs(): void {
    if (this.materializing) return
    const pending = this.pendingLedgerTabs
    if (pending.length === 0) return
    this.materializing = true
    const epoch = this.materializeEpoch
    void (async () => {
      try {
        for (const item of [...pending]) {
          if (epoch !== this.materializeEpoch || this.disposed) return
          if (this.tabs.has(item.tabId)) {
            this.pendingLedgerTabs = this.pendingLedgerTabs.filter((p) => p.tabId !== item.tabId)
            continue
          }
          try {
            // Quota semantics: restore consumes a tab slot like any other open
            // (tryReserveTab = fail-fast, no queue). When the pool is full the
            // remaining tabs STAY PENDING and are retried on the next
            // materialization attempt — restore never exceeds maxTabs.
            const created = await this.pool.withOperation('browser_restore', async () => {
              if (!this.pool.tryReserveTab()) return false
              try {
                await this.createTabReal(item.url, undefined, item.tabId, 'restore')
                return true
              } catch (error) {
                this.pool.releaseReservation()
                throw error
              }
            })
            if (!created) return
            if (epoch === this.materializeEpoch) {
              this.pendingLedgerTabs = this.pendingLedgerTabs.filter((p) => p.tabId !== item.tabId)
            }
          } catch (cause) {
            // A restored tab that fails to load is dropped (createTabReal's
            // error path already cleans view + registry meta). A user takeover
            // aborts materialization: the remaining tabs stay pending.
            this.pendingLedgerTabs = this.pendingLedgerTabs.filter((p) => p.tabId !== item.tabId)
            if (cause instanceof BrowserError && cause.code === 'window-controlled') return
          }
        }
      } finally {
        this.materializing = false
      }
      if (!this.disposed && epoch === this.materializeEpoch) {
        const ledger = this.store.getGroupLedger()
        if (ledger !== undefined && ledger.activeTabId !== undefined && this.pool.has(ledger.activeTabId)) {
          this.pool.setActiveTab(ledger.activeTabId)
        }
        this.relayout()
        this.saveLedger()
      }
    })()
  }

  /** Persist the tab ledger (host wires this on every state change). */
  saveLedger(): void {
    this.store.saveGroupLedger(this.pool.snapshotLedger())
  }

  /** Swap the partition used by NEW tab views (user switch) and the store. */
  setPartition(partition: string): void {
    this.partition = partition
  }

  /** Switch the per-user store (session change): re-point ledger/stores. */
  setStore(store: BrowserStore): void {
    this.store = store
  }

  // ------------------------------------------------------------ tab creation

  /** Set the loopback origin the shell/overlay pages are served from. */
  setShellOrigin(origin: string): void {
    this.shellOrigin = origin
  }

  /**
   * Open a tab (agent path: serial + quota wait under the user gate; user
   * path: fail-fast quota, gate bypassed).
   */
  async open(url: string | undefined, signal?: AbortSignal, user = false): Promise<BrowserTabState> {
    if (this.disposed) throw new Error('browser: runtime disposed')
    if (user) {
      if (!this.pool.tryReserveTab()) {
        throw browserError('quota', 'browser: tab limit reached — close a tab first')
      }
      try {
        return await this.createTabReal(url, signal, undefined, 'user')
      } catch (error) {
        this.pool.releaseReservation()
        throw error
      }
    }
    return await this.withAgentAttribution('browser_open', async () => {
      await this.pool.reserveTab(signal)
      try {
        return await this.createTabReal(url, signal, undefined, 'ai')
      } catch (error) {
        this.pool.releaseReservation()
        throw error
      }
    }, signal)
  }

  private async createTabReal(url: string | undefined, signal: AbortSignal | undefined, fixedId: number | undefined, actor: RecordActor): Promise<BrowserTabState> {
    const id = fixedId ?? this.nextTabId++
    const view = this.adapter.createView(this.partition)
    // Every CDP command is bounded by the tool budget: a wedged renderer
    // rejects the call instead of holding the global mutex forever (P0-4).
    const cdp = new CdpSession(view.webContents.cdp, { timeoutMs: this.options.timeoutMs })
    try {
      await cdp.attach()
    } catch (cause) {
      try { view.destroy() } catch { /* teardown never throws */ }
      throw cause
    }
    const tab: BrowserTab = { id, view, cdp, ownerSession: this.lastAgentId, url: '', title: '', favicon: '', loading: false, canGoBack: false, canGoForward: false, disposers: [] }
    this.tabs.set(id, tab)
    this.pool.registerTab(id, '', '')

    try {
      // User-created tabs (shell ＋) surface the window; agent-created tabs
      // and ledger restore keep it hidden (2026-09-08 product decision).
      const win = await this.ensureWindow(this.shellOrigin, actor === 'user')
      const bounds = this.contentBounds()
      view.attach(win, bounds)
      this.relayout()

      // `target=_blank` / window.open must not silently vanish (P2-30): open
      // the URL as a new tab through the normal agent path (quota, gate,
      // navigation policy, op log) and deny the native popup. A denied or
      // failed open is recorded as a failed op so the activity panel shows it.
      view.webContents.setWindowOpenHandler((details) => {
        const target = typeof details?.url === 'string' ? details.url : ''
        if (target === '' || !this.guard.allowNavigation(target)) {
          this.record('browser_window_open', id, `window.open denied: ${target}`, true)
          return { action: 'deny' }
        }
        this.record('browser_window_open', id, `window.open → new tab: ${target}`)
        void this.open(target).catch((cause: unknown) => {
          const message = cause instanceof Error ? cause.message : String(cause)
          this.record('browser_window_open', id, `window.open failed: ${message}`, true)
        })
        return { action: 'deny' }
      })

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
      view.webContents.on('page-favicon-updated', (_event: unknown, favicons: unknown) => {
        const first = Array.isArray(favicons) ? favicons[0] : undefined
        tab.favicon = typeof first === 'string' ? first : ''
        this.emitAll('tab-meta')
      })
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
      // Downloads are a session-level event with no tab identity: attribute
      // the op to whichever tab is active when it fires (falling back to the
      // registering tab). The guard itself is ref-counted per tab (P0-5).
      tab.disposers.push(this.guard.installDownloadGuard(session, (summary) => {
        this.record('browser_download', this.pool.activeTab ?? id, summary)
      }, this.downloadRecorder(), '', actor, this.options.downloadDir))

      if (url !== undefined && url !== '') {
        await this.navigateInternal(id, url, 'domcontentloaded', actor)
      }
      this.updateTabState(tab)
      this.record('browser_open', id, url === undefined || url === '' ? 'new tab' : url, false, actor)
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

  /** Re-layout tabs (active one visible) + place the AI overlay on top. */
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
    this.applyOverlay()
  }

  /** Effective overlay mode: the interception mask is the DEFAULT state —
   * the whole window is locked (idle OR busy) until the user explicitly clicks
   * 我来操作. Releasing control (交给 AI) re-arms the mask immediately, and it
   * stays armed even while the AI is idle (2026-09-07 product decision). */
  private effectiveOverlayMode(): OverlayMode | 'mask' {
    if (this.pool.controlled) return this.overlayMode
    return 'mask'
  }

  /** Overlay view bounds per mode. The view is always attached (z-top); its
   * rectangle defines what it owns/intercepts — outside it the page receives
   * input. */
  private overlayBounds(mode: OverlayMode | 'mask'): { x: number; y: number; width: number; height: number } {
    const size = this.window?.getContentSize() ?? { width: 0, height: 0 }
    const w = Math.max(0, size.width)
    const h = Math.max(0, size.height)
    switch (mode) {
      case 'mask':
        // Full window: the ONLY interaction is the 我来操作 pill — the
        // toolbar, tabs and the page are all locked behind it.
        return { x: 0, y: 0, width: w, height: h }
      case 'viewer':
        return { x: 0, y: BROWSER_SHELL_TOOLBAR_HEIGHT, width: w, height: Math.max(0, h - BROWSER_SHELL_TOOLBAR_HEIGHT) }
      case 'panel':
        return { x: Math.max(0, w - 340), y: 0, width: 340, height: h }
      case 'menu':
        // 6 items + separator: keep the rect short so the empty lower area
        // does not dead-block page clicks below the menu.
        return { x: Math.max(0, w - 240), y: BROWSER_SHELL_TOOLBAR_HEIGHT, width: 224, height: 244 }
      case 'capsule':
      default:
        // Compact capsule: right-aligned inside its own view, 16px from the
        // window edges; kept narrow so it blocks as little page as possible.
        return { x: Math.max(0, w - 188), y: Math.max(0, h - 50), width: 172, height: 34 }
    }
  }

  private applyOverlay(): void {
    if (this.overlay === null) return
    if (this.window === null || this.window.isDestroyed()) return
    const mode = this.effectiveOverlayMode()
    this.overlay.setBounds(this.overlayBounds(mode))
    this.overlay.moveToTop(this.window)
  }

  /** User-driven overlay mode switch (panel/menu/viewer/capsule). The mode is
   * recorded and takes effect once the AI stops driving (or immediately when
   * the user controls the window). */
  setOverlayMode(mode: OverlayMode): void {
    if (mode !== 'capsule' && mode !== 'panel' && mode !== 'menu' && mode !== 'viewer') return
    this.overlayMode = mode
    this.applyOverlay()
    this.emitAll('state')
    // Leaving a floating surface (menu/viewer) hands the keyboard back to the
    // shell toolbar so Ctrl+L/T/W/R keep working after overlay interactions.
    if (mode === 'capsule' && this.window !== null && !this.window.isDestroyed()) {
      this.window.focusPage()
    }
  }

  /**
   * Create (or return) the browser window. `show` is opt-in (2026-09-08
   * product decision): agent paths — boot prewarm, ledger restore, AI tab
   * creation — must never pop the window to the front after the user closed
   * it; only user paths (shell 浏览器 button, user-created tab) show it.
   */
  async ensureWindow(origin?: string, show = false): Promise<NativeBrowserWindow> {
    this.materializePendingTabs()
    if (this.window !== null && !this.window.isDestroyed()) {
      if (show) this.window.show()
      return this.window
    }
    const win = this.adapter.createBrowserWindow()
    if (show) win.show()
    this.window = win
    const overlay = this.adapter.createMaskView(this.partition)
    this.overlay = overlay
    overlay.attach(win, this.overlayBounds('capsule'))
    if (origin !== undefined) {
      void win.loadURL(`${origin}/browser-shell`).catch((cause: unknown) => {
        void win.loadURL(`${origin}/browser-shell`).catch(() => {
          console.error('[dsh-browser] shell page failed to load', cause)
        })
      })
      void overlay.webContents.loadURL(`${origin}/browser-overlay`).catch((cause: unknown) => {
        void overlay.webContents.loadURL(`${origin}/browser-overlay`).catch(() => {
          console.error('[dsh-browser] overlay page failed to load', cause)
        })
      })
    }
    this.applyOverlay()
    this.windowResizeDisposer = win.onResize(() => { this.relayout() })
    this.windowClosedDisposer = win.onClosed(() => {
      for (const tab of this.tabs.values()) {
        try {
          // Release the per-tab guards first: a real window close destroys
          // the views, so the ref-counted download guard must drop its refs
          // (P2-28) instead of leaking the session listener.
          this.releaseTabDisposers(tab.id)
          tab.cdp.detach()
          tab.view.destroy()
        } catch {
          // Teardown must never throw.
        }
      }
      this.tabs.clear()
      this.pool.clear()
      this.overlay = null
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
      await this.ensureWindow(this.shellOrigin, true)
      this.relayout()
      return
    }
    this.materializePendingTabs()
    this.window.show()
    this.relayout()
  }

  /**
   * Boot / session-switch prewarm (2026-09-08 product decision): bring the
   * browser up HIDDEN — window, restored ledger tabs and their CDP sessions —
   * so the agent can drive it before the user ever opens it, and so a user
   * close (which only hides the window) leaves a fully working background
   * browser. Never shows the window.
   */
  async prewarm(): Promise<void> {
    if (this.disposed) return
    await this.ensureWindow(this.shellOrigin, false)
    this.materializePendingTabs()
    this.relayout()
  }

  hideWindow(): void {
    if (this.window === null || this.window.isDestroyed()) return
    this.window.hide()
  }

  // ------------------------------------------------------------------- state

  private record(tool: string, tab: number, summary: string, failed = false, actor: RecordActor = 'ai'): void {
    const tabEntry = this.tabs.get(tab)
    this.ops.push({
      seq: ++this.opSeq,
      time: Date.now(),
      tool,
      tab,
      group: '',
      session: tabEntry?.ownerSession ?? '',
      actor,
      summary: maskBrowserSummary(summary),
      failed,
    })
    if (this.ops.length > OP_LOG_LIMIT) this.ops.shift()
    this.emitAll('ops')
  }

  private tab(id: number): BrowserTab {
    const tab = this.tabs.get(id)
    if (tab === undefined) {
      // A ledger-restored tab whose view was not materialized yet (lazy
      // restore): kick materialization and ask the caller to retry.
      if (this.pool.has(id)) {
        this.materializePendingTabs()
        throw browserError('not-found', `browser: tab ${id} is being restored — retry the operation`)
      }
      throw browserError('not-found', `browser: unknown tab ${id}`)
    }
    return tab
  }

  /** Resolve a tab id: explicit (must exist) or the pool's active tab. */
  resolveTab(tabId: number | undefined): number {
    if (this.pendingLedgerTabs.length > 0) this.materializePendingTabs()
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
    return this.projectTabState(tab)
  }

  private projectTabState(tab: BrowserTab): BrowserTabState {
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      visible: tab.id === this.pool.activeTab,
      favicon: tab.favicon,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
    }
  }

  private updateTabState(tab: BrowserTab): void {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return
    tab.url = wc.getURL()
    tab.title = wc.getTitle() || tab.url || ''
    tab.loading = wc.isLoading()
    try {
      tab.canGoBack = wc.canGoBack()
      tab.canGoForward = wc.canGoForward()
    } catch {
      // history introspection is best-effort
    }
    this.pool.updateTabMeta(tab.id, tab.url, tab.title)
    this.emitAll('tab-meta')
    this.refreshWindowTitle(tab)
  }

  /** Follow the active tab's page title in the native window caption. */
  private refreshWindowTitle(tab: BrowserTab): void {
    if (this.window === null || this.window.isDestroyed()) return
    if (tab.id !== this.pool.activeTab) return
    const title = tab.title !== '' ? tab.title : 'PicoAide 浏览器'
    this.window.setTitle(title === 'PicoAide 浏览器' ? title : `${title} — PicoAide 浏览器`)
  }

  private releaseTabDisposers(id: number): void {
    const tab = this.tabs.get(id)
    if (tab === undefined) return
    for (const dispose of tab.disposers) {
      try { dispose() } catch { /* 守卫释放失败不阻断关闭 */ }
    }
    tab.disposers.length = 0
  }

  /** Run one agent operation under the global serial mutex (user gate aware). */
  private async agentRun<T>(tool: string, body: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return await this.withAgentAttribution(tool, body, signal)
  }

  /**
   * Serial-mutex runner that keeps per-call agent attribution correct (P3):
   * `noteAgent` runs before the call, but a queued operation only acquires
   * the mutex later — by then another tool may have overwritten the global
   * `lastAgentId`. Snapshot the id at call time and restore it inside the
   * critical section so ops/tabs are attributed to the agent that issued them.
   */
  private async withAgentAttribution<T>(tool: string, body: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const callerAgent = this.lastAgentId
    return await this.pool.withOperation(tool, async () => {
      const previous = this.lastAgentId
      this.lastAgentId = callerAgent
      try {
        return await body()
      } finally {
        this.lastAgentId = previous
      }
    }, signal)
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
    if (waitUntil !== 'domcontentloaded') {
      // 'load' settles on did-finish-load (or immediately when already done);
      // 'networkidle' waits a quiet window (800ms) after the last load event.
      const budget = Math.max(0, this.options.timeoutMs - (Date.now() - started))
      await this.waitForLoad(wc, waitUntil)(Math.min(budget, Math.max(0, this.options.loadTimeoutMs)))
    }
    this.updateTabState(tab)
    this.record('browser_navigate', id, `navigate: ${url.slice(0, 200)}`, false, actor)
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
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        const settle = (): void => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        }
        const scheduleIdle = (): void => {
          if (idleTimer !== undefined) return
          idleTimer = setTimeout(settle, NETWORK_IDLE_TICK_MS)
          idleTimer.unref?.()
        }
        const cleanup = (): void => {
          wc.removeListener('dom-ready', onDomReady)
          wc.removeListener('did-finish-load', onFinish)
          clearTimeout(timer)
          if (idleTimer !== undefined) clearTimeout(idleTimer)
        }
        const onDomReady = (): void => {
          if (waitUntil === 'domcontentloaded') settle()
        }
        const onFinish = (): void => {
          if (waitUntil === 'load') settle()
          if (waitUntil === 'networkidle') scheduleIdle()
        }
        wc.on('dom-ready', onDomReady)
        wc.on('did-finish-load', onFinish)
        const timer = setTimeout(settle, Math.max(0, deadline - Date.now()))
        timer.unref?.()
        if (waitUntil !== 'domcontentloaded' && !wc.isLoading()) {
          if (waitUntil === 'networkidle') scheduleIdle()
          else settle()
        }
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
      this.record('browser_reload', tabId, `reload tab ${tabId}`, false, user ? 'user' : 'ai')
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
      this.record('browser_go_back', tabId, `back to ${tab.url}`, false, user ? 'user' : 'ai')
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
      this.record('browser_go_forward', tabId, `forward to ${tab.url}`, false, user ? 'user' : 'ai')
    }
    if (user) return await body()
    return await this.agentRun('browser_go_forward', body, signal)
  }

  /** Switch the pool's active tab. */
  async switchTab(tabId: number, user = false, signal?: AbortSignal): Promise<void> {
    const body = async (): Promise<void> => {
      this.materializePendingTabs()
      this.pool.setActiveTab(tabId)
      this.relayout()
      const switched = this.tabs.get(tabId)
      if (switched !== undefined) this.refreshWindowTitle(switched)
      this.record('browser_switch_tab', tabId, `switch to tab ${tabId}`, false, user ? 'user' : 'ai')
    }
    if (user) return await body()
    return await this.agentRun('browser_switch_tab', body, signal)
  }

  async closeTab(tabId: number, user = false, signal?: AbortSignal): Promise<void> {
    const body = async (): Promise<void> => {
      this.destroyTab(tabId)
      this.relayout()
      this.record('browser_close_tab', tabId, `close tab ${tabId}`, false, user ? 'user' : 'ai')
    }
    if (user) return await body()
    return await this.agentRun('browser_close_tab', body, signal)
  }

  private destroyTab(id: number): void {
    const tab = this.tabs.get(id)
    if (tab !== undefined) {
      try {
        tab.cdp.detach()
        tab.view.detach()
        tab.view.destroy()
      } catch { /* teardown never throws */ }
      this.releaseTabDisposers(id)
      this.tabs.delete(id)
    }
    // Drop the registry entry even when no view exists (restored ledger tabs
    // in a failed-materialization state must never become un-closable).
    this.pool.removeTab(id)
  }

  /** Close everything (session switch / shell 清除). */
  async closeAll(user = false): Promise<void> {
    const body = async (): Promise<void> => {
      // Cancel in-flight ledger materialization (a previous user's restore
      // must not resurrect tabs after the pool was cleared).
      this.materializeEpoch++
      this.pendingLedgerTabs = []
      for (const id of [...this.tabs.keys()]) this.destroyTab(id)
      this.pool.clear()
      this.relayout()
      this.record('browser_close', 0, 'close browser (all tabs)', false, user ? 'user' : 'ai')
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
    let data: string
    try {
      data = await this.agentRun('browser_screenshot', async () => {
        const tab = this.tab(resolved)
        return await captureScreenshot(tab.view.webContents, this.options.screenshotMaxWidth, this.options.screenshotQuality)
      }, signal)
    } catch (cause) {
      // An empty capture (hidden window / background tab / zero-sized view)
      // must be a visible failure, never a silent 0-byte "screenshot" (P2-31).
      const message = cause instanceof Error ? cause.message : String(cause)
      this.record('browser_screenshot', resolved, `screenshot failed: ${message}`, true)
      throw cause
    }
    this.record('browser_screenshot', resolved, 'screenshot captured')
    return data
  }

  /** Eval guardrail (heuristic AST policy + result masking). The validator is
   * a misuse guardrail, NOT a security boundary: the AI is allowed to operate
   * every part of the browser (fetch/XHR/arbitrary JS included). */
  async eval(tabId: number, expression: string, frame?: number, signal?: AbortSignal): Promise<string> {
    if (!this.options.evalEnabled) {
      throw browserError('policy', 'browser: browser_eval is disabled in this deployment')
    }
    if (typeof frame === 'number' && frame < 0) {
      throw browserError('not-found', 'browser: frame index must be >= 0')
    }
    validateEvalExpression(expression)
    const resolved = this.resolveTab(tabId)
    const result = await this.agentRun('browser_eval', async () => {
      const tab = this.tab(resolved)
      const frameParams = typeof frame === 'number' && frame > 0 ? { contextId: await this.frameContextId(tab, frame) } : undefined
      const evalResult = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: wrapEvalExpression(expression),
        returnByValue: true,
        // awaitPromise: true — a Promise result (fetch/XHR/async expression)
        // must be awaited by the renderer and serialized as its resolved value
        // (P1-20). With `false` CDP returned `{}` for every promise, so the AI
        // could issue requests but never read a response. The page-side
        // `timeout` below and the CDP transport timeout (P0-4) bound a never-
        // settling promise.
        awaitPromise: true,
        timeout: Math.min(this.options.timeoutMs, 10_000),
        ...frameParams,
      })
      if (evalResult.exceptionDetails !== undefined) {
        throw browserError('eval-policy', 'browser: page script failed (exception)')
      }
      return serializeEvalResult(evalResult.result?.value)
    }, signal)
    this.record('browser_eval', resolved, `eval: ${expression.slice(0, 60)}`)
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
            const wanted = ${JSON.stringify(value)};
            el.value = wanted;
            // Assigning an unknown value silently falls back to '' (or the
            // first option). Report it instead of claiming success (P2-32).
            if (el.value !== wanted) return { error: 'option not found: ' + wanted };
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

  /** Upload files through CDP (no native dialog). Every path is vetted
   * against the allowed directories (downloads dir + session workspace) —
   * arbitrary local file uploads are refused. */
  async uploadFile(tabId: number, paths: string[], signal?: AbortSignal, allowedDirs?: string[]): Promise<{ uploaded: number }> {
    if (allowedDirs === undefined || allowedDirs.length === 0) {
      throw browserError('policy', 'browser: upload_file is not allowed in this deployment (no allowed directories)')
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      throw browserError('policy', 'browser: upload_file requires at least one path')
    }
    const vetted = paths.map((p) => this.assertAllowedUploadPath(p, allowedDirs))
    const resolved = this.resolveTab(tabId)
    const outcome = await this.agentRun('browser_upload_file', async () => {
      const tab = this.tab(resolved)
      const doc = await tab.cdp.send<{ root?: { nodeId?: number } }>('DOM.getDocument')
      const rootId = doc.root?.nodeId
      if (rootId === undefined) throw browserError('not-found', 'browser: cannot resolve document')
      const query = await tab.cdp.send<{ nodeId?: number }>('DOM.querySelector', { nodeId: rootId, selector: 'input[type=file]' })
      if (query.nodeId === undefined) throw browserError('not-found', 'browser: no file input found on this page')
      await tab.cdp.send('DOM.setFileInputFiles', { nodeId: query.nodeId, files: vetted })
      return { uploaded: vetted.length }
    }, signal)
    this.record('browser_upload_file', resolved, `upload ${vetted.length} file(s)`)
    return outcome
  }

  /** Canonicalize + verify one upload path against the allowed directories
   * (realpath when the file exists; symlinks are resolved). */
  private assertAllowedUploadPath(path: string, allowedDirs: string[]): string {
    if (typeof path !== 'string' || path.trim() === '') {
      throw browserError('policy', 'browser: upload path must be a non-empty string')
    }
    let absolute: string
    try {
      absolute = realpathSync(path)
    } catch {
      absolute = resolve(path)
    }
    for (const dir of allowedDirs) {
      if (typeof dir !== 'string' || dir.trim() === '') continue
      let dirAbs: string
      try {
        dirAbs = realpathSync(dir)
      } catch {
        dirAbs = resolve(dir)
      }
      if (absolute === dirAbs || absolute.startsWith(dirAbs + sep)) return absolute
    }
    throw browserError('policy', 'browser: upload path is outside the allowed directories (downloads dir + session workspace)')
  }

  /** Wait for a page condition. */
  async waitFor(tabId: number, options: WaitForOptions, signal?: AbortSignal): Promise<{ ok: boolean; reason: string }> {
    const resolved = this.resolveTab(tabId)
    const timeout = Math.min(options.timeoutMs ?? Math.min(this.options.timeoutMs, 30_000), 120_000)
    const deadline = Date.now() + timeout
    return await this.agentRun('browser_wait_for', async () => {
      const tab = this.tab(resolved)
      const startUrl = tab.url
      let lastReason = 'timeout'
      while (Date.now() < deadline) {
        if (signal !== undefined && signal.aborted) throw browserError('interrupted', 'browser: wait aborted')
        try {
          const state = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
            expression: evalExpressionFor(options, startUrl),
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
  static waitExpression(options: WaitForOptions, startUrl = ''): string {
    return evalExpressionFor(options, startUrl)
  }

  // -------------------------------------------------------------- user gate

  /** User takeover / release (whole window). Actor: 'user' on shell/button
   * paths, 'ai' for the browser_takeover/browser_release tools. No-op changes
   * are not recorded (the gate is idempotent). */
  setUserControl(active: boolean, actor: RecordActor = 'user'): void {
    const was = this.pool.controlled
    this.pool.setUserControl(active)
    if (was === this.pool.controlled) return
    if (active) {
      this.record('browser_takeover', 0, 'user took over the browser', false, actor)
    } else {
      this.record('browser_release', 0, 'user released browser control', false, actor)
    }
  }

  // ------------------------------------------------------------- data (P1)

  addBookmark(tabId: number, title?: string, actor: RecordActor = 'ai'): { id: number; url: string; title: string } {
    const resolved = this.resolveTab(tabId)
    const tab = this.tab(resolved)
    const entry = this.store.addBookmark({
      url: tab.url,
      title: title ?? tab.title,
      actor,
      group: '',
    })
    this.record('browser_bookmarks_add', resolved, `bookmark ${entry.title}`, false, actor)
    return { id: entry.id, url: entry.url, title: entry.title }
  }

  listBookmarks(filter: { q?: string | undefined; limit?: number | undefined } = {}): ReturnType<BrowserStore['queryBookmarks']> {
    return this.store.queryBookmarks(filter)
  }

  removeBookmark(id: number): boolean {
    return this.store.removeBookmark(id)
  }

  history(filter: { q?: string | undefined; limit?: number | undefined; group?: string | undefined } = {}): HistoryEntry[] {
    const { group, ...rest } = filter
    return this.store.queryHistory({ ...rest, group: group !== undefined && group !== '' ? group : undefined })
  }

  downloads(filter: { status?: DownloadEntry['status'] | undefined; limit?: number | undefined } = {}): DownloadEntry[] {
    return this.store.queryDownloads(filter)
  }

  removeDownload(id: number): boolean {
    return this.store.removeDownload(id)
  }

  /** Open a downloaded file with the OS default handler (downloads viewer). */
  async openDownloadPath(id: number): Promise<{ ok: boolean; error?: string }> {
    const entry = this.store.queryDownloads({ limit: 500 }).find((d) => d.id === id)
    if (entry === undefined) throw browserError('not-found', 'browser: unknown download')
    if (entry.path === '' || entry.status !== 'done') {
      throw browserError('not-found', 'browser: this download has no finished file to open')
    }
    const result = await this.adapter.openPath(entry.path)
    this.record('browser_download_open', 0, `open download: ${entry.path}`)
    return result.error === undefined ? { ok: true } : { ok: false, error: result.error }
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
    if (!this.guard.allowNavigation(url)) {
      throw browserError('navigation-blocked', `browser: download denied — ${url.slice(0, 200)}`)
    }
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
      await this.clearSessionData(session, all)
    }
    if (seen.size === 0) {
      // No tab has materialized yet (lazy restore / never opened): the
      // partition still holds cookies+storage from previous runs, so a silent
      // no-op here is a lie (P2-28). Clear the known partition through the
      // adapter when it can resolve a session; otherwise fail loudly.
      const session = this.adapter.getSession?.(this.partition)
      if (session === undefined) {
        throw browserError('not-found', 'browser: no browser session yet — open a tab first, then clear data')
      }
      seen.add(session)
      await this.clearSessionData(session, all)
    }
    this.record('browser_clear_data', 0, `clear browsing data (${all ? '全部' : '站点'})`)
  }

  private async clearSessionData(session: NativeSession, all: boolean): Promise<void> {
    if (all) {
      await session.clearStorageData()
      await session.clearCache()
      return
    }
    await session.clearStorageData({ storages: ['localstorage', 'cachestorage', 'indexdb', 'websql', 'serviceworkers'] })
    await session.clearCache()
  }

  // --------------------------------------------------------------- teardown

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.materializeEpoch++
    this.pendingLedgerTabs = []
    for (const id of [...this.tabs.keys()]) {
      // Releasing the per-tab disposers (permission guard + ref-counted
      // download guard) matters: a dropped ref-count keeps the download
      // listener installed forever (P2-28).
      this.releaseTabDisposers(id)
      const tab = this.tabs.get(id)
      if (tab !== undefined) {
        try {
          tab.cdp.detach()
          tab.view.destroy()
        } catch {
          // Teardown must never throw.
        }
      }
    }
    this.tabs.clear()
    this.windowResizeDisposer?.()
    this.windowClosedDisposer?.()
    if (this.window !== null && !this.window.isDestroyed()) this.window.close()
    this.window = null
    this.overlay = null
    this.pool.dispose()
    this.listeners.clear()
  }
}

/** Build the wait-for evaluation expression (pure function). The `startUrl`
 * is the URL captured when the wait began — `url-change` compares against it
 * so the condition only succeeds on an ACTUAL navigation. */
function evalExpressionFor(options: WaitForOptions, startUrl = ''): string {
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
      // TRUE only when the page actually navigated away from the captured URL.
      return `(() => location.href !== ${JSON.stringify(startUrl)})()`
    case 'network-idle':
      // TRUE once the last resource has been quiet for at least 800ms (or the
      // document is already complete with no resource entries at all).
      return `(() => { const rs = performance.getEntriesByType('resource'); if (rs.length === 0) return document.readyState === 'complete'; const last = rs[rs.length - 1]; return performance.now() - (last.responseEnd || 0) > ${String(NETWORK_IDLE_TICK_MS)}; })()`
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
