/**
 * Regression tests for the 2026-09-08 full-audit fixes in this package:
 * P1-18 cookie masking, P1-19 op-log reset, P1-20 awaited eval promises,
 * P2-26 restore lock/quota/attribution, P2-27 idempotent bookmark persistence,
 * P2-28 clearData without tabs + disposer release, P2-29 tool disposers,
 * P2-30 window.open → new tab, P2-31 empty screenshot, P2-32 select
 * verification, plus the P3 attribution/group/snapshot-limit items.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import { applyBrowserTools } from '../src/tools.ts'
import { serializeEvalResult } from '../src/eval-policy.ts'
import { extractSnapshot } from '../src/snapshot.ts'
import type { ElectronAdapter, NativeBounds, NativeImage, NativeSession, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

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
  partition = 'persist:agent-browser-test'
  handlers = new Map<string, Array<(...args: never[]) => void>>()
  clearStorageData = vi.fn(async () => {})
  clearCache = vi.fn(async () => {})
  setPermissionRequestHandler = vi.fn()
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

function fakeImage(width: number, height: number, bytes = Buffer.from('jpeg-bytes')): NativeImage {
  return {
    getSize: () => ({ width, height }),
    resize: () => fakeImage(width, height, bytes),
    toJPEG: () => bytes,
  } as unknown as NativeImage
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
  image: NativeImage = fakeImage(100, 100)
  loadURL = vi.fn(async (u: string) => { this.url = u; this.title = `Title of ${u}`; this.emit('did-stop-loading') })
  downloadURL = vi.fn()
  goBack = vi.fn(() => { this.emit('did-finish-load') })
  goForward = vi.fn(() => { this.emit('did-finish-load') })
  reload = vi.fn(() => { this.emit('did-finish-load') })
  capturePage = vi.fn(async () => this.image)
  windowOpenHandler: ((details: { url: string }) => { action: 'deny' }) | undefined
  setWindowOpenHandler = vi.fn((handler: (details: { url: string }) => { action: 'deny' }) => { this.windowOpenHandler = handler })
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
      capturePage: this.capturePage,
      getURL: () => this.url,
      getTitle: () => this.title,
      isLoading: () => this.loading,
      on: (e: string, l: (...a: unknown[]) => void) => { this.listeners.set(e, [...(this.listeners.get(e) ?? []), l]) },
      removeListener: (e: string, l: (...a: unknown[]) => void) => { this.listeners.set(e, (this.listeners.get(e) ?? []).filter((x) => x !== l)) },
      session: this.session,
      setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => this.setWindowOpenHandler(handler),
      close: () => { this.destroyed = true },
      isDestroyed: () => this.destroyed,
    } as never
  }
}

class MockAdapter implements ElectronAdapter {
  views: MockView[] = []
  overlays: MockView[] = []
  windows: Array<{ visible: boolean; destroyed: boolean }> = []
  partitionSession = new MockSession()
  showSaveDialog = vi.fn(async () => ({ canceled: true }))
  openPath = vi.fn(async () => ({}))
  createView(): NativeView { const v = new MockView(); this.views.push(v); return v }
  createMaskView(): NativeView { const v = new MockView(); this.overlays.push(v); return v }
  createBrowserWindow(): never {
    const w = { visible: false, destroyed: false }
    this.windows.push(w)
    return {
      loadURL: async () => {},
      show: () => { w.visible = true },
      hide: () => { w.visible = false },
      focus: () => {},
      isVisible: () => w.visible,
      isDestroyed: () => w.destroyed,
      close: () => { w.destroyed = true },
      setTitle: () => {},
      getContentSize: () => ({ width: 1100, height: 780 }),
      contentView: { addChildView: () => {}, removeChildView: () => {} },
      onResize: () => () => {},
      onClosed: () => () => {},
      focusPage: () => {},
    } as never
  }
  getSession(): NativeSession { return this.partitionSession }
  lastView(): MockView { return this.views.at(-1)! }
}

function makeRuntime(options: { maxTabs?: number } = {}): { runtime: BrowserRuntime; adapter: MockAdapter; store: BrowserStore; dir: string } {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.a9-store-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(adapter as never, options, undefined, undefined, { store })
  return { runtime, adapter, store, dir }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  const dir = join(process.cwd(), 'tests')
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.a9-store')) rmSync(join(dir, name), { recursive: true, force: true })
    }
  } catch { /* best effort */ }
})

// ---------------------------------------------------------------- P1-20

