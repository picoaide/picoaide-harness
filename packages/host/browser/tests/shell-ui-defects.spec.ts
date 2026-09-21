/**
 * 内置浏览器**壳层 UI** 六条缺陷里"只能在 runtime/adapter 侧判定"的那几条
 * （2026-09-21）。页面侧（jsdom 真按键/真渲染）的判据在
 * `shell-pages.behavior.spec.ts`，本文件钉的是"发给视图/事件总线的确切值"：
 *
 *  - 缺陷 #2 的**前提**：空闲态蒙版铺满整窗（含工具栏）⇒ 空态文案不得指向工具栏
 *    上的 ＋；这条前提一旦变化（蒙版让开工具栏），文案的取舍就要重新审。
 *  - 缺陷 #3：活动面板的确切 bounds 必须从工具条下沿开始（否则盖住 ＋ 与 ⋮）。
 *  - 缺陷 #4：回到 capsule 时除 focusPage() 之外还必须补发 `focus-addr` 信号
 *    （shell 页据此把光标放进 #addr），且沿用 2026-09-17 的 windowAttended 闸门。
 *  - 缺陷 #5c：活动面板的 op summary 走 hostCopy —— 中英都出，且**按调用求值**
 *    （同一实例先 zh 后 en 无需重新 apply）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { HostLocale } from '@picoaide/dsh-host-locale'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import { raiseChildView, type ElectronAdapter, type NativeBounds, type NativeSession, type NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

const CONTENT = { width: 1100, height: 780 }
const TOOLBAR = 66

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
  partition = 'persist:agent-browser-shell-ui'
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
  partition = 'persist:agent-browser-shell-ui'
  destroyed = false
  focus = vi.fn()
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
    win.contentView.addChildView(this)
  }
  setBounds(b: NativeBounds): void { this.bounds = b }
  setVisible(v: boolean): void { this.visible = v }
  detach(): void { this.attached = false }
  moveToTop(win: { contentView: { addChildView: (v: unknown) => void; removeChildView: (v: unknown) => void; children?: readonly unknown[] } }): void {
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
      stop: () => {},
    } as never
  }
}

class MockWindow {
  children: unknown[] = []
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
  getContentSize(): { width: number; height: number } { return { ...CONTENT } }
  contentView: {
    addChildView: (view: unknown) => void
    removeChildView: (view: unknown) => void
    readonly children?: readonly unknown[]
  }
  constructor() {
    const self = this
    this.contentView = {
      addChildView: (view: unknown) => { self.children.push(view) },
      removeChildView: (view: unknown) => {
        const idx = self.children.indexOf(view)
        if (idx >= 0) self.children.splice(idx, 1)
      },
      get children(): readonly unknown[] { return self.children },
    }
  }
  onResize(listener: () => void): () => void { this.resize.add(listener); return () => { this.resize.delete(listener) } }
  onClosed(listener: () => void): () => void { this.closed.add(listener); return () => { this.closed.delete(listener) } }
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

const storeDirs: string[] = []

function makeRuntime(locale?: () => HostLocale): { runtime: BrowserRuntime; adapter: MockAdapter } {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.shell-ui-store-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  storeDirs.push(dir)
  const runtime = new BrowserRuntime(adapter as never, {}, undefined, undefined, {
    store: new BrowserStore({ dir }),
    ...(locale === undefined ? {} : { locale }),
  })
  return { runtime, adapter }
}

afterEach(() => {
  for (const dir of storeDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  const tests = join(process.cwd(), 'tests')
  try {
    for (const name of readdirSync(tests)) {
      if (name.startsWith('.shell-ui-store')) rmSync(join(tests, name), { recursive: true, force: true })
    }
  } catch { /* best effort */ }
})

function attend(win: MockWindow): void { win.visible = true; win.minimized = false; win.focused = true }

// ------------------------------------------------------------------ #2

