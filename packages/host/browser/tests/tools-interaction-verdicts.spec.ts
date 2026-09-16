/**
 * 2026-09-15 全量审计实测缺陷的回归（**模型侧工具面**）。
 *
 * 覆盖：
 * - P2 `browser_press` / `browser_scroll` 静默成功：页内派发返回 `'none'` /
 *   `'not found'` 时工具仍回 `{ok:true}`、oplog 还记成功 ⇒ 现在映射成明确的
 *   not-found 失败（工具层，runtime 冻结）。
 * - P2 `browser_get_text` 的 `truncated` 由 runtime 的文字漏斗给出：旧工具口径
 *   `text.length >= runtime.options.textLimit` 在 `textLimit=65536` 时把一条已被
 *   32KiB 截断的文本判成"未截断"。
 * - P2 快照静默截断/盲区：工具输出必须带 `truncated`/`total`/`note`。
 * - P1 `browser_release` 从模型工具面移除（控制权只能由用户点「交给 AI」交回），
 *   但 runtime 的 `setUserControl` 能力保留（用户按钮/关闭浏览器仍在用）。
 * - P2 `browser_fill_credentials` 的站点绑定（origin 不一致/记录没有 URL ⇒ 拒绝）。
 * - P2 `browser_wait_for` 的 `timeoutMs` 实际生效上限写进描述（工具体 40000ms
 *   先于 runtime 的 120000ms 生效）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import { DEFAULT_GROUPS, applyBrowserTools, parseToolGroups } from '../src/tools.ts'
import type { ElectronAdapter, NativeBounds, NativeSession, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

// ------------------------------------------------------------------ mocks

class MockTransport implements CdpTransport {
  attached = false
  commands: Array<{ method: string; params?: Record<string, unknown> }> = []
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
  partition = 'persist:agent-browser-tools'
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
  partition = 'persist:agent-browser-tools'
  loadURL = vi.fn(async (u: string) => { this.url = u; this.emit('did-stop-loading') })
  downloadURL = vi.fn()
  goBack = vi.fn(() => { this.emit('did-finish-load') })
  goForward = vi.fn(() => { this.emit('did-finish-load') })
  reload = vi.fn(() => { this.emit('did-finish-load') })
  capturePage = vi.fn(async () => ({ getSize: () => ({ width: 10, height: 10 }), resize: () => ({}), toJPEG: () => Buffer.from('x') }))
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
  createView(): NativeView { const view = new MockView(); this.views.push(view); return view }
  createMaskView(): NativeView { const view = new MockView(); this.overlays.push(view); return view }
  createBrowserWindow(): never {
    const window = { visible: false, destroyed: false }
    this.windows.push(window)
    return {
      loadURL: async () => {},
      show: () => { window.visible = true },
      hide: () => { window.visible = false },
      focus: () => {},
      isVisible: () => window.visible,
      isDestroyed: () => window.destroyed,
      close: () => { window.destroyed = true },
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

type CredentialResolverLike = ((id: string) => Promise<{ username?: string; password?: string } | null>) & {
  list?: () => Promise<Array<{ id: string; username?: string }>>
  originOf?: (id: string) => Promise<string | null | undefined> | string | null | undefined
}

interface ToolDefinition {
  name: string
  description: string
  /** defineTool 把参数表转成了 JSON Schema。 */
  parameters: { properties?: Record<string, { description?: string }> }
  timeoutMs?: number
  execute: (args: unknown, exec: unknown) => Promise<unknown>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text?: string }> }
}

interface Harness {
  runtime: BrowserRuntime
  adapter: MockAdapter
  dir: string
  tools: Map<string, ToolDefinition>
  call: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  dispose: () => void
}

function makeHarness(options: Record<string, unknown> = {}, credentials?: CredentialResolverLike): Harness {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.bta-store-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(adapter as never, options, credentials as never, undefined, { store })
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
      if (name.startsWith('.bta-store')) rmSync(join(process.cwd(), 'tests', name), { recursive: true, force: true })
    }
  } catch { /* best effort */ }
})

async function fail(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise
  } catch (error) {
    return error as { code?: string; message: string }
  }
  throw new Error('expected the call to fail')
}

