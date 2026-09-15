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
      return String(params?.['expression'] ?? '').includes('KeyboardEvent') ? { result: { value: 'dispatched' } } : {}
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

  it('工具描述与系统提示词都写明"只有用户能交回控制权"', () => {
    const harness = track(makeHarness())
    const takeover = harness.tools.get('browser_takeover')!
    expect(takeover.description).toMatch(/NO model-side counterpart/u)
    expect(takeover.description).toMatch(/交给 AI/u)
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

  it('部署没有暴露 origin 能力时维持现状（本轮生产形态，不误杀）', async () => {
    const resolver = (async () => ({ username: 'alice', password: SECRET })) as CredentialResolverLike
    const harness = track(makeHarness({}, resolver))
    await harness.runtime.open('https://anywhere.example/')
    harness.adapter.lastView().transport.handler = fillHandler
    await expect(harness.call('browser_fill_credentials', { connectorId: 'corp' })).resolves.toEqual({ username: true, password: true })
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
    expect(tool.timeoutMs).toBe(40_000)
    expect(tool.description).toContain('40000')
    expect(tool.description).toContain('120000')
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

  function textStub(harness: Harness, text: string): void {
    harness.adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      return String(params?.['expression'] ?? '').includes('innerText') ? { result: { value: text } } : {}
    }
  }

  it('散文里紧跟凭据键名的短口令被擦除（审计实测：your password abc123 is wrong）', async () => {
    const resolver = (async () => ({ username: 'alice', password: SHORT })) as CredentialResolverLike
    const harness = track(makeHarness({}, resolver))
    await harness.runtime.open('https://login.example/form')
    await injectShortPassword(harness)

    textStub(harness, `your password ${SHORT} is wrong`)
    const value = await harness.call('browser_get_text', {}) as { text: string }
    expect(value.text).toBe('your password **** is wrong')
  })

  it('非凭据键名的散文不误伤（order abc123 confirmed 逐字节不变）', async () => {
    const resolver = (async () => ({ username: 'alice', password: SHORT })) as CredentialResolverLike
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
    const resolver = (async () => ({ username: 'alice', password: SHORT })) as CredentialResolverLike
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
    const resolver = (async () => ({ username: 'alice', password: SHORT })) as CredentialResolverLike
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

describe('2026-09-15：takeover 仍走用户闸（回归护栏）', () => {
  it('browser_takeover 让 agent 操作排队等待', async () => {
    const harness = track(makeHarness())
    await harness.runtime.open('https://a.example')
    await expect(harness.call('browser_takeover', {})).resolves.toEqual({ ok: true })
    expect(harness.runtime.controlled).toBe(true)
    expect(harness.runtime.opLog.find((entry) => entry.tool === 'browser_takeover')?.actor).toBe('ai')
  })
})
