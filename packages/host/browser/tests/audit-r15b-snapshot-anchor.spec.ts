/**
 * R15B-01（P1）回归判据：数字 target 必须锚定**模型看到的那份快照**。
 *
 * 原形态（2026-09-25 前）：`browser_click/type/select` 的数字 target 在**动作时刻**
 * 重新抽一份快照、按**位置序号**解析（`snapshot.ts` 的 `index` 就是 `out.length + 1`），
 * 而模型面文案把编号定义成"你看到的那份快照里的编号"。页面在"模型快照 → 动作"
 * 之间变过就会点到另一个元素，且工具只回 `{ok:true}`、op log 只记坐标 —— 模型与
 * 用户都拿不到证据。这是 2026-09-15 已判 P1 的"selector 三层不锚定 ⇒ 点错元素"
 * 的同族未收口面（那次只收口了选择器歧义，没收口"数字 → 元素"的重新派生）。
 *
 * 本文件钉死三条**独立的**判据，任何一条被拆掉都必须变红：
 *  1. 锚定：重渲染后仍按**模型看过的那份**清单解析（数字 = 快照里的选择器）；
 *  2. 过期即拒：页面导航走 / 该 tab 从没取过快照 ⇒ `stale-snapshot`，
 *     绝不按新页面重新解析；
 *  3. 命中身份可见：返回值 + render + op log 三处都写清"实际作用于哪个元素"。
 *
 * 反证：字符串选择器路径不受影响（原样透传、原样命中）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import { applyBrowserTools } from '../src/tools.ts'
import type { ElectronAdapter, NativeBounds, NativeSession, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

// ------------------------------------------------------------------ mocks

class MockTransport implements CdpTransport {
  attached = false
  commands: Array<{ method: string, params?: Record<string, unknown> }> = []
  handler: (method: string, params?: Record<string, unknown>) => unknown = () => ({})
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, params })
    return this.handler(method, params)
  }
  on(): unknown { return this }
  removeListener(): unknown { return this }
}

class MockSession implements NativeSession {
  partition = 'persist:agent-browser-r15b'
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
  url = ''
  title = ''
  destroyed = false
  partition = 'persist:agent-browser-r15b'
  loadURL = vi.fn(async (u: string) => { this.url = u; this.emit('did-stop-loading') })
  downloadURL = vi.fn()
  goBack = vi.fn(() => { this.emit('did-finish-load') })
  goForward = vi.fn(() => { this.emit('did-finish-load') })
  reload = vi.fn(() => { this.emit('did-finish-load') })
  capturePage = vi.fn(async () => ({ getSize: () => ({ width: 100, height: 100 }), resize: () => ({}), toJPEG: () => Buffer.from('x') }))
  setWindowOpenHandler = vi.fn()
  attach(_win: unknown, bounds: NativeBounds): void { this.attached = true; this.bounds = bounds }
  setBounds(b: NativeBounds): void { this.bounds = b }
  setVisible(v: boolean): void { this.visible = v }
  detach(): void { this.attached = false }
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
      on: (event: string, listener: (...args: unknown[]) => void) => { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]) },
      removeListener: (event: string, listener: (...args: unknown[]) => void) => {
        this.listeners.set(event, (this.listeners.get(event) ?? []).filter((entry) => entry !== listener))
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
  partitionSession = new MockSession()
  showSaveDialog = vi.fn(async () => ({ canceled: true }))
  openPath = vi.fn(async () => ({}))
  createView(): NativeView { const view = new MockView(); this.views.push(view); return view }
  createMaskView(): NativeView { const view = new MockView(); this.overlays.push(view); return view }
  createBrowserWindow(): never {
    return {
      loadURL: async () => {}, show: () => {}, hide: () => {}, focus: () => {}, isVisible: () => false, isDestroyed: () => false,
      close: () => {}, setTitle: () => {}, getContentSize: () => ({ width: 1100, height: 780 }),
      contentView: { addChildView: () => {}, removeChildView: () => {} }, onResize: () => () => {}, onClosed: () => () => {}, focusPage: () => {},
    } as never
  }
  getSession(): NativeSession { return this.partitionSession }
  lastView(): MockView { return this.views.at(-1)! }
}

// ------------------------------------------------------------------ harness

interface ToolDefinition {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string, text?: string }> }
}

interface Harness {
  runtime: BrowserRuntime
  adapter: MockAdapter
  dir: string
  tools: Map<string, ToolDefinition>
  call: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  render: (name: string, value: unknown) => string
  dispose: () => void
}

function makeHarness(credentials?: (id: string) => Promise<{ username?: string, password?: string } | null>): Harness {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.r15b-store-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(adapter as never, {}, credentials as never, undefined, { store })
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    systemPrompt: { section: () => () => {} },
  } as unknown as Parameters<typeof applyBrowserTools>[0]
  const disposeTools = applyBrowserTools(ctx, runtime)
  return {
    runtime,
    adapter,
    dir,
    tools,
    call: async (name, args = {}) => {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`tool not registered: ${name}`)
      return await tool.execute(args, { agent: undefined, signal: new AbortController().signal })
    },
    render: (name, value) => tools.get(name)!.output.render({}, value).map((part) => part.text ?? '').join('\n'),
    dispose: () => { disposeTools(); runtime.dispose() },
  }
}

const opened: Harness[] = []
function track(harness: Harness): Harness {
  opened.push(harness)
  return harness
}

afterEach(() => {
  for (const harness of opened.splice(0)) {
    try { harness.dispose() } catch { /* already disposed */ }
    rmSync(harness.dir, { recursive: true, force: true })
  }
  try {
    for (const name of readdirSync(join(process.cwd(), 'tests'))) {
      if (name.startsWith('.r15b-store')) rmSync(join(process.cwd(), 'tests', name), { recursive: true, force: true })
    }
  } catch { /* best effort */ }
})

