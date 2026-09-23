/**
 * Regression for the R4-B audit (2026-09-23), findings **R4-B-15** and
 * **R4-B-17**.
 *
 * R4-B-15 — the tool budget was still eaten by internal waiting. Two legs were
 * unbounded relative to the registered deadline:
 *  · the CDP leg used the whole tool budget as its per-command timeout
 *    (`runtime.ts` created the session with `timeoutMs: options.timeoutMs`), so
 *    "user gate 1.2 s + a renderer that never answers" returned at 31.2 s — past
 *    the 30 s deadline, where upstream timeout-policy REPLACES the tool's own
 *    (`Runtime.evaluate did not respond within …`) with a generic
 *    `tool call timed out after 30000ms`;
 *  · `PoolMutex.run` waited for the previous operation with no time bound at
 *    all, so a call queued behind a legal 40 s `browser_wait_for` died of its own
 *    deadline while still waiting (audit probe: `queued tool finished after
 *    30853ms (budget 30000ms)`).
 *
 * R4-B-17 — `installDownloadGuard` handed out a fresh closure per registration
 * with no once-only marker, so a double release decremented the shared ref count
 * twice and silently removed the listener while another tab was still open; and
 * the attribution context stayed on the newest registration even after that tab
 * was closed.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import { BrowserGuard } from '../src/guard.ts'
import type { DownloadRecorder } from '../src/store.ts'
import type { ElectronAdapter, NativeBounds, NativeDownloadItem, NativeSession, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

/** CDP transport whose chosen methods never settle (a wedged renderer). */
class HungTransport implements CdpTransport {
  attached = false
  /** Methods that hang; everything else answers `{}`. */
  hung = new Set<string>()
  readonly calls: string[] = []
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  sendCommand(method: string): Promise<unknown> {
    this.calls.push(method)
    if (this.hung.has(method)) return new Promise<unknown>(() => {})
    return Promise.resolve({ result: { value: true } })
  }
  on(): unknown { return this }
  removeListener(): unknown { return this }
}

class MockSession implements NativeSession {
  clearStorageData = vi.fn(async () => {})
  clearCache = vi.fn(async () => {})
  setPermissionRequestHandler = vi.fn()
  setPermissionCheckHandler = vi.fn()
  on(): void {}
  removeListener(): void {}
}

class MockView implements NativeView {
  transport = new HungTransport()
  session = new MockSession()
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  destroyed = false
  url = ''
  title = 'page'
  loadURL = vi.fn(async (u: string) => { this.url = u; this.emit('did-stop-loading') })
  downloadURL = vi.fn()
  goBack = vi.fn()
  goForward = vi.fn()
  reload = vi.fn()
  capturePage = vi.fn(async () => ({ getSize: () => ({ width: 0, height: 0 }), resize: () => ({}), toJPEG: () => Buffer.from('') }))
  setWindowOpenHandler = vi.fn()
  attach(): void {}
  setBounds(_b: NativeBounds): void {}
  setVisible(_v: boolean): void {}
  detach(): void {}
  moveToTop(): void {}
  destroy(): void { this.destroyed = true }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
  get webContents(): never {
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
      isLoading: () => false,
      on: (event: string, listener: (...args: unknown[]) => void) => {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      },
      removeListener: (event: string, listener: (...args: unknown[]) => void) => {
        this.listeners.set(event, (this.listeners.get(event) ?? []).filter(entry => entry !== listener))
      },
      session: this.session,
      setWindowOpenHandler: this.setWindowOpenHandler,
      close: () => { this.destroyed = true },
      isDestroyed: () => this.destroyed,
    } as never
  }
}

class MockAdapter implements ElectronAdapter {
  views: MockView[] = []
  createView(): NativeView { const view = new MockView(); this.views.push(view); return view }
  createMaskView(): NativeView { return new MockView() }
  showSaveDialog(): Promise<{ canceled: boolean, filePath?: string }> { return Promise.resolve({ canceled: true }) }
  openPath(): Promise<{ error?: string }> { return Promise.resolve({}) }
  createBrowserWindow(): never {
    return {
      loadURL: async () => {}, show: () => {}, hide: () => {}, focus: () => {}, isVisible: () => false,
      isDestroyed: () => false, close: () => {}, setTitle: () => {}, getContentSize: () => ({ width: 1100, height: 780 }),
      contentView: { addChildView: () => {}, removeChildView: () => {} },
      onResize: () => () => {}, onClosed: () => () => {}, onFocus: () => () => {}, focusPage: () => {},
    } as never
  }
  getSession(): NativeSession { return new MockSession() }
}

