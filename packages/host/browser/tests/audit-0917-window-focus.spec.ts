/**
 * 浏览器窗口不得"自己弹出来"（2026-09-17 用户报告）。
 *
 * 现场：用户在 AI 跑浏览器任务时切到别的窗口，过一会儿浏览器窗口又跑到前台；
 * **最小化也会自动弹回来**，导致没法做别的事。根因是两条"抢焦点"路径 ——
 * 给一个 WebContents 抢焦点会激活它的顶层窗口，Windows 上还会把最小化的窗口
 * 恢复回来：
 *
 *  1. 蒙版上锁时 `overlay.focus()`（2026-09-15 审计 P2-7 加的）在**每次**
 *     `applyOverlay()` 里无条件执行，而蒙版是默认状态（用户没接管时恒为 mask）；
 *     `applyOverlay` 又被 'busy'（AI 每个操作起止各一次）、'takeover'/'release'、
 *     以及每次 `relayout()`（建/关/切标签、resize、恢复账本、换会话/分区）触发。
 *  2. `moveToTop()` 用 `removeChildView + addChildView` 实现，而 Electron 的
 *     `addChildView` **会抢焦点**且没有关闭开关（electron#42339 / #42922）；
 *     每次 relayout 都重排一次活动视图与蒙版。
 *
 * 修法：所有夺焦点动作都过 `windowAttended()` 闸（可见 + 未最小化 + 有焦点）；
 * 已在最上层的子视图不再重复 remove+add；窗口重新获得焦点时补做键盘上锁，
 * 因此 P2-7「蒙版上锁必须夺键盘」不会因为这道闸退化。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import { raiseChildView, type ElectronAdapter, type NativeBounds, type NativeImage, type NativeSession, type NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

// ------------------------------------------------------------------ mocks

class MockTransport implements CdpTransport {
  attached = false
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  async sendCommand(): Promise<unknown> { return {} }
  on(): unknown { return this }
  removeListener(): unknown { return this }
}

class MockSession implements NativeSession {
  partition = 'persist:agent-browser-focus'
  clearStorageData = vi.fn(async () => {})
  clearCache = vi.fn(async () => {})
  setPermissionRequestHandler = vi.fn()
  setPermissionCheckHandler = vi.fn()
  on(): void {}
  removeListener(): void {}
}

class MockView implements NativeView {
  transport = new MockTransport()
  session = new MockSession()
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  attached = false
  visible = false
  bounds: NativeBounds = { x: 0, y: 0, width: 0, height: 0 }
  partition = 'persist:agent-browser-focus'
  destroyed = false
  /** 2026-09-17：蒙版夺取键盘焦点的调用次数（回归判据）。 */
  focus = vi.fn()
  moveToTopCalls = 0
  loadURL = vi.fn(async () => { this.emit('did-stop-loading') })
  downloadURL = vi.fn()
  goBack = vi.fn()
  goForward = vi.fn()
  reload = vi.fn()
  capturePage = vi.fn(async () => null)
  setWindowOpenHandler = vi.fn()
  attach(win: { contentView: { addChildView: (v: unknown) => void } }, bounds: NativeBounds): void {
    this.attached = true
    this.bounds = bounds
    // 与真实适配器一致（audit-fixes.spec.ts 的 mock 同形）：attach 会 append 到
    // 子视图列表末尾，也就是**新标签会盖在蒙版上面**，直到 relayout 抬回蒙版。
    // 少了这一步，"新标签压住蒙版"这条真实序列在 mock 里根本不存在（审计 S3）。
    win.contentView.addChildView(this)
  }
  setBounds(b: NativeBounds): void { this.bounds = b }
  setVisible(v: boolean): void { this.visible = v }
  detach(): void { this.attached = false }
  moveToTop(win: { contentView: { addChildView: (v: unknown) => void; removeChildView: (v: unknown) => void; children?: readonly unknown[] } }): void {
    this.moveToTopCalls += 1
    raiseChildView(win as never, this)
  }
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
      getURL: () => '',
      getTitle: () => '',
      isLoading: () => false,
      on: (event: string, listener: (...args: unknown[]) => void) => {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      },
      removeListener: (event: string, listener: (...args: unknown[]) => void) => {
        this.listeners.set(event, (this.listeners.get(event) ?? []).filter((x) => x !== listener))
      },
      session: this.session,
      setWindowOpenHandler: this.setWindowOpenHandler,
      close: () => { this.destroyed = true },
      isDestroyed: () => this.destroyed,
    } as never
  }
}

