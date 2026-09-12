/**
 * 真机工具诊断报告（2026-09-12，`session-c66cc9f4`）驱动的问题复现。
 *
 * 报告在真机上实测 64 个自带工具，判定 2 个缺陷 + 1 个行为差异 + 1 个护栏误拦。
 * 本 spec 把它们钉在代码层：每条断言都对应报告里的一次真机观察，修复前必须红。
 *
 * 1. `browser_screenshot` 报
 *    `"value.image.name" is not a declared property (additionalProperties: false)`。
 *    输出 schema 只声明了 5 个字段，而 `ImageAttachmentRef` 还有可选的 `name`
 *    与 `originalDimensions`——工具的返回值被自己的声明拒收。
 * 2. 同一次诊断里 `browser_screenshot` 还有一次 30s 超时。`capturePage()` 在隐藏
 *    窗口下**挂起**（不 reject），而兜底只在 reject 时触发，于是 CDP 那条永远走不到。
 * 3. `skill_manage action=patch` 永远报"必须先读取"——见
 *    `packages/vendor/memory-evolve/tests/skills.test.js`（该包自己的用例）。
 * 4. `browser_wait_for url-change` 超时只报 `page not ready`——真正的原因被
 *    `catch {}` 吞掉，真机上无法判断是"页面没变"还是"求值失败"。
 * 5. `browser_eval` 把 `document.documentElement.outerHTML`（纯读取）判成
 *    side-effect API 拒收。赋值语句本来就被单表达式护栏挡住，读位置不可能构成写。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import { applyBrowserTools } from '../src/tools.ts'
import { validateEvalExpression } from '../src/eval-policy.ts'
import { BrowserError } from '../src/errors.ts'
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
  bounds: NativeBounds = { x: 0, y: 0, width: 0, height: 0 }
  url = ''
  title = ''
  destroyed = false
  partition = 'persist:agent-browser-test'
  image: NativeImage | null = fakeImage(1280, 800)
  /** Simulate the hidden-window surface failure: `capturePage` rejects. */
  captureError: Error | null = null
  /** Simulate the worse hidden-window state: `capturePage` never settles. */
  captureHangs = false
  loadURL = vi.fn(async (u: string) => { this.url = u; this.emit('did-stop-loading') })
  downloadURL = vi.fn()
  goBack = vi.fn(() => { this.emit('did-finish-load') })
  goForward = vi.fn(() => { this.emit('did-finish-load') })
  reload = vi.fn(() => { this.emit('did-finish-load') })
  capturePage = vi.fn(() => {
    if (this.captureHangs) return new Promise<NativeImage>(() => {})
    if (this.captureError !== null) return Promise.reject(this.captureError)
    return Promise.resolve(this.image as NativeImage)
  })
  setWindowOpenHandler = vi.fn()
  attach(_win: unknown, bounds: NativeBounds): void { this.bounds = bounds }
  setBounds(b: NativeBounds): void { this.bounds = b }
  setVisible(): void {}
  detach(): void {}
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
  partitionSession = new MockSession()
  showSaveDialog = vi.fn(async () => ({ canceled: true }))
  openPath = vi.fn(async () => ({}))
  createView(): NativeView { const v = new MockView(); this.views.push(v); return v }
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
  getSession(): NativeSession { return this.partitionSession }
  lastView(): MockView { return this.views.at(-1)! }
}

function makeRuntime(options: Record<string, unknown> = {}): { runtime: BrowserRuntime; adapter: MockAdapter; dir: string } {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.diag-store-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(adapter as never, options as never, undefined, undefined, { store })
  return { runtime, adapter, dir }
}

/** Capture the registered tool definitions out of a `applyBrowserTools` call. */
function captureTools(runtime: BrowserRuntime): Map<string, Record<string, unknown>> {
  const tools = new Map<string, Record<string, unknown>>()
  const ctx = {
    tools: { register: (definition: { name: string }) => { tools.set(definition.name, definition as never); return () => {} } },
    systemPrompt: { section: () => () => {} },
    attachments: {
      saveImages: async (inputs: Array<{ name?: string }>) => inputs.map((input, index) => ({
        attachmentId: `sha256:${index}`,
        mediaType: 'image/jpeg',
        bytes: 4,
        width: 1280,
        height: 800,
        ...(input.name !== undefined ? { name: input.name } : {}),
      })),
    },
  } as unknown as Parameters<typeof applyBrowserTools>[0]
  applyBrowserTools(ctx, runtime)
  return tools
}

afterEach(() => {
  const dir = join(process.cwd(), 'tests')
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.diag-store')) rmSync(join(dir, name), { recursive: true, force: true })
    }
  } catch { /* best effort */ }
})

// ------------------------------------------- 缺陷 1：返回值被自己的 schema 拒收

