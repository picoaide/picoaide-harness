import { describe, expect, it } from 'vitest'
import type { ElectronModuleLike } from '../src/electron-adapter.ts'
import { createRealElectronAdapter } from '../src/electron-adapter.ts'

/** Captured Electron constructor options + window event handlers. */
const captured: Array<{ kind: string; options: Record<string, unknown> }> = []
const closeHandlers: Array<(event: { preventDefault: () => void }) => void> = []
const focusHandlers: Array<() => void> = []
const hidden: boolean[] = []

function makeElectron(): ElectronModuleLike {
  class FakeWebContentsView {
    webContents = {
      setWindowOpenHandler: () => {},
      session: {},
      on: () => {},
      removeListener: () => {},
      cdp: {},
      loadURL: () => Promise.resolve(),
      getURL: () => '',
      getTitle: () => '',
      isLoading: () => false,
      isDestroyed: () => false,
      close: () => {},
      capturePage: () => Promise.resolve(undefined),
    }
    constructor(options: Record<string, unknown>) { captured.push({ kind: 'view', options }) }
  }
  class FakeBrowserWindow {
    contentView = { addChildView: () => {}, removeChildView: () => {}, children: [] as unknown[] }
    constructor(options: Record<string, unknown>) { captured.push({ kind: 'window', options }) }
    setMenuBarVisibility(): void {}
    on(event: string, handler: (event: { preventDefault: () => void }) => void): void {
      if (event === 'close') closeHandlers.push(handler)
      if (event === 'focus') focusHandlers.push(handler as unknown as () => void)
    }
    removeListener(event: string, handler: (event: { preventDefault: () => void }) => void): void {
      if (event !== 'focus') return
      const idx = focusHandlers.indexOf(handler as unknown as () => void)
      if (idx >= 0) focusHandlers.splice(idx, 1)
    }
    show(): void {}
    hide(): void { hidden.push(true) }
    focus(): void {}
    isDestroyed(): boolean { return false }
    isVisible(): boolean { return false }
    isMinimized(): boolean { return false }
    isFocused(): boolean { return false }
    close(): void {}
    loadURL(): Promise<void> { return Promise.resolve() }
    setTitle(): void {}
    getContentSize(): { width: number; height: number } { return { width: 1100, height: 780 } }
  }
  return {
    WebContentsView: FakeWebContentsView,
    BrowserWindow: FakeBrowserWindow,
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    shell: { openPath: async () => '' },
  } as unknown as ElectronModuleLike
}

describe('electron adapter — 2026-09-08 browser lifecycle decisions', () => {
  it('tab views, the overlay view and the browser window disable background throttling', () => {
    captured.length = 0
    const adapter = createRealElectronAdapter(makeElectron())
    adapter.createView('persist:agent-browser')
    adapter.createMaskView('persist:agent-browser')
    adapter.createBrowserWindow()
    expect(captured).toHaveLength(3)
    for (const entry of captured) {
      const prefs = (entry.options.webPreferences ?? {}) as Record<string, unknown>
      expect(prefs.backgroundThrottling).toBe(false)
    }
  })

  it('the browser window is created hidden so boot prewarm never flashes it', () => {
    captured.length = 0
    const adapter = createRealElectronAdapter(makeElectron())
    adapter.createBrowserWindow()
    expect(captured[0]?.options.show).toBe(false)
  })

  it('a user close is intercepted into hide (background keeps running)', () => {
    captured.length = 0
    closeHandlers.length = 0
    hidden.length = 0
    const adapter = createRealElectronAdapter(makeElectron())
    adapter.createBrowserWindow()
    expect(closeHandlers).toHaveLength(1)
    let prevented = false
    closeHandlers[0]?.({ preventDefault: () => { prevented = true } })
    expect(prevented).toBe(true)
    expect(hidden).toHaveLength(1)
  })

  it('窗口暴露"是否在前台"与子视图顺序（焦点闸门与 z-order 判据的数据来源）', () => {
    captured.length = 0
    focusHandlers.length = 0
    const adapter = createRealElectronAdapter(makeElectron())
    const win = adapter.createBrowserWindow() as unknown as {
      isMinimized?: () => boolean
      isFocused?: () => boolean
      onFocus?: (listener: () => void) => () => void
      contentView: { children?: readonly unknown[] }
    }
    // 2026-09-17：这些成员在接口里是可选的（测试替身可省），但**真实适配器必须
    // 提供** —— 缺 isMinimized/isFocused 会让"不要抢前台焦点"的闸门静默失效。
    expect(typeof win.isMinimized).toBe('function')
    expect(typeof win.isFocused).toBe('function')
    expect(typeof win.onFocus).toBe('function')
    expect(win.contentView.children).toBeDefined()

    let focused = 0
    const off = win.onFocus!(() => { focused += 1 })
    focusHandlers[0]?.()
    expect(focused).toBe(1)
    off()
    expect(focusHandlers).toHaveLength(0)
  })
})