class MockWindow {
  children: unknown[] = []
  /** 原生子视图操作次数：addChildView 会抢焦点，所以"已是最上层就别再动"必须可断言。 */
  addCalls = 0
  removeCalls = 0
  visible = false
  minimized = false
  focused = false
  destroyed = false
  focus = vi.fn()
  focusPage = vi.fn()
  private readonly resize = new Set<() => void>()
  private readonly closed = new Set<() => void>()
  private readonly focusListeners = new Set<() => void>()
  loadURL = vi.fn(async () => {})
  show(): void { this.visible = true }
  hide(): void { this.visible = false }
  isVisible(): boolean { return this.visible }
  isMinimized(): boolean { return this.minimized }
  isFocused(): boolean { return this.focused }
  isDestroyed(): boolean { return this.destroyed }
  onFocus(listener: () => void): () => void {
    this.focusListeners.add(listener)
    return () => { this.focusListeners.delete(listener) }
  }
  close(): void {
    this.destroyed = true
    for (const cb of [...this.closed]) { try { cb() } catch { /* noop */ } }
  }
  setTitle(): void {}
  getContentSize(): { width: number; height: number } {
    if (this.destroyed) throw new Error('Object has been destroyed')
    return { width: 1100, height: 780 }
  }
  contentView: {
    addChildView: (view: unknown) => void
    removeChildView: (view: unknown) => void
    readonly children?: readonly unknown[]
  }
  constructor() {
    const self = this
    this.contentView = {
      addChildView: (view: unknown) => { self.addCalls += 1; self.children.push(view) },
      removeChildView: (view: unknown) => {
        self.removeCalls += 1
        const idx = self.children.indexOf(view)
        if (idx >= 0) self.children.splice(idx, 1)
      },
      get children(): readonly unknown[] { return self.children },
    }
  }
  onResize(listener: () => void): () => void { this.resize.add(listener); return () => { this.resize.delete(listener) } }
  onClosed(listener: () => void): () => void { this.closed.add(listener); return () => { this.closed.delete(listener) } }
  /** 模拟"窗口从最小化/后台被用户带回前台"。 */
  emitFocus(): void { this.focused = true; for (const cb of [...this.focusListeners]) cb() }
  /** 模拟 resize（最小化/还原在 Windows 上都会先改尺寸）。 */
  emitResize(): void { for (const cb of [...this.resize]) cb() }
}

class MockAdapter implements ElectronAdapter {
  views: MockView[] = []
  overlays: MockView[] = []
  windows: MockWindow[] = []
  partitionSession = new MockSession()
  showSaveDialog = vi.fn(async () => ({ canceled: true }))
  openPath = vi.fn(async () => ({}))
  createView(): NativeView { const v = new MockView(); this.views.push(v); return v }
  createMaskView(): NativeView { const v = new MockView(); this.overlays.push(v); return v }
  createBrowserWindow(): never { const w = new MockWindow(); this.windows.push(w); return w as never }
  getSession(): NativeSession { return this.partitionSession }
}