// ------------------------------------------- P2: press / scroll 不再假成功

describe('2026-09-15 P2：browser_press / browser_scroll 不得静默成功', () => {
  it('press：页内兜底报 none ⇒ 工具失败（not-found），oplog 也记失败', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    // 窗口是隐藏的（产品决策），pressKey 走 DOM 派发；这里让它返回 'none'
    harness.adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      return String(params?.['expression'] ?? '').includes('KeyboardEvent') ? { result: { value: 'none' } } : {}
    }

    const error = await fail(harness.call('browser_press', { key: 'Enter' }))
    expect(error.code).toBe('not-found')
    expect(error.message).toMatch(/not delivered/u)
    expect(harness.runtime.opLog.find((entry) => entry.tool === 'browser_press')?.failed).toBe(true)
  })

  it('press：页内派发成功时照常返回 ok（不误伤）', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    harness.adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.['expression'] ?? '')
      // 接收判定（P3）：可见/隐藏两条路径都要先读"谁在接收"。
      if (expression.includes('activeElement')) return { result: { value: 'INPUT' } }
      return expression.includes('KeyboardEvent') ? { result: { value: 'dispatched' } } : {}
    }
    await expect(harness.call('browser_press', { key: 'Enter' })).resolves.toEqual({ ok: true })
    expect(harness.runtime.opLog.find((entry) => entry.tool === 'browser_press')?.failed).toBe(false)
  })

  it('scroll：目标元素不存在 ⇒ not-found，而不是"已滚动"', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    harness.adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.['expression'] ?? '')
      // locateElement 的读回脚本（inline: 'center'）报告元素不存在
      if (expression.includes('inline')) return { result: { value: { error: 'element not found' } } }
      return { result: { value: 'ok' } }
    }

    const error = await fail(harness.call('browser_scroll', { target: '#nope' }))
    expect(error.code).toBe('not-found')
    expect(error.message).toContain('cannot locate element')
  })

  it('scroll：目标存在 ⇒ 正常返回 ok（两段脚本都下发）', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    const view = harness.adapter.lastView()
    view.transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.['expression'] ?? '')
      if (expression.includes('inline')) return { result: { value: { x: 12, y: 34 } } }
      return { result: { value: 'ok' } }
    }

    await expect(harness.call('browser_scroll', { target: '#ok' })).resolves.toEqual({ ok: true })
    const expressions = view.transport.commands
      .filter((command) => command.method === 'Runtime.evaluate')
      .map((command) => String(command.params?.['expression'] ?? ''))
    expect(expressions.some((expression) => expression.includes('inline'))).toBe(true)
    expect(expressions.some((expression) => expression.includes('scrollIntoView') && !expression.includes('inline'))).toBe(true)
  })

  it('scroll：纯 deltaY 滚动不需要元素（保持原样）', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    harness.adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      return { result: { value: 'ok' } }
    }
    await expect(harness.call('browser_scroll', { deltaY: 200 })).resolves.toEqual({ ok: true })
  })
})

// ------------------------------------------- P2: truncated / 快照盲区

