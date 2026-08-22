/**
 * BrowserRuntime: the embedded agent-driven browser service. Owns the tab
 * pool (one WebContentsView per tab), the CDP sessions, the agent/user
 * control mutex, navigation, interaction primitives, guards, and the audit
 * op log. Everything Electron-specific flows through the injected adapter,
 * so the whole service is unit-testable headlessly.
 * @module @picoaide/dsh-browser
 */

import { CdpSession } from './cdp.ts'
import { BROWSER_PARTITION, BROWSER_SHELL_TOOLBAR_HEIGHT, type ElectronAdapter, type NativeBrowserWindow, type NativeSession, type NativeView } from './electron-adapter.ts'
import { BrowserGuard, installPermissionGuard } from './guard.ts'
import { extractSnapshot, extractText } from './snapshot.ts'
import { captureScreenshot } from './shots.ts'
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
export const DEFAULT_TIMEOUT_MS = 30_000
/** Default cap on waiting for Electron's loadURL promise (ms). */
export const DEFAULT_LOAD_TIMEOUT_MS = 20_000
/** Maximum simultaneous tabs. */
export const DEFAULT_MAX_TABS = 8
/** Op-log ring size. */
const OP_LOG_LIMIT = 200

interface BrowserTab {
  readonly id: number
  readonly view: NativeView
  readonly cdp: CdpSession
  url: string
  title: string
  loading: boolean
}

/** One evaluation result from the page (CDP value). */
interface EvalResult {
  result?: { value?: unknown; type?: string }
  exceptionDetails?: unknown
}

/** A promise-queue mutex that also honors user takeover. */
class ControlMutex {
  private tail: Promise<void> = Promise.resolve()
  private taken = false
  /** Resolved when the current takeover ends (recreated on each take). */
  private released: Promise<void> = Promise.resolve()
  private releaseTaken!: () => void

  /**
   * Run `work` while holding the browser control. When the user takes over,
   * the call PAUSES (the whole agent loop blocks on this promise) until the
   * takeover is released; `signal` (the agent step's abort signal) exits the
   * wait when the agent is stopped or a tool deadline fires.
   */
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const prev = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await prev
    // Pause the loop while the user controls the browser.
    while (this.taken) {
      if (signal !== undefined && signal.aborted) {
        release()
        throw new Error('browser: agent was stopped while the user controlled the browser')
      }
      // Wait for release or abort; the abort listener is removed after the
      // race so repeated takeover/release cycles do not leak listeners.
      await new Promise<void>((resolveWait) => {
        let done = false
        const settle = (): void => {
          if (done) return
          done = true
          if (signal !== undefined) signal.removeEventListener('abort', onAbort)
          resolveWait()
        }
        const onAbort = (): void => settle()
        if (signal !== undefined) {
          if (signal.aborted) return settle()
          signal.addEventListener('abort', onAbort, { once: true })
        }
        void this.released.then(settle)
      })
    }
    try {
      return await work()
    } finally {
      release()
    }
  }

  /** User takeover: block agent operations until released. */
  take(): void {
    this.taken = true
    this.released = new Promise<void>((resolve) => { this.releaseTaken = resolve })
  }

  release(): void {
    if (!this.taken) return
    this.taken = false
    this.releaseTaken()
  }

  get controlled(): boolean {
    return this.taken
  }
}

/**
 * The embedded browser service. Constructed by the plugin with the real
 * adapter; tests inject a mock adapter plus a fake approval asker.
 */
export class BrowserRuntime {
  private readonly tabs = new Map<number, BrowserTab>()
  private nextTabId = 1
  private visibleTabId: number | undefined
  private readonly mutex = new ControlMutex()
  /** Loopback origin serving the shell/mask pages (set by the plugin). */
  private shellOrigin: string | undefined
  private readonly ops: BrowserOpLogEntry[] = []
  private opSeq = 0
  private window: NativeBrowserWindow | null = null
  private mask: NativeView | null = null
  private readonly guard: BrowserGuard
  private readonly permissionsDisposers: Array<() => void> = []
  private readonly downloadDisposers: Array<() => void> = []
  private windowResizeDisposer: (() => void) | null = null
  private windowClosedDisposer: (() => void) | null = null
  private disposed = false
  /** Partition name used for newly created tab views (per-user). */
  private partition: string
  /** Whether an agent browser operation is currently in flight (mask status). */
  private busy = false
  /** The agent tool currently executing ('' when idle). */
  private busyTool = ''

