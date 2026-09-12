/**
 * 2026-09-12 P0/P1 修复回归锁（browser 模块）。
 *
 * - **P0-A** `browser_get_snapshot` 不再把 `browser_fill_credentials` 写入的
 *   密码明文交给模型。两层：探针层（`snapshot.ts` 的 `textOf`）**不读**
 *   `type=password` 的 `el.value`（见 tests/snapshot.spec.ts）；运行时漏斗
 *   （`runtime.snapshot`）再按"本 tab 注入过的凭证值"精确擦一遍——这一层
 *   覆盖所有直接调用 `runtime.snapshot` 的调用方（tools.ts:517 / resolveTarget
 *   / 未来的出口），且不依赖关键词形状。
 * - **P1-5** op log 的 URL fragment 与 history/ledger 同款脱敏（复用
 *   `store.maskSensitiveFragment`，不是第二份实现）。
 * - **P1-7** `browser_eval(frame>0)` 在目标 frame 的**默认世界**执行——页面
 *   自己的 JS 全局可见（与 frame 0 语义一致）；拿不到默认世界时报 not-found，
 *   **绝不静默退回隔离世界**。
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
  commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  handler: (method: string, params?: Record<string, unknown>) => unknown = () => ({})
  private readonly messageListeners: Array<(event: unknown, method: string, params: unknown) => void> = []
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, params })
    return this.handler(method, params)
  }
  on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown {
    if (event === 'message') this.messageListeners.push(listener)
    return this
  }
  removeListener(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown {
    if (event === 'message') {
      const idx = this.messageListeners.indexOf(listener)
      if (idx >= 0) this.messageListeners.splice(idx, 1)
    }
    return this
  }
  /** Deliver one CDP notification through the real CdpSession fan-out. */
  emitNotification(method: string, params: unknown): void {
    for (const listener of [...this.messageListeners]) listener(undefined, method, params)
  }
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
}

function makeRuntime(credentials?: (id: string) => Promise<{ username?: string; password?: string } | null>): {
  runtime: BrowserRuntime
  adapter: MockAdapter
  store: BrowserStore
  dir: string
} {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.audit0912-store-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(adapter as never, {}, credentials as never, undefined, { store })
  return { runtime, adapter, store, dir }
}

const opened: Array<{ runtime: BrowserRuntime; dir: string }> = []
afterEach(() => {
  for (const entry of opened.splice(0)) {
    entry.runtime.dispose()
    rmSync(entry.dir, { recursive: true, force: true })
  }
  // Belt: drop any directory left behind by a failed test.
  try {
    for (const name of readdirSync(join(process.cwd(), 'tests'))) {
      if (name.startsWith('.audit0912-store')) rmSync(join(process.cwd(), 'tests', name), { recursive: true, force: true })
    }
  } catch { /* best effort */ }
})

// ------------------------------------------------------------------- P0-A

