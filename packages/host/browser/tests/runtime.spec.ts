import { describe, expect, it, vi } from 'vitest'
import type {
  ElectronAdapter,
  NativeBounds,
  NativeBrowserWindow,
  NativeDownloadItem,
  NativeImage,
  NativeSession,
  NativeView,
  NativeWebContents,
} from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'
import { BrowserRuntime } from '../src/runtime.ts'

class MockTransport implements CdpTransport {
  attached = false
  readonly sent: Array<{ method: string; params: Record<string, unknown> }> = []
  handler: ((method: string, params: Record<string, unknown>) => unknown) | undefined

  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  sendCommand(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params })
    return Promise.resolve(this.handler?.(method, params) ?? {})
  }
  on(): void {}
  removeListener(): void {}
}

class MockSession implements NativeSession {
  partition = 'persist:agent-browser'
  readonly downloads: Array<{ item: NativeDownloadItem; event: unknown }> = []
  private readonly downloadListeners: Array<(event: unknown, item: NativeDownloadItem) => void> = []
  clearStorageData = vi.fn(async () => {})
  clearCache = vi.fn(async () => {})
  setPermissionRequestHandler = vi.fn()

  on(event: 'will-download', listener: (event: unknown, item: NativeDownloadItem) => void): void {
    if (event === 'will-download') this.downloadListeners.push(listener)
  }
  removeListener(event: 'will-download', listener: (event: unknown, item: NativeDownloadItem) => void): void {
    const idx = this.downloadListeners.indexOf(listener)
    if (idx >= 0) this.downloadListeners.splice(idx, 1)
  }
  emitDownload(item: NativeDownloadItem): void {
    for (const listener of [...this.downloadListeners]) listener({}, item)
  }
}

class MockImage implements NativeImage {
  width: number
  height: number
  constructor(width = 1920, height = 1080) {
    this.width = width
    this.height = height
  }
  getSize(): { width: number; height: number } { return { width: this.width, height: this.height } }
  resize(options: { width?: number; height?: number }): NativeImage {
    return new MockImage(options.width ?? this.width, options.height ?? this.height)
  }
  toJPEG(_quality: number): Buffer {
    return Buffer.from('jpeg-bytes')
  }
}

class MockView implements NativeView {
  readonly transport = new MockTransport()
  readonly session = new MockSession()
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  attached = false
  visible = false
  bounds: NativeBounds = { x: 0, y: 0, width: 0, height: 0 }
  url = ''
  title = ''
  loading = false
  destroyed = false
  loadURL = vi.fn(async (url: string) => {
    this.url = url
    this.title = `Title of ${url}`
    this.emit('did-stop-loading')
  })
  goBack = vi.fn(() => { this.url = 'about:blank'; this.title = ''; this.emit('did-finish-load') })
  goForward = vi.fn(() => { this.emit('did-finish-load') })
  reload = vi.fn(() => { this.emit('did-finish-load') })
  capturePage = vi.fn(async () => new MockImage(1920, 1080))
  setWindowOpenHandler = vi.fn()

  attach(win: NativeBrowserWindow, bounds: NativeBounds): void {
    this.attached = true
    this.bounds = bounds
    // Mirror the real adapter: attaching adds the view to the window content.
    win.contentView.addChildView(this)
  }
  setBounds(bounds: NativeBounds): void { this.bounds = bounds }
  setVisible(visible: boolean): void { this.visible = visible }
  detach(): void { this.attached = false }
  moveToTop(win: NativeBrowserWindow): void {
    // Mirror the real adapter: remove + add raises this view to the top.
    win.contentView.removeChildView(this)
    win.contentView.addChildView(this)
  }
  destroy(): void { this.destroyed = true }
  close = vi.fn(() => { this.destroyed = true })

