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
import { captureScreenshot, captureScreenshotViaCdp } from './shots.ts'
import { TabPool } from './pool.ts'
import { BrowserStore, stripSensitiveText, stripSensitiveUrl, type DownloadEntry, type HistoryEntry, type RecordActor } from './store.ts'
import { validateEvalExpression, wrapEvalExpression, serializeEvalResult } from './eval-policy.ts'
import { SENSITIVE_KEY_PATTERN } from './sensitive.ts'
import { browserError, BrowserError } from './errors.ts'
import { isFrameOrderProblem, orderFramesByDom, frameOrderErrorMessage, SRCDOC_URL, type FrameCandidate, type FrameOrderProblem } from './frames.ts'
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
/**
 * Cap on the native `capturePage()` attempt before the renderer-side fallback
 * runs (ms). A hidden window can **hang** that call instead of rejecting it, and
 * an unbounded hang consumed the whole tool budget so the fallback never ran
 * (real-device report 2026-09-12: `tool call timed out after 30000ms`).
 */
const SCREENSHOT_PRIMARY_BUDGET_MS = 8_000
/** Share of the call budget the renderer-side capture must keep in reserve (ms). */
const SCREENSHOT_FALLBACK_RESERVE_MS = 5_000
/** Op-log ring size. */
const OP_LOG_LIMIT = 200
/** Cap on remembered redacted download display paths (R-5): the store keeps the
 * truthful handle, this map only holds the model-facing variant, and the
 * download list itself is pruned by `downloadLimit`. */
const DOWNLOAD_DISPLAY_PATH_LIMIT = 200

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
  /**
   * Credential values handed to this tab by `fillCredentials`. It is the value
   * set every **text** exit of this tab is scrubbed with, and its lifetime is
   * deliberately the TAB's lifetime (R-5, 2026-09-13): nothing clears it before
   * `destroyTab` drops the whole entry.
   *
   * R-4 emptied this list together with the credential window on the first
   * main-frame navigation, on the reasoning that "the values went with the old
   * document". That premise does not hold against a hostile page: a script can
   * copy the injected value into `sessionStorage`, a DOM node, a cookie, an
   * image or a server round-trip and read it back AFTER the navigation — the
   * independent re-verification did exactly that, and every text exit (page
   * text, title, URL, history, downloads) came back in cleartext. Retention is
   * therefore tab-scoped, not window-scoped: the window flag still governs
   * eval/screenshot, the value list keeps governing the text funnels.
   *
   * The converse does not hold — a username-only injection opens the window with
   * this list still empty (it holds passwords, whose redaction value is real
   * while a short username is an ordinary word).
   *
   * HONEST BOUNDARY (declared, not solved): the redaction matches the value
   * **verbatim**. A page may transform it (base64, reversed, split into
   * characters) before rendering and no value-level rule can see through that.
   */
  filledSecrets: string[]
  /**
   * Credential-activity window (R-4, 2026-09-13): true from a successful
   * `browser_fill_credentials` until the next main-frame cross-document
   * navigation. While it is open, `browser_eval` and `browser_screenshot` are
   * refused outright — the independent re-verification showed every value-level
   * defence can be transformed around (`btoa`, `slice`, cross-realm aliases,
   * pixels), so the *channel* is closed instead of the value. It is a separate
   * flag from {@link filledSecrets} because a username-only injection also opens
   * the window while contributing no redaction value.
   */
  credentialWindow: boolean
  /**
   * Out-of-process (cross-origin) subframes of this tab, keyed by their flat
   * CDP session id (R-4). Populated lazily by `ensureFrameTracking` and kept
   * current by `Target.attachedToTarget` / `Target.detachedFromTarget`. The
   * stored `tree` is the attach target's OWN `Page.getFrameTree`: the
   * authoritative source for its frame id, its parent, and its own descendants
   * (an OOPIF's same-process children never appear in the page session's tree).
   */
  oopifFrames: Map<string, { frameId: string; url: string; parentId: string | undefined; tree: RawFrameNode }>
  /** Whether `Target.setAutoAttach` + the attach listeners are installed. */
  frameTrackingReady: boolean
}

interface EvalResult {
  result?: { value?: unknown; type?: string }
  exceptionDetails?: unknown
}

/** Wait-for condition spec. */
/**
 * 浏览器窗口/标签标题的中性缺省值。
 *
 * 刻意不含厂商品牌：仓库里不留任何品牌描述。渠道构建下窗口标题应显示渠道名，
 * 由渠道包注入（迁移见 docs/planning/2026-09-10-channel-package-reference.md）。
 */
