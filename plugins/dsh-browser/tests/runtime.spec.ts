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
  goBack = vi.fn(() => { this.url = 'about:blank'; this.title = '' })
  goForward = vi.fn()
  reload = vi.fn(() => { this.emit('did-stop-loading') })
  capturePage = vi.fn(async () => new MockImage(1920, 1080))
  setWindowOpenHandler = vi.fn()

  attach(_win: NativeBrowserWindow, bounds: NativeBounds): void {
    this.attached = true
    this.bounds = bounds
  }
  setBounds(bounds: NativeBounds): void { this.bounds = bounds }
  setVisible(visible: boolean): void { this.visible = visible }
  detach(): void { this.attached = false }
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
  readonly contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
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

  it('routes approval through the injected asker', async () => {
    const { adapter, views } = makeAdapter()
    const ask = vi.fn(async () => 'allowed-once' as const)
    const runtime = new BrowserRuntime(adapter, {}, ask)
    await runtime.open(undefined)
    await expect(runtime.requireApproval({ agent: undefined, toolName: 'browser_eval', reason: 'test' })).resolves.toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)
    runtime.dispose()
  })

  it('fills login forms from stored credentials', async () => {
    const { adapter, views } = makeAdapter()
    const resolver = vi.fn(async () => ({ username: 'u1', password: 'p1' }))
    const runtime = new BrowserRuntime(adapter, {}, undefined, resolver)
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
    const runtime = new BrowserRuntime(adapter, {}, undefined, async () => null)
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