  get webContents(): NativeWebContents {
    return {
      cdp: this.transport,
      loadURL: this.loadURL,
      goBack: this.goBack,
      goForward: this.goForward,
      reload: this.reload,
      capturePage: this.capturePage,
      getURL: () => this.url,
      getTitle: () => this.title,
      isLoading: () => this.loading,
      on: (event, listener) => {
        const set = this.listeners.get(event) ?? []
        set.push(listener)
        this.listeners.set(event, set)
      },
      removeListener: (event, listener) => {
        const set = this.listeners.get(event)
        if (set === undefined) return
        const idx = set.indexOf(listener)
        if (idx >= 0) set.splice(idx, 1)
      },
      session: this.session,
      setWindowOpenHandler: this.setWindowOpenHandler,
      close: this.close,
      isDestroyed: () => this.destroyed,
    }
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

function makeAdapter(): { adapter: ElectronAdapter; views: MockView[]; windows: MockBrowserWindow[] } {
  const views: MockView[] = []
  const windows: MockBrowserWindow[] = []
  const adapter: ElectronAdapter = {
    createView: () => {
      const view = new MockView()
      views.push(view)
      return view
    },
    createMaskView: () => {
      const view = new MockView()
      views.push(view)
      return view
    },
    createBrowserWindow: () => {
      const win = new MockBrowserWindow()
      windows.push(win)
      return win
    },
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
  }
  return { adapter, views, windows }
}

class MockBrowserWindow implements NativeBrowserWindow {
  visible = true
  destroyed = false
  title = ''
  /** Child-view z-order: later entries render on top. */
  readonly childViews: NativeView[] = []
  readonly contentView = {
    addChildView: vi.fn((view: NativeView) => {
      // Remove first (add semantics re-raise), then push to the top.
      const idx = this.childViews.indexOf(view)
      if (idx >= 0) this.childViews.splice(idx, 1)
      this.childViews.push(view)
    }),
    removeChildView: vi.fn((view: NativeView) => {
      const idx = this.childViews.indexOf(view)
      if (idx >= 0) this.childViews.splice(idx, 1)
    }),
  }
  private readonly resizeListeners = new Set<() => void>()
  private readonly closedListeners = new Set<() => void>()
  size = { width: 1100, height: 780 }
  loadURL = vi.fn(async () => {})
  show = vi.fn(() => { this.visible = true })
  hide = vi.fn(() => { this.visible = false })
  focus = vi.fn()
  isVisible = () => this.visible
  isDestroyed = () => this.destroyed
  close = vi.fn(() => { this.destroyed = true; this.visible = false })
  setTitle = vi.fn((title: string) => { this.title = title })
  getContentSize = () => this.size
  onResize(listener: () => void): () => void {
    this.resizeListeners.add(listener)
    return () => { this.resizeListeners.delete(listener) }
  }
  onClosed(listener: () => void): () => void {
    this.closedListeners.add(listener)
    return () => { this.closedListeners.delete(listener) }
  }
  emitResize(): void { for (const l of [...this.resizeListeners]) l() }
  emitClosed(): void { for (const l of [...this.closedListeners]) l() }
}

function runtimeOf(options = {}): { runtime: BrowserRuntime; adapter: ElectronAdapter; views: MockView[]; windows: MockBrowserWindow[] } {
  const { adapter, views, windows } = makeAdapter()
  const runtime = new BrowserRuntime(adapter, options)
  return { runtime, adapter, views, windows }
}

const snapshotElements = [
  { index: 1, kind: 'link', text: 'Docs', selector: 'a:nth-of-type(1)', visible: true, disabled: false },
  { index: 2, kind: 'input', text: 'Search', selector: 'input#q', visible: true, disabled: false },
]

describe('BrowserRuntime', () => {
  it('opens a tab in the dedicated window and reports state', async () => {
    const { runtime, views, windows } = runtimeOf()
    const tab = await runtime.open('https://example.com')
    expect(tab.id).toBe(1)
    expect(tab.url).toBe('https://example.com')
    expect(tab.title).toContain('example.com')
    expect(views[0]?.attached).toBe(true)
    // The tab view is visible in the dedicated window immediately (the
    // window itself is the surface; no separate panel to wait for).
    expect(views[0]?.visible).toBe(true)
    expect(windows).toHaveLength(1)
    expect(runtime.windowState.created).toBe(true)
    expect(runtime.windowState.visible).toBe(true)
    expect(runtime.listTabs()).toHaveLength(1)
    expect(runtime.currentTabId()).toBe(1)
    runtime.dispose()
  })

  it('hides the window without destroying tabs (user close)', async () => {
    const { runtime, windows } = runtimeOf()
    await runtime.open('https://example.com')
    runtime.hideWindow()
    expect(windows[0]?.isVisible()).toBe(false)
    // Tabs survive a user close: the window can be woken again.
    expect(runtime.listTabs()).toHaveLength(1)
    runtime.showWindow()
    expect(windows[0]?.isVisible()).toBe(true)
    runtime.dispose()
  })

  it('shows the AI-control mask while the agent drives; hides it on takeover', async () => {
    const { runtime, views } = runtimeOf()
    await runtime.open('https://example.com')
    // The mask is the second created view, attached on top of tabs.
    const mask = views[1]
    expect(mask).toBeDefined()
    expect(mask!.visible).toBe(true)
    runtime.setUserControl(true)
    expect(runtime.controlled).toBe(true)
    expect(mask!.visible).toBe(false)
    runtime.setUserControl(false)
    expect(runtime.controlled).toBe(false)
    expect(mask!.visible).toBe(true)
    runtime.dispose()
  })

  it('exposes the in-flight agent tool and latest op for the overlay', async () => {
    const { runtime } = runtimeOf()
    await runtime.open('https://example.com')
    expect(runtime.latestOp?.tool).toBe('browser_open')
    const op = runtime.reload(1)
    expect(runtime.isBusy).toBe(true)
    expect(runtime.busyToolName).toBe('browser_reload')
    await op
    expect(runtime.isBusy).toBe(false)
    expect(runtime.busyToolName).toBe('')
    expect(runtime.latestOp?.tool).toBe('browser_reload')
    runtime.dispose()
  })

  it('records interaction ops (click/type/navigate) in the audit log', async () => {
    const { runtime, views } = runtimeOf()
    await runtime.open('https://example.com')
    await runtime.navigate(1, 'https://example.com/page2')
    expect(runtime.opLog[0]?.tool).toBe('browser_navigate')
    expect(runtime.opLog[0]?.summary).toContain('page2')
    views[0]!.transport.handler = () => ({})
    await runtime.clickAt(1, { x: 10, y: 20 })
    await runtime.typeInto(1, 'input#q', 'hello')
    await runtime.pressKey(1, 'Enter')
    await runtime.scroll(1, 100, undefined)
    const tools = runtime.opLog.map((e) => e.tool)
    expect(tools).toContain('browser_click')
    expect(tools).toContain('browser_type')
    expect(tools).toContain('browser_press')
    expect(tools).toContain('browser_scroll')
    runtime.dispose()
  })

  it('keeps the mask ABOVE every tab view (z-order), incl. after navigation', async () => {
    const { runtime, views, windows } = runtimeOf()
    await runtime.open('https://a.example')
    await runtime.open('https://b.example')
    const win = windows[0]!
    const mask = views[1]!
    const tab1 = views[0]!
    const tab2 = views[2]!
    // relayout() re-raises the mask: it must be the LAST child (topmost).
    expect(win.childViews.at(-1)).toBe(mask)
    // After a navigation the mask stays on top (loadURL does not re-stack,
    // but relayout is called after every state change).
    await runtime.navigate(2, 'https://b.example/next')
    expect(win.childViews.at(-1)).toBe(mask)
    // Tab visibility is unaffected.
    expect(tab1.visible).toBe(false)
    expect(tab2.visible).toBe(true)
    runtime.dispose()
  })

  it('sidebar show creates the window when it never existed (first click)', async () => {
    const { runtime, windows } = runtimeOf()
    // No window yet: showWindow must create one instead of no-op'ing.
    expect(runtime.windowState.created).toBe(false)
    await runtime.showWindow()
    expect(runtime.windowState.created).toBe(true)
    expect(windows).toHaveLength(1)
    // Waking an existing window keeps the same window.
    await runtime.showWindow()
    expect(windows).toHaveLength(1)
    runtime.dispose()
  })

  it('user shell actions bypass the takeover mutex', async () => {
    const { runtime } = runtimeOf()
    await runtime.open(undefined)
    runtime.setUserControl(true)
    // User toolbar actions must complete even while the agent is paused.
    await runtime.reload(1, undefined, true)
    await runtime.goBack(1, undefined, true)
    await runtime.goForward(1, undefined, true)
    await runtime.switchTab(1, true)
    await runtime.closeTab(1, true)
    // A new user tab also bypasses the mutex.
    const tab = await runtime.open(undefined, undefined, true)
    expect(tab.id).toBe(2)
    runtime.setUserControl(false)
    runtime.dispose()
  })

  it('agent operation paused by takeover honors the abort signal', async () => {
    const { runtime } = runtimeOf()
    await runtime.open(undefined)
    runtime.setUserControl(true)
    const ac = new AbortController()
    let settled = false
    const op = runtime.reload(1, ac.signal).catch(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    ac.abort()
    await op
    expect(settled).toBe(true)
    runtime.setUserControl(false)
    runtime.dispose()
  })

  it('close-tab switch re-enters no mutex (no nested deadlock)', async () => {
    const { runtime } = runtimeOf()
    await runtime.open(undefined)
    await runtime.open(undefined)
    // Closing the visible tab 2 switches to tab 1 internally; the switch must
    // not acquire the mutex again (would deadlock).
    await runtime.closeTab(2)
    expect(runtime.currentTabId()).toBe(1)
    expect(runtime.listTabs()).toHaveLength(1)
    runtime.dispose()
  })

  it('pauses agent operations while the user controls the browser', async () => {
    const { runtime, windows } = runtimeOf()
    await runtime.open('https://example.com')
    runtime.setUserControl(true)
    let settled = false
    const op = runtime.reload(1).then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    // The operation is paused, not rejected: the loop waits for release.
    expect(settled).toBe(false)
    runtime.setUserControl(false)
    await op
    expect(settled).toBe(true)
    runtime.dispose()
  })

  it('rejects dangerous navigation', async () => {
    const { runtime } = runtimeOf()
    await runtime.open(undefined)
    await expect(runtime.navigate(1, 'javascript:alert(1)')).rejects.toThrow(/denied/)
    await expect(runtime.navigate(1, 'data:text/html,<b>x</b>')).rejects.toThrow(/denied/)
    runtime.dispose()
  })

  it('navigates http(s)', async () => {
    const { runtime, views } = runtimeOf()
    await runtime.open(undefined)
    await runtime.navigate(1, 'https://example.com/page')
    expect(views[0]?.loadURL).toHaveBeenCalledWith('https://example.com/page')
    runtime.dispose()
  })

  it('does not hang when loadURL never settles (long-lived page connections)', async () => {
    const { runtime, views } = runtimeOf({ loadTimeoutMs: 50 })
    await runtime.open(undefined)
    // Simulate a page whose did-finish-load never fires (polls/SSE/analytics).
    views[0]!.loadURL = vi.fn(() => new Promise<void>(() => {}))
    const started = Date.now()
    await runtime.navigate(1, 'https://example.com/slow')
    expect(Date.now() - started).toBeLessThan(1000)
    runtime.dispose()
  })

  it('reports a navigation that failed with nothing loaded', async () => {
    const { runtime, views } = runtimeOf({ loadTimeoutMs: 50 })
    await runtime.open(undefined)
    views[0]!.loadURL = vi.fn(async () => { throw new Error('ERR_ABORTED') })
    views[0]!.url = ''
    await expect(runtime.navigate(1, 'https://example.com/bad')).rejects.toThrow(/failed/)
    runtime.dispose()
  })

  it('tolerates a failed load that still left a usable page', async () => {
    const { runtime, views } = runtimeOf({ loadTimeoutMs: 50 })
    await runtime.open(undefined)
    views[0]!.loadURL = vi.fn(async () => { throw new Error('ERR_ABORTED') })
    views[0]!.url = 'https://example.com/partial'
    await expect(runtime.navigate(1, 'https://example.com/bad')).resolves.toBeUndefined()
    runtime.dispose()
  })

  it('respects the tab limit', async () => {
    const { runtime } = runtimeOf({ maxTabs: 2 })
    await runtime.open(undefined)
    await runtime.open(undefined)
    await expect(runtime.open(undefined)).rejects.toThrow(/limit/)
    runtime.dispose()
  })

  it('user takeover pauses agent operations until release', async () => {
    const { runtime } = runtimeOf()
    await runtime.open(undefined)
    runtime.setUserControl(true)
    expect(runtime.controlled).toBe(true)
    let settled = false
    const op = runtime.snapshot(1).then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    runtime.setUserControl(false)
    await op
    expect(settled).toBe(true)
    runtime.dispose()
  })

  it('switches and closes tabs', async () => {
    const { runtime, views, windows } = runtimeOf()
    await runtime.open('https://a.example')
    await runtime.open('https://b.example')
    expect(runtime.currentTabId()).toBe(2)
    await runtime.switchTab(1)
    expect(runtime.currentTabId()).toBe(1)
    expect(views[0]?.visible).toBe(true)
    expect(views[2]?.visible).toBe(false)
    await runtime.closeTab(1)
    expect(runtime.listTabs()).toHaveLength(1)
    expect(runtime.currentTabId()).toBe(2)
    expect(views[0]?.destroyed).toBe(true)
    runtime.dispose()
  })

  it('extracts the snapshot through CDP', async () => {
    const { runtime, views } = runtimeOf()
    await runtime.open(undefined)
    views[0]!.transport.handler = (method, params) => {
      if (method === 'Runtime.evaluate' && typeof params.expression === 'string' && params.expression.includes('querySelectorAll')) {
        return { result: { value: [
          { kind: 'link', text: 'Docs', selector: 'a:nth-of-type(1)', visible: true, disabled: false },
          { kind: 'input', text: 'Search', selector: 'input#q', visible: true, disabled: false },
        ] } }
      }
      return {}
    }
    const elements = await runtime.snapshot(1)
    expect(elements).toHaveLength(2)
    expect(elements[0]?.index).toBe(1)
    expect(elements[0]?.selector).toBe('a:nth-of-type(1)')
    expect(elements[1]?.kind).toBe('input')
    runtime.dispose()
  })

  it('extracts bounded text', async () => {
    const { runtime, views } = runtimeOf()
    await runtime.open(undefined)
    views[0]!.transport.handler = (method, params) => {
      if (method === 'Runtime.evaluate' && params.expression === '(document.body ? document.body.innerText : \'\')') {
        return { result: { value: 'Hello world' } }
      }
      return {}
    }
    const text = await runtime.text(1, undefined)
    expect(text).toBe('Hello world')
    runtime.dispose()
  })

  it('captures and compresses screenshots', async () => {
    const { runtime, views } = runtimeOf({ screenshotMaxWidth: 1280, screenshotQuality: 70 })
    await runtime.open(undefined)
    const dataUrl = await runtime.screenshot(1)
    expect(dataUrl).toMatch(/^data:image\/jpeg;base64,/)
    expect(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64').toString()).toBe('jpeg-bytes')
    expect(views[0]?.capturePage).toHaveBeenCalled()
    runtime.dispose()
  })

  it('eval is gated by config', async () => {
    const { runtime } = runtimeOf({ evalEnabled: false })
    await runtime.open(undefined)
    await expect(runtime.eval(1, '1+1')).rejects.toThrow(/disabled/)
    runtime.dispose()
  })

  it('eval returns the page value', async () => {
    const { runtime, views } = runtimeOf()
    await runtime.open(undefined)
    views[0]!.transport.handler = (method) => method === 'Runtime.evaluate'
      ? { result: { value: { a: 1 } } }
      : {}
    const result = await runtime.eval(1, '({a:1})')
    expect(result).toBe('{"a":1}')
    runtime.dispose()
  })

  it('fills login forms from stored credentials', async () => {
    const { adapter, views } = makeAdapter()
    const resolver = vi.fn(async () => ({ username: 'u1', password: 'p1' }))
    const runtime = new BrowserRuntime(adapter, {}, resolver)
    await runtime.open(undefined)
    views[0]!.transport.handler = (method, params) => {
      if (method === 'Runtime.evaluate' && typeof params.expression === 'string' && params.expression.includes('querySelectorAll(\'input\')')) {
        return { result: { value: { filled: 2, username: true, password: true } } }
      }
      return {}
    }
    const filled = await runtime.fillCredentials(1, 'dingtalk')
    expect(filled).toEqual({ username: true, password: true })
    expect(resolver).toHaveBeenCalledWith('dingtalk')
    runtime.dispose()
  })

  it('rejects credential injection without a resolver', async () => {
    const { runtime } = runtimeOf()
    await runtime.open(undefined)
    await expect(runtime.fillCredentials(1, 'dingtalk')).rejects.toThrow(/not available/)
    runtime.dispose()
  })

  it('rejects credential injection for unknown connectors', async () => {
    const { adapter } = makeAdapter()
    const runtime = new BrowserRuntime(adapter, {}, async () => null)
    await runtime.open(undefined)
    await expect(runtime.fillCredentials(1, 'nope')).rejects.toThrow(/no stored credentials/)
    runtime.dispose()
  })

  it('clears data across tabs', async () => {
    const { runtime, views } = runtimeOf()
    await runtime.open(undefined)
    await runtime.open(undefined)
    await runtime.clearData()
    expect(views[0]?.session.clearStorageData).toHaveBeenCalled()
    // views[1] is the mask (no session); the second tab is views[2].
    expect(views[2]?.session.clearStorageData).toHaveBeenCalled()
    runtime.dispose()
  })

  it('records the op log', async () => {
    const { runtime } = runtimeOf()
    await runtime.open('https://example.com')
    const log = runtime.opLog
    expect(log[0]?.tool).toBe('browser_open')
    expect(log[0]?.summary).toContain('example.com')
    expect(log[0]?.failed).toBe(false)
    runtime.dispose()
  })

  it('interaction primitives dispatch CDP input', async () => {
    const { runtime, views } = runtimeOf()
    await runtime.open(undefined)
    views[0]!.transport.handler = (method, params) => {
      if (method === 'Runtime.evaluate' && typeof params.expression === 'string' && params.expression.includes('scrollIntoView')) {
        return { result: { value: { x: 100, y: 200 } } }
      }
      return {}
    }
    const point = await runtime.locateElement(1, 'a:nth-of-type(1)')
    expect(point).toEqual({ x: 100, y: 200 })
    await runtime.clickAt(1, point)
    const methods = views[0]!.transport.sent.map((s) => s.method)
    expect(methods).toContain('Input.dispatchMouseEvent')
    await runtime.typeInto(1, 'input#q', 'hello', true)
    expect(views[0]!.transport.sent.some((s) => s.method === 'Input.insertText' && s.params.text === 'hello')).toBe(true)
    await runtime.pressKey(1, 'Enter')
    expect(views[0]!.transport.sent.some((s) => s.method === 'Input.dispatchKeyEvent')).toBe(true)
    await runtime.selectOption(1, 'select', 'v')
    await runtime.scroll(1, 100, undefined)
    runtime.dispose()
  })

  it('download guard cancels oversized downloads', async () => {
    const { runtime, views } = runtimeOf()
    await runtime.open(undefined)
    const item: NativeDownloadItem = {
      getURL: () => 'https://example.com/big.bin',
      getFilename: () => 'big.bin',
      getTotalBytes: () => 200 * 1024 * 1024,
      getReceivedBytes: () => 200 * 1024 * 1024,
      setSavePath: vi.fn(),
      cancel: vi.fn(),
      on: vi.fn(),
    }
    views[0]!.session.emitDownload(item)
    expect(item.cancel).toHaveBeenCalled()
    expect(runtime.opLog[0]?.summary).toContain('100MB')
    runtime.dispose()
  })
})