describe('2026-09-15 P2：读取输出的真实截断与盲区', () => {
  it('browser_get_text：textLimit=65536 + 40000 字符 ⇒ truncated=true', async () => {
    const harness = track(makeHarness({ textLimit: 65_536 }))
    await harness.runtime.open('https://a.example')
    harness.adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      return String(params?.['expression'] ?? '').includes('innerText') ? { result: { value: 'a'.repeat(40_000) } } : {}
    }

    const value = await harness.call('browser_get_text', {}) as { text: string; truncated: boolean }
    expect(value.text).toHaveLength(32 * 1024)
    expect(value.truncated).toBe(true)
    // 反向对照：旧口径 `text.length >= runtime.options.textLimit`（65536）会判 false
    expect(value.text.length >= 65_536).toBe(false)
  })

  it('browser_get_snapshot：截断与盲区写进工具输出（truncated/total/note）', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    harness.adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.['expression'] ?? '')
      if (!expression.includes('querySelectorAll')) return {}
      return {
        result: {
          value: {
            elements: [
              { kind: 'button', text: 'Sign in', selector: '#go', visible: true, disabled: false },
              { kind: 'link', text: 'Help', selector: '#help', visible: true, disabled: false },
            ],
            total: 57,
            truncated: true,
            frames: 2,
            shadowRoots: 1,
            shadowScanCapped: false,
            countCapped: false,
          },
        },
      }
    }

    const tool = harness.tools.get('browser_get_snapshot')!
    const value = await tool.execute({}, { agent: undefined, signal: new AbortController().signal }) as {
      elements: Array<{ text: string }>
      truncated: boolean
      total: number
      note?: string
    }
    expect(value.elements).toHaveLength(2)
    expect(value.truncated).toBe(true)
    expect(value.total).toBe(57)
    expect(value.note).toContain('only 2 of 57')
    expect(value.note).toContain('2 sub-frames')
    expect(value.note).toContain('1 shadow root')
    // 渲染文本里也要出现（模型读的是这一段）
    const rendered = tool.output.render({}, value).map((part) => part.text ?? '').join('\n')
    expect(rendered).toContain('only 2 of 57')
    expect(rendered).toContain('Sign in')
  })

  it('browser_get_snapshot：完整列表不带噪音 note', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    harness.adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      return String(params?.['expression'] ?? '').includes('querySelectorAll')
        ? { result: { value: { elements: [], total: 0, truncated: false, frames: 0, shadowRoots: 0 } } }
        : {}
    }
    const value = await harness.call('browser_get_snapshot', {}) as { note?: string; truncated: boolean }
    expect(value.truncated).toBe(false)
    expect(value.note).toBeUndefined()
  })
})

// ------------------------------------------- P1: browser_release 移除

describe('2026-09-15 P1：browser_release 不在模型工具面上', () => {
  it('注册表里没有 browser_release，browser_takeover 仍在', () => {
    const harness = track(makeHarness())
    const names = [...harness.tools.keys()]
    expect(names).not.toContain('browser_release')
    expect(names).toContain('browser_takeover')
    expect(names).toHaveLength(31)
  })

  it('control 分组的工具集合被钉死（移除后不能悄悄长回来）', () => {
    const harness = track(makeHarness())
    const control = [...harness.tools.values()]
      .filter((tool) => ['browser_takeover', 'browser_fill_credentials', 'browser_clear_data', 'browser_credentials_list'].includes(tool.name))
      .map((tool) => tool.name)
      .sort()
    expect(control).toEqual(['browser_clear_data', 'browser_credentials_list', 'browser_fill_credentials', 'browser_takeover'])
    // 分组解析本身不认识 browser_release（GROUP_OF 里已删）
    expect([...parseToolGroups(['control'])]).toEqual(['control'])
    expect([...DEFAULT_GROUPS]).not.toContain('browser_release')
  })

  it('工具描述与系统提示词都写明"只有用户能交回控制权"（2026-09-16 i18n：模型面统一英文，按功能描述而非写死按钮名）', () => {
    const harness = track(makeHarness())
    const takeover = harness.tools.get('browser_takeover')!
    expect(takeover.description).toMatch(/NO model-side counterpart/u)
    expect(takeover.description).toMatch(/the hand-back control in the browser window/u)
    expect(takeover.description).not.toMatch(/交给 AI|我来操作/u)
  })

  it('runtime 的 setUserControl 能力保留（用户按钮/关闭浏览器仍然用它）', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    harness.runtime.setUserControl(true, 'user')
    expect(harness.runtime.controlled).toBe(true)
    // 用户点「交给 AI」：actor=user 的记录路径仍可用
    harness.runtime.setUserControl(false, 'user')
    expect(harness.runtime.controlled).toBe(false)
    expect(harness.runtime.opLog.some((entry) => entry.tool === 'browser_release' && entry.actor === 'user')).toBe(true)
  })
})

// ------------------------------------------- P2: 凭据站点绑定

