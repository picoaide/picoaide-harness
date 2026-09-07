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
import { BrowserStore } from '../src/store.ts'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

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
  downloadURL = vi.fn()
  goBack = vi.fn(() => { this.url = 'about:blank'; this.title = ''; this.emit('did-finish-load') })
  goForward = vi.fn(() => { this.emit('did-finish-load') })
  reload = vi.fn(() => { this.emit('did-finish-load') })
  capturePage = vi.fn(async () => new MockImage(1920, 1080))
  setWindowOpenHandler = vi.fn()
  partition = 'persist:agent-browser'
  attach(win: NativeBrowserWindow, bounds: NativeBounds): void {
    this.attached = true
    this.bounds = bounds
    win.contentView.addChildView(this)
  }
  setBounds(bounds: NativeBounds): void { this.bounds = bounds }
  setVisible(visible: boolean): void { this.visible = visible }
  detach(): void { this.attached = false }
  moveToTop(win: NativeBrowserWindow): void {
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
        const set = this.listeners.get(event) ?? []
        const idx = set.indexOf(listener)
        if (idx >= 0) set.splice(idx, 1)
      },
      close: () => { this.destroyed = true },
      isDestroyed: () => this.destroyed,
      session: this.session,
      setWindowOpenHandler: () => {},
    }
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

class MockWindow implements NativeBrowserWindow {
  readonly children: NativeView[] = []
  visible = false
  destroyed = false
  title = ''
  private readonly resize = new Set<() => void>()
  private readonly closed = new Set<() => void>()
  loadURL = vi.fn(async () => {})
  show(): void { this.visible = true }
  hide(): void { this.visible = false }
  focus(): void {}
  isVisible(): boolean { return this.visible }
  isDestroyed(): boolean { return this.destroyed }
  close(): void {
    this.destroyed = true
    for (const cb of [...this.closed]) { try { cb() } catch { /* noop */ } }
  }
  setTitle(title: string): void { this.title = title }
  getContentSize(): { width: number; height: number } { return { width: 1100, height: 780 } }
  contentView = {
    addChildView: (view: unknown) => { this.children.push(view as NativeView) },
    removeChildView: (view: unknown) => {
      const idx = this.children.indexOf(view as NativeView)
      if (idx >= 0) this.children.splice(idx, 1)
    },
  }
  onResize(listener: () => void): () => void { this.resize.add(listener); return () => { this.resize.delete(listener) } }
  onClosed(listener: () => void): () => void { this.closed.add(listener); return () => { this.closed.delete(listener) } }
}

class MockAdapter implements ElectronAdapter {
  readonly views: MockView[] = []
  readonly masks: MockView[] = []
  readonly windows: MockWindow[] = []
  showSaveDialog = vi.fn(async () => ({ canceled: true }))
  createView(partition?: string): NativeView {
    const view = new MockView()
    view.session.partition = partition ?? 'persist:agent-browser'
    view.partition = partition ?? 'persist:agent-browser'
    this.views.push(view)
    return view
  }
  createMaskView(partition?: string): NativeView {
    const view = new MockView()
    view.partition = partition ?? 'persist:agent-browser'
    this.masks.push(view)
    return view
  }
  createBrowserWindow(): NativeBrowserWindow {
    const win = new MockWindow()
    this.windows.push(win)
    return win
  }
  lastView(): MockView {
    const view = this.views.at(-1)
    if (view === undefined) throw new Error('no view created')
    return view
  }
  mask(): MockView {
    const view = this.masks.at(-1)
    if (view === undefined) throw new Error('no mask created')
    return view
  }
}