export const BROWSER_DEFAULT_TITLE = 'AI 浏览器'

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
  /** Redacted display paths of downloads, keyed by download id (R-5). The store
   * keeps the real on-disk path for `downloads_open`; only the model-facing
   * projection swaps this in. Bounded by {@link DOWNLOAD_DISPLAY_PATH_LIMIT}. */
  private readonly downloadDisplayPaths = new Map<number, string>()
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

  /** Persist the tab ledger (host wires this on every state change).
   *
   * R-5 (2026-09-13): the pool metadata is raw (`wc.getURL()`/`getTitle()`), so
   * the tab's value set is applied here as well — the store's key-level rule
   * alone let a page-chosen parameter name or a bare fragment reach
   * `groups.jsonl` in cleartext, and the ledger is re-served to the shell on the
   * next start. */
  saveLedger(): void {
    const ledger = this.pool.snapshotLedger()
    const tabs = ledger.tabs?.map((entry) => {
      const tab = this.tabs.get(entry.tabId)
      if (tab === undefined) return entry
      return {
        ...entry,
        url: redactFilledSecretsText(tab, entry.url, { verbatim: true }),
        title: redactFilledSecretsText(tab, entry.title),
      }
    })
    this.store.saveGroupLedger(tabs === undefined ? ledger : { ...ledger, tabs })
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
   *
   * `inheritSecretsFrom` (R-5, 2026-09-13): a tab opened by a credential-bearing
   * page (`window.open` / `target=_blank`) inherits that tab's redaction VALUE
   * set, not its credential window. The child document never received the
   * credential, but the opener can put it in the popup URL (`/popup?pw=` + value)
   * — the independent re-verification read it straight out of `browser_list_tabs`
   * while the child tab sat there with an empty set (R-5 F7). Inheriting makes
   * every child text exit value-scrubbed too; eval/screenshot stay available
   * because nothing was injected into that document.
   */
  async open(url: string | undefined, signal?: AbortSignal, user = false, inheritSecretsFrom?: number): Promise<BrowserTabState> {
    if (this.disposed) throw new Error('browser: runtime disposed')
    if (user) {
      if (!this.pool.tryReserveTab()) {
        throw browserError('quota', 'browser: tab limit reached — close a tab first')
      }
      try {
        return await this.createTabReal(url, signal, undefined, 'user', inheritSecretsFrom)
      } catch (error) {
        this.pool.releaseReservation()
        throw error
      }
    }
    return await this.withAgentAttribution('browser_open', async () => {
      await this.pool.reserveTab(signal)
      try {
        return await this.createTabReal(url, signal, undefined, 'ai', inheritSecretsFrom)
      } catch (error) {
        this.pool.releaseReservation()
        throw error
      }
    }, signal)
  }

  private async createTabReal(url: string | undefined, signal: AbortSignal | undefined, fixedId: number | undefined, actor: RecordActor, inheritSecretsFrom?: number): Promise<BrowserTabState> {
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
    const tab: BrowserTab = { id, view, cdp, ownerSession: this.lastAgentId, url: '', title: '', favicon: '', loading: false, canGoBack: false, canGoForward: false, disposers: [], filledSecrets: [], credentialWindow: false, oopifFrames: new Map(), frameTrackingReady: false }
    // R-5 (F7): inherit the opener's redaction value set (never its window).
    if (inheritSecretsFrom !== undefined) {
      const opener = this.tabs.get(inheritSecretsFrom)
      if (opener !== undefined) tab.filledSecrets.push(...opener.filledSecrets)
    }
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
      // the URL as a new tab through the normal path (quota, gate, navigation
      // policy, op log) and deny the native popup. A denied or failed open is
      // recorded as a failed op so the activity panel shows it.
      //
      // While the USER holds control (我来操作) no agent operation can be
      // running, so a popup at that moment is user-initiated: it MUST take the
      // user path — routing it through the agent path parked it behind the
      // user's own gate forever (the tab only appeared after 交给 AI, as a
      // burst; 2026-09-11 fix).
      view.webContents.setWindowOpenHandler((details) => {
        const target = typeof details?.url === 'string' ? details.url : ''
        const userInitiated = this.pool.controlled
        if (target === '' || !this.guard.allowNavigation(target)) {
          this.record('browser_window_open', id, `window.open denied: ${target}`, true)
          return { action: 'deny' }
        }
        this.record('browser_window_open', id, `window.open → new tab: ${target}`, false, userInitiated ? 'user' : 'ai')
        // R-5 (F7): the popup inherits this tab's redaction value set — the
        // opener commonly puts the injected value in the popup URL, and an
        // empty set on the child tab published it in cleartext.
        void this.open(target, undefined, userInitiated, id).catch((cause: unknown) => {
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
      view.webContents.on('did-navigate', () => {
        // A main-frame cross-document navigation is the end of the
        // credential-activity window (R-4): the injected values are no longer in
        // the document, so their read-back risk is gone with it. Belt and braces
        // next to the CDP event below — Electron's `did-navigate` fires for the
        // same navigation, and is a no-op when the window is already closed.
        this.exitCredentialWindow(tab)
        this.updateTabState(tab)
      })
      // `did-navigate-in-page` (same-document) deliberately does NOT close the
      // window: the very same document (and the credentials in it) is still up.
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

      // Credential-activity window, CDP half (R-4): the model-facing definition
      // of "the tab navigated" is the protocol's, not Electron's. Only a
      // main-frame (`parentId === undefined`) `Page.frameNavigated` closes the
      // window; subframe navigations never do, and same-document navigations
      // emit `Page.navigatedWithinDocument` instead, so they never do either.
      tab.disposers.push(tab.cdp.on('Page.frameNavigated', (params) => {
        const frame = (params as { frame?: { parentId?: string } }).frame
        if (frame === undefined || frame.parentId !== undefined) return
        this.exitCredentialWindow(tab)
      }))
      // Enable the Page domain ONCE, here (never from `fillCredentials`): if
      // Chromium re-announced the current document on enable, doing it after an
      // injection would immediately close a window that had just opened. Here no
      // window can exist yet, so the notification is inert.
      void tab.cdp.send('Page.enable').catch(() => { /* mock/older protocol: `did-navigate` still closes the window */ })

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
      // Key-level first (credential-shaped names), then the tab's value set:
      // a summary embeds the page URL verbatim (`navigate: …`), and that URL
      // can carry an injected value under a page-chosen name (R-5). The op log
      // is model-facing through the /ops route and the shell's activity panel.
      summary: tabEntry === undefined
        ? maskBrowserSummary(summary)
        : redactFilledSecretsText(tabEntry, maskBrowserSummary(summary), { verbatim: true }),
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

  /**
   * The credential-activity window (R-4, 2026-09-13).
   *
   * A tab enters the window when `browser_fill_credentials` injects a stored
   * credential into it, and leaves it on the next MAIN-FRAME CROSS-DOCUMENT
   * navigation (`Page.frameNavigated` with no `parentId`, mirrored by
   * Electron's `did-navigate`). Same-document navigations (`pushState`, `#hash`,
   * `did-navigate-in-page`) do NOT end it: the same document, and the credential
   * inside it, is still up.
   *
   * Leaving the window does NOT drop {@link BrowserTab.filledSecrets} any more
   * (R-5, 2026-09-13): the injected value can outlive the document (a script
   * copies it into `sessionStorage`/DOM/cookies before navigating), so the value
   * set is held for the tab's lifetime and keeps driving every text funnel. The
   * window, not the value list, is the eval/screenshot contract: inside it those
   * two channels are refused (see those methods), outside it they work again —
   * with value redaction still applied to whatever they return.
   */
  credentialWindowOpen(tabId: number): boolean {
    const tab = this.tabs.get(tabId)
    return tab !== undefined && tab.credentialWindow
  }

  /** Close the window (idempotent): called on every main-frame navigation, and
   * by nothing else — the window must never close while its document is up.
   * `filledSecrets` is deliberately left alone (tab-scoped retention, R-5). */
  private exitCredentialWindow(tab: BrowserTab): void {
    tab.credentialWindow = false
  }

  /**
   * Model/UI-facing projection of a tab (R-1, 2026-09-13).
   *
   * A tab's live `url`/`title`/`favicon` are raw by design (navigation needs
   * them), but EVERY payload that leaves the runtime is built here: the
   * `browser_list_tabs` / `browser_open` / `browser_navigate` /
   * `browser_get_snapshot` envelopes, the shell's `/api/pico/browser/state`
   * and its SSE `state` event. Before this the redaction was applied per call
   * site and `browser_get_snapshot` shipped `state.url` in cleartext while the
   * element text beside it read `****` (independent re-verification
   * 2026-09-13). One projection, so a new accessor cannot miss it.
   *
   * Cost, stated on purpose: the shell address bar shows the masked URL for a
   * credential-bearing address. Restoring a cleartext address bar needs a
   * deliberately separate (un-redacted) shell-only channel — the unsafe
   * default is not kept for convenience.
   *
   * R-5 (2026-09-13) adds the value-level pass on top of the key-level one, for
   * all three fields. Key-level rules only see credential-*shaped* names, so a
   * page that picks its own name (`history.replaceState('?pw=' + value)`, a
   * bare `location.hash = value`) or none at all (`<a download=value + '.txt'>`)
   * published the injected value as an ordinary URL, title or file name.
   */
  private projectTabState(tab: BrowserTab): BrowserTabState {
    return {
      id: tab.id,
      url: redactFilledSecretsText(tab, stripSensitiveUrl(tab.url), { verbatim: true }),
      title: redactFilledSecretsText(tab, stripSensitiveText(tab.title)),
      loading: tab.loading,
      visible: tab.id === this.pool.activeTab,
      favicon: redactFilledSecretsText(tab, stripSensitiveUrl(tab.favicon), { verbatim: true }),
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
    }
  }

  private updateTabState(tab: BrowserTab): void {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return
    tab.url = wc.getURL()
    // FIX-06 (2026-09-12): the page title frequently *is* a URL (no `<title>`,
    // a guard-rejected navigation, an Electron title fallback) and it feeds the
    // persisted history, the native window caption and the model-facing
    // state — while `tab.url` next to it was already redacted. Same text-level
    // redactor as the store, applied once at the source.
    tab.title = stripSensitiveText(wc.getTitle() || tab.url || '')
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

  /** Follow the active tab's page title in the native window caption.
   *
   * R-5: the caption is built from the raw `tab.title`, which a page can set to
   * anything (`document.title = pw.value`) — it would then sit in the OS window
   * list, screen shares and screenshots of the app. Same value-level redactor as
   * the model-facing projection. */
  private refreshWindowTitle(tab: BrowserTab): void {
    if (this.window === null || this.window.isDestroyed()) return
    if (tab.id !== this.pool.activeTab) return
    const shown = redactFilledSecretsText(tab, tab.title)
    const title = shown !== '' ? shown : BROWSER_DEFAULT_TITLE
    this.window.setTitle(title === BROWSER_DEFAULT_TITLE ? title : `${title} — ${BROWSER_DEFAULT_TITLE}`)
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
      // R-1: the refusal text is model-facing (tool error) — echo the
      // *redacted* URL, exactly like history/op-log do.
      throw browserError('navigation-blocked', `browser: navigation denied — ${stripSensitiveUrl(url).slice(0, 200)}`)
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
    // R-5 (2026-09-13): the persisted history is a model-facing exit
    // (`browser_history_search`, the shell's history panel, `<dir>/history.jsonl`),
    // so it gets BOTH layers: the store's key-level rule and this tab's value set
    // (a page-chosen parameter name or a path segment carries the value past the
    // key vocabulary). Redacted at the write path so every reader agrees.
    this.store.addHistory({
      time: Date.now(),
      url: redactFilledSecretsText(tab, url, { verbatim: true }),
      title: redactFilledSecretsText(tab, tab.title),
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
      const snapshot = await extractSnapshot((m, p) => tab.cdp.send(m, p), this.options.snapshotLimit)
      // P0-A depth layer: scrub values this tab received through credential
      // injection, whatever source produced the text (the probe today, a future
      // field/attribute dump tomorrow). Value-exact matching keeps ordinary page
      // text untouched. Placed in the runtime funnel — not only in tools.ts —
      // so every `runtime.snapshot` caller is covered.
      return redactFilledSecrets(tab, snapshot)
    }, signal)
    this.record('browser_get_snapshot', resolved, `snapshot: ${elements.length} elements`)
    return elements
  }

  async text(tabId: number, selector: string | undefined, signal?: AbortSignal): Promise<string> {
    const resolved = this.resolveTab(tabId)
    const text = await this.agentRun('browser_get_text', async () => {
      const tab = this.tab(resolved)
      const raw = await extractText((m, p) => tab.cdp.send(m, p), selector, this.options.textLimit)
      // R-1 (2026-09-13): page text is a model-facing exit too. innerText of a
      // password input is empty, but a page that *echoes* what was typed
      // ("your password abc123 is weak", a confirmation screen, a debug dump)
      // hands the injected credential back verbatim. Same value-level redactor
      // as the snapshot/eval funnels — one implementation, three exits.
      return redactFilledSecretsText(tab, raw)
    }, signal)
    this.record('browser_get_text', resolved, selector === undefined ? `page text: ${text.length} chars` : `element text: ${text.length} chars`)
    return text
  }

  async screenshot(tabId: number, signal?: AbortSignal): Promise<string> {
    const resolved = this.resolveTab(tabId)
    // R-4 credential-activity window: checked BEFORE the capture `try`, so the
    // policy refusal below is not rewritten into the generic "screenshot failed"
    // wrapper (which would hide both the code and the reason).
    if (this.credentialWindowOpen(resolved)) {
      this.record('browser_screenshot', resolved, 'refused: credential window open', true)
      throw browserError('policy', CREDENTIAL_WINDOW_SCREENSHOT_REFUSAL)
    }
    let data: string
    try {
      data = await this.agentRun('browser_screenshot', async () => {
        const tab = this.tab(resolved)
        let primary: string
        try {
          return await withScreenshotBudget(
            captureScreenshot(tab.view.webContents, this.options.screenshotMaxWidth, this.options.screenshotQuality),
            this.screenshotPrimaryBudgetMs(),
          )
        } catch (cause) {
          primary = cause instanceof Error ? cause.message : String(cause)
        }
        // 2026-09-12: the browser window is created hidden by design, and a
        // hidden window has no viz surface — `capturePage()` then fails with
        // "Current display surface not available for capture". The renderer-side
        // CDP path composites the frame without a surface, so screenshots keep
        // working for an agent-driven (never shown) window.
        try {
          const fallback = await captureScreenshotViaCdp(
            (method, params) => tab.cdp.send(method, params),
            this.options.screenshotMaxWidth,
            this.options.screenshotQuality,
          )
          this.record('browser_screenshot', resolved, `capturePage unavailable (${primary.slice(0, 120)}); captured via CDP fromSurface:false`)
          return fallback
        } catch (cause) {
          const secondary = cause instanceof Error ? cause.message : String(cause)
          // Both reasons are kept: the primary one is what the P2-31 guard
          // ("empty image (0x0)") and real-device diagnostics key on.
          throw new Error(`${primary}; renderer-side fallback: ${secondary}`)
        }
      }, signal)
    } catch (cause) {
      // An empty capture (hidden window / background tab / zero-sized view)
      // must be a visible failure, never a silent 0-byte "screenshot" (P2-31).
      const message = cause instanceof Error ? cause.message : String(cause)
      this.record('browser_screenshot', resolved, `screenshot failed: ${message}`, true)
      throw new Error(
        `browser: screenshot failed — ${message}; the tab must be able to render (open the 浏览器 window if it is closed, then retry)`,
      )
    }
    this.record('browser_screenshot', resolved, 'screenshot captured')
    return data
  }

  /**
   * Budget for the native capture attempt. The renderer-side fallback needs a
   * real share of the call budget, so a deployment that shortens `timeoutMs`
   * shortens this bound with it instead of letting the native path overrun.
   */
  private screenshotPrimaryBudgetMs(): number {
    return Math.min(
      SCREENSHOT_PRIMARY_BUDGET_MS,
      Math.max(1_000, this.options.timeoutMs - SCREENSHOT_FALLBACK_RESERVE_MS),
    )
  }

  /**
   * Eval guardrail (heuristic AST policy + result masking + credential window).
   *
   * On an ordinary tab the validator stays a misuse guardrail, NOT a security
   * boundary: the AI may operate every part of the browser (fetch/XHR/arbitrary
   * JS included). Since FIX-03 the *returned* string additionally goes through
   * {@link redactFilledSecretsText}.
   *
   * R-4 (2026-09-13) replaces the R-2 "per-API refusal on credential tabs"
   * layer with the credential-activity window: while the injected credential is
   * still in the page, `browser_eval` is refused **entirely**. The R-2 layer was
   * a heuristic (it refused the API names a model might use and shimmed the top
   * realm for the duration of one call) and the independent re-verification
   * walked around it — `document.querySelector('#f').contentWindow['fe'+'tch']`,
   * `Object.getPrototypeOf(navigator)['send'+'Beacon']`, `setAttribute('src')`,
   * and above all the read side (`btoa(pw)`, `[...pw].join('-')`, `pw.slice()`).
   * Value-level defences cannot see a transform, so the channel — not the value
   * — is what has to close. `assertCredentialTabExpression` /
   * `wrapEvalExpression({denyEgress:true})` stay in `eval-policy.ts` as the
   * documented R-2 vocabulary and as the second layer for any future eval entry
   * point that is not behind this window; they are no longer on this path.
   */
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
      // R-4 credential-activity window: while the injected credentials are still
      // in this page, `browser_eval` is refused outright — the read-back itself
      // is a channel (see the class doc above).
      if (tab.credentialWindow) {
        this.record('browser_eval', resolved, 'refused: credential window open', true)
        throw browserError('policy', CREDENTIAL_WINDOW_EVAL_REFUSAL)
      }
      // R-4: `frame: N` is a DOM position. Resolve it through the reconciled
      // index (same-process frames + out-of-process iframes) or refuse.
      const target = typeof frame === 'number' && frame > 0 ? await this.resolveFrame(tab, frame) : undefined
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
        // A frame's default world is addressed by contextId (same-process);
        // frame 0 passes neither and keeps the pre-existing default-world
        // semantics. A cross-origin frame is addressed by its flat CDP session
        // on the TRANSPORT (third argument), not as a command parameter.
        ...(target?.contextId === undefined ? {} : { contextId: target.contextId }),
      }, target?.sessionId === undefined ? {} : { sessionId: target.sessionId })
      if (evalResult.exceptionDetails !== undefined) {
        throw browserError('eval-policy', 'browser: page script failed (exception)')
      }
      // FIX-03 (2026-09-12): `browser_eval` used to be the un-redacted sibling
      // of `browser_get_snapshot` — `document.querySelector('#pw').value`
      // handed the injected connector password straight back to the model.
      // The serialized string goes through the SAME value-level redactor as the
      // snapshot funnel (`redactFilledSecretsText`), applied after
      // `serializeEvalResult`'s keyword masking (a random password carries no
      // keyword for that mask to catch).
      //
      // Since R-4 the credential window refuses eval before this point, so
      // `filledSecrets` is empty here on every tab that can reach it. The call
      // is kept as the value-exact backstop for any future path that runs page
      // JS without being behind the window.
      return redactFilledSecretsText(tab, serializeEvalResult(evalResult.result?.value))
    }, signal)
    this.record('browser_eval', resolved, `eval: ${expression.slice(0, 60)}`)
    return result
  }

  /**
   * Apply the value-level secret redaction of the snapshot/eval funnels to an
   * arbitrary text produced from `tabId` (FIX-03 depth layer, 2026-09-12).
   *
   * Exposed so the tool layer can re-apply the exact same reducer to a value
   * that already went through `runtime.eval` — redundant by design, so a
   * future runtime path or caller cannot hand the model a credential this tab
   * received through `fillCredentials`. Unknown/empty tabs pass the text
   * through unchanged (this helper must never break a working call). Since R-4
   * the list is non-empty only inside the credential window, where eval itself
   * is refused — this is a backstop, not the enforcement point.
   *
   * Same honest boundary as `eval()`: this is not an egress firewall.
   */
  redactTabSecrets(tabId: number, text: string): string {
    const tab = this.tabs.get(tabId)
    if (tab === undefined || tab.filledSecrets.length === 0) return text
    return redactFilledSecretsText(tab, text)
  }

  /**
   * Resolve the requested `frame: N` through the reconciled index.
   *
   * Out-of-range is a plain not-found listing the page's real frame count (the
   * model can only fix its call if it knows how many frames exist); a page the
   * index cannot prove 1:1 throws the explicit R-4 refusal instead.
   */
  private async resolveFrame(tab: BrowserTab, frameIndex: number): Promise<ResolvedFrame> {
    const index = await this.frameIndex(tab)
    const entry = index[frameIndex]
    if (entry === undefined) {
      throw browserError('not-found', `browser: frame ${frameIndex} does not exist (this page has ${index.length} frames: 0-${index.length - 1})`)
    }
    return entry
  }

  /**
   * Resolve `frame: N` into the JS world it actually means (R-4, 2026-09-13).
   *
   * The pre-2026-09-13 version indexed `Page.getFrameTree` directly. On a
   * site-isolated page that array is NOT the DOM order the model sees: a
   * cross-origin (out-of-process) iframe is absent from the page session's
   * frame tree, so with the OOPIF first in the DOM and a same-process iframe
   * second, `frame: 1` silently resolved to the *second* iframe. Verified on
   * Electron 43.4.0 / Chromium 150 with real CDP
   * (`tests/probes/frame-index-probe.mjs`, evidence `oopif-probe.json`).
   *
   * The index is now built from the page structure (DOM order of the
   * `iframe`/`frame` owners) reconciled against everything CDP can reach —
   * including out-of-process frames, which ARE reachable: Electron's debugger
   * supports flat sessions, so `Target.setAutoAttach({flatten:true})` reports
   * the OOPIF as an `iframe` target and `Runtime.evaluate` with its
   * `sessionId` reads the frame's own globals (same probe). Any frame owner
   * that cannot be paired 1:1 is refused with an explicit error instead of
   * being pointed at a neighbouring frame.
   */
  private async frameIndex(tab: BrowserTab): Promise<ResolvedFrame[]> {
    const attempt = async (): Promise<ResolvedFrame[] | FrameOrderProblem> => {
      const tree = await tab.cdp.send<{ frameTree?: RawFrameNode }>('Page.getFrameTree')
      if (tree.frameTree === undefined) throw browserError('not-found', 'browser: the page has no frame tree yet')
      // One flat registry built from BOTH sources: the page session's frame tree
      // (same-process frames) and every attached out-of-process target's own
      // frame tree. An OOPIF's same-process children exist only in the latter,
      // which is why indexing a single `Page.getFrameTree` silently dropped them.
      interface RegisteredFrame {
        frameId: string
        url: string
        parentId: string | undefined
        sessionId: string | undefined
        /** DOM children, in DOM order (rebuilt when the OOPIF re-registers the
         *  node from its own tree, so a frame is never listed twice). */
        childIds: string[]
        /** Root of an out-of-process frame: it IS addressed by its session, so
         *  no `contextId` is resolved for it (evaluating with the session and no
         *  context lands in that frame's own default world). */
        sessionOnly: boolean
      }
      const registry = new Map<string, RegisteredFrame>()
      const addTree = (node: RawFrameNode, parentId: string | undefined, sessionId: string | undefined, sessionOnly: boolean): string | undefined => {
        const id = node.frame?.id
        if (id === undefined) return undefined
        const childIds: string[] = []
        for (const child of node.childFrames ?? []) {
          const childId = addTree(child, id, sessionId, false)
          if (childId !== undefined) childIds.push(childId)
        }
        registry.set(id, { frameId: id, url: node.frame?.url ?? '', parentId, sessionId, childIds, sessionOnly })
        return id
      }
      const rootId = addTree(tree.frameTree, undefined, undefined, false)
      if (rootId === undefined) throw browserError('not-found', 'browser: the page has no frame tree yet')
      // Out-of-process frames only need attaching when the document actually has
      // frame owners: a page without any iframe must not pay for the round trips.
      const rootOwners = await this.domFrameOwnerUrls(tab, {})
      await this.ensureFrameTracking(tab, registry.size > 1 || rootOwners.length > 0)
      // Re-register every attached OOPIF from its OWN tree (authoritative
      // session + parent). Doing it unconditionally — not only when the frame id
      // is unknown — matters when a parent tree also mentions the remote frame:
      // the OOPIF entry must still carry the OOPIF's session, otherwise its
      // same-process children are resolved in the parent process and the whole
      // index is refused (R-4, 2026-09-13).
      for (const [sessionId, frame] of tab.oopifFrames) {
        addTree(frame.tree, frame.parentId, sessionId, true)
      }
      // Link re-adds: an out-of-process frame is normally absent from its
      // parent's `Page.getFrameTree` (that is WHY it needs its own session), so
      // the re-registration above left it out of `parent.childIds` and the DOM
      // reconciliation would count one frame owner too many and refuse the page.
      // The OOPIF's own tree reports its `parentId`, so the edge is known — add
      // it back, once.
      for (const frame of registry.values()) {
        if (frame.parentId === undefined) continue
        const parent = registry.get(frame.parentId)
        if (parent === undefined || parent.childIds.includes(frame.frameId)) continue
        parent.childIds.push(frame.frameId)
      }

      const index: ResolvedFrame[] = []
      const visit = async (frame: RegisteredFrame, depth: number, contextId: number | undefined): Promise<ResolvedFrame[] | FrameOrderProblem> => {
        index.push({
          frameId: frame.frameId,
          url: frame.url,
          depth,
          ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
          ...(contextId === undefined ? {} : { contextId }),
        })
        // This document's frame owners, read in ITS own world: the OOPIF session
        // for a cross-origin frame, the default-world context otherwise (nothing
        // at all for the main frame, whose world is the implicit default).
        const domUrls = depth === 0 && contextId === undefined && frame.sessionId === undefined
          ? rootOwners
          : await this.domFrameOwnerUrls(tab, {
            ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
            ...(contextId === undefined ? {} : { contextId }),
          })
        const candidates: FrameCandidate[] = frame.childIds.map((id) => {
          const child = registry.get(id)!
          return { frameId: child.frameId, url: child.url, ...(child.sessionId === undefined ? {} : { sessionId: child.sessionId }) }
        })
        const ordered = orderFramesByDom(domUrls, candidates)
        if (isFrameOrderProblem(ordered)) return { ...ordered, depth }
        for (const child of ordered) {
          const childNode = registry.get(child.frameId)
          if (childNode === undefined) continue
          // A frame that is not the root of its own (out-of-process) session is
          // addressed by the default-world context of THAT session: with only a
          // session id and no context, CDP evaluates in the session's own main
          // document, i.e. silently one frame up (the R-4 defect).
          let childContext: number | undefined
          if (!childNode.sessionOnly) {
            childContext = await defaultWorldContextId(tab, child.frameId, childNode.sessionId)
            // No silent fallback to an isolated world: that would restore the
            // P1-7 bug (page JS globals read as `undefined`) without any error.
            if (childContext === undefined) {
              return { domUrls, reachableUrls: [], reason: `frame ${child.url || child.frameId} has no default JavaScript world` }
            }
          }
          const nested = await visit(childNode, depth + 1, childContext)
          if (isFrameOrderProblem(nested)) return nested
        }
        return index
      }
      // The main frame is evaluated in its default world implicitly (no
      // contextId), exactly like `frame: 0` always did.
      return await visit(registry.get(rootId)!, 0, undefined)
    }

    let outcome = await attempt()
    if (isFrameOrderProblem(outcome)) {
      // A frame owner that appears a tick before its frame (insert before
      // commit) is a real race, not a security event: settle once, then refuse.
      await sleep(FRAME_INDEX_SETTLE_MS)
      outcome = await attempt()
      if (isFrameOrderProblem(outcome)) {
        throw browserError('not-found', frameOrderErrorMessage(outcome))
      }
    }
    return outcome
  }

  /** The `frame`/`iframe` owner URLs of one document, in DOM order (R-4). */
  private async domFrameOwnerUrls(tab: BrowserTab, world: { contextId?: number; sessionId?: string }): Promise<string[]> {
    const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('iframe,frame')].map((el) => el.hasAttribute('srcdoc') ? ${JSON.stringify(SRCDOC_URL)} : (el.src || 'about:blank'))`,
      returnByValue: true,
      ...(world.contextId === undefined ? {} : { contextId: world.contextId }),
    }, world.sessionId === undefined ? {} : { sessionId: world.sessionId })
    const value = result.result?.value
    if (!Array.isArray(value)) {
      // Mid-navigation / detached: the caller turns this into a fail-loud
      // refusal, because indexing an unknown layout is exactly the defect.
      throw browserError('not-found', 'browser: the page frame layout is not readable right now (navigation in progress)')
    }
    return value.map((url) => String(url))
  }

  /**
   * Install flat-session frame tracking for a tab (idempotent).
   *
   * `Target.setAutoAttach` reports existing out-of-process iframes once; the
   * listeners keep {@link BrowserTab.oopifFrames} current afterwards, so a
   * second `frame: N` call does not have to re-discover them. Detached targets
   * remove their entry.
   */
  private async ensureFrameTracking(tab: BrowserTab, needed: boolean): Promise<void> {
    if (tab.frameTrackingReady || !needed) return
    tab.frameTrackingReady = true
    const register = (sessionId: string, targetInfo: { url?: string } | undefined): void => {
      // The frame id and parent come from the attached target's OWN frame tree
      // (authoritative), not from URL guessing.
      void tab.cdp.send<{ frameTree?: RawFrameNode }>('Page.getFrameTree', {}, { sessionId }).then((tree) => {
        const frameTree = tree.frameTree
        if (frameTree?.frame?.id === undefined) return
        tab.oopifFrames.set(sessionId, {
          frameId: frameTree.frame.id,
          url: frameTree.frame.url ?? targetInfo?.url ?? '',
          parentId: frameTree.frame.parentId,
          tree: frameTree,
        })
        // Nested out-of-process frames: attach on the child session too, so a
        // grandchild OOPIF registers itself the same way.
        void tab.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, { sessionId }).catch(() => { /* not an attachable target */ })
      }).catch(() => { /* detached before it answered */ })
    }
    tab.disposers.push(tab.cdp.on('Target.attachedToTarget', (params) => {
      const event = params as { sessionId?: string; targetInfo?: { type?: string; url?: string } }
      if (event.sessionId === undefined || event.targetInfo?.type !== 'iframe') return
      register(event.sessionId, event.targetInfo)
    }))
    tab.disposers.push(tab.cdp.on('Target.detachedFromTarget', (params) => {
      const sessionId = (params as { sessionId?: string }).sessionId
      if (sessionId !== undefined) tab.oopifFrames.delete(sessionId)
    }))
    try {
      await tab.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    } catch {
      // Older protocol / plain-Node mock: the index still works for
      // same-process frames, and refuses when the DOM proves more frames exist.
      return
    }
    // Let the already-existing iframe targets report in before the caller
    // reconciles (the attach events race the setAutoAttach reply).
    const deadline = Date.now() + FRAME_CONTEXT_WAIT_MS
    while (Date.now() < deadline && tab.oopifFrames.size === 0) await sleep(FRAME_CONTEXT_POLL_MS)
    await sleep(FRAME_CONTEXT_POLL_MS)
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
      // 2026-09-12: synthesized OS-level input (CDP `Input.dispatchMouseEvent`)
      // needs an input-visible RenderWidgetHost. The browser window is created
      // hidden by design (2026-09-08 product decision), and on a hidden window
      // those events are accepted by the protocol yet never delivered to the
      // page — the tool reported success while nothing happened (real-device
      // report: links did not navigate, submit buttons did not submit, while
      // DOM-level tools such as fill_form/select kept working).
      //
      // So: real input when the window can receive it, DOM-level activation
      // (elementFromPoint + a full bubbling event sequence) otherwise. The
      // dispatch path is recorded in the op log so the difference stays visible.
      if (this.windowCanReceiveInput()) {
        await tab.cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
        })
        await tab.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
        })
        this.record('browser_click', resolved, `click at (${Math.round(point.x)}, ${Math.round(point.y)})`)
        return
      }
      const target = await this.activateAtPoint(tab, point)
      this.record(
        'browser_click',
        resolved,
        target === 'none'
          ? `click at (${Math.round(point.x)}, ${Math.round(point.y)}) hit no element (hidden window: DOM dispatch)`
          : `click at (${Math.round(point.x)}, ${Math.round(point.y)}) via DOM dispatch (hidden window)`,
        target === 'none',
      )
      if (target === 'none') {
        throw browserError('not-found', `browser: nothing to click at (${Math.round(point.x)}, ${Math.round(point.y)}) — the point is outside any element`)
      }
    }, signal)
  }

  /** Whether the browser window currently has a surface that receives input. */
  private windowCanReceiveInput(): boolean {
    if (this.window === null || this.window.isDestroyed()) return false
    return this.window.isVisible()
  }

  /**
   * DOM-level activation of whatever sits at a viewport point, used when the
   * window cannot deliver real input (hidden window). `elementFromPoint` is
   * layout-based, so it works without a compositor, and the dispatched sequence
   * is a full bubbling pointer/mouse/click chain so handlers that listen for any
   * of those (and activation behavior such as link navigation, checkbox toggle
   * or form submission) still fire.
   *
   * @returns `'element'` when something was hit, `'none'` for an empty point.
   */
  private async activateAtPoint(tab: BrowserTab, point: { x: number; y: number }): Promise<'element' | 'none'> {
    const x = Number(point.x)
    const y = Number(point.y)
    const result = await tab.cdp.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
      expression: `
        (() => {
          const x = ${JSON.stringify(x)};
          const y = ${JSON.stringify(y)};
          const el = document.elementFromPoint(x, y);
          if (!el) return 'none';
          if (typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch {} }
          const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, detail: 1 };
          const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
          const sequence = [
            () => el.dispatchEvent(new Pointer('pointerdown', { ...base, buttons: 1, isPrimary: true, pointerId: 1, pointerType: 'mouse' })),
            () => el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 })),
            () => el.dispatchEvent(new Pointer('pointerup', { ...base, buttons: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse' })),
            () => el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 })),
            () => el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 })),
          ];
          for (const dispatch of sequence) dispatch();
          return 'element';
        })()
      `,
      returnByValue: true,
    })
    return result.result?.value === 'element' ? 'element' : 'none'
  }

  async typeInto(tabId: number, selector: string, text: string, clear = true, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolveTab(tabId)
    await this.agentRun('browser_type', async () => {
      const tab = this.tab(resolved)
      const before = await this.textFieldState(tab, selector)
      if (before === null) throw browserError('not-found', `browser: cannot locate element ${selector}`)
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
      // 2026-09-12: `Input.insertText` 与鼠标/键盘事件同属输入域，隐藏窗口下未必送达
      // （真机自检报告把 browser_type 记成"返回成功"，但没验效果）。这里不做平台假设，
      // 直接读回校验：内容没变就退到 DOM 写入（原生 setter + input/change，React 受控
      // 组件也认），并把实际路径写进操作日志。
      const after = await this.textFieldState(tab, selector)
      if (this.contentChanged(before, after)) {
        this.record('browser_type', resolved, `type into ${selector}`)
        await this.afterChangeSummary(tab)
        return
      }
      const outcome = await this.insertTextViaDom(tab, selector, text, clear)
      this.record(
        'browser_type',
        resolved,
        `type into ${selector} via DOM write (hidden window)${outcome === 'typed' ? '' : ` — ${outcome}`}`,
        outcome !== 'typed',
      )
      if (outcome !== 'typed') {
        throw browserError('not-found', `browser: cannot type into ${selector} (${outcome})`)
      }
      await this.afterChangeSummary(tab)
    }, signal)
  }

  /** Read back a field's current content (`null` when the element is missing). */
  private async textFieldState(tab: BrowserTab, selector: string): Promise<string | null> {
    try {
      const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: `
          (() => {
            const el = document.querySelector(${JSON.stringify(String(selector))});
            if (!el) return null;
            if (typeof el.value === 'string') return el.value;
            if (el.isContentEditable) return el.textContent ?? '';
            return '';
          })()
        `,
        returnByValue: true,
      })
      const value = result.result?.value
      return typeof value === 'string' ? value : value === null ? null : ''
    } catch {
      return null
    }
  }

  /** Whether the readback shows the DOM write changed the field. */
  private contentChanged(before: string | null, after: string | null): boolean {
    if (after === null) return false
    return after !== before
  }

  /**
   * DOM-level text entry, used when the CDP input-domain write had no effect
   * (hidden window). Prefers `execCommand('insertText')` — that is the path rich
   * editors (contenteditable/Lexical) accept — and falls back to the element's
   * native `value` setter plus `input`/`change` events, which is what React
   * controlled inputs require.
   *
   * @returns `'typed'` on success, otherwise a short reason.
   */
  private async insertTextViaDom(
    tab: BrowserTab,
    selector: string,
    text: string,
    clear: boolean,
  ): Promise<'typed' | 'unsupported' | 'not-found'> {
    const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
      expression: `
        (() => {
          const el = document.querySelector(${JSON.stringify(String(selector))});
          if (!el) return 'not-found';
          el.focus();
          const editable = el.isContentEditable === true || typeof el.value === 'string';
          if (!editable) return 'unsupported';
          if (${JSON.stringify(clear)}) {
            if (el.isContentEditable) {
              try { document.execCommand('selectAll', false, undefined); document.execCommand('delete', false, undefined); } catch {}
            } else if (typeof el.select === 'function') {
              el.select();
            }
          }
          let inserted = false;
          try { inserted = document.execCommand('insertText', false, ${JSON.stringify(text)}); } catch { inserted = false; }
          if (!inserted && typeof el.value === 'string') {
            const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
            const next = ${JSON.stringify(clear)} ? ${JSON.stringify(text)} : String(el.value ?? '') + ${JSON.stringify(text)};
            if (descriptor !== undefined && typeof descriptor.set === 'function') descriptor.set.call(el, next);
            else el.value = next;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            inserted = true;
          }
          return inserted ? 'typed' : 'unsupported';
        })()
      `,
      returnByValue: true,
    })
    const value = result.result?.value
    return value === 'typed' || value === 'unsupported' || value === 'not-found' ? value : 'unsupported'
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
      // 2026-09-12：与 browser_click 同源。键盘事件也属输入域，隐藏窗口下协议层接受、
      // 页面收不到（真机自检报告把 browser_press 记成"返回成功"，但没有验证效果）。
      if (this.windowCanReceiveInput()) {
        await tab.cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        })
        await tab.cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        })
        this.record('browser_press', resolved, `press ${key}`)
        return
      }
      const outcome = await this.dispatchKeyViaDom(tab, key, code, vk)
      this.record('browser_press', resolved, `press ${key} via DOM dispatch (hidden window) — ${outcome}`, outcome === 'none')
    }, signal)
  }

  /**
   * DOM-level key dispatch for a window that cannot receive real input.
   *
   * Synthetic keyboard events do **not** trigger a browser's activation behavior,
   * so the two shortcuts users actually depend on are applied explicitly:
   * Enter inside a form submits it, and Enter/Space on a button, link, checkbox
   * or radio activates it. Without that, "fill the field then press Enter" would
   * silently do nothing in a hidden window.
   *
   * @returns a short outcome label for the op log.
   */
  private async dispatchKeyViaDom(tab: BrowserTab, key: string, code: string, vk: number): Promise<string> {
    const result = await tab.cdp.send<EvalResult>('Runtime.evaluate', {
      expression: `
        (() => {
          const key = ${JSON.stringify(key)};
          const target = document.activeElement ?? document.body;
          if (!target) return 'none';
          const base = { key, code: ${JSON.stringify(code)}, keyCode: ${JSON.stringify(vk)}, which: ${JSON.stringify(vk)}, bubbles: true, cancelable: true, composed: true };
          const down = new KeyboardEvent('keydown', base);
          const allowed = target.dispatchEvent(down);
          target.dispatchEvent(new KeyboardEvent('keypress', base));
          target.dispatchEvent(new KeyboardEvent('keyup', base));
          if (!allowed) return 'default-prevented';
          if (key === 'Enter') {
            const form = target.form ?? (typeof target.closest === 'function' ? target.closest('form') : null);
            if (form !== null && form !== undefined && typeof form.requestSubmit === 'function') { form.requestSubmit(); return 'submitted-form'; }
          }
          const activatable = typeof target.closest === 'function'
            ? target.closest('button, a[href], input[type=checkbox], input[type=radio], [role=button]')
            : null;
          const activating = key === 'Enter' || key === ' ' || key === 'Spacebar';
          if (activating && activatable !== null && activatable !== undefined && typeof activatable.click === 'function') {
            activatable.click();
            return 'activated-element';
          }
          return 'dispatched';
        })()
      `,
      returnByValue: true,
    })
    const value = result.result?.value
    return typeof value === 'string' ? value : 'dispatched'
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
      // Remember what this tab was given (P0-A depth layer: runtime.snapshot
      // redacts these values even if a future probe source reads them back), and
      // open the credential-activity window (R-4): from here until the next
      // main-frame navigation, `browser_eval` and `browser_screenshot` are shut.
      // The window opens on ANY successful fill — a username-only injection is
      // still a credential in the DOM — while `filledSecrets` (the redaction
      // list) only ever holds passwords: a short username is an ordinary word
      // and masking it in page text would corrupt facts (R-3).
      tab.credentialWindow = true
      if (value.password === true && typeof credential.password === 'string' && credential.password !== ''
        && !tab.filledSecrets.includes(credential.password)) {
        tab.filledSecrets.push(credential.password)
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
      // The condition spec travels as a CDP *argument*: the page-side source is
      // the constant WAIT_FOR_FUNCTION_DECLARATION, so selector/text/URL values
      // can never become page-side syntax (they are data, not code).
      const payload = waitForPayload(options, startUrl)
      while (Date.now() < deadline) {
        if (signal !== undefined && signal.aborted) throw browserError('interrupted', 'browser: wait aborted')
        try {
          const state = await tab.cdp.send<EvalResult>('Runtime.callFunctionOn', {
            functionDeclaration: WAIT_FOR_FUNCTION_DECLARATION,
            // Re-resolved every poll: a navigation destroys the old object (and
            // with it the id), which is exactly the state `url-change` waits on.
            objectId: await pageGlobalObjectId(tab),
            arguments: [{ value: payload }],
            returnByValue: true,
          })
          if (state.result?.value === true) {
            this.updateTabState(tab)
            return { ok: true, reason: options.condition }
          }
          lastReason = `condition not met (${options.condition})`
        } catch (cause) {
          // Keep the underlying failure: a navigation destroys the execution
          // context mid-poll, and swallowing that into a constant "page not
          // ready" made a real-device timeout indistinguishable from "the URL
          // never changed" (report 2026-09-12).
          const message = cause instanceof Error ? cause.message : String(cause)
          lastReason = `page not ready: ${message.slice(0, 200)}`
        }
        await sleep(Math.min(250, Math.max(50, deadline - Date.now())))
      }
      this.updateTabState(tab)
      const urlChanged = tab.url !== startUrl ? 'page navigated' : lastReason
      // R-1: the reason is the tool's return value; a CDP failure text can carry
      // the current URL, so the whole string goes through the text redactor.
      // R-6: plus this tab's value set — a page-chosen URL (`?pw=<value>`) is
      // not credential-shaped, so the key vocabulary alone would let it through.
      return { ok: false, reason: redactFilledSecretsText(tab, stripSensitiveText(`wait_for ${options.condition} timed out — ${urlChanged}`), { verbatim: true }) }
    }, signal)
  }

  /** Page-side wait predicate source. Constant by construction — the values
   * arrive through `Runtime.callFunctionOn` `arguments` (see `waitPayload`). */
  static waitFunctionDeclaration(): string {
    return WAIT_FOR_FUNCTION_DECLARATION
  }

  /** Wait-for payload builder (pure, testable). */
  static waitPayload(options: WaitForOptions, startUrl = ''): WaitForPayload {
    return waitForPayload(options, startUrl)
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
    // R-5: bookmarks are persisted AND handed back to the model
    // (`browser_bookmarks_list`), so the value set applies to both fields.
    const entry = this.store.addBookmark({
      url: redactFilledSecretsText(tab, tab.url, { verbatim: true }),
      title: redactFilledSecretsText(tab, title ?? tab.title),
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
    // R-5 (2026-09-13): a download carries no tab identity (a session-level
    // Electron event), so its value set is the union of the live tabs' sets —
    // the tab that received the credential is live when it triggers a download.
    // `fileName` was already redacted at the write path; `path` is the real
    // on-disk handle (`downloads_open`, the file tools) and stays truthful in
    // the store, so the model-facing projection swaps in the redacted display
    // path recorded when the entry was written.
    const secrets = this.liveSecrets()
    return this.store.queryDownloads(filter).map((entry) => {
      const displayPath = this.downloadDisplayPaths.get(entry.id)
      const projected: DownloadEntry = displayPath === undefined ? entry : { ...entry, path: displayPath }
      if (secrets.length === 0) return projected
      return {
        ...projected,
        fileName: redactSecretsText(secrets, projected.fileName, { verbatim: true }),
        path: redactSecretsText(secrets, projected.path, { verbatim: true }),
      }
    })
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
    // R-6: attribute the op to the live tab (it used to be tab 0, which the op
    // log cannot value-scrub) — the summary embeds the real path, which carries
    // the download name.
    this.record('browser_download_open', this.pool.activeTab ?? 0, `open download: ${entry.path}`)
    return result.error === undefined ? { ok: true } : { ok: false, error: result.error }
  }

  /** Download recorder adapter for guard events.
   *
   * R-5 (2026-09-13): the name comes from `Content-Disposition` or the URL
   * basename, and a page can pick BOTH (`<a download=pw + '.txt'>`) — no
   * key-shaped rule can see a value in it, so the live tabs' value set is
   * applied at the write path (the store keeps the redacted name; the response
   * headers are not a model-facing exit). `path` must stay the real handle for
   * `downloads_open`, so its redacted variant is remembered separately and used
   * by the model-facing projection (`runtime.downloads`). */
  private downloadRecorder(): { add: (entry: Omit<DownloadEntry, 'id' | 'createdAt'>) => number; update: (id: number, patch: Partial<Pick<DownloadEntry, 'status' | 'path' | 'size'>>) => void } {
    return {
      add: (entry) => {
        const secrets = this.liveSecrets()
        const record = this.store.addDownload(secrets.length === 0 ? entry : {
          ...entry,
          url: redactSecretsText(secrets, entry.url, { verbatim: true }),
          fileName: redactSecretsText(secrets, entry.fileName, { verbatim: true }),
        })
        if (entry.path !== '') this.rememberDownloadPath(record.id, secrets, entry.path)
        return record.id
      },
      update: (id, patch) => {
        if (patch.path !== undefined && patch.path !== '') this.rememberDownloadPath(id, this.liveSecrets(), patch.path)
        this.store.updateDownload(id, patch)
      },
    }
  }

  /** Union of the live tabs' injected-value sets (downloads/bookmarks have no
   * single owning tab). Empty when nothing was injected in this browser. */
  private liveSecrets(): string[] {
    const out: string[] = []
    for (const tab of this.tabs.values()) {
      for (const secret of tab.filledSecrets) {
        if (secret !== '' && !out.includes(secret)) out.push(secret)
      }
    }
    return out
  }

  /** Remember the redacted display path of a download (bounded; the store keeps
   * the truthful handle). */
  private rememberDownloadPath(id: number, secrets: readonly string[], path: string): void {
    if (secrets.length === 0) return
    const redacted = redactSecretsText(secrets, path, { verbatim: true })
    if (redacted === path) return
    this.downloadDisplayPaths.set(id, redacted)
    if (this.downloadDisplayPaths.size > DOWNLOAD_DISPLAY_PATH_LIMIT) {
      const oldest = this.downloadDisplayPaths.keys().next()
      if (oldest.done !== true) this.downloadDisplayPaths.delete(oldest.value)
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
      throw browserError('navigation-blocked', `browser: download denied — ${stripSensitiveUrl(url).slice(0, 200)}`)
    }
    const active = this.pool.activeTab
    if (active === undefined) throw browserError('not-found', 'browser: no tab open in the browser')
    await this.agentRun('browser_download', async () => {
      const tab = this.tab(active)
      tab.view.webContents.downloadURL(url)
      this.store.addHistory({
        // FIX-06: the summary title embeds the (possibly signed) URL verbatim;
        // redact it here so it never depends on the store having to clean up.
        // R-5: plus the tab's value set, same as the navigate path.
        time: Date.now(),
        url: redactFilledSecretsText(tab, url, { verbatim: true }),
        title: redactFilledSecretsText(tab, `download: ${stripSensitiveUrl(url)}`, { verbatim: true }),
        actor: 'ai',
        group: '',
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

/** Everything the page-side wait predicate needs, as **data**.
 *
 * The six conditions are evaluated by `WAIT_FOR_FUNCTION_DECLARATION` inside the
 * page, with this object passed through CDP `Runtime.callFunctionOn`
 * `arguments`. Nothing here is ever concatenated into page-side source: a
 * selector/text/URL value can only ever be a string value, never a syntax node
 * (`js/bad-code-sanitization`). */
export interface WaitForPayload {
  condition: WaitForOptions['condition']
  /** `null` when the condition has no selector — `querySelector(null)` yields null. */
  selector: string | null
  text: string | null
  startUrl: string
  networkIdleMs: number
}

/** The page-side wait predicate: a **constant** function body.
 *
 * `payload.selector` / `payload.text` / `payload.startUrl` are looked up as
 * values only; the source text of this function never changes with the input,
 * so there is no code-construction point at all. Kept byte-stable so tests can
 * evaluate it under `node:vm` together with `waitForPayload`.
 *
 * DO NOT interpolate anything into this string: an interpolated
 * selector/text/URL would turn the AI's tool input back into page-side syntax
 * (`js/bad-code-sanitization`, alerts #40/#41/#43/#44). Add a field to
 * `WaitForPayload` instead. */
const WAIT_FOR_FUNCTION_DECLARATION = `function (payload) {
  switch (payload.condition) {
    case 'element-present': {
      const el = document.querySelector(payload.selector);
      return el !== null;
    }
    case 'element-visible': {
      const el = document.querySelector(payload.selector);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    }
    case 'text-appear':
      return (document.body ? document.body.innerText : '').includes(payload.text);
    case 'url-change':
      // TRUE only when the page actually navigated away from the captured URL.
      return location.href !== payload.startUrl;
    case 'network-idle': {
      // TRUE once the last resource has been quiet for at least
      // payload.networkIdleMs (or the document is already complete with no
      // resource entries at all).
      const rs = performance.getEntriesByType('resource');
      if (rs.length === 0) return document.readyState === 'complete';
      const last = rs[rs.length - 1];
      return performance.now() - (last.responseEnd || 0) > payload.networkIdleMs;
    }
    case 'settled':
      return document.readyState === 'complete';
    default:
      return false;
  }
}`

/** Build the wait-for payload (pure function). The `startUrl` is the URL
 * captured when the wait began — `url-change` compares against it so the
 * condition only succeeds on an ACTUAL navigation. */
function waitForPayload(options: WaitForOptions, startUrl = ''): WaitForPayload {
  return {
    condition: options.condition,
    selector: options.selector ?? null,
    text: options.text ?? null,
    startUrl,
    networkIdleMs: NETWORK_IDLE_TICK_MS,
  }
}

/** `objectId` of the page's global object, so the constant predicate can run in
 * the page's own world via `Runtime.callFunctionOn`. */
async function pageGlobalObjectId(tab: BrowserTab): Promise<string> {
  const global = await tab.cdp.send<{ result?: { objectId?: string } }>('Runtime.evaluate', {
    expression: 'globalThis',
  })
  const objectId = global.result?.objectId
  if (objectId === undefined) {
    throw browserError('not-found', 'browser: page has no global object to evaluate against')
  }
  return objectId
}

const NETWORK_IDLE_TICK_MS = 800

/**
 * Resolve `attempt`, or reject once `budgetMs` elapses without it settling.
 *
 * `webContents.capturePage()` can stay pending forever on a window with no viz
 * surface rather than rejecting, so the caller's rejection-only fallback was
 * unreachable and the tool reported a bare timeout. Losing the race is not a
 * failure of the abandoned attempt: it keeps a rejection handler so a late
 * failure can never surface as an unhandled rejection.
 *
 * @param attempt - the capture already in flight.
 * @param budgetMs - how long it may take before the caller falls back.
 * @returns the capture result when it settles in time.
 */
async function withScreenshotBudget(attempt: Promise<string>, budgetMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      attempt,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`capture did not settle within ${budgetMs}ms`)) }, budgetMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    attempt.catch(() => { /* superseded by the renderer-side fallback */ })
  }
}

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

/**
 * Model-facing refusals of the credential-activity window (R-4, 2026-09-13).
 *
 * Exported so the regression tests and the real-machine probes assert on the
 * shipped string instead of a copy of it, and so the release notes can quote
 * what a user sees. Both name the tool, the cause and the way out.
 */
export const CREDENTIAL_WINDOW_EVAL_REFUSAL = 'browser: browser_eval is paused on this tab — credentials were injected here through browser_fill_credentials and are still in the page, so any script read-back could hand them to the model (a transformed value, a frame realm or an image is still a channel). Submit the form or navigate the tab to leave the credential window; browser_eval resumes automatically on the next document.'

/** Screenshot half of the window refusal (the page can render a credential as
 * text or a barcode, which no image redaction can undo). */
export const CREDENTIAL_WINDOW_SCREENSHOT_REFUSAL = 'browser: browser_screenshot is paused on this tab — credentials were injected here through browser_fill_credentials and are still in the page, and a page can render them as text or a barcode that no image redaction can undo. Submit the form or navigate the tab to leave the credential window; screenshots resume automatically on the next document.'

/** Redact credential-shaped parts of a browser op-log summary. Delegates to
 * `store.stripSensitiveText` (userinfo + sensitive query parameters + fragment
 * pairs) so the same URL never reads `****` in history and cleartext in the op
 * log / activity panel (P1-5, and FIX-06 for titles). The scanner used to live
 * here as a second copy; it now has exactly one implementation. */
function maskBrowserSummary(summary: string): string {
  return stripSensitiveText(summary)
}

/**
 * Shortest injected secret that may be redacted as a **substring** of a longer
 * text (R-3, 2026-09-13).
 *
 * Below this length a bare `includes()` match is not evidence of a credential:
 * `abc123` is also an order id, a SKU, a build number. The independent
 * re-verification found the page text `order abc123 confirmed` rewritten to
 * `order **** confirmed`, i.e. the redactor was *corrupting facts* the model
 * needs in order to act — a false positive that is worse than the leak it
 * prevents, because the leak (a short password echoed in prose) is ambiguous
 * by construction while the corruption is certain.
 *
 * A short secret is therefore still redacted in the shapes that are not
 * ambiguous — the whole field, an assignment (`password=abc123`), a JSON pair
 * (`"pw":"abc123"`) and a keyed wrapper (`token=[abc123]`) — and left alone in
 * prose, INCLUDING prose that happens to bracket or quote it (`Item (abc123)
 * shipped`, `Ref "abc123" noted`: R-4 closed that last residual by requiring a
 * credential key name in front of a bracket/quote before it counts as a value).
 */
export const MIN_EMBEDDED_SECRET_LENGTH = 8

/** Characters that make a short occurrence look like a *value* on its left, on
 * their own: `key=value`, `key: value`, `user:pass@host`. */
const VALUE_LEFT_STRONG = new Set(['=', ':'])
/** Characters that only *suggest* a value position: brackets, quotes and
 * separators. Prose uses them too (`Item (abc123) shipped`, `Ref "abc123"
 * noted`), so an occurrence wrapped in one of them is masked only when a
 * credential KEY name sits in the fragment in front of it (R-4, 2026-09-13). */
const VALUE_LEFT_WEAK = new Set(['(', '[', '{', ',', '"', "'"])
/** Characters that make it look like a value on its right. `@` covers
 * userinfo (`user:abc123@host`) — the left-hand `:` alone is not enough — and
 * the whitespace characters end a value the way a page's own markup does
 * (`password=abc123\n…`: without them the newline made the occurrence look like
 * prose and the credential was returned verbatim). */
const VALUE_RIGHT = new Set(['"', "'", ')', ']', '}', ',', ';', '&', '@', '\n', '\r', '\t'])
/** Structural characters that end the backward scan for a key name: the
 * fragment in front of the value cannot cross them. `=`/`:` are deliberately
 * absent — they are the separator the key name sits before. */
const KEY_STOP = new Set([';', '{', '}', '<', '>', ',', '(', ')', '[', ']', '"', "'", '\n', '\r', '|'])
/** How far back (characters) a wrapped occurrence looks for that key name. */
const KEY_LOOKBACK = 48

/** Characters skipped when looking for the delimiter next to an occurrence:
 * whitespace, and the backslash that JSON string escaping puts in front of a
 * quote (`serializeEvalResult` hands the redactor `"{\"pw\":\"abc123\"}"`, where
 * the quote next to the value is escaped). */
function isSkippable(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\\'
}

/** Nearest significant character index walking left from `from`, if any. */
function nearestLeftIndex(text: string, from: number): number {
  for (let i = from; i >= 0; i--) {
    if (!isSkippable(text[i]!)) return i
  }
  return -1
}

/**
 * Nearest significant character walking right from `from`, if any.
 *
 * Only spaces (alignment before a delimiter) and the JSON string escape are
 * skipped — NOT newlines: a line break is where a page's value ends, and
 * skipping it made `password=abc123\nnext line` read as prose and hand the
 * credential back verbatim (real-machine `credential-window-probe.mjs`, R-3).
 */
function nearestRight(text: string, from: number): string | undefined {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!
    if (ch !== ' ' && ch !== '\\') return ch
  }
  return undefined
}

/** True when a credential KEY name (`password`, `token`, `sid`, …) sits in the
 * fragment immediately in front of the delimiter at `delimiterIndex`. */
function keyVocabularyBefore(text: string, delimiterIndex: number): boolean {
  let start = delimiterIndex
  const floor = Math.max(0, delimiterIndex - KEY_LOOKBACK)
  while (start > floor && !KEY_STOP.has(text[start - 1]!)) start--
  return start < delimiterIndex && SENSITIVE_KEY_PATTERN.test(text.slice(start, delimiterIndex))
}

/**
 * Redact the occurrences of a SHORT secret that are *value-shaped*:
 * `password=abc123`, `"pw":"abc123"`, `user:abc123@host`, `?token=abc123&x=1`,
 * `token=[abc123]`. Prose keeps its text (`order abc123 confirmed`,
 * `Item (abc123) shipped`, `Ref "abc123" noted`), and so does a longer word
 * containing the value (`xabc123y`).
 *
 * R-4 (2026-09-13) splits the left context in two, because the earlier single
 * delimiter set rewrote facts: parentheses and quotes are punctuation in prose,
 * so they only count as a value position when a credential key name precedes
 * them. `=`/`:` stay unconditional — that shape is an assignment.
 */
function maskShortSecretOccurrences(text: string, secret: string): string {
  const parts: string[] = []
  let from = 0
  for (;;) {
    const at = text.indexOf(secret, from)
    if (at < 0) {
      parts.push(text.slice(from))
      return parts.join('')
    }
    parts.push(text.slice(from, at), isValueShaped(text, at, secret.length) ? MASK : secret)
    from = at + secret.length
  }
}

/** Is the occurrence at `at` sitting where a *value* would sit? */
function isValueShaped(text: string, at: number, length: number): boolean {
  const leftIndex = at === 0 ? -1 : nearestLeftIndex(text, at - 1)
  const left = leftIndex < 0 ? undefined : text[leftIndex]!
  // R-5 (2026-09-13): an assignment delimiter is a value position on its own,
  // whatever character follows the occurrence. The R-4 rule checked the RIGHT
  // character first, and internal `innerText` folds the page's newline into a
  // space — so `password=abc123\nnext line` arrived as `password=abc123 next
  // line`, the character after the short password was an ordinary `n`, and the
  // credential was returned verbatim (real-machine probe E, R-5). A longer word
  // that merely starts with the value (`x=abc123y`) is over-masked in the same
  // step: fail-closed, and the visible tail is recoverable from the page.
  if (left !== undefined && VALUE_LEFT_STRONG.has(left)) return true
  const right = at + length >= text.length ? undefined : nearestRight(text, at + length)
  if (right !== undefined && !VALUE_RIGHT.has(right)) return false
  if (left === undefined) return true
  if (!VALUE_LEFT_WEAK.has(left)) return false
  // A quote right after a separator is a value (`"pw":"abc123"`, `pw: "abc123"`).
  if (left === '"' || left === "'") {
    const before = nearestLeftIndex(text, leftIndex - 1)
    if (before >= 0 && VALUE_LEFT_STRONG.has(text[before]!)) return true
  }
  return keyVocabularyBefore(text, leftIndex)
}

