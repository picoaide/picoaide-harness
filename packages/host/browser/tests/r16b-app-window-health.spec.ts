/**
 * R16B-19 / R16B-20（第十六轮审计泳道 B）在**浏览器侧**的两条判据。
 *
 * 缺陷（修前）：
 *  - R16B-19：`browser_list_tabs` 把应用窗口（`kind:'app'`）的 `crashed` **硬编码成
 *    `false`**（注释自承"应用窗口不在浏览器标签池里、也没有崩溃自动重载"）⇒ 窗口崩了
 *    以后模型看到的一切都正常。
 *  - R16B-20：`runtime.syncSurfaces()` 只清浏览器标签，应用窗口的 surface 一直留着
 *    ⇒ 用户自己关掉的窗口继续出现在模型面（宿主侧的原生订阅是主修，这里是纵深防御：
 *    宿主适配器没实现订阅时，仍然不该把**已销毁**的 webContents 当成可用目标）。
 *
 * 本文件跑**真实** `BrowserRuntime` + 真实 surface 注册表 + 真实 `browser_list_tabs`
 * 工具（不是 grep 字符串）：判据打在工具的真实输出上。
 *
 * 变异验证：
 *  · 把 `tools.ts` 的应用行 `crashed` 改回硬编码 `false` ⇒ ①②红；
 *  · 去掉 `surface.ts` 的 `markAppCrashed` ⇒ ②红；
 *  · 去掉 `runtime.syncSurfaces` 里的应用 surface 清扫 ⇒ ③红；
 *  · 把 fail-open 判据（只清 `isDestroyed() === true`）改成"只要 isDestroyed 不是
 *    false 就清" ⇒ ④红。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import { applyBrowserTools } from '../src/tools.ts'
import { createSurfaceRegistry } from '../src/surface.ts'
import type { ElectronAdapter, NativeBounds, NativeSession, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

const SCHEME = 'harness-app'

// ------------------------------------------------------------------ Electron 替身

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
  partition = 'persist:agent-browser-appa'
  clearStorageData = async (): Promise<void> => {}
  clearCache = async (): Promise<void> => {}
  setPermissionRequestHandler(): void {}
  setPermissionCheckHandler(): void {}
  on(): void {}
  removeListener(): void {}
}

class MockView implements NativeView {
  transport = new MockTransport()
  session = new MockSession()
  url = ''
  async loadURL(u: string): Promise<void> { this.url = u }
  title = ''
  destroyed = false
  partition = 'persist:agent-browser-appa'
  async capturePage(): Promise<never> { throw new Error('not used') }
  setWindowOpenHandler(): void {}
  attach(): void {}
  setBounds(_bounds: NativeBounds): void {}
  setVisible(): void {}
  detach(): void {}
  moveToTop(): void {}
  destroy(): void { this.destroyed = true }
  get webContents(): never {
    return {
      cdp: this.transport,
      loadURL: (u: string) => this.loadURL(u),
      downloadURL: (): void => {},
      goBack: (): void => {},
      goForward: (): void => {},
      reload: (): void => {},
      getURL: () => this.url,
      getTitle: () => this.title,
      isLoading: () => false,
      on: (): void => {},
      removeListener: (): void => {},
      session: this.session,
      setWindowOpenHandler: (): void => {},
      close: (): void => { this.destroyed = true },
      isDestroyed: () => this.destroyed,
      stop: (): void => {},
    } as never
  }
}

class MockAdapter implements ElectronAdapter {
  views: MockView[] = []
  async showSaveDialog(): Promise<{ canceled: boolean }> { return { canceled: true } }
  async openPath(): Promise<unknown> { return {} }
  createView(): NativeView { const view = new MockView(); this.views.push(view); return view }
  createMaskView(): NativeView { return new MockView() }
  createBrowserWindow(): never {
    return {
      loadURL: async (): Promise<void> => {},
      show: (): void => {},
      hide: (): void => {},
      focus: (): void => {},
      isVisible: () => false,
      isDestroyed: () => false,
      close: (): void => {},
      setTitle: (): void => {},
      getContentSize: () => ({ width: 1100, height: 780 }),
      contentView: { addChildView: (): void => {}, removeChildView: (): void => {} },
      onResize: () => (): void => {},
      onClosed: () => (): void => {},
      focusPage: (): void => {},
    } as never
  }
  getSession(): NativeSession { return new MockSession() }
  lastView(): MockView { return this.views.at(-1)! }
}

/**
 * 应用窗口的 `webContents`（宿主交过来的不透明句柄的最小面）。
 *
 * `destroyed` 三种取值覆盖 fail-open 判据：`undefined` = 报不出来（保留）、
 * `false` = 明确活着（保留）、`true` = 明确销毁（清掉）。
 */
class MockAppWebContents {
  urls: string[] = []
  /** `isDestroyed` 的形态：缺席 / 布尔 / 抛错。 */
  destroyed: boolean | undefined = false
  throwsOnIsDestroyed = false
  async loadURL(url: string): Promise<void> { this.urls.push(url) }
  getURL(): string { return this.urls.at(-1) ?? '' }
  getTitle(): string { return 'Notes' }
  on(): void {}
  removeListener(): void {}
  isDestroyed(): boolean {
    if (this.throwsOnIsDestroyed) throw new Error('webContents is gone')
    return this.destroyed === true
  }
}