describe('2026-09-15 P2：browser_fill_credentials 的站点绑定', () => {
  const SECRET = 'hunter2-xyz9-quartz'

  function resolverWithOrigin(origin: string | null | undefined): CredentialResolverLike {
    const resolver = (async (id: string) => (id === 'corp' ? { username: 'alice', password: SECRET } : null)) as CredentialResolverLike
    resolver.originOf = async () => origin
    return resolver
  }

  const fillHandler = (method: string, params?: Record<string, unknown>): unknown => {
    if (method !== 'Runtime.evaluate') return {}
    return String(params?.['expression'] ?? '').includes('passField') ? { result: { value: { filled: 2, username: true, password: true } } } : {}
  }

  it('origin 不一致 ⇒ policy 拒绝，且一个字节都没注入', async () => {
    const harness = track(makeHarness({}, resolverWithOrigin('https://login.example')))
    await harness.runtime.open('https://login.example.evil.test/')
    const view = harness.adapter.lastView()
    view.transport.handler = fillHandler

    const error = await fail(harness.call('browser_fill_credentials', { connectorId: 'corp' }))
    expect(error.code).toBe('policy')
    expect(error.message).toContain('https://login.example.evil.test')
    expect(error.message).toContain('https://login.example')
    expect(view.transport.commands.some((command) => String(command.params?.['expression'] ?? '').includes('passField'))).toBe(false)
  })

  it('origin 一致 ⇒ 照常注入（不误杀）', async () => {
    const harness = track(makeHarness({}, resolverWithOrigin('https://login.example/page')))
    await harness.runtime.open('https://login.example/login')
    harness.adapter.lastView().transport.handler = fillHandler
    await expect(harness.call('browser_fill_credentials', { connectorId: 'corp' })).resolves.toEqual({ username: true, password: true })
  })

  it('连接器记录里没有可用 URL ⇒ 拒绝并说明原因', async () => {
    const harness = track(makeHarness({}, resolverWithOrigin(null)))
    await harness.runtime.open('https://login.example/')
    harness.adapter.lastView().transport.handler = fillHandler
    const error = await fail(harness.call('browser_fill_credentials', { connectorId: 'corp' }))
    expect(error.code).toBe('policy')
    expect(error.message).toMatch(/no usable http\(s\) site URL/u)
  })

  it('部署没暴露 origin 能力 ⇒ fail-closed 拒绝（BUG-03：旧的"维持现状"就是漏洞本身）', async () => {
    const resolver = (async () => ({ username: 'alice', password: SECRET })) as CredentialResolverLike
    const harness = track(makeHarness({}, resolver))
    await harness.runtime.open('https://anywhere.example/')
    const view = harness.adapter.lastView()
    view.transport.handler = fillHandler
    const error = await fail(harness.call('browser_fill_credentials', { connectorId: 'corp' }))
    expect(error.code).toBe('policy')
    expect(error.message).toMatch(/no connector site URL/u)
    // 一个字节都没注入
    expect(view.transport.commands.some((command) => String(command.params?.['expression'] ?? '').includes('passField'))).toBe(false)
  })

  it('检查与注入之间标签页导航走 ⇒ 临界区内复核后拒绝（TOCTOU 收口）', async () => {
    let harness: Harness | undefined
    let navigateOnLookup = false
    // The secret is the previously injected password; the hostile page puts it
    // in a URL longer than the 200-char cap, crossing the cut so a "cap first,
    // redact second" order would leak its head fragment (R4 BUG-1).
    const secret = 'ZZTOP98765'
    const prefix = 'https://login.example.evil.test/landing?'
    const fillerLen = 195 - `${prefix}&pwd=`.length
    const evilUrl = `${prefix}${'a'.repeat(fillerLen)}&pwd=${secret}`
    const resolver = (async (id: string) => {
      // 工具层的 origin 检查已经通过；就在"取凭据"这一步把同一标签页的 URL 改掉，
      // 模拟排队/取凭据期间发生的导航（旧实现会照常把凭据注入新页面）。
      if (navigateOnLookup && harness !== undefined) {
        await harness.runtime.navigate(1, evilUrl, 'domcontentloaded')
      }
      return id === 'corp' ? { username: 'alice', password: secret } : null
    }) as CredentialResolverLike
    resolver.originOf = async () => 'https://login.example'
    const bound = track(makeHarness({}, resolver))
    harness = bound
    await bound.runtime.open('https://login.example/login')
    const view = bound.adapter.lastView()
    view.transport.handler = fillHandler

    // A first, legitimate injection leaves the password in the tab's filled
    // secret set, which the refusal message must erase.
    await bound.call('browser_fill_credentials', { connectorId: 'corp' })
    navigateOnLookup = true
    // Snapshot the DOM-write commands BEFORE the refused call: the first
    // injection already pushed one containing `passField`, so a plain `.some()`
    // afterwards is true either way and stops guarding the TOCTOU fence
    // (2026-09-16 R9 audit).
    const writesBefore = view.transport.commands.length

    const error = await fail(bound.call('browser_fill_credentials', { connectorId: 'corp' }))
    expect(error.code).toBe('policy')
    expect(error.message).toMatch(/left https:\/\/login\.example before the injection/u)
    // 先擦除再截断：不得留下跳转 URL 里的一次性 code/ticket，更不得留下口令前缀。
    expect(error.message).not.toContain(secret)
    expect(error.message).not.toContain('ZZTOP')
    expect(error.message).toContain('****')
    // The refused call must not have written the credential into the page: no
    // NEW command may carry the fill expression.
    const writesDuringRefusal = view.transport.commands
      .slice(writesBefore)
      .filter((command) => String(command.params?.['expression'] ?? '').includes('passField'))
    expect(writesDuringRefusal).toHaveLength(0)
    // ...while the legitimate injection did write it (the probe is not vacuous).
    expect(view.transport.commands
      .slice(0, writesBefore)
      .some((command) => String(command.params?.['expression'] ?? '').includes('passField'))).toBe(true)
  })

  it('描述文案写明站点绑定（对外契约同步）', () => {
    const harness = track(makeHarness())
    expect(harness.tools.get('browser_fill_credentials')!.description).toMatch(/SITE-BOUND/u)
  })
})