describe('空闲态蒙版的形状（缺陷 #2 的前提）', () => {
  it('蒙版仍是整窗 bounds —— 工具栏被完全盖住，所以空态文案不能指向 ＋', async () => {
    const { runtime, adapter } = makeRuntime()
    await runtime.prewarm()
    const win = adapter.windows[0]!
    const overlay = adapter.overlays[0]!
    attend(win)

    // 未接管 ⇒ 生效蒙版 = mask（2026-09-11 A 方案：整窗上锁，唯一入口是 pill）。
    runtime.setUserControl(false, 'user')
    expect(runtime.shellState().ui.mode).toBe('mask')
    expect(overlay.bounds).toEqual({ x: 0, y: 0, width: CONTENT.width, height: CONTENT.height })
    await runtime.dispose()
  })
})

// ------------------------------------------------------------------ #3

describe('活动面板不得盖住工具栏（缺陷 #3）', () => {
  it('panel bounds 从工具条下沿开始（＋ 与 ⋮ 仍可点）', async () => {
    const { runtime, adapter } = makeRuntime()
    await runtime.prewarm()
    const win = adapter.windows[0]!
    const overlay = adapter.overlays[0]!
    attend(win)
    runtime.setUserControl(true, 'user')
    runtime.setOverlayMode('panel')

    // 旧实现在这里给 { y: 0, height: 780 }：面板宽 340 且贴右缘 ⇒ 正好盖住
    // 工具栏右端的 ＋（新建标签）与 ⋮（更多）。
    expect(overlay.bounds).toEqual({
      x: CONTENT.width - 340,
      y: TOOLBAR,
      width: 340,
      height: CONTENT.height - TOOLBAR,
    })
    // 底部仍贴到窗口下沿：面板没有被"整体上移"，只是不侵占工具条。
    expect(overlay.bounds.y + overlay.bounds.height).toBe(CONTENT.height)
    await runtime.dispose()
  })
})

// ------------------------------------------------------------------ #7

describe('胶囊态的失败提示矩形（缺陷 #7）', () => {
  /** 紧凑胶囊的精确 bounds（右下角 16px 边距、172×34）。 */
  const COMPACT = { x: CONTENT.width - 188, y: CONTENT.height - 50, width: 172, height: 34 }
  /** 提示矩形：同一个右下角锚点，放大到放得下 3 行 toast。 */
  const NOTICE = { x: CONTENT.width - 16 - 300, y: CONTENT.height - 16 - 116, width: 300, height: 116 }

  it('提示期间临时放大，收起后精确还原（右下角锚点与边距不变）', async () => {
    const { runtime, adapter } = makeRuntime()
    await runtime.prewarm()
    const win = adapter.windows[0]!
    const overlay = adapter.overlays[0]!
    attend(win)
    runtime.setUserControl(true, 'user')
    expect(overlay.bounds).toEqual(COMPACT)

    // 页面弹失败 toast ⇒ 请求放大（172×34 的视图装不下 position:fixed 的 toast）。
    runtime.setOverlayNotice(true)
    expect(overlay.bounds).toEqual(NOTICE)
    // 锚点不变：右下角仍在同一像素上 ⇒ 胶囊（由页面 CSS 锚在视图底部）不动。
    expect(NOTICE.x + NOTICE.width).toBe(COMPACT.x + COMPACT.width)
    expect(NOTICE.y + NOTICE.height).toBe(COMPACT.y + COMPACT.height)

    runtime.setOverlayNotice(false)
    expect(overlay.bounds).toEqual(COMPACT)
    await runtime.dispose()
  })

  it('模式切换 / 控制权变化立即归还（不留右下角死区）', async () => {
    const { runtime, adapter } = makeRuntime()
    await runtime.prewarm()
    const win = adapter.windows[0]!
    const overlay = adapter.overlays[0]!
    attend(win)
    runtime.setUserControl(true, 'user')

    runtime.setOverlayNotice(true)
    runtime.setOverlayMode('panel')
    runtime.setOverlayMode('capsule')
    expect(overlay.bounds).toEqual(COMPACT)

    runtime.setOverlayNotice(true)
    runtime.setUserControl(false, 'user')
    expect(overlay.bounds).not.toEqual(NOTICE) // mask = 整窗
    runtime.setUserControl(true, 'user')
    expect(overlay.bounds).toEqual(COMPACT)
    await runtime.dispose()
  })

  it('兜底超时：页面没回报收起（重载/崩溃）时自动归还', async () => {
    const { runtime, adapter } = makeRuntime()
    await runtime.prewarm()
    const win = adapter.windows[0]!
    const overlay = adapter.overlays[0]!
    attend(win)
    runtime.setUserControl(true, 'user')

    vi.useFakeTimers()
    try {
      runtime.setOverlayNotice(true)
      expect(overlay.bounds).toEqual(NOTICE)
      vi.advanceTimersByTime(6_000)
      expect(overlay.bounds).toEqual(COMPACT)
    } finally {
      vi.useRealTimers()
    }
    await runtime.dispose()
  })

  it('页面重载（语言切换）时归还：新页面不会回报上一个 toast 的收起', async () => {
    const { runtime, adapter } = makeRuntime()
    await runtime.prewarm()
    const win = adapter.windows[0]!
    const overlay = adapter.overlays[0]!
    attend(win)
    runtime.setUserControl(true, 'user')
    runtime.setShellOrigin('http://127.0.0.1:45999')

    runtime.setOverlayNotice(true)
    expect(overlay.bounds).toEqual(NOTICE)
    runtime.reloadChromePages()
    expect(overlay.bounds).toEqual(COMPACT)
    await runtime.dispose()
  })
})

