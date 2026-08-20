/**
 * BrowserRuntime: the embedded agent-driven browser service. Owns the tab
 * pool (one WebContentsView per tab), the CDP sessions, the agent/user
 * control mutex, navigation, interaction primitives, guards, and the audit
 * op log. Everything Electron-specific flows through the injected adapter,
 * so the whole service is unit-testable headlessly.
 * @module @picoaide/dsh-browser
 */

import { CdpSession } from './cdp.ts'
import type { ElectronAdapter, NativeSession, NativeView } from './electron-adapter.ts'
import { BrowserGuard, installPermissionGuard } from './guard.ts'
import { extractSnapshot, extractText } from './snapshot.ts'
import { captureScreenshot } from './shots.ts'
import type {
  BrowserOpLogEntry,
  BrowserPanelState,
  BrowserSnapshotElement,
  BrowserTabState,
  BrowserToolOptions,
  BrowserWaitUntil,
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

  /** Run `work` while holding the browser control; rejects under takeover. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.taken) throw new Error('browser: the user is currently controlling the browser; ask them to release it')
    const prev = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await prev
    if (this.taken) {
      release()
      throw new Error('browser: the user took over the browser')
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
  }

  release(): void {
    this.taken = false
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
  private readonly ops: BrowserOpLogEntry[] = []
  private opSeq = 0
  private panel: BrowserPanelState = { visible: false }
  private readonly guard: BrowserGuard
  private readonly permissionsDisposers: Array<() => void> = []
  private readonly downloadDisposers: Array<() => void> = []
  private readonly windowGoneDisposer: () => void
  private disposed = false

  constructor(
    private readonly adapter: ElectronAdapter,
    options: BrowserToolOptions = {},
    askApproval?: BrowserGuard['askApproval'],
    private readonly credentials?: CredentialResolver,
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
    this.windowGoneDisposer = adapter.onMainWindowGone(() => {
      for (const tab of this.tabs.values()) tab.view.detach()
      this.panel = { visible: false }
    })
  }

  readonly options: Required<BrowserToolOptions>

  /** Current panel visibility + placement (set by the client panel). */
  get panelState(): BrowserPanelState {
    return this.panel
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

  /** Update the panel placement and re-layout the visible view. */
  setPanel(state: BrowserPanelState): void {
    this.panel = state
    if (!state.visible) {
      for (const tab of this.tabs.values()) tab.view.setVisible(false)
      return
    }
    const visible = this.visibleTab()
    if (visible !== undefined && state.bounds !== undefined) {
      visible.view.setVisible(true)
      visible.view.setBounds(state.bounds)
    }
  }

  private record(tool: string, tab: number, summary: string, failed = false): void {
    // P2-1: redact credential-shaped material from the op log — the summary
    // can carry full URLs whose query may embed tokens/codes.
    this.ops.push({ seq: ++this.opSeq, time: Date.now(), tool, tab, summary: maskBrowserSummary(summary), failed })
    if (this.ops.length > OP_LOG_LIMIT) this.ops.shift()
  }

  private visibleTab(): BrowserTab | undefined {
    return this.visibleTabId === undefined ? undefined : this.tabs.get(this.visibleTabId)
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
   */
  async open(url: string | undefined): Promise<BrowserTabState> {
    if (this.disposed) throw new Error('browser: runtime disposed')
    if (this.tabs.size >= this.options.maxTabs) {
      throw new Error(`browser: tab limit reached (${this.options.maxTabs}); close a tab first`)
    }
    const id = this.nextTabId++
    const view = this.adapter.createView()
    const cdp = new CdpSession(view.webContents.cdp)
    await cdp.attach()
    const tab: BrowserTab = { id, view, cdp, url: '', title: '', loading: false }
    this.tabs.set(id, tab)

    const win = this.adapter.getMainWindow()
    if (win === undefined) {
      throw new Error('browser: no main window (the browser needs the desktop shell)')
    }
    if (this.panel.visible && this.panel.bounds !== undefined) {
      view.attach(win, this.panel.bounds)
      view.setVisible(true)
    } else {
      view.attach(win, { x: 0, y: 0, width: 0, height: 0 })
      view.setVisible(false)
    }
    this.visibleTabId = id

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
      await this.navigate(id, url, 'domcontentloaded')
    }
    this.updateTabState(tab)
    this.record('browser_open', id, url === undefined || url === '' ? 'new tab' : url)
    return this.tabState(id)
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

  /** Run one agent operation under the control mutex. */
  async withControl<T>(_tool: string, tabId: number, work: (tab: BrowserTab) => Promise<T>): Promise<T> {
    return await this.mutex.run(async () => {
      const tab = this.tab(tabId)
      const result = await work(tab)
      this.updateTabState(tab)
      return result
    })
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
   * tick.
   */
  async navigate(id: number, url: string, waitUntil: BrowserWaitUntil = 'domcontentloaded'): Promise<void> {
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
        if (waitUntil === 'domcontentloaded' && wc.isLoading() === false && wc.getURL() !== '') settle()
      })
    }
  }

  /** Extract the interactable-element snapshot of one tab. */
  async snapshot(id: number): Promise<BrowserSnapshotElement[]> {
    return await this.withControl('browser_get_snapshot', id, (tab) =>
      extractSnapshot((m, p) => tab.cdp.send(m, p), this.options.snapshotLimit))
  }

  /** Extract page text (optionally scoped by selector). */
  async text(id: number, selector: string | undefined): Promise<string> {
    return await this.withControl('browser_get_text', id, (tab) =>
      extractText((m, p) => tab.cdp.send(m, p), selector, this.options.textLimit))
  }

  /** Capture a JPEG screenshot of one tab. */
  async screenshot(id: number): Promise<string> {
    return await this.withControl('browser_screenshot', id, (tab) =>
      captureScreenshot(tab.view.webContents, this.options.screenshotMaxWidth, this.options.screenshotQuality))
  }

  /** Navigate history. */
  async goBack(id: number): Promise<void> {
    await this.withControl('browser_go_back', id, async (tab) => {
      const wc = tab.view.webContents
      if (wc.isDestroyed()) return
      wc.goBack()
      await this.waitForLoad(wc, 'domcontentloaded')(this.options.timeoutMs)
      this.updateTabState(tab)
    })
  }

  async goForward(id: number): Promise<void> {
    await this.withControl('browser_go_forward', id, async (tab) => {
      const wc = tab.view.webContents
      if (wc.isDestroyed()) return
      wc.goForward()
      await this.waitForLoad(wc, 'domcontentloaded')(this.options.timeoutMs)
      this.updateTabState(tab)
    })
  }

  async reload(id: number): Promise<void> {
    await this.withControl('browser_reload', id, async (tab) => {
      const wc = tab.view.webContents
      if (wc.isDestroyed()) return
      wc.reload()
      await this.waitForLoad(wc, 'domcontentloaded')(this.options.timeoutMs)
      this.updateTabState(tab)
    })
  }

  /** Switch the visible tab. */
  async switchTab(id: number): Promise<void> {
    const tab = this.tab(id)
    for (const other of this.tabs.values()) other.view.setVisible(other.id === id)
    this.visibleTabId = id
    if (this.panel.visible && this.panel.bounds !== undefined) {
      tab.view.setBounds(this.panel.bounds)
    }
    this.record('browser_switch_tab', id, `switch to tab ${id}`)
  }

  /** Close a tab and destroy its view/CDP. */
  async closeTab(id: number): Promise<void> {
    const tab = this.tabs.get(id)
    if (tab === undefined) return
    tab.cdp.detach()
    tab.view.detach()
    tab.view.destroy()
    this.tabs.delete(id)
    if (this.visibleTabId === id) {
      this.visibleTabId = [...this.tabs.keys()].at(-1)
      if (this.visibleTabId !== undefined) await this.switchTab(this.visibleTabId)
    }
    this.record('browser_close_tab', id, `close tab ${id}`)
  }

  /** Close the whole browser (all tabs). */
  async closeAll(): Promise<void> {
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
  }

  /** User takeover / release. */
  setUserControl(active: boolean): void {
    if (active) this.mutex.take()
    else this.mutex.release()
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
  async eval(id: number, expression: string): Promise<unknown> {
    if (!this.options.evalEnabled) {
      throw new Error('browser: browser_eval is disabled in this deployment')
    }
    if (typeof expression !== 'string' || expression.length === 0 || expression.length > 64 * 1024) {
      throw new Error('browser: eval expression must be a non-empty string ≤ 64KB')
    }
    return await this.withControl('browser_eval', id, async (tab) => {
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
    })
  }

  /** Locate an element and return its viewport-center point for CDP input. */
  async locateElement(id: number, selector: string): Promise<{ x: number; y: number }> {
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
    })
  }

  /** Dispatch a left-click at a viewport point. */
  async clickAt(id: number, point: { x: number; y: number }): Promise<void> {
    await this.withControl('browser_click', id, async (tab) => {
      await tab.cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
      })
      await tab.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
      })
    })
  }

  /** Focus an element and insert text (Unicode-safe); clears first when requested. */
  async typeInto(id: number, selector: string, text: string, clear = true): Promise<void> {
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
    })
  }

  /** Dispatch one keyboard key. */
  async pressKey(id: number, key: string): Promise<void> {
    await this.withControl('browser_press', id, async (tab) => {
      const code = KEY_CODES[key] ?? key
      const vk = KEY_VK[key] ?? 0
      await tab.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      })
      await tab.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      })
    })
  }

  /** Set a select's value and fire change/input. */
  async selectOption(id: number, selector: string, value: string): Promise<void> {
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
    })
  }

  /**
   * Fill the login form with stored connector credentials. The resolver looks
   * up the connector's credential fields (username/password); the form's first
   * text/email input receives the username and its password input the
   * password. Callers must route this through approval (credentials are
   * sensitive).
   */
  async fillCredentials(id: number, connectorId: string): Promise<{ username: boolean; password: boolean }> {
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
    })
  }

  /** Scroll the page by a delta (or the element into view). */
  async scroll(id: number, deltaY: number, selector: string | undefined): Promise<void> {
    await this.withControl('browser_scroll', id, async (tab) => {
      const expression = selector === undefined || selector === ''
        ? `window.scrollBy({ top: ${Math.round(deltaY)}, behavior: 'instant' }); 'ok'`
        : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'not found'; el.scrollIntoView({ block: 'center' }); return 'ok'; })()`
      await tab.cdp.send('Runtime.evaluate', { expression, returnByValue: true })
    })
  }

  /** Dispose everything (plugin teardown). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.windowGoneDisposer()
    void this.closeAll()
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