describe('P1-20 browser_eval awaits promise results', () => {
  it('sends awaitPromise:true and returns the resolved value', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    let sawAwaitPromise: unknown
    view.transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      sawAwaitPromise = params?.awaitPromise
      // Emulate CDP: with awaitPromise:false a promise serializes to `{}`.
      return params?.awaitPromise === true ? { result: { value: 42 } } : { result: { value: {} } }
    }
    await expect(runtime.eval(1, 'Promise.resolve(42)')).resolves.toBe('42')
    expect(sawAwaitPromise).toBe(true)
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------- P1-18

describe('P1-18 cookie-shaped eval results are masked', () => {
  it('masks `k=v; k2=v2` cookie strings whole', () => {
    expect(serializeEvalResult('sid=abc123; theme=dark')).toBe('"****"')
    expect(serializeEvalResult({ cookie: 'a=1; b=2; c=3' })).toBe('{"cookie":"****"}')
    expect(serializeEvalResult(['session=xyz; Path=/; HttpOnly'])).toBe('["****"]')
  })

  it('masks a single session/CSRF cookie pair but keeps ordinary text', () => {
    expect(serializeEvalResult('jsessionid=ABC123')).toBe('"****"')
    expect(serializeEvalResult('csrftoken=abcdef')).toBe('"****"')
    expect(serializeEvalResult('theme=dark')).toBe('"theme=dark"')
    expect(serializeEvalResult('page 3 of 10; results')).toBe('"page 3 of 10; results"')
    expect(serializeEvalResult('k=1')).toBe('"k=1"')
  })
})

// ---------------------------------------------------------------- P1-19

describe('P1-19 op log is per-account', () => {
  it('clearOps drops the trail and resets the sequence', async () => {
    const { runtime, dir } = makeRuntime()
    await runtime.open('https://a.example')
    expect(runtime.opLog.length).toBeGreaterThan(0)
    runtime.clearOps()
    expect(runtime.opLog).toHaveLength(0)
    await runtime.open('https://b.example')
    // opLog is newest-first; the reset counter must restart at 1.
    expect(Math.min(...runtime.opLog.map((op) => op.seq))).toBe(1)
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------- P2-26

describe('P2-26 ledger restore honors the tab quota and attribution', () => {
  it('never materializes more tabs than maxTabs and records actor=restore', async () => {
    const first = makeRuntime()
    await first.runtime.open('https://a.example')
    await first.runtime.open('https://b.example')
    await first.runtime.open('https://c.example')
    first.runtime.saveLedger()
    first.runtime.dispose()

    const adapter2 = new MockAdapter()
    const runtime2 = new BrowserRuntime(adapter2 as never, { maxTabs: 1 }, undefined, undefined, { store: first.store })
    runtime2.restoreLedger()
    await runtime2.prewarm()
    await sleep(80)
    expect(runtime2.listTabs()).toHaveLength(1)
    // The window must stay hidden while restoring (restore is not a user act).
    expect(adapter2.windows[0]?.visible).toBe(false)
    const restoreOps = runtime2.opLog.filter((op) => op.tool === 'browser_open')
    expect(restoreOps.every((op) => op.actor === 'restore')).toBe(true)
    runtime2.dispose(); rmSync(first.dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------- P2-27

describe('P2-27 idempotent bookmarks reach disk', () => {
  it('re-stamping an existing URL persists the new title/actor', () => {
    const dir = join(process.cwd(), 'tests', `.a9-store-bm-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    const store = new BrowserStore({ dir })
    store.addBookmark({ url: 'https://a.example', title: 'first', actor: 'ai', group: '' })
    const again = store.addBookmark({ url: 'https://a.example', title: 'second', actor: 'user', group: '' })
    expect(again.title).toBe('second')
    const onDisk = readFileSync(store.pathOf('bookmarks'), 'utf8')
    expect(onDisk).toContain('"title":"second"')
    expect(onDisk).not.toContain('"title":"first"')
    // A fresh store (restart) reads the persisted stamp.
    const reloaded = new BrowserStore({ dir })
    expect(reloaded.queryBookmarks()[0]?.title).toBe('second')
    rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------- P2-28

describe('P2-28 clearData with no tab + dispose releases disposers', () => {
  it('clears the known partition session when no tab exists', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.clearData(false)
    expect(adapter.partitionSession.clearStorageData).toHaveBeenCalledTimes(1)
    expect(adapter.partitionSession.clearCache).toHaveBeenCalledTimes(1)
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })

  it('fails loudly when the adapter cannot resolve the partition session', async () => {
    const adapter = new MockAdapter()
    ;(adapter as { getSession?: unknown }).getSession = undefined
    const dir = join(process.cwd(), 'tests', `.a9-store-ns-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    const runtime = new BrowserRuntime(adapter as never, {}, undefined, undefined, { store: new BrowserStore({ dir }) })
    await expect(runtime.clearData()).rejects.toMatchObject({ code: 'not-found' })
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })

  it('dispose releases the per-tab disposers', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    // The download guard is ref-counted per tab: dispose must drop the ref.
    const listenersBefore = view.session.handlers.get('will-download')?.length ?? 0
    expect(listenersBefore).toBe(1)
    runtime.dispose()
    expect(view.session.handlers.get('will-download')?.length ?? 0).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------- P2-29

describe('P2-29 tool registrations are fiber-scoped', () => {
  it('returns a disposer that unregisters every tool and the eval group is write', async () => {
    const { runtime, dir } = makeRuntime()
    const registered: string[] = []
    const ctx = {
      tools: {
        register: (definition: { name: string }) => {
          registered.push(definition.name)
          return () => {
            const i = registered.indexOf(definition.name)
            if (i >= 0) registered.splice(i, 1)
          }
        },
      },
      systemPrompt: { section: () => () => {} },
    } as unknown as Parameters<typeof applyBrowserTools>[0]

    const dispose = applyBrowserTools(ctx, runtime, new Set(['write']))
    expect(registered).toEqual(['browser_eval'])
    dispose()
    expect(registered).toEqual([])

    const all = applyBrowserTools(ctx, runtime)
    expect(registered.length).toBe(32)
    all()
    expect(registered).toEqual([])
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------- P2-30

describe('P2-30 window.open opens a tab instead of failing silently', () => {
  it('installs a handler that opens the target as a new tab and records an op', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const handler = view.windowOpenHandler
    expect(handler).toBeDefined()
    expect(handler?.({ url: 'https://popup.example/x' })).toEqual({ action: 'deny' })
    await vi.waitFor(() => { expect(runtime.listTabs()).toHaveLength(2) })
    expect(runtime.opLog.some((op) => op.tool === 'browser_window_open')).toBe(true)
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------- P2-31

describe('P2-31 empty screenshots fail loudly', () => {
  it('rejects a zero-sized capture and records a failed op', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    adapter.lastView().image = fakeImage(0, 0)
    await expect(runtime.screenshot(1)).rejects.toThrow(/empty image/u)
    const op = runtime.opLog.find((entry) => entry.tool === 'browser_screenshot')
    expect(op?.failed).toBe(true)
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------- P2-32

describe('P2-32 browser_select verifies the assignment', () => {
  it('reports not-found when the option does not exist', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      // Emulate a select whose value assignment did not stick.
      return String(params?.expression).includes('el.value !== wanted')
        ? { result: { value: { error: 'option not found: zz' } } }
        : { result: { value: {} } }
    }
    await expect(runtime.selectOption(1, 'select#size', 'zz')).rejects.toMatchObject({ code: 'not-found' })
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })
})

// ------------------------------------------------------- P3 (selective)

describe('P3: agent attribution, snapshot limit, eval group', () => {
  it('attributes a queued operation to the agent that issued it', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.hang = true
    runtime.setAgentContext('agent-1')
    const blocked = runtime.eval(1, 'document.title')
    await sleep(10)
    runtime.setAgentContext('agent-2')
    const second = runtime.open('https://b.example')
    runtime.setAgentContext('agent-3')
    const third = runtime.open('https://c.example')
    view.transport.hang = false
    await Promise.all([blocked, second, third])
    // opLog is newest-first: c (agent-3) then b (agent-2), then the initial
    // unattributed open of a.example.
    const opens = runtime.opLog.filter((op) => op.tool === 'browser_open').map((op) => op.session)
    expect(opens).toEqual(['agent-3', 'agent-2', ''])
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })

  it('wires the fixed pieces into the plugin entry (P1-19 / P2-29)', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    // P1-19: the session-change handler must clear the previous account's ops.
    expect(source).toContain('runtime.clearOps()')
    // P2-29: the tool suite's disposer must be owned by the plugin fiber.
    expect(source).toMatch(/ctx\.effect\(\s*\(\) => applyBrowserTools/u)
    // P2-38b: no cwd-relative browser store fallback remains.
    expect(source).not.toContain("join(process.cwd(), '.browser-store'")
    expect(source).toContain('dshHomePath()')
  })

  it('injects the configured snapshot limit into the page probe', async () => {
    let expression = ''
    const elements = await extractSnapshot(async (_method, params) => {
      expression = String(params?.expression)
      return { result: { value: [] } }
    }, 500)
    expect(expression).toContain('const MAX = 500;')
    expect(elements).toEqual([])
  })
})
