/**
 * 应用窗口 surface 的**落点**判据（§16.1；2026-09-21 P1）。
 *
 * 缺陷形态：宿主把应用窗口注册进 surface 注册表之后，`browser_navigate{app_id, url}`
 * 只**校验**了 app_id 是否存在，随后仍然返回 `tabOf()` 的浏览器标签 —— 模型以为自己在
 * 驱动应用窗口，实际把用户正在看的浏览器标签导航走了（http(s) URL），或者被浏览器闸门
 * 拒绝（应用 scheme URL）。两条都是错的目标，前者对用户是真实伤害。
 *
 * 本文件的判据一律成对：**应用 surface 的 webContents 被调用**，且**浏览器标签的
 * webContents 完全没有被碰**（对 `loadURL` 与 `tabState().url` 双重断言）。变异验证：
 *   · 把 `resolveSurfaceTarget` 的 app 分支改回 `{kind:'browser-tab', tab: await tabOf(...)}`
 *     ⇒ 用例 ①②⑤ 必红；
 *   · 去掉 `appSurfaceAllowsUrl` 闸门 ⇒ 用例 ③ 必红；
 *   · 去掉 `assertSurfaceAgentStillAllowed` ⇒ 用例 ⑥ 必红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import { applyBrowserTools, parseToolGroups } from '../src/tools.ts'
import { createSurfaceRegistry } from '../src/surface.ts'
import { gateRefusal } from '../src/pool.ts'
import type { ElectronAdapter, NativeBounds, NativeSession, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

const SCHEME = 'harness-app'

// ------------------------------------------------------------------ Electron 替身

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
  partition = 'persist:agent-browser-appa'
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
  url = ''
  /** 浏览器标签的导航记录 —— 判据的核心：应用窗口的寻址绝不能出现在这里。 */
  loadURL = vi.fn(async (u: string) => { this.url = u })
  title = ''
  destroyed = false
  partition = 'persist:agent-browser-appa'
  capturePage = vi.fn(async () => ({ getSize: () => ({ width: 1, height: 1 }), resize: () => ({}), toJPEG: () => Buffer.from('x') }))
  setWindowOpenHandler = vi.fn()
  attach(): void {}
  setBounds(_bounds: NativeBounds): void {}
  setVisible(): void {}
  detach(): void {}
  moveToTop(): void {}
  destroy(): void { this.destroyed = true }
  get webContents(): never {
    return {
      cdp: this.transport,
      loadURL: this.loadURL,
      downloadURL: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      reload: vi.fn(),
      capturePage: this.capturePage,
      getURL: () => this.url,
      getTitle: () => this.title,
      isLoading: () => false,
      on: (event: string, listener: (...args: unknown[]) => void) => {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      },
      removeListener: (event: string, listener: (...args: unknown[]) => void) => {
        this.listeners.set(event, (this.listeners.get(event) ?? []).filter(x => x !== listener))
      },
      session: this.session,
      setWindowOpenHandler: this.setWindowOpenHandler,
      close: () => { this.destroyed = true },
      isDestroyed: () => this.destroyed,
      stop: vi.fn(),
    } as never
  }
}