// ------------------------------------------- P2: wait_for 上限文案

describe('2026-09-15 P2：browser_wait_for 的实际生效上限写进描述', () => {
  it('描述与参数都写明 40000ms（工具体预算），并说明 runtime 的 120000ms 够不到', () => {
    const harness = track(makeHarness())
    const tool = harness.tools.get('browser_wait_for')!
    expect(tool.timeoutMs).toBe(55_000)
    expect(tool.description).toContain('40000')
    expect(tool.description).toContain('55')
    const timeout = tool.parameters.properties?.['timeoutMs']?.description ?? ''
    expect(timeout).toContain('40000')
    expect(timeout).toContain('30000')
  })
})

// ------------------------------------------- P1: 短凭据在散文里也要擦除

describe('2026-09-15 P1：短凭据的散文擦除（模型面文本出口）', () => {
  const SHORT = 'abc123'

  /** 注入一次短口令：fillCredentials 的页内脚本由桩确认，之后改写文本桩。 */
  async function injectShortPassword(harness: Harness): Promise<void> {
    const view = harness.adapter.lastView()
    view.transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      return String(params?.['expression'] ?? '').includes('passField')
        ? { result: { value: { filled: 2, username: true, password: true } } }
        : {}
    }
    await harness.call('browser_fill_credentials', { connectorId: 'corp' })
  }

  /** 站点绑定（BUG-03）之后，注入前必须能解析出连接器自己的 origin。 */
  function boundResolver(): CredentialResolverLike {
    const resolver = (async () => ({ username: 'alice', password: SHORT })) as unknown as CredentialResolverLike
    resolver.originOf = async () => 'https://login.example'
    return resolver
  }

  function textStub(harness: Harness, text: string): void {
    harness.adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      return String(params?.['expression'] ?? '').includes('innerText') ? { result: { value: text } } : {}
    }
  }

  it('散文里紧跟凭据键名的短口令被擦除（审计实测：your password abc123 is wrong）', async () => {
    const resolver = boundResolver()
    const harness = track(makeHarness({}, resolver))
    await harness.runtime.open('https://login.example/form')
    await injectShortPassword(harness)

    textStub(harness, `your password ${SHORT} is wrong`)
    const value = await harness.call('browser_get_text', {}) as { text: string }
    expect(value.text).toBe('your password **** is wrong')
  })

  it('非凭据键名的散文不误伤（order abc123 confirmed 逐字节不变）', async () => {
    const resolver = boundResolver()
    const harness = track(makeHarness({}, resolver))
    await harness.runtime.open('https://login.example/form')
    await injectShortPassword(harness)

    for (const prose of [
      `order ${SHORT} confirmed`,
      `Item (${SHORT}) shipped`,
      `Ref "${SHORT}" noted`,
      `${SHORT} is weak`,
      `keyboard ${SHORT} layout`,
    ]) {
      textStub(harness, prose)
      const value = await harness.call('browser_get_text', {}) as { text: string }
      expect(value.text, prose).toBe(prose)
    }
  })

  it('值位形态照旧擦除（= / : / 键名+括号 / 换行结尾）', async () => {
    const resolver = boundResolver()
    const harness = track(makeHarness({}, resolver))
    await harness.runtime.open('https://login.example/form')
    await injectShortPassword(harness)

    for (const [input, expected] of [
      [`pw=${SHORT}`, 'pw=****'],
      [`user:${SHORT}@host`, 'user:****@host'],
      [`token=[${SHORT}]`, 'token=[****]'],
      [`password: (${SHORT})`, 'password: (****)'],
      [`password=${SHORT}\nnext line`, 'password=****\nnext line'],
      // 键名 + 空格 + 值（R-8 新口径），值后同句继续
      [`password ${SHORT} expires soon`, 'password **** expires soon'],
    ] as const) {
      textStub(harness, input)
      const value = await harness.call('browser_get_text', {}) as { text: string }
      expect(value.text, input).toBe(expected)
    }
  })

  it('快照元素文本走同一把尺子（值位键名后的短口令）', async () => {
    const resolver = boundResolver()
    const harness = track(makeHarness({}, resolver))
    await harness.runtime.open('https://login.example/form')
    await injectShortPassword(harness)

    harness.adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      return String(params?.['expression'] ?? '').includes('querySelectorAll')
        ? {
            result: {
              value: [{
                kind: 'input',
                text: `hint: password ${SHORT} is weak`,
                selector: '#hint',
                visible: true,
                disabled: false,
              }],
            },
          }
        : {}
    }
    const value = await harness.call('browser_get_snapshot', {}) as { elements: Array<{ text: string }> }
    expect(value.elements[0]!.text).toBe('hint: password **** is weak')
  })
})