/**
 * Value-level redaction of the secrets this tab received through
 * `fillCredentials` (P0-A depth layer, extended to `browser_eval` by FIX-03,
 * to `browser_get_text` and short-secret precision by R-1/R-3 on 2026-09-13,
 * re-scoped by the R-4 credential window and made TAB-scoped by R-5).
 *
 * Exact-value matching: a page string that merely *talks* about passwords is
 * untouched, while an injected secret can never leave through a snapshot or the
 * page text — no matter which probe/field/expression produced it. A text that is
 * a truncated head of a longer secret (the probe caps text at 80 chars) is
 * redacted as a whole.
 *
 * `verbatim: true` (R-5) is for strings that cannot be prose: a URL, a download
 * name/path, a file name. There a short secret is masked on EVERY occurrence
 * rather than only in a value-shaped position — a page that chooses its own
 * parameter name (`?pw=…`) or none at all (`#…`) must not turn the value into
 * an ordinary-looking token. Titles, page text and eval results keep the
 * prose-preserving short-secret rule, because those strings really can be prose.
 *
 * ONE implementation for every text funnel (`runtime.snapshot`,
 * `runtime.text`, `runtime.eval`'s result, the tab projection, history/ledger,
 * the op log, downloads). HONEST BOUNDARY: the match is verbatim — a page that
 * transforms the value (base64, reversed, character-split) renders something
 * this function cannot recognize; that residual is declared in the tool
 * descriptions and asserted by `tests/probes/r6-outlet-probe.mjs`.
 */