interface ToolDefinition {
  name: string
  output?: { render?: (args: unknown, value: unknown) => Array<{ type: string, text?: string }> }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

interface Harness {
  runtime: BrowserRuntime
  surfaces: ReturnType<typeof createSurfaceRegistry>
  app: MockAppWebContents
  dispose: () => void
}

const opened: Harness[] = []

function makeHarness(): Harness & { call: (name: string) => Promise<unknown>, render: (value: unknown) => string, tool: ToolDefinition } {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.r16b-app-health-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const store = new BrowserStore({ dir })
  let runtime!: BrowserRuntime
  const surfaces = createSurfaceRegistry({ activeBrowserTab: () => runtime.pool.activeTab })
  runtime = new BrowserRuntime(adapter as never, {}, undefined, undefined, { store, surfaces })
  const app = new MockAppWebContents()
  surfaces.registerApp({ id: 1_000_001, appId: 'notes', appScheme: SCHEME, webContents: app })
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    systemPrompt: { section: () => () => {} },
  } as unknown as Parameters<typeof applyBrowserTools>[0]
  const disposeTools = applyBrowserTools(ctx, runtime)
  const listTabs = tools.get('browser_list_tabs')!
  const harness = {
    runtime,
    surfaces,
    app,
    tool: listTabs,
    call: async (name: string) => {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`tool not registered: ${name}`)
      return await tool.execute({}, { agent: undefined, signal: new AbortController().signal })
    },
    render: (value: unknown): string => (listTabs.output?.render?.({}, value) ?? [])
      .map(part => (part.type === 'text' ? part.text ?? '' : ''))
      .join('\n'),
    dispose: () => { disposeTools(); runtime.dispose(); rmSync(dir, { recursive: true, force: true }) },
  }
  opened.push(harness)
  return harness
}

afterEach(() => {
  for (const harness of opened.splice(0)) {
    try { harness.dispose() } catch { /* already disposed */ }
  }
  try {
    for (const name of readdirSync(join(process.cwd(), 'tests'))) {
      if (name.startsWith('.r16b-app-health-')) rmSync(join(process.cwd(), 'tests', name), { recursive: true, force: true })
    }
  } catch { /* best effort */ }
})

describe('R16B-19：应用窗口的 crashed 如实上报给模型', () => {
  it('①未崩溃 ⇒ crashed:false；崩溃后 ⇒ crashed:true（模型面不再是恒 false）', async () => {
    const harness = makeHarness()

    const healthy = await harness.call('browser_list_tabs') as { tabs: Array<{ kind: string, app_id: string, crashed: boolean }> }
    const appRow = healthy.tabs.find(row => row.kind === 'app')
    expect(appRow).toMatchObject({ app_id: 'notes', crashed: false })

    // 宿主（`wasm-apps-host` 的窗口管理器）在渲染进程崩溃/主框架加载失败时标它。
    const surfaceId = harness.surfaces.appSurfaces()[0]!.id
    harness.surfaces.markAppCrashed(surfaceId, true)

    const crashed = await harness.call('browser_list_tabs') as { tabs: Array<{ kind: string, app_id: string, crashed: boolean }> }
    expect(crashed.tabs.find(row => row.kind === 'app')).toMatchObject({ app_id: 'notes', crashed: true })

    // 一次成功加载后必须能回到 false（否则"崩过一次"就成了永久标签）。
    harness.surfaces.markAppCrashed(surfaceId, false)
    const recovered = await harness.call('browser_list_tabs') as { tabs: Array<{ kind: string, app_id: string, crashed: boolean }> }
    expect(recovered.tabs.find(row => row.kind === 'app')).toMatchObject({ crashed: false })
  })

  it('②render 出口也说得出"它坏了"（JSON 与文本同构；应用窗口不能用 browser_reload）', async () => {
    const harness = makeHarness()
    const surfaceId = harness.surfaces.appSurfaces()[0]!.id
    harness.surfaces.markAppCrashed(surfaceId, true)

    const value = await harness.call('browser_list_tabs')
    const text = harness.render(value)
    expect(text).toContain('app_id=notes')
    expect(text).toContain('[crashed]')
    // 应用窗口不吃 `browser_reload`（只有 `browser_navigate` 会派发到应用窗口）⇒
    // 给模型的提示不能把模型送到一个必然报错的工具上。
    expect(text).not.toContain('browser_reload')
  })
})

describe('R16B-20：已销毁应用窗口的 surface 不得继续留在模型面（纵深防御）', () => {
  it('③webContents 明确已销毁 ⇒ syncSurfaces 清掉它（模型面不再列出不存在的窗口）', async () => {
    const harness = makeHarness()
    expect(harness.surfaces.appSurfaces()).toHaveLength(1)

    // 用户点了窗口自己的关闭按钮：原生 webContents 已销毁，但宿主适配器没订阅
    // `closed`（旧宿主/替身）⇒ 注册表里还留着它。
    harness.app.destroyed = true
    harness.runtime.syncSurfaces()

    expect(harness.surfaces.appSurfaces()).toEqual([])
    // 幂等：再镜像一次不抛。
    harness.runtime.syncSurfaces()

    const value = await harness.call('browser_list_tabs') as { tabs: Array<{ kind: string }> }
    expect(value.tabs.filter(row => row.kind === 'app')).toEqual([])
  })

  it('④fail-open：报不出 isDestroyed / 明确活着 / 查询抛错 ⇒ 一律保留（不许把活窗口抹掉）', async () => {
    for (const shape of ['absent', 'alive', 'throws'] as const) {
      const harness = makeHarness()
      const app = harness.app
      if (shape === 'absent') (app as unknown as { isDestroyed?: unknown }).isDestroyed = undefined
      if (shape === 'alive') app.destroyed = false
      if (shape === 'throws') app.throwsOnIsDestroyed = true

      harness.runtime.syncSurfaces()
      expect(harness.surfaces.appSurfaces(), shape).toHaveLength(1)
      harness.dispose()
      opened.splice(opened.indexOf(harness), 1)
    }
  })
})