// ------------------------------------------- watch: 事件语义不回归

describe('2026-09-15：mutating store tools respect the user gate', () => {
  it('browser_bookmarks_remove waits for the user to hand control back', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    const tabId = harness.runtime.currentTabId()!
    const bookmark = harness.runtime.addBookmark(tabId, 'blocked-while-controlled')
    harness.runtime.setUserControl(true, 'user')

    let settled = false
    const pending = harness.call('browser_bookmarks_remove', { id: bookmark.id }).then(
      (value) => { settled = true; return value },
      (error) => { settled = true; throw error },
    )
    await new Promise((resolve) => { setTimeout(resolve, 120) })
    expect(settled, 'mutation must not run while the user controls the browser').toBe(false)

    harness.runtime.setUserControl(false, 'user')
    await expect(pending).resolves.toEqual({ ok: true })
  })
})

describe('2026-09-15：takeover 仍走用户闸（回归护栏）', () => {
  it('browser_takeover 让 agent 操作排队等待', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    await expect(harness.call('browser_takeover', {})).resolves.toEqual({ ok: true })
    expect(harness.runtime.controlled).toBe(true)
    expect(harness.runtime.opLog.find((entry) => entry.tool === 'browser_takeover')?.actor).toBe('ai')
  })
})

// ------------------------------------------- BUG-04: fill_form 的真实页内行为

/**
 * 2026-09-15 审计 BUG-04 的行为回归。
 *
 * 与上面的桩式断言不同，这里把 runtime 真正下发的页内脚本**在 jsdom 里执行**
 * （页面上有两个 form、一个受控输入、一个未知选项的 select、一个 checkbox），
 * 断言的是"页面上真的发生了什么"：
 *   · submit 只能提交**所填字段所属**的表单（旧实现取 document.querySelector('form')
 *     = 页面第一个表单，多表单页面会误提交无关表单）；
 *   · 写入必须读回校验（受控组件吞掉赋值 ⇒ 记 missed，不再盲计数）；
 *   · 未知 select 选项 / 填不进去的字段同样进 missed；
 *   · 提交目标不唯一/不存在 ⇒ 明确失败。
 */
