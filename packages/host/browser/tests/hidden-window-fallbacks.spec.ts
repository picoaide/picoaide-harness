/**
 * 隐藏窗口下的工具兜底（2026-09-12，真机报告驱动）。
 *
 * 背景：浏览器窗口按产品决策（2026-09-08）**创建即隐藏**——agent 路径绝不弹窗。
 * 但隐藏窗口**没有 viz surface**，于是两条原本"看着成功"的能力实际失效：
 *
 * 1. `browser_click` 走 CDP `Input.dispatchMouseEvent`，需要 input-visible 的
 *    RenderWidgetHost；隐藏窗口下协议层接受、页面收不到 → 工具返回 "Click." 但
 *    链接不跳转、Submit 不提交（真机报告：fill_form / select / upload_file 正常，
 *    因为它们走 DOM 路径）。
 * 2. `browser_screenshot` 走 `webContents.capturePage()`，失败信息是
 *    `Current display surface not available for capture / UnknownVizError`。
 *
 * 本 spec 锁住兜底语义：**窗口能收输入就用真输入，收不到就退到 DOM 激活**；
 * 截图先试 `capturePage`，失败再走 CDP `fromSurface:false`（渲染器侧合成，
 * 这正是 headless 抓帧的方式），两条都失败时**两条原因都要报出来**。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import type { ElectronAdapter, NativeBounds, NativeImage, NativeSession, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

// ------------------------------------------------------------------ mocks

class MockTransport implements CdpTransport {
  attached = false
  commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  handler: (method: string, params?: Record<string, unknown>) => unknown = () => ({})
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  async sendCommand(method: string, params?: Record<string, unknown>) {
    this.commands.push({ method, params })
    return this.handler(method, params)
  }
  on(): unknown { return this }
  removeListener(): unknown { return this }
}

class MockSession implements NativeSession {
  partition = 'persist:agent-browser-test'
  clearStorageData = vi.fn(async () => {})
  clearCache = vi.fn(async () => {})
  setPermissionRequestHandler = vi.fn()
  setPermissionCheckHandler = vi.fn()
  on(): void {}
  removeListener(): void {}
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
  destroyed = false
  partition = 'persist:agent-browser-test'
  image: NativeImage | null = fakeImage(100, 100)
  captureError: Error | null = null
  loadURL = vi.fn(async (u: string) => { this.url = u; this.emit('did-stop-loading') })
  downloadURL = vi.fn()
  goBack = vi.fn(() => { this.emit('did-finish-load') })
  goForward = vi.fn(() => { this.emit('did-finish-load') })
  reload = vi.fn(() => { this.emit('did-finish-load') })
  capturePage = vi.fn(async () => {
    if (this.captureError !== null) throw this.captureError
    return this.image
  })
  setWindowOpenHandler = vi.fn()
  attach(_win: unknown, bounds: NativeBounds): void { this.attached = true; this.bounds = bounds }
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
      isLoading: () => false,
      on: (e: string, l: (...a: unknown[]) => void) => {
        this.listeners.set(e, [...(this.listeners.get(e) ?? []), l])
      },
      removeListener: (e: string, l: (...a: unknown[]) => void) => {
        this.listeners.set(e, (this.listeners.get(e) ?? []).filter((x) => x !== l))
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
  lastWindow(): { visible: boolean; destroyed: boolean } { return this.windows.at(-1)! }
}

function makeRuntime(): { runtime: BrowserRuntime; adapter: MockAdapter; dir: string } {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.hidden-store-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(adapter as never, {}, undefined, undefined, { store })
  return { runtime, adapter, dir }
}

afterEach(() => {
  const dir = join(process.cwd(), 'tests')
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.hidden-store')) rmSync(join(dir, name), { recursive: true, force: true })
    }
  } catch { /* best effort */ }
})

// ------------------------------------------------- click: DOM fallback

describe('browser_click 在隐藏窗口下退到 DOM 激活', () => {
  it('窗口隐藏时不发真输入，改走 elementFromPoint 事件序列', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    expect(adapter.lastWindow().visible, '前置条件：窗口是隐藏的').toBe(false)
    view.transport.handler = (method) => (method === 'Runtime.evaluate' ? { result: { value: 'element' } } : {})

    await runtime.clickAt(1, { x: 120, y: 340 })

    const methods = view.transport.commands.map((c) => c.method)
    expect(methods).not.toContain('Input.dispatchMouseEvent')
    const evaluate = view.transport.commands.find((c) => c.method === 'Runtime.evaluate')
    expect(String(evaluate?.params?.expression)).toContain('elementFromPoint')
    const op = runtime.opLog.find((entry) => entry.tool === 'browser_click')
    expect(op?.failed).toBeFalsy()
    expect(op?.summary).toContain('via DOM dispatch')
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })

  it('窗口可见时仍然用 CDP 真输入', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    adapter.lastWindow().visible = true
    const view = adapter.lastView()

    await runtime.clickAt(1, { x: 10, y: 20 })

    const methods = view.transport.commands.map((c) => c.method)
    expect(methods.filter((m) => m === 'Input.dispatchMouseEvent')).toHaveLength(2)
    expect(methods).not.toContain('Runtime.evaluate')
    expect(runtime.opLog.find((entry) => entry.tool === 'browser_click')?.summary).toContain('click at (10, 20)')
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })

  it('点上没有任何元素时不再"假成功"，报 not-found 并记失败', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    adapter.lastView().transport.handler = (method) => (method === 'Runtime.evaluate' ? { result: { value: 'none' } } : {})

    await expect(runtime.clickAt(1, { x: 5, y: 5 })).rejects.toThrow(/nothing to click/u)
    expect(runtime.opLog.find((entry) => entry.tool === 'browser_click')?.failed).toBe(true)
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })
})