async function fail(promise: Promise<unknown>): Promise<{ code?: string, message: string }> {
  try {
    await promise
  } catch (error) {
    return error as { code?: string, message: string }
  }
  throw new Error('expected the call to fail')
}

/** 页面里当前"被看到"的元素（探针按它渲染快照）。 */
interface PageElement { kind: string, text: string, selector: string, visible: boolean, disabled: boolean }

/**
 * 装一个会随 `page` 变的页面桩：快照探针返回 `page`，定位返回固定坐标。
 * `page` 是 getter，所以用例可以在两次调用之间"重渲染"页面。
 *
 * 输入框读回（`textFieldState`）按调用顺序给 `before → after`，使
 * `browser_type` 的原生输入路径判定为成功 —— 这条用例只关心**定位到了哪个
 * 选择器**，输入本身走最省事的成功分支。
 */
function stubPage(view: MockView, page: () => PageElement[]): void {
  let reads = 0
  view.transport.handler = (method, params) => {
    if (method !== 'Runtime.evaluate') return {}
    const expression = String(params?.['expression'] ?? '')
    // insertTextViaDom 的兜底脚本（type 专用）先判，避免被下面的 isContentEditable 抢先。
    if (expression.includes('const editable')) return { result: { value: 'typed' } }
    if (expression.includes('isContentEditable')) return { result: { value: reads++ === 0 ? 'before' : 'after' } }
    if (expression.includes('kindOf')) return { result: { value: page() } }
    if (expression.includes('document.querySelector')) return { result: { value: { x: 12, y: 34 } } }
    if (expression.includes('document.elementFromPoint')) return { result: { value: 'element' } }
    return { result: { value: '' } }
  }
}

/** 每一次 `document.querySelector("<sel>")` 的 sel（定位脚本是唯一的 querySelector 出口）。 */
function locatedSelectors(view: MockView): string[] {
  const out: string[] = []
  for (const command of view.transport.commands) {
    if (command.method !== 'Runtime.evaluate') continue
    const expression = String(command.params?.['expression'] ?? '')
    const match = /document\.querySelector\(("(?:[^"\\]|\\.)*")\)/u.exec(expression)
    if (match !== null) out.push(JSON.parse(match[1]!) as string)
  }
  return out
}

const FIRST_PAGE: PageElement[] = [
  { kind: 'button', text: 'Sign out', selector: '#signout', visible: true, disabled: false },
  { kind: 'button', text: 'Cancel', selector: '#cancel', visible: true, disabled: false },
]
const SECOND_PAGE: PageElement[] = [
  { kind: 'button', text: 'Sign out', selector: '#signout', visible: true, disabled: false },
  { kind: 'button', text: 'Delete account', selector: '#delete-account', visible: true, disabled: false },
]

// ------------------------------------------------- 1) 锚定：不再重新派生