describe('P0-A 快照不得回传注入的凭证密码', () => {
  // 刻意选一个**不含任何 secret 形状关键词**的密码：关键词掩码救不了它，
  // 只有"值级"擦除（或源头不读 value）才算真修好。
  const SECRET = 'hunter2-xyz9-quartz'

  it('runtime.snapshot 擦除本 tab 注入过的凭证值（纵深防御，覆盖所有调用方）', async () => {
    const { runtime, adapter, dir } = makeRuntime(async (id) => (id === 'corp-sso' ? { username: 'alice', password: SECRET } : null))
    opened.push({ runtime, dir })
    await runtime.open('https://login.example')
    const view = adapter.lastView()
    view.transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.expression ?? '')
      // fillCredentials 的页内脚本（runtime.ts:1529+）
      if (expression.includes('passField')) return { result: { value: { filled: 2, username: true, password: true } } }
      // 快照探针：模拟"某个未来/其它取值来源把 value 又读进来了"
      if (expression.includes('querySelectorAll')) {
        return {
          result: {
            value: [
              { kind: 'input', text: SECRET, selector: '#pw', visible: true, disabled: false },
              { kind: 'input', text: `password: ${SECRET}`, selector: '#hint', visible: true, disabled: false },
              { kind: 'button', text: 'Sign in', selector: '#go', visible: true, disabled: false },
            ],
          },
        }
      }
      return {}
    }

    const filled = await runtime.fillCredentials(1, 'corp-sso')
    expect(filled).toEqual({ username: true, password: true })

    const elements = await runtime.snapshot(1)
    const serialized = JSON.stringify(elements)
    expect(serialized).not.toContain(SECRET)
    expect(elements[0]!.text).toBe('****')
    expect(elements[1]!.text).toBe('password: ****')
    // 非凭证文本不受影响（擦除是值级精确匹配，不是关键词一刀切）
    expect(elements[2]!.text).toBe('Sign in')
  })

  it('没注入过凭证的 tab 快照保持原样（不误伤）', async () => {
    const { runtime, adapter, dir } = makeRuntime(async () => ({ password: SECRET }))
    opened.push({ runtime, dir })
    await runtime.open('https://other.example')
    adapter.lastView().transport.handler = (method, params) => {
      if (method === 'Runtime.evaluate' && String(params?.expression ?? '').includes('querySelectorAll')) {
        return { result: { value: [{ kind: 'input', text: SECRET, selector: '#x', visible: true, disabled: false }] } }
      }
      return {}
    }
    const elements = await runtime.snapshot(1)
    expect(elements[0]!.text).toBe(SECRET)
  })

  it('模型实际看到的出口（工具返回值 + render 文本）都不含密码', async () => {
    const { runtime, adapter, dir } = makeRuntime(async (id) => (id === 'corp-sso' ? { username: 'alice', password: SECRET } : null))
    opened.push({ runtime, dir })
    await runtime.open('https://login.example')
    adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.expression ?? '')
      if (expression.includes('passField')) return { result: { value: { filled: 2, username: true, password: true } } }
      if (expression.includes('querySelectorAll')) {
        // The probe itself no longer emits this; the stub stands in for any
        // future probe/source that reads the value back.
        return { result: { value: [{ kind: 'input', text: SECRET, selector: '#pw', visible: true, disabled: false }] } }
      }
      return {}
    }

    const tools = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown>, output: { render: (args: unknown, value: unknown) => Array<{ type: string, text: string }> } }>()
    const ctx = {
      tools: { register: (definition: { name: string }) => { tools.set(definition.name, definition as never); return () => tools.delete(definition.name) } },
      systemPrompt: { section: () => () => {} },
    } as unknown as Parameters<typeof applyBrowserTools>[0]
    const dispose = applyBrowserTools(ctx, runtime)
    const exec = { agent: undefined, signal: new AbortController().signal }

    const fill = tools.get('browser_fill_credentials')!
    expect(await fill.execute({ connectorId: 'corp-sso' }, exec)).toEqual({ username: true, password: true })

    const snapshotTool = tools.get('browser_get_snapshot')!
    const value = await snapshotTool.execute({}, exec) as { elements: Array<{ text: string }> }
    const rendered = snapshotTool.output.render({}, value).map((part) => part.text).join('\n')

    expect(JSON.stringify(value)).not.toContain(SECRET)
    expect(rendered).not.toContain(SECRET)
    expect(rendered).toContain('****')
    dispose()
  })
})

// ------------------------------------------------------------------- P1-5

describe('P1-5 op log 的 URL fragment 与 history 同款脱敏', () => {
  it('navigate 的 fragment token 在 op log 里被掩码（不再明文）', async () => {
    const { runtime, dir } = makeRuntime()
    opened.push({ runtime, dir })
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    await runtime.navigate(id, 'https://idp.example/callback#access_token=eyJhbGciOiJIUzI1NiJ9.SECRET&state=x')
    const op = runtime.opLog.find((entry) => entry.tool === 'browser_navigate')
    expect(op?.summary).toContain('#access_token=****&state=x')
    expect(op?.summary).not.toContain('eyJhbGciOiJIUzI1NiJ9.SECRET')
    // 非敏感 fragment 与 key 原样保留（不整体打码）
    expect(op?.summary).toContain('&state=x')
  })

  it('userinfo + fragment 组合，两个出口都脱敏', async () => {
    const { runtime, store, dir } = makeRuntime()
    opened.push({ runtime, dir })
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    await runtime.navigate(id, 'https://alice:pw@idp.example/cb#sid=SECRETVALUE')
    const op = runtime.opLog.find((entry) => entry.tool === 'browser_navigate')
    expect(op?.summary).toContain('https://****:****@idp.example/cb#sid=****')
    expect(store.queryHistory({ limit: 1 })[0]?.url).toBe('https://****:****@idp.example/cb#sid=****')
  })

  it('重复参数（?token=a&token=b）与 7 个缺口键在 op log 里同样被掩码', async () => {
    const { runtime, dir } = makeRuntime()
    opened.push({ runtime, dir })
    await runtime.open('https://a.example')
    await runtime.navigate(runtime.currentTabId()!, 'https://h/cb?token=a&token=b&session=SHOULD-NOT-APPEAR')
    const summary = runtime.opLog.find((entry) => entry.tool === 'browser_navigate')?.summary ?? ''
    expect(summary).not.toContain('SHOULD-NOT-APPEAR')
    expect(summary).not.toContain('token=a')
    expect(summary).toContain('token=****')
  })
})