function makeRuntime(): { runtime: BrowserRuntime; adapter: MockAdapter; cleanup: () => void } {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.focus-store-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const runtime = new BrowserRuntime(adapter as never, {}, undefined, undefined, { store: new BrowserStore({ dir }) })
  return {
    runtime,
    adapter,
    cleanup: () => {
      runtime.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

afterEach(() => {
  const dir = join(process.cwd(), 'tests')
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.focus-store')) rmSync(join(dir, name), { recursive: true, force: true })
    }
  } catch { /* best effort */ }
})

/** 窗口从"用户在看的窗口"变成隐藏/最小化/后台的三种状态。 */
type Attendance = 'attended' | 'hidden' | 'minimized' | 'background'

function setWindowState(win: MockWindow, state: Attendance): void {
  win.visible = state === 'attended' || state === 'minimized' || state === 'background'
  win.minimized = state === 'minimized'
  win.focused = state === 'attended'
}

describe('浏览器窗口不得自己弹出来（2026-09-17）', () => {
  for (const state of ['hidden', 'minimized', 'background'] as const) {
    it(`${state}：蒙版上锁不得抢键盘焦点`, async () => {
      const { runtime, adapter, cleanup } = makeRuntime()
      try {
        await runtime.prewarm()
        const win = adapter.windows[0]!
        const overlay = adapter.overlays[0]!
        setWindowState(win, state)
        overlay.focus.mockClear()
        win.focusPage.mockClear()

        // 用户交还控制权 → 蒙版重新上锁（这是旧代码夺焦点、把窗口拽回前台的时刻）
        runtime.setUserControl(true, 'user')
        runtime.setUserControl(false, 'user')

        expect(overlay.focus).not.toHaveBeenCalled()
      } finally {
        cleanup()
      }
    })
  }

  it('最小化判据本身是承重的：可见 + 最小化 + 仍有焦点时也不得夺焦点', async () => {
    // 审计 S2：上面那组用例的最小化场景同时把 focused 置为 false，会被 isFocused
    // 判据顺带兜住 —— 用户报告里最扎眼的那一条（最小化）没有被 isMinimized 单独钉住。
    const { runtime, adapter, cleanup } = makeRuntime()
    try {
      await runtime.prewarm()
      const win = adapter.windows[0]!
      const overlay = adapter.overlays[0]!
      win.visible = true
      win.minimized = true
      win.focused = true
      overlay.focus.mockClear()

      runtime.setUserControl(true, 'user')
      runtime.setUserControl(false, 'user')

      expect(overlay.focus).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })

  it('capsule 交还键盘（focusPage）同样只在前台时执行', async () => {
    // 审计 S1：这条闸门原来是零覆盖（全套件从未调用过 setOverlayMode）。
    const { runtime, adapter, cleanup } = makeRuntime()
    try {
      await runtime.prewarm()
      const win = adapter.windows[0]!
      setWindowState(win, 'background')
      win.focusPage.mockClear()
      runtime.setOverlayMode('menu')
      runtime.setOverlayMode('capsule')
      expect(win.focusPage).not.toHaveBeenCalled()

      setWindowState(win, 'attended')
      runtime.setOverlayMode('menu')
      runtime.setOverlayMode('capsule')
      expect(win.focusPage).toHaveBeenCalledTimes(1)
    } finally {
      cleanup()
    }
  })

  it('隐藏/最小化时 AI 的每次操作（busy）都不得抢焦点', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    try {
      await runtime.prewarm()
      const win = adapter.windows[0]!
      const overlay = adapter.overlays[0]!
      setWindowState(win, 'minimized')
      overlay.focus.mockClear()

      await runtime.pool.withOperation('browser_probe', async () => { /* one agent op */ })

      expect(overlay.focus).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })

  it('最小化引发的 resize→relayout 不得抢焦点，也不得把窗口拽回来', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    try {
      await runtime.prewarm()
      const win = adapter.windows[0]!
      const overlay = adapter.overlays[0]!
      setWindowState(win, 'minimized')
      overlay.focus.mockClear()

      win.emitResize()

      expect(overlay.focus).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })

  it('relayout 不再触碰原生子视图顺序（切/关标签、resize、恢复账本）', async () => {
    // 审计 M1：旧代码每次 relayout 都会重排活动标签 + 蒙版（各一次 remove+add），
    // 即每次 addChildView —— 而它在 Windows 上可能激活顶层窗口。修法后：原生层序
    // 只由 attach（新视图在最上）与 applyOverlay（蒙版在最上）改变。
    const { runtime, adapter, cleanup } = makeRuntime()
    try {
      await runtime.prewarm()
      const win = adapter.windows[0]!
      const overlay = adapter.overlays[0]!
      setWindowState(win, 'background')

      await runtime.open('https://a.example')
      await runtime.open('https://b.example')
      // 新标签 attach 会盖住蒙版；relayout 末尾的 applyOverlay 必须把蒙版抬回来
      expect(win.children.at(-1)).toBe(overlay)

      const adds = win.addCalls
      const removes = win.removeCalls
      await runtime.switchTab(1)
      win.emitResize()
      await runtime.closeTab(2)

      // 这三种路径都不该再动原生子视图（蒙版已在最上层 → raiseChildView 直接返回）
      expect(win.addCalls).toBe(adds)
      expect(win.removeCalls).toBe(removes)
      expect(win.children.at(-1)).toBe(overlay)
    } finally {
      cleanup()
    }
  })

  it('可见且持有焦点时，蒙版上锁仍然必须夺键盘（P2-7 不退化）', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    try {
      await runtime.prewarm()
      const win = adapter.windows[0]!
      const overlay = adapter.overlays[0]!
      setWindowState(win, 'attended')
      runtime.setUserControl(true, 'user')
      overlay.focus.mockClear()

      runtime.setUserControl(false, 'user')

      expect(overlay.focus).toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })

  it('用户把窗口带回前台时补做键盘上锁（否则 P2-7 会因为闸门永久失效）', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    try {
      await runtime.prewarm()
      const win = adapter.windows[0]!
      const overlay = adapter.overlays[0]!
      setWindowState(win, 'background')
      runtime.setUserControl(true, 'user')
      runtime.setUserControl(false, 'user')
      overlay.focus.mockClear()

      // 用户在任务栏点回浏览器窗口：这一刻才允许夺键盘
      win.emitFocus()

      expect(overlay.focus).toHaveBeenCalledTimes(1)
    } finally {
      cleanup()
    }
  })

  it('蒙版始终留在最上层；已在最上层时不再重复 remove+add（addChildView 会抢焦点）', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    try {
      await runtime.prewarm()
      const win = adapter.windows[0]!
      const overlay = adapter.overlays[0]!
      setWindowState(win, 'attended')

      runtime.setUserControl(true, 'user')
      runtime.setUserControl(false, 'user')

      expect(win.children.at(-1)).toBe(overlay)
      const adds = win.addCalls
      const removes = win.removeCalls
      runtime.setUserControl(true, 'user')
      runtime.setUserControl(false, 'user')
      // 第二轮：蒙版已经在最上层 → 不得再触碰原生子视图顺序
      // （addChildView 会抢焦点，这正是"窗口自己弹回来"的第二条路径）
      expect(win.children.at(-1)).toBe(overlay)
      expect(win.addCalls).toBe(adds)
      expect(win.removeCalls).toBe(removes)
    } finally {
      cleanup()
    }
  })

  it('raiseChildView：最上层不动原生子视图，否则 remove+add', () => {
    const view = { id: 'view' }
    const other = { id: 'other' }
    const children: unknown[] = [other, view]
    const addChildView = vi.fn((v: unknown) => { children.push(v) })
    const removeChildView = vi.fn((v: unknown) => {
      const idx = children.indexOf(v)
      if (idx >= 0) children.splice(idx, 1)
    })
    const win = { contentView: { addChildView, removeChildView, children } } as never

    raiseChildView(win, view)
    expect(addChildView).not.toHaveBeenCalled()
    expect(removeChildView).not.toHaveBeenCalled()

    raiseChildView(win, other)
    expect(removeChildView).toHaveBeenCalledWith(other)
    expect(addChildView).toHaveBeenCalledWith(other)
    expect(children.at(-1)).toBe(other)

    // children 不可得时退回无条件重排（只浪费、不错序）
    const blind = { contentView: { addChildView, removeChildView } } as never
    raiseChildView(blind, view)
    expect(addChildView).toHaveBeenLastCalledWith(view)
  })
})