describe('R15B-01 数字 target 锚定模型面快照', () => {
  it('页面在快照与点击之间重渲染 ⇒ 仍点到模型看到的那一个元素', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/list')
    const view = h.adapter.lastView()
    let page = FIRST_PAGE
    stubPage(view, () => page)

    const snapshot = await h.call('browser_get_snapshot', { tab: 1 }) as { elements: Array<{ index: number, text: string }>, snapshot: number }
    expect(snapshot.elements.map((e) => [e.index, e.text])).toEqual([[1, 'Sign out'], [2, 'Cancel']])

    // 页面重渲染：2 号位置换成了破坏性按钮（同一 URL，同一文档）
    page = SECOND_PAGE

    await h.call('browser_click', { tab: 1, target: 2 })
    // 关键判据：定位到的是**模型看到的那份**清单里的 #cancel，而不是新页面的 #delete-account
    expect(locatedSelectors(view)).toEqual(['#cancel'])
  })

  it('反证（不许回归）：字符串选择器原样透传、原样命中', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/list')
    const view = h.adapter.lastView()
    stubPage(view, () => SECOND_PAGE)

    await h.call('browser_click', { tab: 1, target: '#cancel' })
    expect(locatedSelectors(view)).toEqual(['#cancel'])
  })

  it('重新取一份快照 ⇒ 编号按新那一份解析（锚点是"最近一次"，不是"第一次"）', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/list')
    const view = h.adapter.lastView()
    let page = FIRST_PAGE
    stubPage(view, () => page)

    const first = await h.call('browser_get_snapshot', { tab: 1 }) as { snapshot: number }
    page = SECOND_PAGE
    const second = await h.call('browser_get_snapshot', { tab: 1 }) as { snapshot: number }
    expect(second.snapshot).toBeGreaterThan(first.snapshot)

    await h.call('browser_click', { tab: 1, target: 2 })
    expect(locatedSelectors(view)).toEqual(['#delete-account'])
  })

  it('type / select 与 click 共用同一份锚点（三个交互工具同口径）', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/list')
    const view = h.adapter.lastView()
    let page = FIRST_PAGE
    stubPage(view, () => page)
    await h.call('browser_get_snapshot', { tab: 1 })
    page = SECOND_PAGE

    await h.call('browser_type', { tab: 1, target: 2, text: 'x' })
    await h.call('browser_select', { tab: 1, target: 2, value: 'v' })
    expect(locatedSelectors(view)).toContain('#cancel')
    expect(locatedSelectors(view)).not.toContain('#delete-account')
  })
})

// ------------------------------------------------- 2) 过期即拒（stale-snapshot）

describe('R15B-01 锚点失效必须显式拒绝，绝不按新页面重新解析', () => {
  it('页面导航走之后，旧编号报 stale-snapshot（且完全没有下发定位命令）', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/list')
    const view = h.adapter.lastView()
    stubPage(view, () => FIRST_PAGE)
    await h.call('browser_get_snapshot', { tab: 1 })

    // 主帧跨文档导航：URL 变了 ⇒ 编号必然重新分配
    view.url = 'https://app.example/other'
    view.emit('did-navigate')
    const before = view.transport.commands.length

    const error = await fail(h.call('browser_click', { tab: 1, target: 2 }))
    expect(error.code).toBe('stale-snapshot')
    expect(error.message).toContain('browser_get_snapshot')
    // 没有任何新的 DOM 读/点击：拒绝发生在解析阶段，不是"先点了再报错"
    expect(view.transport.commands.length).toBe(before)
  })

  it('该 tab 从没取过快照 ⇒ 数字 target 报 stale-snapshot（不许现抽一份顶上）', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/list')
    const view = h.adapter.lastView()
    stubPage(view, () => FIRST_PAGE)

    const error = await fail(h.call('browser_click', { tab: 1, target: 1 }))
    expect(error.code).toBe('stale-snapshot')
    expect(locatedSelectors(view)).toEqual([])
  })

  it('编号不在锚定的那份清单里 ⇒ not-found（带上该份快照的世代号与元素数）', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/list')
    const view = h.adapter.lastView()
    stubPage(view, () => FIRST_PAGE)
    const snapshot = await h.call('browser_get_snapshot', { tab: 1 }) as { snapshot: number }

    const error = await fail(h.call('browser_click', { tab: 1, target: 9 }))
    expect(error.code).toBe('not-found')
    expect(error.message).toContain(`snapshot #${snapshot.snapshot}`)
    expect(error.message).toContain('2 elements')
  })

  it('标签关掉之后锚点一起丢（不许把新标签的 1 号解析成上一个页面）', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/list')
    stubPage(h.adapter.lastView(), () => FIRST_PAGE)
    await h.call('browser_get_snapshot', { tab: 1 })
    await h.runtime.closeTab(1)

    await h.runtime.open('https://app.example/other')
    const error = await fail(h.call('browser_click', { tab: 2, target: 1 }))
    expect(error.code).toBe('stale-snapshot')
  })
})