  constructor(
    private readonly adapter: ElectronAdapter,
    options: BrowserToolOptions = {},
    askApproval?: BrowserGuard['askApproval'],
    private readonly credentials?: CredentialResolver,
    partition?: string,
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
    }
    this.guard = new BrowserGuard(adapter, askApproval)
    this.partition = partition ?? BROWSER_PARTITION
  }

  /** Swap the partition used by NEW tab views (user switch). Existing tabs
   * keep their partition; callers close all tabs first. */
  setPartition(partition: string): void {
    this.partition = partition
  }

  readonly options: Required<BrowserToolOptions>

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

  /** Snapshot of all tabs. */
  listTabs(): BrowserTabState[] {
    return [...this.tabs.values()].map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      visible: tab.id === this.visibleTabId,
    }))
  }

  get controlled(): boolean {
    return this.mutex.controlled
  }

  /** Whether an agent browser operation is running right now. */
  get isBusy(): boolean {
    return this.busy
  }

  /** The agent tool currently executing ('' when idle). */
  get busyToolName(): string {
    return this.busyTool
  }

  /** Latest completed agent operation (mask "recent activity" line). */
  get latestOp(): BrowserOpLogEntry | undefined {
    return this.ops.at(-1)
  }

  /** Id of the visible tab, or undefined when none is open. */
  currentTabId(): number | undefined {
    return this.visibleTabId
  }

  /** Public tab state (throws for unknown ids). */
  tabState(id: number): BrowserTabState {
    return this.tabStateInternal(id)
  }

  /** Route a sensitive-action approval through the guard. */
  async requireApproval(request: Parameters<BrowserGuard['askApproval']>[0]): Promise<boolean> {
    return await this.guard.requireApproval(request)
  }

  /** Content-area bounds below the shell toolbar (DIP). */
  private contentBounds(): { x: number; y: number; width: number; height: number } {
    const size = this.window?.getContentSize() ?? { width: 0, height: 0 }
    return {
      x: 0,
      y: BROWSER_SHELL_TOOLBAR_HEIGHT,
      width: Math.max(0, size.width),
      height: Math.max(0, size.height - BROWSER_SHELL_TOOLBAR_HEIGHT),
    }
  }

  /** Re-layout every tab view + the mask over the window content area. */
  private relayout(): void {
    const bounds = this.contentBounds()
    for (const tab of this.tabs.values()) {
      tab.view.setBounds(bounds)
      tab.view.setVisible(tab.id === this.visibleTabId)
    }
    if (this.mask !== null) {
      this.mask.setBounds(bounds)
      // The mask must always sit on TOP of every tab view. Electron's
      // WebContentsView z-order follows attach order, but `loadURL`/reload
      // and re-layouts can re-stack child views; re-attaching the mask
      // (remove + add) is the only reliable way to keep it above the tabs.
      // setVisible alone does NOT change z-order (verified 2026-08-21).
      if (this.window !== null && !this.window.isDestroyed()) {
        this.mask.moveToTop(this.window)
      }
      this.applyMaskVisibility()
    }
  }

  /**
   * Mask visibility policy: the AI-control overlay stays over the content
   * area whenever the agent holds control (i.e. the user has NOT taken
   * over). It is TRANSLUCENT (the mask view is created with `transparent:
   * true`, see electron-adapter.ts) so the user can see exactly what the AI
   * is doing, and it displays the in-flight tool + recent operations. When
   * the user takes over the overlay hides; releasing restores it.
   */
  private applyMaskVisibility(): void {
    if (this.mask === null) return
    this.mask.setVisible(!this.mutex.controlled)
  }

  /**
   * Ensure the dedicated browser window exists and is shown. Creating the
   * window also loads the control-shell page and mounts the AI-control mask.
   * @param origin - the loopback webServer origin (e.g. `http://127.0.0.1:33407`)
   *   the shell/mask pages are served from; without it the window cannot load
   *   them (Electron needs absolute URLs).
   */
  async ensureWindow(origin?: string): Promise<NativeBrowserWindow> {
    if (this.window !== null && !this.window.isDestroyed()) {
      this.window.show()
      return this.window
    }
    const win = this.adapter.createBrowserWindow()
    this.window = win
    // The mask overlays the content area while the agent controls the
    // browser; it is attached LAST so it sits above every tab view.
    const mask = this.adapter.createMaskView()
    this.mask = mask
    mask.attach(win, this.contentBounds())
    if (origin !== undefined) {
      // P1-14: never leave an unhandled rejection when the shell/mask page
      // fails to load (loopback port quirk, navigation abort) — a swallowed
      // failure would leave a blank window with no hint.
      void mask.webContents.loadURL(`${origin}/browser-mask`).catch((cause: unknown) => {
        void mask.webContents.loadURL(`${origin}/browser-mask`).catch(() => {
          console.error('[dsh-browser] mask page failed to load', cause)
        })
      })
      void win.loadURL(`${origin}/browser-shell`).catch((cause: unknown) => {
        void win.loadURL(`${origin}/browser-shell`).catch(() => {
          console.error('[dsh-browser] shell page failed to load', cause)
        })
      })
    }
    // P1-14: the mask must reflect the real control state on first render.
    // The overlay follows the takeover state: while the agent holds control
    // it is shown (translucent, so the page below stays visible — verified
    // 2026-08-22), and it hides the moment the user takes over so the page
    // is fully interactive. A user opening the window from the sidebar while
    // the agent is idle sees the live page through the translucent scrim.
    this.applyMaskVisibility()
    this.windowResizeDisposer = win.onResize(() => { this.relayout() })
    this.windowClosedDisposer = win.onClosed(() => {
      // The window is truly gone (agent close or app quit): drop all tabs.
      for (const tab of this.tabs.values()) {
        try {
          tab.cdp.detach()
          tab.view.destroy()
        } catch {
          // Teardown must never throw.
        }
      }
      this.tabs.clear()
      this.visibleTabId = undefined
      this.mask = null
      this.windowResizeDisposer?.()
      this.windowClosedDisposer?.()
      this.windowResizeDisposer = null
      this.windowClosedDisposer = null
      this.window = null
    })
    return win
  }

  /** Set the loopback origin the shell/mask pages are served from. */
  setShellOrigin(origin: string): void {
    this.shellOrigin = origin
  }

  /** Show the browser window (wake from a user close; the sidebar trigger).
   * When the window has never been created (sidebar clicked before any agent
   * open), create it now — the shell loads with an empty tab strip and the
   * 「+」 button starts the first tab. */
  async showWindow(): Promise<void> {
    if (this.window === null || this.window.isDestroyed()) {
      // P1-14: the cold path must lay out the view stack (mask on/off, tabs)
      // — otherwise the mask stays at its initial state and the content
      // area is mis-sized.
      await this.ensureWindow(this.shellOrigin)
      this.relayout()
      return
    }
    this.window.show()
    this.relayout()
  }

  /** Hide the browser window without destroying tabs (user close semantics). */
  hideWindow(): void {
    if (this.window === null || this.window.isDestroyed()) return
    this.window.hide()
  }

  private record(tool: string, tab: number, summary: string, failed = false): void {
    // P2-1: redact credential-shaped material from the op log — the summary
    // can carry full URLs whose query may embed tokens/codes.
    this.ops.push({ seq: ++this.opSeq, time: Date.now(), tool, tab, summary: maskBrowserSummary(summary), failed })
    if (this.ops.length > OP_LOG_LIMIT) this.ops.shift()
  }

  /** Resolve a tab by id; throws with a model-facing message. */
  private tab(id: number): BrowserTab {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error(`browser: unknown tab ${id}`)
    return tab
  }

  private updateTabState(tab: BrowserTab): void {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return
    tab.url = wc.getURL()
    tab.title = wc.getTitle() || tab.url || ''
    tab.loading = wc.isLoading()
  }

  /**
   * Create a tab and optionally navigate it. The first tab becomes visible.
   * Runs under the control mutex so a user takeover also pauses tab opening
   * (and the agent's abort signal can cancel it while paused); the shell
   * toolbar's own `+` button passes `user=true` and bypasses the mutex.
   */
  async open(url: string | undefined, signal?: AbortSignal, user = false): Promise<BrowserTabState> {
    const body = async (): Promise<BrowserTabState> => {
      if (this.disposed) throw new Error('browser: runtime disposed')
      if (this.tabs.size >= this.options.maxTabs) {
        throw new Error(`browser: tab limit reached (${this.options.maxTabs}); close a tab first`)
      }
      const id = this.nextTabId++
      const view = this.adapter.createView(this.partition)
      const cdp = new CdpSession(view.webContents.cdp)
      // P1-14: if CDP attach fails (debugger already occupied, teardown
      // race), the freshly created view must be destroyed — otherwise a
      // repeated failure leaks WebContentsViews and starves the tab pool.
      try {
        await cdp.attach()
      } catch (cause) {
        try { view.destroy() } catch { /* teardown never throws */ }
        throw cause
      }
      const tab: BrowserTab = { id, view, cdp, url: '', title: '', loading: false }
      this.tabs.set(id, tab)

      // The dedicated browser window is created (and shown) on first open.
      const win = await this.ensureWindow(this.shellOrigin)
      const bounds = this.contentBounds()
      view.attach(win, bounds)
      view.setVisible(true)
      this.visibleTabId = id
      this.relayout()

      view.webContents.on('did-start-loading', () => { tab.loading = true })
      view.webContents.on('did-stop-loading', () => {
        tab.loading = false
        this.updateTabState(tab)
      })
      view.webContents.on('did-navigate', () => this.updateTabState(tab))
      view.webContents.on('page-title-updated', () => this.updateTabState(tab))

      const session = view.webContents.session
      this.permissionsDisposers.push(installPermissionGuard(session))
      this.downloadDisposers.push(this.guard.installDownloadGuard(session, (summary) => {
        this.record('browser_download', id, summary)
      }))

      if (url !== undefined && url !== '') {
        try {
          await this.navigateInternal(id, url, 'domcontentloaded')
        } catch (cause) {
          // P1-14: a navigation failure must not leave a half-baked tab in
          // the pool (it would consume a slot and confuse the tab strip).
          try {
            cdp.detach()
            view.destroy()
          } catch { /* teardown never throws */ }
          this.tabs.delete(id)
          if (this.visibleTabId === id) this.visibleTabId = undefined
          throw cause
        }
      }
      this.updateTabState(tab)
      this.record('browser_open', id, url === undefined || url === '' ? 'new tab' : url)
      return this.tabState(id)
    }
    if (user) return await body()
    return await this.agentRun('browser_open', body, signal)
  }

  private tabStateInternal(id: number): BrowserTabState {
    const tab = this.tab(id)
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      visible: tab.id === this.visibleTabId,
    }
  }

  /** Run one agent operation under the control mutex. Passes the agent's
   * abort signal so a takeover pauses the loop until release (or the agent
   * stops). While the operation is in flight, `isBusy`/`busyToolName` expose
   * it to the mask overlay ("AI is currently doing X").
   *
   * `summary` (when given) is recorded in the op log on success so the
   * overlay's "recent activity" line shows what the agent actually did. */
  async withControl<T>(tool: string, tabId: number, work: (tab: BrowserTab) => Promise<T>, signal?: AbortSignal, summary?: string): Promise<T> {
    return await this.agentRun(tool, async () => {
      const tab = this.tab(tabId)
      const result = await work(tab)
      this.updateTabState(tab)
      if (summary !== undefined) this.record(tool, tabId, summary)
      return result
    }, signal)
  }

  /** Run `body` under the control mutex while flagging the in-flight agent
   * tool (mask status). The flag covers the whole wait incl. a user
   * takeover pause; it clears only when the operation truly finishes. */
  private async agentRun<T>(tool: string, body: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.busy = true
    this.busyTool = tool
    try {
      return await this.mutex.run(body, signal)
    } finally {
      this.busy = false
      this.busyTool = ''
    }
  }

  /**
   * Navigate the tab to `url`, waiting per `waitUntil`.
   *
   * Electron's `loadURL` promise settles on `did-finish-load`, which pages
   * with long-lived connections (polls, SSE, analytics) can delay well past
   * the page being interactive. Racing it against `loadTimeoutMs` keeps the
   * tool call from dying on the cooperative 30s budget while the page is
   * already usable; once the load promise settles (or the race times out),
   * `domcontentloaded`/`load` are guaranteed satisfied (did-finish-load is
   * strictly after dom-ready) and only `networkidle` needs an extra quiet
   * tick. `user=true` (address bar) bypasses the takeover mutex.
   */
  async navigate(id: number, url: string, waitUntil: BrowserWaitUntil = 'domcontentloaded', signal?: AbortSignal, user = false): Promise<void> {
    const body = async (): Promise<void> => {
      await this.navigateInternal(id, url, waitUntil)
    }
    if (user) return await body()
    // Pause the agent loop while the user controls the browser.
    await this.agentRun('browser_navigate', body, signal)
  }

  /** Navigation body without mutex acquisition (used by open and navigate). */
  private async navigateInternal(id: number, url: string, waitUntil: BrowserWaitUntil): Promise<void> {
    if (!this.guard.allowNavigation(url)) {
      throw new Error(`browser: navigation denied — ${url.slice(0, 200)}`)
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
      // A failed load may still leave a usable page (partial render); only
      // report it when the webContents shows nothing loaded at all.
      if (!wc.isLoading() && wc.getURL() === '') {
        throw new Error('browser: navigation failed to load')
      }
    }
    if (waitUntil === 'networkidle') {
      const budget = Math.max(0, this.options.timeoutMs - (Date.now() - started))
      await sleep(Math.min(NETWORK_IDLE_TICK_MS, budget))
    }
    this.updateTabState(tab)
    this.record('browser_navigate', id, `navigate: ${url.slice(0, 200)}`)
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
            // One extra quiet tick approximates network idle without a full
            // Network-domain state machine.
            const idle = setTimeout(settle, 800)
            idle.unref?.()
          }
        }
        wc.on('dom-ready', onDomReady)
        wc.on('did-finish-load', onFinish)
        const timer = setTimeout(settle, Math.max(0, deadline - Date.now()))
        timer.unref?.()
        if (waitUntil !== 'domcontentloaded' && !wc.isLoading()) settle()
        // An idle, empty (about:blank-style) page never emits dom-ready after
        // a reload; treat it as loaded so `reload`/`goBack` on a blank tab do
        // not burn the full timeout budget.
        if (waitUntil === 'domcontentloaded' && wc.isLoading() === false) settle()
      })
    }
  }

  /** Extract the interactable-element snapshot of one tab. */
  async snapshot(id: number, signal?: AbortSignal): Promise<BrowserSnapshotElement[]> {
    const elements = await this.withControl('browser_get_snapshot', id, (tab) =>
      extractSnapshot((m, p) => tab.cdp.send(m, p), this.options.snapshotLimit), signal)
    this.record('browser_get_snapshot', id, `snapshot: ${elements.length} elements`)
    return elements
  }

  /** Extract page text (optionally scoped by selector). */
  async text(id: number, selector: string | undefined, signal?: AbortSignal): Promise<string> {
    const text = await this.withControl('browser_get_text', id, (tab) =>
      extractText((m, p) => tab.cdp.send(m, p), selector, this.options.textLimit), signal)
    this.record('browser_get_text', id, selector === undefined ? `page text: ${text.length} chars` : `element text: ${text.length} chars`)
    return text
  }

  /** Capture a JPEG screenshot of one tab. */
  async screenshot(id: number, signal?: AbortSignal): Promise<string> {
    const data = await this.withControl('browser_screenshot', id, (tab) =>
      captureScreenshot(tab.view.webContents, this.options.screenshotMaxWidth, this.options.screenshotQuality), signal)
    this.record('browser_screenshot', id, 'screenshot captured')
    return data
  }

  /** Navigate history (agent path: honors the control mutex + abort signal;
   * user path (shell toolbar): runs immediately, never blocked by takeover). */
  async goBack(id: number, signal?: AbortSignal, user = false): Promise<void> {
    const body = async (tab: BrowserTab): Promise<void> => {
      const wc = tab.view.webContents
      if (wc.isDestroyed()) return
      wc.goBack()
      await this.waitForLoad(wc, 'domcontentloaded')(this.options.timeoutMs)
      this.updateTabState(tab)
    }
    if (user) return await body(this.tab(id))
    await this.withControl('browser_go_back', id, body, signal)
    this.record('browser_go_back', id, 'history back')
  }

  async goForward(id: number, signal?: AbortSignal, user = false): Promise<void> {
    const body = async (tab: BrowserTab): Promise<void> => {
      const wc = tab.view.webContents
      if (wc.isDestroyed()) return
      wc.goForward()
      await this.waitForLoad(wc, 'domcontentloaded')(this.options.timeoutMs)
      this.updateTabState(tab)
    }
    if (user) return await body(this.tab(id))
    await this.withControl('browser_go_forward', id, body, signal)
    this.record('browser_go_forward', id, 'history forward')
  }

  async reload(id: number, signal?: AbortSignal, user = false): Promise<void> {
    const body = async (tab: BrowserTab): Promise<void> => {
      const wc = tab.view.webContents
      if (wc.isDestroyed()) return
      wc.reload()
      await this.waitForLoad(wc, 'domcontentloaded')(this.options.timeoutMs)
      this.updateTabState(tab)
    }
    if (user) return await body(this.tab(id))
    await this.withControl('browser_reload', id, body, signal)
    this.record('browser_reload', id, 'page reloaded')
  }

  /** Switch the visible tab (user path: immediate; agent path: mutex). */
  async switchTab(id: number, user = false, signal?: AbortSignal): Promise<void> {
    const body = async (): Promise<void> => {
      const tab = this.tab(id)
      for (const other of this.tabs.values()) other.view.setVisible(other.id === id)
      this.visibleTabId = id
      tab.view.setBounds(this.contentBounds())
      this.record('browser_switch_tab', id, `switch to tab ${id}`)
    }
    if (user) return await body()
    return await this.agentRun('browser_switch_tab', body, signal)
  }

  /** Close a tab and destroy its view/CDP (user path: immediate; agent path: mutex). */
  async closeTab(id: number, user = false, signal?: AbortSignal): Promise<void> {
    const body = async (): Promise<void> => {
      const tab = this.tabs.get(id)
      if (tab === undefined) return
      tab.cdp.detach()
      tab.view.detach()
      tab.view.destroy()
      this.tabs.delete(id)
      if (this.visibleTabId === id) {
        this.visibleTabId = [...this.tabs.keys()].at(-1)
        if (this.visibleTabId !== undefined) await this.switchTab(this.visibleTabId, true)
      }
      this.record('browser_close_tab', id, `close tab ${id}`)
    }
    if (user) return await body()
    return await this.agentRun('browser_close_tab', body, signal)
  }

  /**
   * Close the whole browser (all tabs). The dedicated window stays alive
   * (hidden) so the user can wake it from the sidebar — only plugin teardown
   * truly destroys it. Tabs are dropped; the next `browser_open` recreates
   * them. `user=true` (shell 清除) bypasses the takeover mutex.
   */
  async closeAll(signal?: AbortSignal, user = false): Promise<void> {
    const body = async (): Promise<void> => {
      for (const id of [...this.tabs.keys()]) {
        const tab = this.tabs.get(id)
        if (tab === undefined) continue
        tab.cdp.detach()
        tab.view.detach()
        tab.view.destroy()
        this.tabs.delete(id)
      }
      this.visibleTabId = undefined
      for (const dispose of this.permissionsDisposers) dispose()
      for (const dispose of this.downloadDisposers) dispose()
      this.permissionsDisposers.length = 0
      this.downloadDisposers.length = 0
      this.record('browser_close', 0, 'close browser')
      this.hideWindow()
    }
    if (user) return await body()
    return await this.agentRun('browser_close', body, signal)
  }

  /** User takeover / release: hides/shows the AI-control mask and pauses /
   * resumes the agent loop (in-flight tool calls wait on the mutex). */
  setUserControl(active: boolean): void {
    if (active) {
      this.mutex.take()
      this.record('browser_takeover', 0, 'user took over the browser')
    } else {
      this.mutex.release()
      this.record('browser_release', 0, 'user released browser control')
    }
    // relayout() re-stacks the mask above every tab view AND applies its
    // visibility — a direct setVisible would leave the mask buried under
    // tabs (z-order follows attach order in Electron, not visibility).
    this.relayout()
  }

  /** Clear the persistent partition data (cookies, storage, cache). */
  async clearData(): Promise<void> {
    const seen = new Set<NativeSession>()
    for (const tab of this.tabs.values()) {
      const session = tab.view.webContents.session
      if (seen.has(session)) continue
      seen.add(session)
      await session.clearStorageData()
      await session.clearCache()
    }
    this.record('browser_clear_data', 0, 'clear browsing data')
  }

  /** Evaluate page JS (eval-enabled deployments only). */
  async eval(id: number, expression: string, signal?: AbortSignal): Promise<unknown> {
    if (!this.options.evalEnabled) {
      throw new Error('browser: browser_eval is disabled in this deployment')
    }
    if (typeof expression !== 'string' || expression.length === 0 || expression.length > 64 * 1024) {
      throw new Error('browser: eval expression must be a non-empty string ≤ 64KB')
    }
    const result = await this.withControl('browser_eval', id, async (tab) => {
      const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: this.options.timeoutMs,
      })
      if (result.exceptionDetails !== undefined) {
        throw new Error('browser: page script failed')
      }
      const value = result.result?.value
      const text = typeof value === 'string' ? value : safeJson(value)
      return text.slice(0, this.options.textLimit)
    }, signal, `eval: ${expression.slice(0, 60)}`)
    return result
  }

  /** Locate an element and return its viewport-center point for CDP input. */
  async locateElement(id: number, selector: string, signal?: AbortSignal): Promise<{ x: number; y: number }> {
    return await this.withControl('browser_locate', id, async (tab) => {
      const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: `
          (() => {
            try {
              const el = document.querySelector(${JSON.stringify(selector)});
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
        throw new Error(`browser: cannot locate element ${selector}${value?.error !== undefined ? ` (${value.error})` : ''}`)
      }
      if (typeof value.x !== 'number' || typeof value.y !== 'number') {
        throw new Error(`browser: cannot locate element ${selector}`)
      }
      return { x: value.x, y: value.y }
    }, signal)
  }

  /** Dispatch a left-click at a viewport point. */
  async clickAt(id: number, point: { x: number; y: number }, signal?: AbortSignal): Promise<void> {
    await this.withControl('browser_click', id, async (tab) => {
      await tab.cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
      })
      await tab.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
      })
    }, signal, `click at (${Math.round(point.x)}, ${Math.round(point.y)})`)
  }

  /** Focus an element and insert text (Unicode-safe); clears first when requested. */
  async typeInto(id: number, selector: string, text: string, clear = true, signal?: AbortSignal): Promise<void> {
    await this.withControl('browser_type', id, async (tab) => {
      await tab.cdp.send('Runtime.evaluate', {
        expression: `
          (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return { error: 'element not found' };
            el.focus();
            ${clear ? 'if (typeof el.select === "function") el.select();' : ''}
            return {};
          })()
        `,
        returnByValue: true,
      })
      await tab.cdp.send('Input.insertText', { text })
    }, signal, `type into ${selector}`)
  }

  /** Dispatch one keyboard key. */
  async pressKey(id: number, key: string, signal?: AbortSignal): Promise<void> {
    await this.withControl('browser_press', id, async (tab) => {
      const code = KEY_CODES[key] ?? key
      const vk = KEY_VK[key] ?? 0
      await tab.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      })
      await tab.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      })
    }, signal, `press ${key}`)
  }

  /** Set a select's value and fire change/input. */
  async selectOption(id: number, selector: string, value: string, signal?: AbortSignal): Promise<void> {
    await this.withControl('browser_select', id, async (tab) => {
      const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: `
          (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
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
        throw new Error(`browser: select failed — ${(result.result.value as { error: string }).error}`)
      }
    }, signal, `select ${selector} = ${value.slice(0, 80)}`)
  }

  /**
   * Fill the login form with stored connector credentials. The resolver looks
   * up the connector's credential fields (username/password); the form's first
   * text/email input receives the username and its password input the
   * password. Callers must route this through approval (credentials are
   * sensitive).
   */
  /** Current URL of a tab ('' when unknown) — used in approval prompts. */
  currentUrlOf(id: number): string {
    const tab = this.tabs.get(id)
    if (tab === undefined) return ''
    return tab.url
  }

  async fillCredentials(id: number, connectorId: string, signal?: AbortSignal): Promise<{ username: boolean; password: boolean }> {
    if (this.credentials === undefined) {
      throw new Error('browser: credential injection is not available in this deployment')
    }
    const credential = await this.credentials(connectorId)
    if (credential === null) {
      throw new Error(`browser: no stored credentials for connector ${JSON.stringify(connectorId)}`)
    }
    return await this.withControl('browser_fill_credentials', id, async (tab) => {
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
        throw new Error('browser: no matching login form found on this page')
      }
      return { username: value.username === true, password: value.password === true }
    }, signal, `fill credentials for ${connectorId}`)
  }

  /** Scroll the page by a delta (or the element into view). */
  async scroll(id: number, deltaY: number, selector: string | undefined, signal?: AbortSignal): Promise<void> {
    await this.withControl('browser_scroll', id, async (tab) => {
      const expression = selector === undefined || selector === ''
        ? `window.scrollBy({ top: ${Math.round(deltaY)}, behavior: 'instant' }); 'ok'`
        : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'not found'; el.scrollIntoView({ block: 'center' }); return 'ok'; })()`
      await tab.cdp.send('Runtime.evaluate', { expression, returnByValue: true })
    }, signal, selector === undefined || selector === '' ? `scroll ${Math.round(deltaY)}px` : `scroll to ${selector}`)
  }

  /** Dispose everything (plugin teardown): destroy the window for real. */
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
    this.visibleTabId = undefined
    this.windowResizeDisposer?.()
    this.windowClosedDisposer?.()
    if (this.window !== null && !this.window.isDestroyed()) this.window.close()
    this.window = null
    this.mask = null
  }
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

/** Safe JSON rendering with a hard cap (never throws). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return String(value)
  }
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

/** Redact credential-shaped parts of a browser op-log summary (URLs and
 * query parameters). Mirrors the desktop logger's mask-secrets semantics. */
export function maskBrowserSummary(summary: string): string {
  return summary.replace(/https?:\/\/[^\s<>"']+/giu, (raw) => {
    const trailing = /[),.;]+$/u.exec(raw)?.[0] ?? ''
    const value = trailing === '' ? raw : raw.slice(0, -trailing.length)
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