function redactFilledSecretsText(tab: BrowserTab, text: string, options: { verbatim?: boolean } = {}): string {
  return redactSecretsText(tab.filledSecrets, text, options)
}

/** Secrets-array core of {@link redactFilledSecretsText}: also usable for exits
 * with no single owning tab (a download is a session event, so its redaction set
 * is the union of the live tabs' sets). */
function redactSecretsText(secrets: readonly string[], text: string, options: { verbatim?: boolean } = {}): string {
  if (secrets.length === 0) return text
  let out = text
  for (const secret of secrets) {
    if (secret === '') continue
    if (out === secret) { out = MASK; continue }
    // A truncated head of a longer secret is unambiguous once it is long
    // enough to not be an ordinary word.
    if (out.length >= MIN_EMBEDDED_SECRET_LENGTH && secret.startsWith(out)) { out = MASK; continue }
    if (options.verbatim === true || secret.length >= MIN_EMBEDDED_SECRET_LENGTH) {
      if (out.includes(secret)) out = out.split(secret).join(MASK)
      continue
    }
    out = maskShortSecretOccurrences(out, secret)
  }
  return out
}

/** Snapshot-shaped wrapper around {@link redactFilledSecretsText}: keeps the
 * element objects untouched when nothing matched. */
function redactFilledSecrets(tab: BrowserTab, elements: BrowserSnapshotElement[]): BrowserSnapshotElement[] {
  if (tab.filledSecrets.length === 0) return elements
  return elements.map((element) => {
    const text = redactFilledSecretsText(tab, element.text)
    return text === element.text ? element : { ...element, text }
  })
}