// ------------------------------------------------------------------ #4

describe('Ctrl+L：回到 capsule 必须补发 focus-addr（缺陷 #4）', () => {
  it('前台 + 用户持控制权：focusPage 之后发一条 focus-addr', async () => {
    const { runtime, adapter } = makeRuntime()
    await runtime.prewarm()
    const win = adapter.windows[0]!
    attend(win)
    runtime.setUserControl(true, 'user')

    const events: string[] = []
    runtime.onAny((event) => events.push(event))
    win.focusPage.mockClear()

    // 页面真实路径：Ctrl+L 在 overlay 页里被消费 → POST overlay{mode:capsule}。
    runtime.setOverlayMode('menu')
    runtime.setOverlayMode('capsule')

    expect(win.focusPage).toHaveBeenCalledTimes(1)
    // 只把**原生**焦点还给 shell 文档不够：它的 activeElement 还是 body，地址栏
    // 拿不到光标（这就是"Ctrl+L 要按两次"）。信号必须一起发出去。
    expect(events.filter((e) => e === 'focus-addr')).toHaveLength(1)
    await runtime.dispose()
  })

  it('窗口不在前台（切走/最小化）：沿用 2026-09-17 的闸门，不发信号也不抢焦点', async () => {
    const { runtime, adapter } = makeRuntime()
    await runtime.prewarm()
    const win = adapter.windows[0]!
    attend(win)
    runtime.setUserControl(true, 'user')
    win.visible = false
    win.focused = false

    const events: string[] = []
    runtime.onAny((event) => events.push(event))
    win.focusPage.mockClear()

    runtime.setOverlayMode('menu')
    runtime.setOverlayMode('capsule')

    expect(win.focusPage).not.toHaveBeenCalled()
    expect(events).not.toContain('focus-addr')
    await runtime.dispose()
  })

  it('蒙版态（用户没接管）：地址栏本来就不可用，不发信号', async () => {
    const { runtime, adapter } = makeRuntime()
    await runtime.prewarm()
    const win = adapter.windows[0]!
    attend(win)
    runtime.setUserControl(false, 'user')

    const events: string[] = []
    runtime.onAny((event) => events.push(event))

    // 蒙版下 Esc 也会 POST overlay{mode:capsule}（关浮层，不改控制权）。
    runtime.setOverlayMode('capsule')

    expect(events).not.toContain('focus-addr')
    await runtime.dispose()
  })
})