const opened: Array<{ runtime: BrowserRuntime, root: string }> = []
afterEach(() => {
  for (const entry of opened.splice(0)) {
    entry.runtime.dispose()
    rmSync(entry.root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function makeRuntime(label: string, timeoutMs: number): Promise<{ runtime: BrowserRuntime, adapter: MockAdapter }> {
  const root = join(process.cwd(), 'tests', `.audit0923-r4b15-${label}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  const store = new BrowserStore({ dir: join(root, 'user-a') })
  const adapter = new MockAdapter()
  const runtime = new BrowserRuntime(
    adapter as never,
    { downloadDir: join(root, 'downloads'), timeoutMs, loadTimeoutMs: timeoutMs },
    undefined,
    `persist:agent-browser-${label}`,
    { store, locale: () => 'en' },
  )
  opened.push({ runtime, root })
  const tab = await runtime.open('https://example.com/page', undefined, false)
  return { runtime, adapter }
}

describe('R4-B-15: the CDP leg is bounded by what is left of the tool deadline', () => {
  it('a renderer that never answers is abandoned before the tool deadline', async () => {
    // 1500 ms tool budget ⇒ operation deadline = start + 500 ms ⇒ the CDP call
    // may use 500 ms, not the whole 1500 ms budget.
    const { runtime, adapter } = await makeRuntime('hung-cdp', 1_500)
    const view = adapter.views[0]!
    view.transport.hung.add('Runtime.evaluate')
    const started = Date.now()
    const failure = await runtime.eval(1, '1 + 1').then(() => undefined, (error: unknown) => error)
    const elapsed = Date.now() - started
    expect(failure, 'a wedged renderer must fail, not hang').toBeInstanceOf(Error)
    // The tool's OWN diagnosis, not a generic timeout.
    expect(String(failure)).toMatch(/did not respond|timeout/iu)
    expect(elapsed, `the CDP leg must not eat the whole tool budget (took ${String(elapsed)}ms)`).toBeLessThan(1_100)
  }, 30_000)

  it('control: gate wait + CDP hang stays inside the tool budget', async () => {
    const { runtime, adapter } = await makeRuntime('gate-plus-cdp', 3_000)
    const view = adapter.views[0]!
    view.transport.hung.add('Runtime.evaluate')
    // The user holds the browser for 1.5 s of a 3 s budget, then hands it back.
    runtime.pool.setUserControl(true)
    const started = Date.now()
    const pending = runtime.eval(1, '1 + 1').then(() => undefined, (error: unknown) => error)
    await sleep(1_500)
    runtime.pool.setUserControl(false)
    const failure = await pending
    const elapsed = Date.now() - started
    expect(failure, 'the call must end with a readable error').toBeInstanceOf(Error)
    // Pre-fix: gate 1.5 s + CDP 3.0 s = 4.5 s > the 3 s registered budget, so the
    // upstream policy would have replaced this message with a generic timeout.
    expect(elapsed, `gate + CDP must fit the tool budget (took ${String(elapsed)}ms)`).toBeLessThan(2_800)
  }, 30_000)
})

describe('R4-B-15: waiting for the running operation is bounded too', () => {
  it('a call queued behind a long operation fails with its own error, not the tool deadline', async () => {
    const { runtime } = await makeRuntime('queue-budget', 3_000)
    // The predecessor legitimately occupies the global lock for ~1.8 s.
    const first = runtime.waitFor(1, { condition: 'element-present', selector: '#never', timeoutMs: 1_800 })
    await sleep(50)
    const started = Date.now()
    const failure = await runtime.eval(1, '1 + 1').then(() => undefined, (error: unknown) => error)
    const elapsed = Date.now() - started
    await first
    expect(failure, 'the queued call must not silently wait out its budget').toBeInstanceOf(Error)
    expect(String(failure)).toMatch(/waiting for the running browser operation/iu)
    // Pre-fix the call waited out the predecessor (1.8 s) and then ran into its
    // own deadline; the bound is `deadline − now − QUEUE_MIN_WORK_MS` ≈ 1 s.
    expect(elapsed, `the queue bound fired at ${String(elapsed)}ms`).toBeLessThan(1_400)
  }, 30_000)

  it('control: a call queued behind a SHORT operation still runs', async () => {
    const { runtime, adapter } = await makeRuntime('queue-short', 3_000)
    const view = adapter.views[0]!
    const first = runtime.waitFor(1, { condition: 'element-present', selector: '#never', timeoutMs: 300 })
    await sleep(30)
    const result = await runtime.eval(1, '1 + 1')
    await first
    expect(result).toBeDefined()
    expect(view.transport.calls).toContain('Runtime.evaluate')
  }, 30_000)
})

describe('R4-B-17: the download guard is idempotent and drops closed registrations', () => {
  interface FakeSession {
    listeners: Array<(event: unknown, item: NativeDownloadItem) => void>
    on: (event: 'will-download', listener: (event: unknown, item: NativeDownloadItem) => void) => void
    removeListener: (event: 'will-download', listener: (event: unknown, item: NativeDownloadItem) => void) => void
    emit: (item: NativeDownloadItem) => void
  }

  function fakeSession(): FakeSession {
    const listeners: FakeSession['listeners'] = []
    return {
      listeners,
      on(_event, listener): void { listeners.push(listener) },
      removeListener(_event, listener): void {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      },
      emit(item): void { for (const listener of [...listeners]) listener({}, item) },
    }
  }

  function fakeItem(): NativeDownloadItem {
    return {
      getFilename: () => 'report.txt',
      getURL: () => 'https://example.com/report.txt',
      getReceivedBytes: () => 0,
      getTotalBytes: () => 10,
      setSavePath: () => {},
      cancel: () => {},
      on: () => {},
    } as unknown as NativeDownloadItem
  }

  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('a doubled dispose does not release another tab\'s reference', () => {
    const guard = new BrowserGuard({} as never)
    const session = fakeSession()
    const dir = mkdtempSync(join(tmpdir(), 'r4b17-dl-'))
    dirs.push(dir)
    const recorder: DownloadRecorder = { add: () => 1, update: () => {} }
    const native = session as unknown as NativeSession
    const disposeFirst = guard.installDownloadGuard(native, () => {}, recorder, 'g1', 'user', dir)
    const disposeSecond = guard.installDownloadGuard(native, () => {}, recorder, 'g2', 'ai', dir)
    expect(session.listeners).toHaveLength(1)
    // Two releases of ONE registration must count as one.
    disposeFirst()
    disposeFirst()
    expect(session.listeners, 'the second tab is still open: interception must stay installed').toHaveLength(1)
    disposeSecond()
    expect(session.listeners).toHaveLength(0)
  })

  it('attribution falls back to the tabs that are still open', () => {
    const guard = new BrowserGuard({} as never)
    const session = fakeSession()
    const dir = mkdtempSync(join(tmpdir(), 'r4b17-ctx-'))
    dirs.push(dir)
    const added: Array<{ group?: string, actor?: string }> = []
    const recorder: DownloadRecorder = { add: (entry) => { added.push(entry); return added.length }, update: () => {} }
    const native = session as unknown as NativeSession
    const disposeFirst = guard.installDownloadGuard(native, () => {}, recorder, 'g1', 'user', dir)
    const disposeSecond = guard.installDownloadGuard(native, () => {}, recorder, 'g2', 'ai', dir)
    // The newest tab closes; only the first (user) tab remains.
    disposeSecond()
    session.emit(fakeItem())
    expect(added).toHaveLength(1)
    expect(added[0]?.actor, 'a live tab owns the attribution, not the closed one').toBe('user')
    expect(added[0]?.group).toBe('g1')
    // The newest LIVE registration wins while it is open (unchanged behavior).
    const disposeThird = guard.installDownloadGuard(native, () => {}, recorder, 'g3', 'ai', dir)
    session.emit(fakeItem())
    expect(added[1]?.group).toBe('g3')
    disposeFirst()
    disposeThird()
    expect(session.listeners).toHaveLength(0)
  })
})
