import { describe, expect, it } from 'vitest'
import type { ElectronModuleLike } from '../src/electron-adapter.ts'
import { createRealElectronAdapter } from '../src/electron-adapter.ts'

/** Captured Electron constructor options + window event handlers. */
const captured: Array<{ kind: string; options: Record<string, unknown> }> = []
const closeHandlers: Array<(event: { preventDefault: () => void }) => void> = []
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
    contentView = { addChildView: () => {}, removeChildView: () => {} }
    constructor(options: Record<string, unknown>) { captured.push({ kind: 'window', options }) }
    setMenuBarVisibility(): void {}
    on(event: string, handler: (event: { preventDefault: () => void }) => void): void {
      if (event === 'close') closeHandlers.push(handler)
    }
    show(): void {}
    hide(): void { hidden.push(true) }
    focus(): void {}
    isDestroyed(): boolean { return false }
    isVisible(): boolean { return false }
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
})