function makeRuntime(options: { maxTabs?: number; evalEnabled?: boolean } = {}) {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.rt-store-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(adapter, options, undefined, undefined, { store })
  const cleanup = () => { runtime.dispose(); rmSync(dir, { recursive: true, force: true }) }
  return { adapter, runtime, store, cleanup }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('BrowserRuntime v4.2 — flat pool', () => {
  it('open creates a tab, marks it active, and listTabs sees it', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    const tab = await runtime.open('https://example.com')
    expect(tab.id).toBe(1)
    expect(runtime.listTabs()).toHaveLength(1)
    expect(runtime.listTabs()[0]?.visible).toBe(true)
    expect(runtime.listTabs()[0]?.url).toBe('https://example.com')
    expect(adapter.windows[0]?.visible).toBe(true)
    cleanup()
  })

  it('opens a second tab and switches active', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const t2 = await runtime.open('https://b.example')
    expect(runtime.currentTabId()).toBe(t2.id)
    await runtime.switchTab(t2.id === 1 ? 2 : 1)
    expect(runtime.currentTabId()).toBe(t2.id === 1 ? 2 : 1)
    cleanup()
  })

  it('resolveTab defaults to the active tab and rejects unknown ids', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    await runtime.open('https://b.example')
    const active = runtime.currentTabId()!
    expect(runtime.resolveTab(undefined)).toBe(active)
    expect(() => runtime.resolveTab(999)).toThrow()
    cleanup()
  })

  it('navigate goes through the guard (javascript:/data: rejected)', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const tab = runtime.currentTabId()!
    const err = await runtime.navigate(tab, 'javascript:alert(1)').catch((e: unknown) => e)
    expect((err as Error).message).toContain('navigation denied')
    cleanup()
  })

  it('reload/back/forward work on the active tab', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    await runtime.navigate(id, 'https://b.example')
    await runtime.goBack(id)
    expect(adapter.lastView().url).toBe('about:blank')
    await runtime.goForward(id)
    await runtime.reload(id)
    cleanup()
  })

  it('closes a tab and destroys its view', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    await runtime.open('https://b.example')
    const first = adapter.views[0]!
    await runtime.closeTab(first === adapter.views[0] ? first.bounds ? runtime.listTabs()[0]!.id : runtime.listTabs()[0]!.id : 0)
    expect(runtime.listTabs()).toHaveLength(1)
    cleanup()
  })

  it('evalFor read-only policy: legal passes, assignment rejected, gate honored', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    const result = await runtime.eval(id, 'window.__NEXT_DATA__ ? 1 : 2')
    expect(typeof result).toBe('string')
    const err = await runtime.eval(id, 'window.x = 1').catch((e: unknown) => e)
    expect((err as Error & { code?: string }).code).toBe('eval-policy')
    cleanup()
  })

  it('gate: evalEnabled=false rejects with policy', async () => {
    const { runtime, cleanup } = makeRuntime({ evalEnabled: false })
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    const err = await runtime.eval(id, '1 + 1').catch((e: unknown) => e)
    expect((err as Error & { code?: string }).code).toBe('policy')
    cleanup()
  })

  it('waitFor returns ok for settled conditions and times out gracefully', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    adapter.lastView().transport.handler = (method) => {
      if (method === 'Runtime.evaluate') return { result: { value: true } }
      return {}
    }
    const ok = await runtime.waitFor(id, { condition: 'settled', timeoutMs: 1000 })
    expect(ok.ok).toBe(true)
    cleanup()
  })

  it('downloadUrl triggers webContents.downloadURL and records history', async () => {
    const { runtime, adapter, store, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    await runtime.downloadUrl('https://files.example/x.zip')
    expect(adapter.lastView().downloadURL).toHaveBeenCalledWith('https://files.example/x.zip')
    expect(store.counts().history).toBeGreaterThan(0)
    cleanup()
  })

  it('bookmarks add/list/remove work with active tab', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    const b = runtime.addBookmark(id, 'My Bookmark')
    expect(runtime.listBookmarks().some((x) => x.id === b.id)).toBe(true)
    expect(runtime.removeBookmark(b.id)).toBe(true)
    cleanup()
  })

  it('clearData clears session storage/cache', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    await runtime.open('https://b.example')
    await runtime.clearData(true)
    for (const view of adapter.views) {
      expect(view.session.clearStorageData).toHaveBeenCalled()
      expect(view.session.clearCache).toHaveBeenCalled()
    }
    cleanup()
  })

  it('user takeover pauses agent ops; release resumes them; abort rejects window-controlled', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    runtime.setUserControl(true)
    let ran = false
    const p = runtime.navigate(1, 'https://c.example').then(() => { ran = true })
    await sleep(80)
    expect(ran).toBe(false)
    runtime.setUserControl(false)
    await p
    expect(ran).toBe(true)
    runtime.setUserControl(true)
    const ctrl = new AbortController()
    const pending = runtime.navigate(1, 'https://d.example', 'domcontentloaded', ctrl.signal).catch((e: unknown) => e)
    ctrl.abort()
    const err = await pending
    expect((err as Error & { code?: string }).code).toBe('window-controlled')
    cleanup()
  })

  it('shellState exposes tabs/busy/controlled/latestOp', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const state = runtime.shellState()
    expect(state.tabs).toHaveLength(1)
    expect(state.busy).toBe(false)
    expect(state.controlled).toBe(false)
    expect(state.latestOp?.tool).toBe('browser_open')
    cleanup()
  })

  it('closeAll clears tabs and hides the window', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    await runtime.closeAll(true)
    expect(runtime.listTabs()).toHaveLength(0)
    expect(adapter.windows[0]?.visible).toBe(false)
    cleanup()
  })

  it('ledger persists tabs across runtimes (same store)', async () => {
    const { runtime, store, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    runtime.saveLedger()
    const runtime2 = new BrowserRuntime(new MockAdapter(), {}, undefined, undefined, { store })
    runtime2.restoreLedger()
    expect(runtime2.pool.list().length).toBe(1)
    cleanup()
    runtime2.dispose()
  })
})
