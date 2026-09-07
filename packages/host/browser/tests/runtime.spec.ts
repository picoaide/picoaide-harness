import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
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
import type { BrowserToolOptions, CredentialResolver } from '../src/types.ts'
import { BrowserStore } from '../src/store.ts'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Extract the stable error code thrown by a synchronous call. */
function errorCodeOf(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

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
  private readonly downloadListeners: Array<(event: unknown, item: NativeDownloadItem) => void> = []
  clearStorageData = vi.fn(async (_options?: { storages?: string[] }) => {})
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
  partition = 'persist:agent-browser'
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
  downloadURL = vi.fn((_url: string) => {})

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
      downloadURL: this.downloadURL,
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

class MockDownloadItem implements NativeDownloadItem {
  cancel = vi.fn()
  setSavePath = vi.fn()
  private readonly listeners = new Map<string, Array<(event: unknown, state?: string) => void>>()
  private readonly url: string
  private readonly filename: string
  private readonly totalBytes: number
  private received: number

  constructor(url: string, filename: string, totalBytes = 0, received = 0) {
    this.url = url
    this.filename = filename
    this.totalBytes = totalBytes
    this.received = received
  }
  getURL(): string { return this.url }
  getFilename(): string { return this.filename }
  getTotalBytes(): number { return this.totalBytes }
  getReceivedBytes(): number { return this.received }
  setReceived(bytes: number): void { this.received = bytes }
  setSavePath(path: string): void { this.setSavePath(path) }
  on(event: 'done' | 'updated', listener: (event: unknown, state?: string) => void): void {
    const set = this.listeners.get(event) ?? []
    set.push(listener)
    this.listeners.set(event, set)
  }
  emit(event: string, state?: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener({}, state)
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

const storeDirs: string[] = []

function makeRuntime(opts: { options?: BrowserToolOptions; credentials?: CredentialResolver } = {}): {
  runtime: BrowserRuntime
  adapter: ElectronAdapter
  views: MockView[]
  windows: MockBrowserWindow[]
  store: BrowserStore
} {
  const { adapter, views, windows } = makeAdapter()
  const dir = mkdtempSync(join(process.cwd(), 'tests/.store-tmp-'))
  storeDirs.push(dir)
  // The store (and its download dir) live inside the workspace temp tree so
  // no fixture file ever escapes into cwd; removed in afterAll.
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(
    adapter,
    { downloadDir: join(dir, 'downloads'), ...opts.options },
    opts.credentials,
    undefined,
    { store },
  )
  return { runtime, adapter, views, windows, store }
}

afterAll(() => {
  for (const dir of storeDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort cleanup.
    }
  }
})

const snapshotElements = [
  { index: 1, kind: 'link', text: 'Docs', selector: 'a:nth-of-type(1)', visible: true, disabled: false },
  { index: 2, kind: 'input', text: 'Search', selector: 'input#q', visible: true, disabled: false },
]

describe('BrowserRuntime v4 — group semantics', () => {
  it('openFor creates the group, shows the first tab, and listTabs is group-scoped', async () => {
    const { runtime, views, windows } = makeRuntime()
    const tab = await runtime.openFor('sess-1', 'https://example.com')
    expect(tab.id).toBe(1)
    expect(tab.url).toBe('https://example.com')
    expect(tab.title).toContain('example.com')
    expect(tab.visible).toBe(true)
    // The group now exists and its first tab is live in the dedicated window.
    expect(runtime.registry.get('sess-1')).toBeDefined()
    expect(views[0]?.attached).toBe(true)
    expect(views[0]?.visible).toBe(true)
    expect(windows).toHaveLength(1)
    expect(runtime.windowState.created).toBe(true)
    expect(runtime.windowState.visible).toBe(true)
    expect(runtime.listTabs('sess-1')).toHaveLength(1)
    expect(runtime.currentTabId()).toBe(1)
    // A second session's tabs never leak into the first group's listing.
    const other = await runtime.openFor('sess-2', 'https://b.example')
    expect(runtime.listTabs('sess-2').map((t) => t.id)).toEqual([other.id])
    expect(runtime.listTabs('sess-1').map((t) => t.id)).toEqual([tab.id])
    runtime.dispose()
  })

  it('resolveTab defaults to the group active tab and rejects foreign tab ids', async () => {
    const { runtime } = makeRuntime()
    const a = await runtime.openFor('sess-a', 'https://a.example')
    const b = await runtime.openFor('sess-b', 'https://b.example')
    expect(runtime.resolveTab('sess-a', undefined)).toBe(a.id)
    expect(runtime.resolveTab('sess-b', undefined)).toBe(b.id)
    // Cross-group references are isolated: the id belongs to another session.
    expect(errorCodeOf(() => runtime.resolveTab('sess-b', a.id))).toBe('foreign-tab')
    expect(errorCodeOf(() => runtime.resolveTab('sess-a', b.id))).toBe('foreign-tab')
    expect(errorCodeOf(() => runtime.resolveTab('sess-a', 999))).toBe('foreign-tab')
    runtime.dispose()
  })

  it('two sessions drive in parallel without serializing each other', async () => {
    const { runtime, views } = makeRuntime()
    const keyA = runtime.ensureGroup('sess-a')
    const keyB = runtime.ensureGroup('sess-b')
    // Concurrent opens: group B does not wait for group A's mutex or window.
    const [ta, tb] = await Promise.all([
      runtime.openFor(keyA, 'https://a.example'),
      runtime.openFor(keyB, 'https://b.example'),
    ])
    expect(runtime.listTabs(keyA).map((t) => t.id)).toEqual([ta.id])
    expect(runtime.listTabs(keyB).map((t) => t.id)).toEqual([tb.id])
    // While A locates+clicks, B keeps opening tabs — no serial wait.
    views[0]!.transport.handler = (method, params) => method === 'Runtime.evaluate'
      && String(params.expression).includes('scrollIntoView')
      ? { result: { value: { x: 10, y: 20 } } }
      : {}
    const [point, tb2] = await Promise.all([
      runtime.locateFor(keyA, ta.id, 'a:nth-of-type(1)'),
      runtime.openFor(keyB, 'https://b.example/2'),
    ])
    await Promise.all([
      runtime.clickFor(keyA, ta.id, point),
      runtime.openFor(keyB, 'https://b.example/3'),
      runtime.openFor(keyA, 'https://a.example/2'),
    ])
    expect(runtime.listTabs(keyB).map((t) => t.id)).toHaveLength(3)
    expect(runtime.listTabs(keyB).map((t) => t.id)).toContain(tb2.id)
    expect(runtime.listTabs(keyA).map((t) => t.id)).toHaveLength(2)
    runtime.dispose()
  })

  it('user takeover pauses group operations until release, then they continue', async () => {
    const { runtime } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    const tab = await runtime.openFor(key, 'https://example.com')
    runtime.setUserControl(true)
    expect(runtime.controlled).toBe(true)
    let settled = false
    const op = runtime.navigateFor(key, tab.id, 'https://example.com/page').then(() => {
      settled = true
    })
    await sleep(40)
    // Paused at the group's queue head: the agent op must wait for the user.
    expect(settled).toBe(false)
    runtime.setUserControl(false)
    await op
    expect(settled).toBe(true)
    runtime.dispose()
  })

  it('aborting an agent op during takeover rejects window-controlled', async () => {
    const { runtime } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    const tab = await runtime.openFor(key, undefined)
    runtime.setUserControl(true)
    const ac = new AbortController()
    const op = runtime.reloadFor(key, tab.id, ac.signal)
    await sleep(30)
    ac.abort()
    await expect(op).rejects.toMatchObject({ code: 'window-controlled' })
    runtime.setUserControl(false)
    runtime.dispose()
  })

  it('navigation goes through the guard (javascript:/data: rejected)', async () => {
    const { runtime } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    const tab = await runtime.openFor(key, undefined)
    await expect(runtime.navigateFor(key, tab.id, 'javascript:alert(1)')).rejects.toMatchObject({
      code: 'navigation-blocked',
    })
    await expect(runtime.navigateFor(key, tab.id, 'data:text/html,<b>x</b>')).rejects.toMatchObject({
      code: 'navigation-blocked',
    })
    runtime.dispose()
  })

  it('evalFor is read-only: legal expressions pass, assignments are rejected, config gate works', async () => {
    const { runtime, views } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    const tab = await runtime.openFor(key, undefined)
    views[0]!.transport.handler = (method) => method === 'Runtime.evaluate'
      ? { result: { value: { a: 1 } } }
      : {}
    expect(await runtime.evalFor(key, tab.id, '({a:1})')).toBe('{"a":1}')
    // Assignment/update is a write → eval-policy before any page execution.
    await expect(runtime.evalFor(key, tab.id, 'x = 1')).rejects.toMatchObject({ code: 'eval-policy' })
    await expect(runtime.evalFor(key, tab.id, 'document.title = "hacked"')).rejects.toMatchObject({ code: 'eval-policy' })
    await expect(runtime.evalFor(key, tab.id, 'window.fetch("/x")')).rejects.toMatchObject({ code: 'eval-policy' })
    // Deployments may switch eval off entirely → generic policy error.
    const disabled = makeRuntime({ options: { evalEnabled: false } })
    const dKey = disabled.runtime.ensureGroup('sess-2')
    await disabled.runtime.openFor(dKey, undefined)
    await expect(disabled.runtime.evalFor(dKey, 1, '1+1')).rejects.toMatchObject({ code: 'policy' })
    runtime.dispose()
    disabled.runtime.dispose()
  })

  it('closing the last tab of a group deletes the group', async () => {
    const { runtime } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    const t1 = await runtime.openFor(key, 'https://a.example')
    const t2 = await runtime.openFor(key, 'https://b.example')
    await runtime.closeTabFor(key, t1.id)
    expect(runtime.registry.get(key)).toBeDefined()
    expect(runtime.listTabs(key)).toHaveLength(1)
    await runtime.closeTabFor(key, t2.id)
    expect(runtime.listTabs(key)).toHaveLength(0)
    expect(runtime.registry.get(key)).toBeUndefined()
    runtime.dispose()
  })

  it('archiveFor blocks re-open with group-archived; reactivateFor makes it openable again', async () => {
    const { runtime } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, 'https://a.example')
    await runtime.archiveFor(key)
    expect(runtime.registry.get(key)?.status).toBe('archived')
    await expect(runtime.openFor(key, 'https://b.example')).rejects.toMatchObject({ code: 'group-archived' })
    await runtime.reactivateFor(key)
    expect(runtime.registry.get(key)?.status).toBe('active')
    const tab = await runtime.openFor(key, 'https://b.example')
    expect(tab.id).toBeGreaterThan(0)
    expect(runtime.listTabs(key).map((t) => t.id)).toContain(tab.id)
    runtime.dispose()
  })

  it('archiveFor keeps tab metadata so reactivateFor rebuilds views and the ledger persists them', async () => {
    const { runtime, views, store } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    const tab = await runtime.openFor(key, 'https://a.example')
    await runtime.archiveFor(key)
    // Views are dropped, metadata survives in the registry.
    const archived = runtime.registry.get(key)!
    expect(archived.status).toBe('archived')
    expect(archived.tabs.size).toBe(1)
    expect(views[0]?.destroyed).toBe(true)
    expect(runtime.listTabs(key)).toHaveLength(0)
    // The persisted ledger carries the archived group WITH its tab.
    const ledger = store.getGroupLedger()
    expect(ledger?.groups).toHaveLength(1)
    expect(ledger?.groups[0]?.status).toBe('archived')
    expect(ledger?.groups[0]?.tabs).toHaveLength(1)
    expect(ledger?.groups[0]?.tabs[0]).toMatchObject({ tabId: tab.id, url: 'https://a.example' })
    // Reactivate rebuilds the view for the archived tab.
    await runtime.reactivateFor(key)
    const rebuilt = runtime.listTabs(key)
    expect(rebuilt.map((t) => t.id)).toEqual([tab.id])
    expect(rebuilt[0]?.url).toBe('https://a.example')
    expect(views[1]?.attached).toBe(true)
    runtime.dispose()
  })

  it('shellState exposes groups with label/status/busy/foreground/tabs', async () => {
    const { runtime } = makeRuntime()
    const keyA = runtime.ensureGroup('sess-a', 'Group A')
    const keyB = runtime.ensureGroup('sess-b', 'Group B')
    await runtime.openFor(keyA, 'https://a.example')
    await runtime.openFor(keyB, 'https://b.example')
    const state = runtime.shellState()
    expect(state.controlled).toBe(false)
    expect(state.foreground).toBe(keyA)
    expect(state.window.created).toBe(true)
    const groupA = state.groups.find((g) => g.key === keyA)!
    expect(groupA).toBeDefined()
    expect(groupA.label).toBe('Group A')
    expect(groupA.status).toBe('active')
    expect(groupA.busy).toBe(false)
    expect(groupA.busyTool).toBe('')
    expect(groupA.foreground).toBe(true)
    expect(groupA.tabs).toHaveLength(1)
    expect(groupA.tabs[0]).toMatchObject({ id: 1, url: 'https://a.example', active: true })
    const groupB = state.groups.find((g) => g.key === keyB)!
    expect(groupB.label).toBe('Group B')
    expect(groupB.foreground).toBe(false)
    expect(groupB.tabs[0]?.active).toBe(true) // per-group active tab
    runtime.dispose()
  })
})

describe('BrowserRuntime v4 — baseline ops through group APIs', () => {
  it('navigates, reloads and walks history within a group', async () => {
    const { runtime, views } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    const tab = await runtime.openFor(key, undefined)
    await runtime.navigateFor(key, tab.id, 'https://example.com/page2')
    expect(views[0]?.loadURL).toHaveBeenCalledWith('https://example.com/page2')
    await runtime.reloadFor(key, tab.id)
    expect(views[0]?.reload).toHaveBeenCalled()
    await runtime.goBackFor(key, tab.id)
    expect(views[0]?.goBack).toHaveBeenCalled()
    await runtime.goForwardFor(key, tab.id)
    expect(views[0]?.goForward).toHaveBeenCalled()
    runtime.dispose()
  })

  it('does not hang when loadURL never settles (long-lived page connections)', async () => {
    const { runtime, views } = makeRuntime({ options: { loadTimeoutMs: 50 } })
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    // Simulate a page whose did-finish-load never fires (polls/SSE/analytics).
    views[0]!.loadURL = vi.fn(() => new Promise<void>(() => {}))
    const started = Date.now()
    await runtime.navigateFor(key, 1, 'https://example.com/slow')
    expect(Date.now() - started).toBeLessThan(1000)
    runtime.dispose()
  })

  it('reports a navigation that failed with nothing loaded', async () => {
    const { runtime, views } = makeRuntime({ options: { loadTimeoutMs: 50 } })
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    views[0]!.loadURL = vi.fn(async () => { throw new Error('ERR_ABORTED') })
    views[0]!.url = ''
    await expect(runtime.navigateFor(key, 1, 'https://example.com/bad')).rejects.toMatchObject({ code: 'network' })
    runtime.dispose()
  })

  it('tolerates a failed load that still left a usable page', async () => {
    const { runtime, views } = makeRuntime({ options: { loadTimeoutMs: 50 } })
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    views[0]!.loadURL = vi.fn(async () => { throw new Error('ERR_ABORTED') })
    views[0]!.url = 'https://example.com/partial'
    await expect(runtime.navigateFor(key, 1, 'https://example.com/bad')).resolves.toBeUndefined()
    runtime.dispose()
  })

  it('extracts the snapshot through CDP', async () => {
    const { runtime, views } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    views[0]!.transport.handler = (method, params) => {
      if (method === 'Runtime.evaluate' && typeof params.expression === 'string' && params.expression.includes('querySelectorAll')) {
        return { result: { value: snapshotElements } }
      }
      return {}
    }
    const elements = await runtime.snapshotFor(key, 1)
    expect(elements).toHaveLength(2)
    expect(elements[0]?.index).toBe(1)
    expect(elements[0]?.selector).toBe('a:nth-of-type(1)')
    expect(elements[1]?.kind).toBe('input')
    runtime.dispose()
  })

  it('extracts bounded text', async () => {
    const { runtime, views } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    views[0]!.transport.handler = (method, params) => {
      if (method === 'Runtime.evaluate' && params.expression === '(document.body ? document.body.innerText : \'\')') {
        return { result: { value: 'Hello world' } }
      }
      return {}
    }
    expect(await runtime.textFor(key, 1, undefined)).toBe('Hello world')
    runtime.dispose()
  })

  it('captures and compresses screenshots', async () => {
    const { runtime, views } = makeRuntime({ options: { screenshotMaxWidth: 1280, screenshotQuality: 70 } })
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    const dataUrl = await runtime.screenshotFor(key, 1)
    expect(dataUrl).toMatch(/^data:image\/jpeg;base64,/)
    expect(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64').toString()).toBe('jpeg-bytes')
    expect(views[0]?.capturePage).toHaveBeenCalled()
    runtime.dispose()
  })

  it('locates, clicks, types, presses, selects and scrolls through CDP', async () => {
    const { runtime, views } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    views[0]!.transport.handler = (method, params) => {
      if (method === 'Runtime.evaluate' && typeof params.expression === 'string' && params.expression.includes('scrollIntoView')) {
        return { result: { value: { x: 100, y: 200 } } }
      }
      return {}
    }
    const point = await runtime.locateFor(key, 1, 'a:nth-of-type(1)')
    expect(point).toEqual({ x: 100, y: 200 })
    await runtime.clickFor(key, 1, point)
    const methods = views[0]!.transport.sent.map((s) => s.method)
    expect(methods).toContain('Input.dispatchMouseEvent')
    await runtime.typeFor(key, 1, 'input#q', 'hello', true)
    expect(views[0]!.transport.sent.some((s) => s.method === 'Input.insertText' && s.params.text === 'hello')).toBe(true)
    await runtime.pressFor(key, 1, 'Enter')
    expect(views[0]!.transport.sent.some((s) => s.method === 'Input.dispatchKeyEvent')).toBe(true)
    await runtime.selectFor(key, 1, 'select', 'v')
    await runtime.scrollFor(key, 1, 100, undefined)
    runtime.dispose()
  })

  it('fills login forms from stored credentials', async () => {
    const resolver = vi.fn(async () => ({ username: 'u1', password: 'p1' }))
    const { runtime, views } = makeRuntime({ credentials: resolver })
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    views[0]!.transport.handler = (method, params) => {
      if (method === 'Runtime.evaluate' && typeof params.expression === 'string' && params.expression.includes('querySelectorAll(\'input\')')) {
        return { result: { value: { filled: 2, username: true, password: true } } }
      }
      return {}
    }
    const filled = await runtime.fillCredentialsFor(key, 1, 'dingtalk')
    expect(filled).toEqual({ username: true, password: true })
    expect(resolver).toHaveBeenCalledWith('dingtalk')
    runtime.dispose()
  })

  it('rejects credential injection without a resolver', async () => {
    const { runtime } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    await expect(runtime.fillCredentialsFor(key, 1, 'dingtalk')).rejects.toMatchObject({ code: 'policy' })
    runtime.dispose()
  })

  it('rejects credential injection for unknown connectors', async () => {
    const { runtime } = makeRuntime({ credentials: async () => null })
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    await expect(runtime.fillCredentialsFor(key, 1, 'nope')).rejects.toMatchObject({ code: 'not-found' })
    runtime.dispose()
  })

  it('clears data across tabs (all-data scope)', async () => {
    const { runtime, views } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    await runtime.openFor(key, undefined)
    await runtime.clearDataFor(key, 'all-data')
    expect(views[0]?.session.clearStorageData).toHaveBeenCalled()
    expect(views[1]?.session.clearStorageData).toHaveBeenCalled()
    expect(views[0]?.session.clearCache).toHaveBeenCalled()
    runtime.dispose()
  })

  it('clears data only for one group (group scope)', async () => {
    const { runtime, views } = makeRuntime()
    const keyA = runtime.ensureGroup('sess-a')
    const keyB = runtime.ensureGroup('sess-b')
    await runtime.openFor(keyA, undefined)
    await runtime.openFor(keyB, undefined)
    await runtime.clearDataFor(keyA, 'group')
    expect(views[0]?.session.clearStorageData).toHaveBeenCalledWith({
      storages: ['localstorage', 'cachestorage', 'indexdb', 'websql', 'serviceworkers'],
    })
    expect(views[1]?.session.clearStorageData).not.toHaveBeenCalled()
    runtime.dispose()
  })

  it('records the group-scoped op log', async () => {
    const { runtime } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, 'https://example.com')
    const log = runtime.opLog
    expect(log[0]?.tool).toBe('browser_open')
    expect(log[0]?.summary).toContain('example.com')
    expect(log[0]?.failed).toBe(false)
    expect(log[0]?.group).toBe(key)
    runtime.dispose()
  })

  it('records interaction ops (navigate/click/type/press/scroll) in the audit log', async () => {
    const { runtime, views } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    await runtime.navigateFor(key, 1, 'https://example.com/page2')
    views[0]!.transport.handler = () => ({})
    await runtime.clickFor(key, 1, { x: 10, y: 20 })
    await runtime.typeFor(key, 1, 'input#q', 'hello')
    await runtime.pressFor(key, 1, 'Enter')
    await runtime.scrollFor(key, 1, 100, undefined)
    const tools = runtime.opLog.map((e) => e.tool)
    expect(tools).toContain('browser_navigate')
    expect(tools).toContain('browser_click')
    expect(tools).toContain('browser_type')
    expect(tools).toContain('browser_press')
    expect(tools).toContain('browser_scroll')
    runtime.dispose()
  })

  it('waits for a page condition and fills a form', async () => {
    const { runtime, views } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    views[0]!.transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String((params as { expression?: string }).expression ?? '')
      // fillForm's probe runs querySelectorAll; wait_for's condition probe does not.
      if (expression.includes('querySelectorAll')) return { result: { value: { filled: 2, submitted: true } } }
      if (expression.includes('querySelector')) return { result: { value: true } }
      return {}
    }
    const wait = await runtime.waitFor(key, 1, { condition: 'element-present', selector: '#q' })
    expect(wait).toEqual({ ok: true, reason: 'element-present' })
    const form = await runtime.fillFormFor(key, 1, [{ field: 'q', value: 'x' }], true)
    expect(form).toEqual({ filled: 2, submitted: true })
    runtime.dispose()
  })

  it('uploads files through DOM.setFileInputFiles', async () => {
    const { runtime, views } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    views[0]!.transport.handler = (method) => {
      if (method === 'Runtime.evaluate') return { result: { value: [{ idx: 0 }] } }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: 2 }
      return {}
    }
    const result = await runtime.uploadFor(key, 1, ['/tmp/a.png'])
    expect(result).toEqual({ uploaded: 1 })
    runtime.dispose()
  })

  it('waits for the tab quota instead of failing; abort cancels the wait', async () => {
    const { runtime } = makeRuntime({ options: { maxTabs: 2 } })
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    await runtime.openFor(key, undefined)
    const ac = new AbortController()
    let settled = false
    const op = runtime.openFor(key, undefined, ac.signal).catch((error) => {
      settled = true
      throw error
    })
    await sleep(30)
    expect(settled).toBe(false) // queued at the per-group cap, not rejected
    ac.abort()
    await expect(op).rejects.toMatchObject({ code: 'group-quota' })
    runtime.dispose()
  })

  it('user shell actions bypass the takeover mutex', async () => {
    const { runtime } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    const t1 = await runtime.openFor(key, undefined)
    const t2 = await runtime.openFor(key, undefined)
    runtime.setUserControl(true)
    // User toolbar actions must complete even while the agent is paused.
    await runtime.reloadFor(key, t2.id, undefined, true)
    await runtime.goBackFor(key, t2.id, undefined, true)
    await runtime.goForwardFor(key, t2.id, undefined, true)
    await runtime.navigateFor(key, t2.id, 'https://user.example', 'domcontentloaded', undefined, true)
    // A new user tab also bypasses the mutex (bound to the foreground group).
    const t3 = await runtime.userOpen('https://user.example/2')
    expect(t3.id).toBe(3)
    expect(runtime.listTabs(key).map((t) => t.id)).toContain(t3.id)
    await runtime.closeTabFor(key, t3.id, undefined, true)
    expect(runtime.listTabs(key)).toHaveLength(2)
    void t1
    runtime.setUserControl(false)
    runtime.dispose()
  })

  it('close-tab switch re-enters no mutex (no nested deadlock)', async () => {
    const { runtime } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    await runtime.openFor(key, undefined)
    // Closing the active tab switches to the remaining one internally; the
    // switch must not re-acquire the mutex (would deadlock).
    await runtime.closeTabFor(key, 2)
    expect(runtime.currentTabId()).toBe(1)
    expect(runtime.listTabs(key)).toHaveLength(1)
    runtime.dispose()
  })

  it('creates the window lazily and hides without destroying tabs', async () => {
    const { runtime, windows } = makeRuntime()
    expect(runtime.windowState.created).toBe(false)
    await runtime.showWindow()
    expect(runtime.windowState.created).toBe(true)
    expect(windows).toHaveLength(1)
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, 'https://example.com')
    runtime.hideWindow()
    expect(windows[0]?.isVisible()).toBe(false)
    expect(runtime.listTabs(key)).toHaveLength(1)
    runtime.showWindow()
    expect(windows[0]?.isVisible()).toBe(true)
    runtime.dispose()
  })

  it('download guard cancels oversized downloads and records rejection', async () => {
    const { runtime, views, store } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    // The big file arrives small first and grows past the 100MB cap while
    // streaming — the guard cancels and marks the record rejected.
    const item = new MockDownloadItem('https://example.com/big.bin', 'big.bin', 200 * 1024 * 1024, 0)
    views[0]!.session.emitDownload(item)
    expect(store.queryDownloads()[0]?.status).toBe('in-progress')
    item.setReceived(150 * 1024 * 1024)
    item.emit('updated')
    expect(item.cancel).toHaveBeenCalled()
    expect(store.queryDownloads()[0]?.status).toBe('rejected')
    expect(runtime.opLog[0]?.summary).toContain('100MB')
    runtime.dispose()
  })

  it('downloadUrl triggers the native download and records the entry in the store', async () => {
    const { runtime, views, store } = makeRuntime()
    const key = runtime.ensureGroup('sess-1')
    await runtime.openFor(key, undefined)
    await runtime.downloadUrl(key, 'https://example.com/file.bin')
    expect(views[0]!.downloadURL).toHaveBeenCalledWith('https://example.com/file.bin')
    // The will-download event lands the entry through the guard recorder.
    const item = new MockDownloadItem('https://example.com/file.bin', 'file.bin', 1024, 0)
    views[0]!.session.emitDownload(item)
    const entries = store.queryDownloads()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.url).toBe('https://example.com/file.bin')
    expect(entries[0]?.fileName).toBe('file.bin')
    expect(entries[0]?.group).toBe(key)
    expect(entries[0]?.status).toBe('in-progress')
    // Completion updates the record.
    item.emit('done', 'completed')
    const done = store.queryDownloads()[0]!
    expect(done.status).toBe('done')
    expect(done.path).toContain('file.bin')
    runtime.dispose()
  })
})