// ------------------------------------------------------------------ #5c

describe('活动面板 summary 的语言（缺陷 #5c）', () => {
  /** 打开两个标签并按 zh/en 各跑一遍最常见的四类 op。 */
  async function runOps(locale: () => HostLocale): Promise<Map<string, string>> {
    const { runtime, adapter } = makeRuntime(locale)
    await runtime.prewarm()
    await runtime.open('https://a.example/one')
    const first = runtime.currentTabId()!
    await runtime.navigate(first, 'https://b.example/two')
    await runtime.open('https://c.example/three')
    await runtime.switchTab(first, true)

    // 页面自己发起的导航（will-navigate）落在**本机目标**上 ⇒ 记一条拒绝。
    const view = adapter.views.at(-1)!
    let prevented = false
    view.emit('will-navigate', { preventDefault: () => { prevented = true } }, 'http://127.0.0.1:1/api/pico/browser/state')
    expect(prevented).toBe(true)

    runtime.setUserControl(true, 'user')
    runtime.setUserControl(false, 'user')

    const summaries = new Map<string, string[]>()
    // opLog 是**最新在前**：按时间正序建表（`open(url)` 自己也会记一条
    // browser_navigate —— 它内部走 navigateInternal）。
    for (const op of [...runtime.opLog].reverse()) {
      const key = op.tool + (op.failed ? ':failed' : '')
      summaries.set(key, [...(summaries.get(key) ?? []), op.summary])
    }
    await runtime.dispose()
    return summaries
  }

  it('中文：打开网页 / 切换标签页 / 交给用户 / 导航被拒 全部出中文', async () => {
    const zh = await runOps(() => 'zh')
    expect(zh.get('browser_navigate')).toEqual([
      '打开网页：https://a.example/one',
      '打开网页：https://b.example/two',
      '打开网页：https://c.example/three',
    ])
    expect(zh.get('browser_switch_tab')).toEqual(['切换标签页：1'])
    expect(zh.get('browser_takeover')).toEqual(['用户接管了浏览器'])
    expect(zh.get('browser_release')).toEqual(['用户交还了浏览器控制权'])
    expect(zh.get('navigate:failed')).toEqual(['导航被拒（本机目标，http://127.0.0.1:1/api/pico/browser/state）'])
  })

  it('英文：同一批 op 出英文（en 侧行为与本地化之前逐字一致）', async () => {
    const en = await runOps(() => 'en')
    expect(en.get('browser_navigate')).toEqual([
      'navigate: https://a.example/one',
      'navigate: https://b.example/two',
      'navigate: https://c.example/three',
    ])
    expect(en.get('browser_switch_tab')).toEqual(['switch to tab 1'])
    expect(en.get('browser_takeover')).toEqual(['user took over the browser'])
    expect(en.get('browser_release')).toEqual(['user released browser control'])
    expect(en.get('navigate:failed')).toEqual(['navigation denied (local target, http://127.0.0.1:1/api/pico/browser/state)'])
  })

  it('语言按**调用**解析：同一个 runtime 先 zh 后 en，无需重新 apply', async () => {
    let locale: HostLocale = 'zh'
    const { runtime } = makeRuntime(() => locale)
    await runtime.prewarm()
    await runtime.open('https://a.example/one')
    await runtime.navigate(runtime.currentTabId()!, 'https://d.example/first')
    expect(runtime.opLog[0]!.summary).toBe('打开网页：https://d.example/first')

    locale = 'en'
    await runtime.navigate(runtime.currentTabId()!, 'https://d.example/second')
    expect(runtime.opLog[0]!.summary).toBe('navigate: https://d.example/second')
    await runtime.dispose()
  })
})