// ------------------------------------------------------------------- P1-7

describe('P1-7 browser_eval(frame>0) 跑目标 frame 的默认世界', () => {
  const FRAME_TREE = { frameTree: { frame: { id: 'MAIN' }, childFrames: [{ frame: { id: 'IFRAME-1' } }] } }

  it('frame 1 用默认世界 contextId 求值（页面 JS 全局可见），不建隔离世界', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    opened.push({ runtime, dir })
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.handler = (method) => {
      if (method === 'Page.getFrameTree') return FRAME_TREE
      if (method === 'Runtime.enable') {
        // 真实 CDP：enable 的响应与"既有 context"通知竞争，通知可能晚一拍。
        setTimeout(() => {
          view.transport.emitNotification('Runtime.executionContextCreated', { context: { id: 7, auxData: { frameId: 'MAIN', isDefault: true } } })
          view.transport.emitNotification('Runtime.executionContextCreated', { context: { id: 41, auxData: { frameId: 'IFRAME-1', isDefault: false } } })
          view.transport.emitNotification('Runtime.executionContextCreated', { context: { id: 42, auxData: { frameId: 'IFRAME-1', isDefault: true } } })
        }, 5)
        return {}
      }
      if (method === 'Runtime.evaluate') return { result: { value: 'FROM-IFRAME-SCRIPT' } }
      return {}
    }

    await expect(runtime.eval(1, 'window.__APP__.token', 1)).resolves.toBe('"FROM-IFRAME-SCRIPT"')
    const evaluate = view.transport.commands.find((c) => c.method === 'Runtime.evaluate')
    expect(evaluate?.params?.contextId).toBe(42)
    expect(view.transport.commands.map((c) => c.method)).not.toContain('Page.createIsolatedWorld')
  })

  it('拿不到默认世界时报 not-found，不静默退回隔离世界', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    opened.push({ runtime, dir })
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.handler = (method) => {
      if (method === 'Page.getFrameTree') return FRAME_TREE
      if (method === 'Runtime.evaluate') return { result: { value: 'SHOULD-NOT-RUN' } }
      return {}
    }
    const err = await runtime.eval(1, 'window.__APP__', 1).catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('not-found')
    expect(view.transport.commands.map((c) => c.method)).not.toContain('Page.createIsolatedWorld')
    expect(view.transport.commands.map((c) => c.method)).not.toContain('Runtime.evaluate')
  })

  it('frame 0 依旧不带 contextId（语义不变）', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    opened.push({ runtime, dir })
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.handler = (method) => (method === 'Runtime.evaluate' ? { result: { value: 1 } } : {})
    await runtime.eval(1, '1 + 0')
    const evaluate = view.transport.commands.find((c) => c.method === 'Runtime.evaluate')
    expect(evaluate?.params?.contextId).toBeUndefined()
    expect(view.transport.commands.map((c) => c.method)).not.toContain('Page.getFrameTree')
  })

  it('frame 越界仍然报 not-found', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    opened.push({ runtime, dir })
    await runtime.open('https://a.example')
    adapter.lastView().transport.handler = (method) => (method === 'Page.getFrameTree' ? FRAME_TREE : {})
    const err = await runtime.eval(1, 'window.__APP__', 9).catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('not-found')
    expect((err as Error).message).toContain('does not exist')
  })
})