const JSDOM_CANDIDATES = [join(process.cwd(), 'tests'), join(process.cwd(), '..', 'cron'), join(process.cwd(), '..', '..', '..', 'server', 'webadmin')]
function loadJsdomCtor(): new (html: string, options: Record<string, unknown>) => { window: any } {
  const { createRequire } = require('node:module') as typeof import('node:module')
  for (const base of JSDOM_CANDIDATES) {
    try {
      const requireFrom = createRequire(join(base, '__fill_form_behavior__.cjs'))
      const mod = requireFrom('jsdom') as { JSDOM?: new (html: string, options: Record<string, unknown>) => { window: any } }
      if (typeof mod.JSDOM === 'function') return mod.JSDOM
    } catch { /* 换下一个候选目录 */ }
  }
  throw new Error(`fill_form 行为测试需要 jsdom；已尝试：${JSDOM_CANDIDATES.join(', ')}`)
}
const JSDOM = loadJsdomCtor()

const FILL_FORM_HTML = `<!doctype html><html><body>
  <form id="search"><input name="q" placeholder="search"><button type="submit" id="search-submit">Search</button></form>
  <form id="login">
    <input id="user" name="user">
    <input id="pwd" name="pwd" type="password">
    <input id="remember" name="remember" type="checkbox">
    <select id="plan" name="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
    <button type="submit" id="login-submit">Sign in</button>
  </form>
</body></html>`

interface DomRun {
  window: any
  submitted: string[]
  /** 页内脚本最后一次返回的值。 */
  value: unknown
}

/** 让 runtime 下发的页内脚本真的在 jsdom 文档里跑，并记录提交事件。 */
function domRun(): DomRun {
  const dom = new JSDOM(FILL_FORM_HTML, { runScripts: 'dangerously' })
  const state: DomRun = { window: dom.window, submitted: [], value: undefined }
  for (const id of ['search', 'login']) {
    const form = dom.window.document.getElementById(id) as { addEventListener: (t: string, h: (e: unknown) => void) => void }
    form.addEventListener('submit', (event: unknown) => {
      (event as { preventDefault?: () => void }).preventDefault?.()
      state.submitted.push(id)
    })
  }
  return state
}

/** 把页内脚本接到 runtime 的 CDP 求值口上（只处理 Runtime.evaluate）。 */
function attachDom(harness: Harness, run: DomRun): void {
  harness.adapter.lastView().transport.handler = (method, params) => {
    if (method !== 'Runtime.evaluate') return {}
    const expression = String(params?.['expression'] ?? '')
    const value = run.window.eval(expression) as unknown
    run.value = value
    return { result: { value } }
  }
}