/** How long to wait for `Runtime.enable` to re-report existing execution
 * contexts, and the re-check interval (the enable response and the
 * `executionContextCreated` notifications race on the wire; Chromium reports
 * them alongside the reply, but a slow renderer can lag). */
const FRAME_CONTEXT_WAIT_MS = 500
const FRAME_CONTEXT_POLL_MS = 10

/** Extra settle time before refusing an index a dynamic page may still be
 * committing (a frame owner inserted a tick before its frame exists). */
const FRAME_INDEX_SETTLE_MS = 150

/** One entry of the DOM-ordered frame index (`frame: N`). */
interface ResolvedFrame {
  frameId: string
  url: string
  depth: number
  /** Flat CDP session of an out-of-process (cross-origin) frame. */
  sessionId?: string
  /** Default-world context of a same-process frame (absent for frame 0). */
  contextId?: number
}

/** Raw `Page.getFrameTree` node shape. */
interface RawFrameNode {
  frame?: { id?: string; url?: string; parentId?: string }
  childFrames?: RawFrameNode[]
}

/**
 * Execution context id of `frameId`'s DEFAULT world.
 *
 * `frame: 0` evaluates in the default world implicitly (no `contextId` is
 * passed) and `frame: N > 0` must mean exactly the same thing: the tool
 * advertises reading page-owned data ("SSR globals, hidden fields, datasets").
 * `Page.createIsolatedWorld` — used here before 2026-09-12 — shares the DOM but
 * NOT the page's JS globals by design, so `window.__APP__` silently read as
 * `undefined` in every frame but the main one (P1-7). The default-world context
 * of a frame can only be learned from `Runtime.executionContextCreated`
 * (`auxData.frameId` + `auxData.isDefault`), which `Runtime.enable` re-emits for
 * every existing context.
 *
 * `sessionId` (R-4, 2026-09-13): the flat CDP session that owns the frame. A
 * frame inside an out-of-process iframe has its execution contexts in THAT
 * session, so both the `Runtime.enable` that reports them and the events that
 * carry them are session-scoped. Without this the nested frame's context was
 * searched in the page session, found nowhere, and the whole index was refused.
 */