// --------------------------------------- press / type: same input-domain rule

describe('browser_press 与 browser_type 在隐藏窗口下同样兜底', () => {
  it('press：窗口隐藏时不发键盘输入，改走 DOM 派发并显式处理回车提交', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    let expression = ''
    view.transport.handler = (method, params) => {
      if (method === 'Runtime.evaluate') {
        expression = String(params?.expression)
        return { result: { value: 'submitted-form' } }
      }
      return {}
    }

    await runtime.pressKey(1, 'Enter')

    expect(view.transport.commands.map((c) => c.method)).not.toContain('Input.dispatchKeyEvent')
    expect(expression).toContain('KeyboardEvent')
    expect(expression, '合成键盘事件不会触发表单隐式提交，必须显式补').toContain('requestSubmit')
    const op = runtime.opLog.find((entry) => entry.tool === 'browser_press')
    expect(op?.failed).toBeFalsy()
    expect(op?.summary).toContain('via DOM dispatch')
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })

  it('press：窗口可见时仍然用 CDP 键盘事件', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    adapter.lastWindow().visible = true
    const view = adapter.lastView()

    await runtime.pressKey(1, 'Enter')

    const methods = view.transport.commands.map((c) => c.method)
    expect(methods.filter((m) => m === 'Input.dispatchKeyEvent')).toHaveLength(2)
    expect(methods).not.toContain('Runtime.evaluate')
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })

  it('type：CDP 写入没生效（隐藏窗口）时退到 DOM 写入并记日志', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    let field = ''
    const expressions: string[] = []
    view.transport.handler = (method, params) => {
      if (method === 'Input.insertText') return {} // 送达失败：字段不变
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression)
        expressions.push(expression)
        if (expression.includes('execCommand')) { field = 'dsh-tool-probe'; return { result: { value: 'typed' } } }
        if (expression.includes('el.value')) return { result: { value: field } }
        return { result: { value: {} } }
      }
      return {}
    }

    await runtime.typeInto(1, '#my-text', 'dsh-tool-probe')

    expect(field).toBe('dsh-tool-probe')
    expect(expressions.some((e) => e.includes('execCommand'))).toBe(true)
    const op = runtime.opLog.find((entry) => entry.tool === 'browser_type')
    expect(op?.failed).toBeFalsy()
    expect(op?.summary).toContain('via DOM write')
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })

  it('type：CDP 写入生效时不做 DOM 兜底（优先真输入）', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    let field = ''
    const expressions: string[] = []
    view.transport.handler = (method, params) => {
      if (method === 'Input.insertText') { field = String((params as { text?: string }).text ?? ''); return {} }
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression)
        expressions.push(expression)
        if (expression.includes('el.value')) return { result: { value: field } }
        return { result: { value: {} } }
      }
      return {}
    }

    await runtime.typeInto(1, '#my-text', 'typed-by-cdp')

    expect(field).toBe('typed-by-cdp')
    expect(expressions.some((e) => e.includes('execCommand'))).toBe(false)
    expect(runtime.opLog.find((entry) => entry.tool === 'browser_type')?.summary).not.toContain('via DOM write')
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })
})

// --------------------------------------------- screenshot: CDP fallback

describe('browser_screenshot 在无渲染表面时退到 CDP fromSurface:false', () => {
  it('capturePage 报 display surface 错误时改走渲染器侧抓帧', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.captureError = new Error('Current display surface not available for capture')
    const png = Buffer.from('renderer-frame').toString('base64')
    view.transport.handler = (method) => {
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } }
      if (method === 'Page.captureScreenshot') return { data: png }
      return {}
    }

    await expect(runtime.screenshot(1)).resolves.toBe(`data:image/jpeg;base64,${png}`)

    const capture = view.transport.commands.find((c) => c.method === 'Page.captureScreenshot')
    expect(capture?.params?.fromSurface).toBe(false)
    expect(capture?.params?.format).toBe('jpeg')
    const ops = runtime.opLog.filter((entry) => entry.tool === 'browser_screenshot')
    expect(ops.some((entry) => entry.summary.includes('CDP fromSurface:false')), '兜底路径必须留在操作日志里').toBe(true)
    expect(ops.every((entry) => !entry.failed)).toBe(true)
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })

  it('页面比 maxWidth 宽时用 clip.scale 等比缩到上限', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.captureError = new Error('no surface')
    view.transport.handler = (method) => {
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 2560, clientHeight: 1440 } }
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('x').toString('base64') }
      return {}
    }

    await runtime.screenshot(1)

    const clip = view.transport.commands.find((c) => c.method === 'Page.captureScreenshot')?.params?.clip as { scale?: number } | undefined
    expect(clip?.scale).toBeCloseTo(1280 / 2560, 5)
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })

  it('两条路都失败时两条原因都报出来（P2-31 的 "empty image" 不能被吞掉）', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.image = fakeImage(0, 0)
    view.transport.handler = (method) => (method === 'Page.getLayoutMetrics' ? { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } } : {})

    await expect(runtime.screenshot(1)).rejects.toThrow(/empty image/u)
    await expect(runtime.screenshot(1)).rejects.toThrow(/renderer-side fallback/u)
    expect(runtime.opLog.find((entry) => entry.tool === 'browser_screenshot')?.failed).toBe(true)
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })
})