// ------------------------------------------------- 3) 命中身份三处可见

describe('R15B-01 命中元素身份进返回值 + render + op log', () => {
  it('数字 target：返回值带回编号/世代/类型/文本/选择器，render 与 op log 同样写明', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/list')
    stubPage(h.adapter.lastView(), () => FIRST_PAGE)
    const snapshot = await h.call('browser_get_snapshot', { tab: 1 }) as { snapshot: number }

    const result = await h.call('browser_click', { tab: 1, target: 2 })
    expect(result).toEqual({
      ok: true,
      hit: { index: 2, snapshot: snapshot.snapshot, kind: 'button', text: 'Cancel', selector: '#cancel' },
    })

    const rendered = h.render('browser_click', result)
    expect(rendered).toContain('#cancel')
    expect(rendered).toContain('Cancel')
    expect(rendered).toContain(`snapshot #${snapshot.snapshot}`)

    const op = h.runtime.opLog.find((entry) => entry.tool === 'browser_click')
    expect(op?.summary).toContain('#cancel')
    expect(op?.summary).toContain('Cancel')
    expect(op?.summary).toContain(`@snapshot#${snapshot.snapshot}`)
  })

  it('字符串 target：身份只有 selector（不编造编号/世代）', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/list')
    stubPage(h.adapter.lastView(), () => FIRST_PAGE)

    const result = await h.call('browser_click', { tab: 1, target: '#cancel' })
    expect(result).toEqual({ ok: true, hit: { selector: '#cancel' } })
    expect(h.render('browser_click', result)).toContain('selector #cancel')
    expect(h.runtime.opLog.find((entry) => entry.tool === 'browser_click')?.summary).toContain('#cancel')
  })

  it('快照本身把世代号写给模型（"点的是哪一版"当场可读）', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/list')
    stubPage(h.adapter.lastView(), () => FIRST_PAGE)

    const snapshot = await h.call('browser_get_snapshot', { tab: 1 }) as { snapshot: number }
    expect(typeof snapshot.snapshot).toBe('number')
    expect(h.render('browser_get_snapshot', snapshot)).toContain(`snapshot #${snapshot.snapshot}`)
  })

  it('回传的 hit.selector 与快照同一套值级擦除口径（R7 P0：页面可控 id 可能逐字带口令）', async () => {
    const secret = 'P@ssw0rd-verbatim'
    const h = track(makeHarness(async () => ({ username: 'alice', password: secret })))
    await h.runtime.open('https://login.example/form')
    const view = h.adapter.lastView()
    // 页面把口令当 id：selector 会逐字拼成 `#<口令>`（R7 P0 的真实形态）。
    const page: PageElement[] = [{ kind: 'button', text: 'Sign in', selector: `#${secret}`, visible: true, disabled: false }]
    view.transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.['expression'] ?? '')
      // 凭据注入的探测脚本（与 audit-r7-credential-scope 的替身同形）。
      if (expression.includes('passField')) return { result: { value: { filled: 2, username: true, password: true } } }
      if (expression.includes('kindOf')) return { result: { value: page } }
      if (expression.includes('document.querySelector')) return { result: { value: { x: 12, y: 34 } } }
      if (expression.includes('document.elementFromPoint')) return { result: { value: 'element' } }
      return { result: { value: '' } }
    }
    await h.runtime.fillCredentials(1, 'connector-x')

    const snapshot = await h.call('browser_get_snapshot', { tab: 1 }) as { elements: Array<{ selector: string }> }
    expect(snapshot.elements[0]!.selector).toBe('#****')

    const result = await h.call('browser_click', { tab: 1, target: 1 }) as { hit: { selector: string } }
    expect(result.hit.selector).toBe('#****')
    expect(h.render('browser_click', result)).not.toContain(secret)
    // 定位用的仍是未擦除的选择器（擦过的选择器当 CSS 选择器会定位失败）。
    expect(locatedSelectors(view)).toEqual([`#${secret}`])
  })
})