async function defaultWorldContextId(tab: BrowserTab, frameId: string, sessionId?: string): Promise<number | undefined> {
  const contexts: Array<{ id: number; frameId: string | undefined; isDefault: boolean; session: string | undefined }> = []
  const dispose = tab.cdp.on('Runtime.executionContextCreated', (params, eventSession) => {
    const context = (params as {
      context?: { id?: number; auxData?: { frameId?: string; isDefault?: boolean } }
    }).context
    if (context?.id === undefined) return
    contexts.push({
      id: context.id,
      frameId: context.auxData?.frameId,
      isDefault: context.auxData?.isDefault === true,
      session: eventSession,
    })
  })
  const call = sessionId === undefined ? {} : { sessionId }
  /**
   * A frame id is announced by the session that can reach the frame, so a
   * same-session context is the answer. An event that arrives with NO session
   * attribution (a transport that does not report flat-session ids) is accepted
   * only as a fallback — never preferred over an attributed one, which is how a
   * context belonging to another process would otherwise be adopted.
   */
  const pick = (): number | undefined => {
    const matches = (context: { frameId: string | undefined; isDefault: boolean }): boolean => context.frameId === frameId && context.isDefault
    if (sessionId === undefined) return contexts.find(matches)?.id
    const exact = contexts.find((context) => matches(context) && context.session === sessionId)
    if (exact !== undefined) return exact.id
    return contexts.find((context) => matches(context) && context.session === undefined)?.id
  }
  const look = async (): Promise<number | undefined> => {
    await tab.cdp.send('Runtime.enable', {}, call)
    const deadline = Date.now() + FRAME_CONTEXT_WAIT_MS
    for (;;) {
      const hit = pick()
      if (hit !== undefined) return hit
      if (Date.now() >= deadline) return undefined
      await new Promise((resolve) => setTimeout(resolve, FRAME_CONTEXT_POLL_MS))
    }
  }
  try {
    const first = await look()
    if (first !== undefined) return first
    // Chromium does NOT re-announce the existing execution contexts on a second
    // `Runtime.enable` — verified on Electron 43.4.0 with real CDP
    // (`tests/probes/frame-index-probe.mjs`): after
    // `Target.setAutoAttach({flatten:true})` (which the frame index needs for
    // out-of-process frames) the next `Runtime.enable` reported nothing, while
    // `Runtime.disable` + `Runtime.enable` reported every context again. Without
    // this cycle the R-4 resolver would refuse every same-process subframe of a
    // page that also has an OOPIF.
    contexts.length = 0
    try { await tab.cdp.send('Runtime.disable', {}, call) } catch { /* not enabled */ }
    return await look()
  } finally {
    dispose()
  }
}