describe('缺陷 1：browser_screenshot 的输出 schema 必须容纳附件引用的全部字段', () => {
  it('声明 name —— 工具确实会返回它（真机报 "value.image.name is not a declared property"）', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    await runtime.open('https://a.example')
    adapter.lastView().captureError = new Error('no surface')
    adapter.lastView().transport.handler = (method) => {
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } }
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('frame').toString('base64') }
      return {}
    }

    const tools = captureTools(runtime)
    const screenshot = tools.get('browser_screenshot') as {
      output: { schema: { properties: { image: { additionalProperties: boolean; properties: Record<string, unknown> } } } }
      execute: (args: unknown, exec: unknown) => Promise<{ image: Record<string, unknown> }>
    }

    const value = await screenshot.execute({}, { signal: new AbortController().signal, agent: undefined })
    const declared = Object.keys(screenshot.output.schema.properties.image.properties)

    // 工具真的返回了 name（tools.ts 传了 `browser-tab-N.jpg`）……
    expect(value.image.name, '前置条件：实际返回值带 name').toBe('browser-tab-1.jpg')
    // ……那声明就必须容纳它，否则校验层整条结果拒收。
    expect(declared, '声明的属性必须覆盖实际返回值').toContain('name')
    for (const key of Object.keys(value.image)) {
      expect(declared, `返回字段 ${key} 未在 output schema 中声明`).toContain(key)
    }
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  })
})

// ------------------------------ 缺陷 2：capturePage 挂起时兜底路径永远走不到

describe('缺陷 2：capturePage 挂起（不只是 reject）也要退到 CDP 抓帧', () => {
  it('capturePage 永不 settle 时仍能在工具预算内返回渲染器侧抓帧', async () => {
    // 短预算：原生抓帧的上限跟着 timeoutMs 走，测试不必等 8s 默认值。
    const { runtime, adapter, dir } = makeRuntime({ timeoutMs: 600 })
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.captureHangs = true
    const frame = Buffer.from('renderer-frame').toString('base64')
    view.transport.handler = (method) => {
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } }
      if (method === 'Page.captureScreenshot') return { data: frame }
      return {}
    }

    // 真机第一次失败的形态：30s 后工具超时。挂起必须被兜底吸收，而不是拖到超时。
    await expect(runtime.screenshot(1)).resolves.toBe(`data:image/jpeg;base64,${frame}`)
    expect(view.transport.commands.some((c) => c.method === 'Page.captureScreenshot')).toBe(true)
    expect(runtime.opLog.find((entry) => entry.tool === 'browser_screenshot')?.failed).toBeFalsy()
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  }, 20_000)
})

// --------------------------------- 缺陷 3：读前置检查读的是被移除的 .events

// 缺陷 3（`skill_manage` 的 read-before-patch 读的是被移除的 `.events`）属于
// `packages/vendor/memory-evolve`，它的双形状断言在 `tests/skills.test.js` 里。

// ------------------------------- 缺陷 4：wait_for 把真正的原因吞成 "page not ready"

describe('缺陷 4：browser_wait_for 超时必须报出求值失败的真实原因', () => {
  it('页面侧求值一直抛错时，reason 带上底层错误而不是笼统的 page not ready', async () => {
    const { runtime, adapter, dir } = makeRuntime({ timeoutMs: 600 })
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.handler = (method) => {
      if (method === 'Runtime.evaluate') throw new Error('Cannot find context with specified id')
      return {}
    }

    const result = await runtime.waitFor(1, { condition: 'url-change', timeoutMs: 400 })

    expect(result.ok).toBe(false)
    expect(result.reason, '必须能看出是求值失败而不是页面没变').toMatch(/Cannot find context/u)
    runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  }, 20_000)
})

// ----------------------------- 缺陷 5：outerHTML 是纯读取，却被判成写 API

describe('缺陷 5：browser_eval 不应把 outerHTML/innerHTML 的**读取**当副作用', () => {
  it('读 DOM 快照的表达式被接受', () => {
    for (const expression of [
      'document.documentElement.outerHTML',
      'document.body.innerHTML',
      'document.querySelector("#a").outerHTML',
    ]) {
      expect(() => validateEvalExpression(expression), `纯读取被误拦：${expression}`).not.toThrow()
    }
  })

  it('真正的写路径仍然被单表达式护栏挡住', () => {
    for (const expression of [
      'document.body.innerHTML = "x"',
      'document.querySelector("#a").outerHTML = "x"',
    ]) {
      let thrown: unknown
      try {
        validateEvalExpression(expression)
      } catch (error) {
        thrown = error
      }
      expect(thrown, `写路径必须继续拒绝：${expression}`).toBeInstanceOf(BrowserError)
    }
  })

  it('其余副作用 API 的拦截没有被这次放宽带走', () => {
    for (const expression of [
      `localStorage.setItem('a','b')`,
      `document.querySelector('#f').submit()`,
      `document.querySelector('#a').remove()`,
    ]) {
      expect(() => validateEvalExpression(expression), `副作用 API 漏放：${expression}`).toThrow(BrowserError)
    }
  })
})
