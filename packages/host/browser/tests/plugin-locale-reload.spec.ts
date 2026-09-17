/**
 * 2026-09-17 审计 S03-02 回归：`pico/locale-changed` → `reloadChromePages()` 的
 * **接线**此前零覆盖。
 *
 * 生产代码只有一句 `ctx.on('pico/locale-changed', () => { runtime.reloadChromePages() })`
 * （src/index.ts），而唯一的既有用例（audit-r9-chrome-locale.spec.ts）直接调方法 ——
 * 删掉这行注册，整包测试仍全绿，于是"用户在设置里切语言 → 已开着的浏览器窗口
 * 继续用旧语言"这个原始缺陷可以静默回归。
 *
 * 这里按真实路径跑：真的 `apply()` + 假 ctx（捕获事件监听器与注册的工具）+ mock 的
 * Electron 适配器（观察两个 chrome 视图的 loadURL）。断言：
 *   1. 插件确实注册了 `pico/locale-changed`；
 *   2. 事件真的让 shell 页与 overlay 页各重新 loadURL 一次（历史先清空，否则会被
 *      创建期那次同参数调用满足 —— 正是 S03-01 的恒真形态）；
 *   3. 标签页视图一个都不碰（用户的浏览会话必须活着）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAdapter, NativeBounds, NativeSession, NativeView } from '../src/electron-adapter.ts'

/** 由 mock 工厂读取的适配器句柄（vi.mock 是提升的，只能用 vi.hoisted 共享状态）。 */
const holder = vi.hoisted(() => ({ adapter: undefined as unknown }))

vi.mock('../src/electron-adapter.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/electron-adapter.ts')>('../src/electron-adapter.ts')
  // 只换掉真 Electron 适配器：`browserPartitionFor` 等纯函数保持真实现。
  return { ...actual, createRealElectronAdapter: () => holder.adapter }
})

import { apply } from '../src/index.ts'

const SHELL_ORIGIN = 'http://127.0.0.1:3080'

class MockSession implements NativeSession {
  partition = 'persist:locale-reload'
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
  partition = 'persist:locale-reload'
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
  createView(): NativeView { const view = new MockView(); this.tabs.push(view); return view as unknown as NativeView }
  createMaskView(): NativeView { const view = new MockView(); this.overlays.push(view); return view as unknown as NativeView }
  createBrowserWindow(): never {
    return {
      loadURL: async (url: string) => { this.windowLoads.push(url) },
      show: () => {}, hide: () => {}, focus: () => {},
      isVisible: () => false, isDestroyed: () => false,
      close: () => {},
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

interface Route { kind: 'exact' | 'prefix', path: string, handler: (...args: never[]) => unknown }
interface ToolDefinition { name: string, execute: (args: unknown, exec: unknown) => Promise<unknown> }

let home: string
let adapter: MockAdapter
let listeners: Map<string, Array<(...args: unknown[]) => void>>
let tools: Map<string, ToolDefinition>
const disposers: Array<() => void> = []

function harness(): Record<string, unknown> {
  listeners = new Map()
  tools = new Map()
  adapter = new MockAdapter()
  holder.adapter = adapter
  return {
    get: (name: string) => {
      if (name === 'picoSession') return { getSession: () => null }
      if (name === 'desktopRuntime') return { locale: 'zh' }
      return undefined
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {}
    },
    effect: (fn: () => unknown) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
      return () => {}
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tools: { register: (definition: ToolDefinition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    systemPrompt: { section: () => () => {} },
    webServer: { port: 3080, register: (_route: Route) => () => {} },
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'browser-locale-reload-'))
  process.env.DSH_HOME = home
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) { try { dispose() } catch { /* already disposed */ } }
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

/** Boot prewarm is asynchronous (the plugin awaits the session-restore probe). */
async function waitForWindow(): Promise<void> {
  const deadline = Date.now() + 5_000
  while ((adapter.overlays.length === 0 || adapter.windowLoads.length === 0) && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
  expect(adapter.windowLoads).toContain(`${SHELL_ORIGIN}/browser-shell`)
  expect(adapter.overlays).toHaveLength(1)
}

describe('pico/locale-changed 接线（2026-09-17 审计 S03-02）', () => {
  it('事件真的重新服务两个 chrome 页，且不碰标签页视图', async () => {
    apply(harness() as never, {})

    const reloads = listeners.get('pico/locale-changed') ?? []
    expect(reloads, 'apply() 必须注册 pico/locale-changed 监听').toHaveLength(1)

    await waitForWindow()
    // 开一个标签页：chrome 重载时它的视图一个字节都不能动。
    await tools.get('browser_open')!.execute(
      { url: 'https://example.test/page' },
      { signal: new AbortController().signal, agent: undefined },
    )
    const tabView = adapter.tabs.at(-1)!
    const overlayView = adapter.overlays.at(-1)!
    expect(tabView.loadURL).toHaveBeenCalled()

    // 先清空三条历史：创建期的调用参数与重载完全相同，不清就是恒真断言（S03-01）。
    adapter.windowLoads.length = 0
    overlayView.loadURL.mockClear()
    tabView.loadURL.mockClear()

    for (const listener of reloads) listener('en')
    // loadURL is fire-and-forget in the reload path (errors are logged).
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect(adapter.windowLoads).toEqual([`${SHELL_ORIGIN}/browser-shell`])
    expect(overlayView.loadURL).toHaveBeenCalledTimes(1)
    expect(overlayView.loadURL).toHaveBeenCalledWith(`${SHELL_ORIGIN}/browser-overlay`)
    for (const view of adapter.tabs) expect(view.loadURL).not.toHaveBeenCalled()
  })
})
