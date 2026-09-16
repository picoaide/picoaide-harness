/**
 * 2026-09-16 R9 审计回归：语言切换后 chrome 页必须重新服务。
 *
 * 两个 chrome 页（`/browser-shell` 工具栏、`/browser-overlay` 蒙版）是**按请求**
 * 渲染的，窗口一旦创建（含开机 prewarm 的隐藏窗口）就再也不会请求第二次 ——
 * 用户在设置里切语言后，整个 chrome（工具栏 tooltip、胶囊、活动面板、⋮ 菜单、
 * 查看器、时间格式）会停在旧语言，而原生窗口标题是按现算的 ⇒ 一窗两语。
 *
 * 本用例钉住 `reloadChromePages()` 的语义：
 *   1. shell 页与 overlay 页都被重新 loadURL；
 *   2. **标签页视图一律不碰**（用户的浏览会话、登录态必须活着）；
 *   3. 没有窗口/没有 overlay 时是安全 no-op。
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import type { ElectronAdapter, NativeBounds, NativeSession, NativeView } from '../src/electron-adapter.ts'

const SHELL_ORIGIN = 'http://127.0.0.1:45999'

class MockSession implements NativeSession {
  partition = 'persist:r9-chrome'
  clearStorageData = vi.fn(async () => {})
  clearCache = vi.fn(async () => {})
  setPermissionRequestHandler = vi.fn()
  setPermissionCheckHandler = vi.fn()
  on(): void {}
  removeListener(): void {}
}

class MockView {
  loadURL = vi.fn(async (_url: string) => {})
  attach = vi.fn((_win: unknown, _bounds: NativeBounds) => {})
  setBounds = vi.fn((_bounds: NativeBounds) => {})
  setVisible = vi.fn((_visible: boolean) => {})
  detach = vi.fn()
  moveToTop = vi.fn()
  destroy = vi.fn()
  url = ''
  title = ''
  session = new MockSession()
  private readonly cdpAttached = { value: false }
  get webContents(): never {
    return {
      cdp: {
        attach: () => { this.cdpAttached.value = true },
        detach: () => { this.cdpAttached.value = false },
        isAttached: () => this.cdpAttached.value,
        sendCommand: async () => ({}),
        on: () => {},
        removeListener: () => {},
      },
      loadURL: this.loadURL,
      downloadURL: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      reload: vi.fn(),
      capturePage: vi.fn(async () => ({ getSize: () => ({ width: 1, height: 1 }), resize: () => null, toJPEG: () => Buffer.from('') })),
      getURL: () => this.url,
      getTitle: () => this.title,
      isLoading: () => false,
      on: () => {},
      removeListener: () => {},
      session: this.session,
      setWindowOpenHandler: vi.fn(),
      close: () => {},
      isDestroyed: () => false,
    } as never
  }
}

class MockAdapter implements ElectronAdapter {
  tabs: MockView[] = []
  overlays: MockView[] = []
  windowLoads: string[] = []
  windowCreated = false
  createView(): NativeView { const view = new MockView(); this.tabs.push(view); return view as unknown as NativeView }
  createMaskView(): NativeView { const view = new MockView(); this.overlays.push(view); return view as unknown as NativeView }
  createBrowserWindow(): never {
    this.windowCreated = true
    return {
      loadURL: async (url: string) => { this.windowLoads.push(url) },
      show: () => {}, hide: () => {}, focus: () => {},
      isVisible: () => true, isDestroyed: () => false,
      close: () => { this.windowCreated = false },
      setTitle: () => {},
      getContentSize: () => ({ width: 1100, height: 780 }),
      contentView: { addChildView: () => {}, removeChildView: () => {} },
      onResize: () => () => {},
      onClosed: () => () => {},
      focusPage: () => {},
    } as never
  }
  getSession(): NativeSession { return new MockSession() }
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeRuntime(): { runtime: BrowserRuntime; adapter: MockAdapter } {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.r9-chrome-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  const runtime = new BrowserRuntime(adapter as never, {}, undefined, undefined, { store: new BrowserStore({ dir }) })
  runtime.setShellOrigin(SHELL_ORIGIN)
  return { runtime, adapter }
}

describe('语言切换后重新服务 chrome 页', () => {
  it('reloads both chrome pages and leaves tab views alone', async () => {
    const { runtime, adapter } = makeRuntime()
    await runtime.ensureWindow(SHELL_ORIGIN, false)
    // Open a tab as well: its view must survive the chrome reload.
    await runtime.open(`${SHELL_ORIGIN}/blank`)
    const tabView = adapter.tabs.at(-1)!
    expect(adapter.windowLoads).toEqual([`${SHELL_ORIGIN}/browser-shell`])
    expect(adapter.overlays.at(-1)!.loadURL).toHaveBeenCalledWith(`${SHELL_ORIGIN}/browser-overlay`)
    tabView.loadURL.mockClear()
    adapter.windowLoads.length = 0

    runtime.reloadChromePages()
    // loadURL is fire-and-forget in the reload path (errors are logged).
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(adapter.windowLoads).toEqual([`${SHELL_ORIGIN}/browser-shell`])
    expect(adapter.overlays.at(-1)!.loadURL).toHaveBeenCalledWith(`${SHELL_ORIGIN}/browser-overlay`)
    expect(tabView.loadURL).not.toHaveBeenCalled()
  })

  it('is a no-op before the window exists', () => {
    const { runtime, adapter } = makeRuntime()
    runtime.reloadChromePages()
    expect(adapter.windowLoads).toEqual([])
    expect(adapter.overlays).toHaveLength(0)
  })
})