class MockAdapter implements ElectronAdapter {
  views: MockView[] = []
  showSaveDialog = vi.fn(async () => ({ canceled: true }))
  openPath = vi.fn(async () => ({}))
  createView(): NativeView { const view = new MockView(); this.views.push(view); return view }
  createMaskView(): NativeView { return new MockView() }
  createBrowserWindow(): never {
    return {
      loadURL: async () => {},
      show: () => {},
      hide: () => {},
      focus: () => {},
      isVisible: () => false,
      isDestroyed: () => false,
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
  lastView(): MockView { return this.views.at(-1)! }
}

/** 应用窗口的 `webContents`（宿主交过来的不透明句柄的最小面）。 */
class MockAppWebContents {
  urls: string[] = []
  stopped = 0
  loading = false
  async loadURL(url: string): Promise<void> { this.urls.push(url) }
  isLoading(): boolean { return this.loading }
  getURL(): string { return this.urls.at(-1) ?? '' }
  getTitle(): string { return 'Notes' }
  stop(): void { this.stopped += 1 }
  on(): void {}
  removeListener(): void {}
}

// ------------------------------------------------------------------ 工具面替身

interface ToolDefinition {
  name: string
  /** `defineTool` 把参数表转成了 JSON Schema。 */
  parameters?: { properties?: Record<string, unknown> }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

interface Harness {
  runtime: BrowserRuntime
  adapter: MockAdapter
  surfaces: ReturnType<typeof createSurfaceRegistry>
  app: MockAppWebContents
  appId: number
  tools: Map<string, ToolDefinition>
  call: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  dispose: () => void
}

const opened: Harness[] = []

function makeHarness(options: { withWebContents?: boolean } = {}): Harness {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.app-surface-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const store = new BrowserStore({ dir })
  let runtime!: BrowserRuntime
  const surfaces = createSurfaceRegistry({ activeBrowserTab: () => runtime.pool.activeTab })
  runtime = new BrowserRuntime(adapter as never, {}, undefined, undefined, { store, surfaces })
  const app = new MockAppWebContents()
  const surface = surfaces.registerApp({
    id: 1_000_001,
    appId: 'notes',
    appScheme: SCHEME,
    ...(options.withWebContents === false ? {} : { webContents: app }),
  })
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    systemPrompt: { section: () => () => {} },
  } as unknown as Parameters<typeof applyBrowserTools>[0]
  const disposeTools = applyBrowserTools(ctx, runtime)
  const harness: Harness = {
    runtime,
    adapter,
    surfaces,
    app,
    appId: surface.id,
    tools,
    call: async (name, args = {}) => {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`tool not registered: ${name}`)
      return await tool.execute(args, { agent: undefined, signal: new AbortController().signal })
    },
    dispose: () => { disposeTools(); runtime.dispose(); rmSync(dir, { recursive: true, force: true }) },
  }
  opened.push(harness)
  return harness
}

/** 打开一张浏览器标签，返回它的 view（判据里的"绝不能被动到"的那个目标）。 */
async function openBrowserTab(harness: Harness): Promise<MockView> {
  await harness.runtime.open('https://user.example/current')
  const view = harness.adapter.lastView()
  view.loadURL.mockClear()
  return view
}

async function failure(promise: Promise<unknown>): Promise<{ code?: string, message: string }> {
  try {
    await promise
  } catch (error) {
    return error as { code?: string, message: string }
  }
  throw new Error('expected the call to fail')
}

afterEach(() => {
  for (const harness of opened.splice(0)) {
    try { harness.dispose() } catch { /* already disposed */ }
  }
  try {
    for (const name of readdirSync(join(process.cwd(), 'tests'))) {
      if (name.startsWith('.app-surface')) rmSync(join(process.cwd(), 'tests', name), { recursive: true, force: true })
    }
  } catch { /* best effort */ }
})

// ------------------------------------------------------------------ 判据

describe('应用窗口 surface 的落点（§16.1）', () => {
  it('① browser_navigate{app_id} 落在应用窗口自己的 webContents 上，绝不碰浏览器标签', async () => {
    const harness = makeHarness()
    const browserTab = await openBrowserTab(harness)

    const result = await harness.call('browser_navigate', { app_id: 'notes', url: `${SCHEME}://notes/page/2` }) as { url: string }

    expect(harness.app.urls).toEqual([`${SCHEME}://notes/page/2`])
    expect(browserTab.loadURL).not.toHaveBeenCalled()
    expect(harness.runtime.tabState(1).url).toBe('https://user.example/current')
    expect(result.url).toBe(`${SCHEME}://notes/page/2`)
  })

  it('② 默认寻址仍然只指浏览器标签（应用窗口必须显式 app_id）', async () => {
    const harness = makeHarness()
    const browserTab = await openBrowserTab(harness)

    await harness.call('browser_navigate', { url: 'https://user.example/next' })

    expect(browserTab.loadURL).toHaveBeenCalledWith('https://user.example/next')
    expect(harness.app.urls).toEqual([])
  })

  it('③ 应用窗口拒绝导航到外站（结构化 navigation-blocked，两个 webContents 都没被碰）', async () => {
    const harness = makeHarness()
    const browserTab = await openBrowserTab(harness)

    const error = await failure(harness.call('browser_navigate', { app_id: 'notes', url: 'https://evil.example/' }))

    expect(error.code).toBe('navigation-blocked')
    expect(error.message).toContain('app:notes')
    expect(harness.app.urls).toEqual([])
    expect(browserTab.loadURL).not.toHaveBeenCalled()
  })

  it('③b 同 scheme 但别的 app_id（foreign app）同样被拒', async () => {
    const harness = makeHarness()
    await openBrowserTab(harness)

    const error = await failure(harness.call('browser_navigate', { app_id: 'notes', url: `${SCHEME}://other/page` }))

    expect(error.code).toBe('navigation-blocked')
    expect(harness.app.urls).toEqual([])
  })

  it('④ 未知 app_id ⇒ not-found，且不回落浏览器标签', async () => {
    const harness = makeHarness()
    const browserTab = await openBrowserTab(harness)

    const error = await failure(harness.call('browser_navigate', { app_id: 'nope', url: `${SCHEME}://nope/` }))

    expect(error.code).toBe('not-found')
    expect(browserTab.loadURL).not.toHaveBeenCalled()
    expect(harness.app.urls).toEqual([])
  })

  it('⑤ tab 与 app_id 同时给 ⇒ 拒绝（矛盾的寻址不猜）', async () => {
    const harness = makeHarness()
    const browserTab = await openBrowserTab(harness)

    const error = await failure(harness.call('browser_navigate', { tab: 1, app_id: 'notes', url: `${SCHEME}://notes/` }))

    expect(error.code).toBe('policy')
    expect(error.message).toContain('ambiguous')
    expect(browserTab.loadURL).not.toHaveBeenCalled()
    expect(harness.app.urls).toEqual([])
  })

  it('⑥ 没有可驱动 webContents 的 surface ⇒ 明确报错，绝不回落浏览器标签', async () => {
    const harness = makeHarness({ withWebContents: false })
    const browserTab = await openBrowserTab(harness)

    const error = await failure(harness.call('browser_navigate', { app_id: 'notes', url: `${SCHEME}://notes/` }))

    expect(error.code).toBe('not-found')
    expect(error.message).toContain('app:notes')
    expect(browserTab.loadURL).not.toHaveBeenCalled()
  })

  it('⑦ runtime.navigateAppSurface 直接调用时也拒绝 kind 不符的 surface', async () => {
    const harness = makeHarness()
    const tab = await harness.runtime.open('https://user.example/')
    harness.runtime.syncSurfaces()
    const browserSurface = harness.surfaces.get(tab.id)!

    const error = await failure(harness.runtime.navigateAppSurface(browserSurface, 'https://user.example/x'))

    expect(error.code).toBe('policy')
    expect(harness.adapter.lastView().loadURL).not.toHaveBeenCalledWith('https://user.example/x')
  })

  it('⑧ oplog 记录应用窗口导航，但不占用任何浏览器标签 id', async () => {
    const harness = makeHarness()
    await openBrowserTab(harness)

    await harness.call('browser_navigate', { app_id: 'notes', url: `${SCHEME}://notes/log` })

    const op = harness.runtime.opLog[0]!
    expect(op.tool).toBe('browser_navigate')
    expect(op.tab).toBe(0)
    expect(op.summary).toContain('app:notes')
  })

  it('⑨ 其余工具收到未声明的 app_id 时 fail-loud（不再静默操作浏览器标签）', async () => {
    const harness = makeHarness()
    const browserTab = await openBrowserTab(harness)
    const others = [
      'browser_get_snapshot',
      'browser_get_text',
      'browser_screenshot',
      'browser_eval',
      'browser_wait_for',
      'browser_close_tab',
      'browser_reload',
    ]
    for (const name of others) {
      const error = await failure(harness.call(name, { app_id: 'notes', target: 1, expression: '1', condition: 'settled' }))
      expect(error.code, `${name} must refuse a stray app_id`).toBe('policy')
      expect(error.message, `${name} must name itself`).toContain(name)
    }
    expect(browserTab.loadURL).not.toHaveBeenCalled()
    expect(harness.app.urls).toEqual([])
  })

  it('⑩ 用 surface id 当 tab 寻址应用窗口 ⇒ 明确拒绝（不是含混的 unknown tab）', async () => {
    const harness = makeHarness()
    const browserTab = await openBrowserTab(harness)

    const error = await failure(harness.call('browser_get_text', { tab: harness.appId }))

    expect(error.code).toBe('policy')
    expect(error.message).toContain('app:notes')
    expect(error.message).toContain('app_id')
    expect(browserTab.loadURL).not.toHaveBeenCalled()
  })

  it('⑪ 声明 app_id 的工具集合恰好是分派到应用窗口的那一个；其余**逐个**工具都 fail-loud', async () => {
    const harness = makeHarness()
    const declaring = [...harness.tools.entries()]
      .filter(([, definition]) => definition.parameters?.properties?.app_id !== undefined)
      .map(([name]) => name)
    expect(declaring, 'only browser_navigate declares app_id (add dispatch before declaring it)').toEqual(['browser_navigate'])
    expect(harness.tools.size).toBeGreaterThan(20)
    for (const [name] of harness.tools) {
      if (name === 'browser_navigate') continue
      const error = await failure(harness.call(name, { app_id: 'notes' }))
      expect(error.code, `${name} must refuse a stray app_id`).toBe('policy')
    }
  })
})

describe('逐 surface 的控制权（§16.1 第 3 条）', () => {
  it('⑥ 用户按住应用窗口时，针对它的 AI 导航被拒（与浏览器窗口同一段文案）', async () => {
    const harness = makeHarness()
    const browserTab = await openBrowserTab(harness)
    expect(harness.runtime.setSurfaceControl(harness.appId, 'user')).toBe(true)
    expect(harness.runtime.surfaceControl(harness.appId)).toBe('user')
    expect(harness.runtime.controlState().userHeldSurfaces).toEqual([{ id: harness.appId, appId: 'notes' }])

    const error = await failure(harness.call('browser_navigate', { app_id: 'notes', url: `${SCHEME}://notes/blocked` }))

    expect(error.code).toBe('window-controlled')
    expect(error.message).toBe(gateRefusal('zh'))
    expect(harness.app.urls).toEqual([])
    expect(browserTab.loadURL).not.toHaveBeenCalled()
  })

  it('⑥b 交还控制权（同一个入口反向）后 AI 立刻可以继续', async () => {
    const harness = makeHarness()
    await openBrowserTab(harness)
    harness.runtime.setSurfaceControl(harness.appId, 'user')
    await failure(harness.call('browser_navigate', { app_id: 'notes', url: `${SCHEME}://notes/1` }))

    expect(harness.runtime.setSurfaceControl(harness.appId, 'agent')).toBe(true)
    expect(harness.runtime.controlState().userHeldSurfaces).toEqual([])
    await harness.call('browser_navigate', { app_id: 'notes', url: `${SCHEME}://notes/2` })

    expect(harness.app.urls).toEqual([`${SCHEME}://notes/2`])
  })

  it('⑥c 应用窗口归人**不**波及浏览器标签（逐 surface 而不是池级）', async () => {
    const harness = makeHarness()
    const browserTab = await openBrowserTab(harness)
    harness.runtime.setSurfaceControl(harness.appId, 'user')

    await harness.call('browser_navigate', { url: 'https://user.example/while-user-holds-app' })

    expect(browserTab.loadURL).toHaveBeenCalledWith('https://user.example/while-user-holds-app')
    expect(harness.runtime.controlState().controlled).toBe(false)
  })

  it('⑥d 用户按住时停掉该窗口正在进行的加载（浏览器标签的 stop 不经手）', async () => {
    const harness = makeHarness()
    await openBrowserTab(harness)

    harness.runtime.setSurfaceControl(harness.appId, 'user')

    expect(harness.app.stopped).toBe(1)
  })

  it('⑥e 未知 surface id 不产生任何状态（也不记录 op）', async () => {
    const harness = makeHarness()
    const before = harness.runtime.opLog.length
    expect(harness.runtime.setSurfaceControl(999_999, 'user')).toBe(false)
    expect(harness.runtime.surfaceControl(999_999)).toBeUndefined()
    expect(harness.runtime.opLog.length).toBe(before)
  })

  it('⑥f 窗口注销后控制权一并消失（重开的窗口回到 agent 缺省）', () => {
    const harness = makeHarness()
    harness.runtime.setSurfaceControl(harness.appId, 'user')
    harness.surfaces.unregister(harness.appId)
    expect(harness.runtime.controlState().userHeldSurfaces).toEqual([])

    const rebuilt = harness.surfaces.registerApp({ id: 1_000_002, appId: 'notes', appScheme: SCHEME, webContents: harness.app })
    expect(harness.runtime.surfaceControl(rebuilt.id)).toBe('agent')
  })

  it('⑥g 宿主可以按设计总纲 §7.2 把新窗口注册成"默认人操作"（挂载胶囊后的形态）', async () => {
    const harness = makeHarness()
    await openBrowserTab(harness)
    const surface = harness.surfaces.registerApp({
      id: 1_000_009,
      appId: 'held-app',
      appScheme: SCHEME,
      webContents: new MockAppWebContents(),
      control: 'user',
    })

    expect(harness.runtime.surfaceControl(surface.id)).toBe('user')
    expect(harness.runtime.userHeldSurfaces()).toEqual([{ id: surface.id, appId: 'held-app' }])
    const error = await failure(harness.call('browser_navigate', { app_id: 'held-app', url: `${SCHEME}://held-app/` }))
    expect(error.code).toBe('window-controlled')
  })
})

describe('browser_list_tabs 的模型面', () => {
  it('列出应用窗口并如实报出用户持有的窗口', async () => {
    const harness = makeHarness()
    await openBrowserTab(harness)
    harness.runtime.setSurfaceControl(harness.appId, 'user')

    const value = await harness.call('browser_list_tabs') as {
      tabs: Array<{ kind: string, app_id: string }>
      control: { controlled: boolean, userHeldSurfaces: Array<{ id: number, appId: string }> }
    }

    expect(value.tabs.some(tab => tab.kind === 'app' && tab.app_id === 'notes')).toBe(true)
    // 池级 controlled 仍然是"浏览器窗口被用户接管"（浏览器工具不受影响）。
    expect(value.control.controlled).toBe(false)
    expect(value.control.userHeldSurfaces).toEqual([{ id: harness.appId, appId: 'notes' }])
  })
})

describe('工具分组不影响落点', () => {
  it('组策略过滤后，navigate 的工具面仍然是同一份实现', () => {
    const harness = makeHarness()
    const groups = parseToolGroups(undefined)
    expect(groups.has('navigate')).toBe(true)
  })
})