describe('2026-09-15 BUG-04：browser_fill_form 的提交目标与受控写入', () => {
  it('submit 提交的是所填字段所属的表单，不是页面第一个表单', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    const run = domRun()
    attachDom(harness, run)

    await expect(harness.runtime.fillForm(1, [
      { field: 'user', value: 'alice' },
      { field: 'pwd', value: 's3cret' },
    ], true)).resolves.toEqual({ filled: 2, submitted: true, missed: [] })

    expect(run.submitted).toEqual(['login'])
    expect(run.window.document.getElementById('user').value).toBe('alice')
    expect(run.window.document.querySelector('input[name=q]').value).toBe('')
  })

  it('受控组件吞掉赋值 ⇒ 该字段记 missed，不再报告"已填"', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    const run = domRun()
    const pwd = run.window.document.getElementById('pwd')
    // React 式受控输入：实例上的 value 访问器吞掉写入、读回是旧值。
    let stored = ''
    Object.defineProperty(pwd, 'value', {
      configurable: true,
      get: () => stored,
      set: () => { /* swallowed: 页面状态没变 */ },
    })
    attachDom(harness, run)

    await expect(harness.runtime.fillForm(1, [
      { field: 'user', value: 'alice' },
      { field: 'pwd', value: 's3cret' },
    ], false)).resolves.toEqual({ filled: 1, submitted: false, missed: ['pwd'] })
    expect(stored).toBe('')
  })

  it('未知 select 选项与不可写字段都进 missed；checkbox 用 checked 语义', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    const run = domRun()
    attachDom(harness, run)

    const outcome = await harness.runtime.fillForm(1, [
      { field: 'plan', value: 'enterprise' }, // 选项不存在
      { field: 'remember', value: 'yes' },
      { field: 'nope', value: 'x' }, // 页面上没有
    ], false)
    expect(outcome.filled).toBe(1)
    expect(outcome.missed).toEqual(expect.arrayContaining(['plan', 'nope']))
    expect(run.window.document.getElementById('remember').checked).toBe(true)
  })

  it('所填字段横跨两个表单 ⇒ 拒绝猜测提交目标，明确失败', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    const run = domRun()
    attachDom(harness, run)

    const error = await fail(harness.runtime.fillForm(1, [
      { field: 'user', value: 'alice' },
      { field: 'q', value: 'picoaide' },
    ], true))
    expect(error.message).toMatch(/ambiguous/u)
    expect(run.submitted).toEqual([])
  })

  it('字段不在任何表单里却要求提交 ⇒ 明确失败（不静默 submitted:false）', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    const run = domRun()
    run.window.document.body.insertAdjacentHTML('beforeend', '<input id="loose" name="loose">')
    attachDom(harness, run)

    const error = await fail(harness.runtime.fillForm(1, [{ field: 'loose', value: 'x' }], true))
    expect(error.message).toMatch(/not inside a form/u)
    expect(run.submitted).toEqual([])
  })
})

// ------------------------------------------- BUG-05: 接管检查点

describe('2026-09-15 BUG-05：用户接管必须中止已在跑的长操作', () => {
  /** 让"加载完成"发生在用户接管之后：模拟一次已经在跑的操作被接管打断。 */
  function takeoverDuringLoad(harness: Harness): void {
    const view = harness.adapter.lastView()
    view.reload = vi.fn(() => { harness.runtime.setUserControl(true); view.emit('did-finish-load') }) as never
    view.goBack = vi.fn(() => { harness.runtime.setUserControl(true); view.emit('did-finish-load') }) as never
    view.goForward = vi.fn(() => { harness.runtime.setUserControl(true); view.emit('did-finish-load') }) as never
  }

  it('reload / goBack / goForward 在接管后报 window-controlled', async () => {
    for (const op of ['reload', 'goBack', 'goForward'] as const) {
      const harness = track(makeHarness())
      await harness.runtime.open('https://a.example')
      takeoverDuringLoad(harness)
      const error = await fail(harness.runtime[op](1))
      expect(error.code, op).toBe('window-controlled')
      expect(harness.runtime.opLog.some((entry) => entry.tool === `browser_${op === 'goBack' ? 'go_back' : op === 'goForward' ? 'go_forward' : 'reload'}` && entry.failed !== true)).toBe(false)
    }
  })

  it('screenshot 在渲染期间被接管 ⇒ 拒绝把画面交给模型', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    const view = harness.adapter.lastView()
    view.capturePage = vi.fn(async () => {
      harness.runtime.setUserControl(true)
      return { getSize: () => ({ width: 10, height: 10 }), resize: () => ({}), toJPEG: () => Buffer.from('x') }
    }) as never
    const error = await fail(harness.runtime.screenshot(1))
    expect(error.code).toBe('window-controlled')
  })

  it('用户路径（user=true）不受接管检查点影响', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    takeoverDuringLoad(harness)
    await expect(harness.runtime.reload(1, undefined, true)).resolves.toBeUndefined()
  })
})

// ------------------------------------------- P3: press 的读回与 scroll 的页内判定

describe('2026-09-15 P3：scroll 的页内判定', () => {
  it('runtime.scroll 的页内判定为 not found ⇒ 抛 not-found，而不是记一条成功', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    harness.adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.['expression'] ?? '')
      return expression.includes('scrollIntoView') ? { result: { value: 'not found' } } : { result: { value: 'ok' } }
    }
    const error = await fail(harness.runtime.scroll(1, 0, '#nope'))
    expect(error.code).toBe('not-found')
    expect(harness.runtime.opLog.some((entry) => entry.tool === 'browser_scroll')).toBe(false)
  })
})
