/**
 * 2026-09-13 R-1…R-4 回归锁（browser 模块）。每条都有对应的真机证据：
 * `tests/probes/outlet-egress-probe.mjs`（R-1/R-2/R-3）与
 * `tests/probes/frame-index-probe.mjs`（R-4），在真 Electron + 真 CDP 上跑；
 * 本文件把同样的性质钉成无需 Electron 的回归用例。
 *
 * - **R-1** 出口统一脱敏：`browser_get_snapshot` 信封的 `url`/`title`、list_tabs、
 *   open/navigate、shellState、history/bookmark ledger、下载名、refusal 错误文本、
 *   页面文本。投影只有一处（`runtime.projectTabState` + store 写入路径）。
 * - **R-2** 注入了凭据的 tab 上 `browser_eval` 的网络写面被拒（静态）+ 页面内被
 *   禁用（shim）；普通 tab 不受影响；读完即还原页面 API。
 * - **R-3** 短口令不再误伤普通文本（词边界/长度判据），长口令仍然擦除。
 * - **R-4** `frame: N` 与 DOM 一一对应，OOPIF 纳入索引，对不上就 fail-loud。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore, stripSensitiveUrl } from '../src/store.ts'
import { applyBrowserTools } from '../src/tools.ts'
import { orderFramesByDom, isFrameOrderProblem, type FrameCandidate } from '../src/frames.ts'
import { wrapEvalExpression, EVAL_EGRESS_BLOCKED_MARKER, assertCredentialTabExpression, validateEvalExpression } from '../src/eval-policy.ts'
import type { ElectronAdapter, NativeBounds, NativeSession, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

// ------------------------------------------------------------------ mocks

class MockTransport implements CdpTransport {
  attached = false
  commands: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = []
  handler: (method: string, params?: Record<string, unknown>, sessionId?: string) => unknown = () => ({})
  private readonly messageListeners: Array<(event: unknown, method: string, params: unknown) => void> = []
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  async sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    this.commands.push({ method, ...(params === undefined ? {} : { params }), ...(sessionId === undefined ? {} : { sessionId }) })
    return this.handler(method, params, sessionId)
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
  emitNotification(method: string, params: unknown): void {
    for (const listener of [...this.messageListeners]) listener(undefined, method, params)
  }
  of(method: string): Array<{ params?: Record<string, unknown>; sessionId?: string }> {
    return this.commands.filter((command) => command.method === method)
  }
}

class MockSession implements NativeSession {
  partition = 'persist:agent-browser-r3'
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
  partition = 'persist:agent-browser-r3'
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
      on: (e: string, l: (...a: unknown[]) => void) => { this.listeners.set(e, [...(this.listeners.get(e) ?? []), l]) },
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
  partitionSession = new MockSession()
  showSaveDialog = vi.fn(async () => ({ canceled: true }))
  openPath = vi.fn(async () => ({}))
  createView(): NativeView { const v = new MockView(); this.views.push(v); return v }
  createMaskView(): NativeView { const v = new MockView(); this.overlays.push(v); return v }
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

interface Harness {
  runtime: BrowserRuntime
  adapter: MockAdapter
  store: BrowserStore
  dir: string
  tools: Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>
  call: (name: string, args?: Record<string, unknown>) => Promise<never>
}

const SECRET_URL = 'https://idp.example/cb?code=OPAQUECODE123&SAMLResponse=SAMLRESP1#access_token=FRAGACC1'
const LONG_SECRET = 'S3cr3t-Passw0rd!'
const SHORT_SECRET = 'abc123'
const exec = { signal: new AbortController().signal, agent: undefined }

function makeHarness(credentials?: (id: string) => Promise<{ username?: string; password?: string } | null>, options: Record<string, unknown> = {}): Harness {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.audit0913-store-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(adapter as never, { downloadDir: join(dir, 'downloads'), ...options }, credentials as never, undefined, { store })
  const tools = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
  applyBrowserTools({
    tools: { register: (definition: { name: string }) => { tools.set(definition.name, definition as never); return () => {} } },
    systemPrompt: { section: () => () => {} },
    attachments: { saveImages: async () => [] },
  } as never, runtime)
  return {
    runtime,
    adapter,
    store,
    dir,
    tools,
    call: async (name, args = {}) => await tools.get(name)!.execute(args, exec) as never,
  }
}

const opened: Array<{ runtime: BrowserRuntime; dir: string }> = []
function track(h: Harness): Harness {
  opened.push({ runtime: h.runtime, dir: h.dir })
  return h
}
afterEach(() => {
  for (const entry of opened.splice(0)) {
    entry.runtime.dispose()
    rmSync(entry.dir, { recursive: true, force: true })
  }
})

/** Fill the credential form of the current view (the same shape fillCredentials reads). */
async function injectCredentials(h: Harness, id: string, password: string): Promise<void> {
  h.adapter.lastView().transport.handler = (method, params) => {
    if (method !== 'Runtime.evaluate') return {}
    const expression = String(params?.['expression'] ?? '')
    if (expression.includes('passField')) return { result: { value: { filled: 2, username: true, password: true } } }
    return { result: { value: '' } }
  }
  await expect(h.runtime.fillCredentials(1, id)).resolves.toEqual({ username: true, password: true })
  void password
}

// -------------------------------------------------------------------- R-1

describe('R-1 出口统一脱敏', () => {
  it('browser_get_snapshot 信封的 url/title 与元素文本同一把尺子（不再明文）', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/login')
    const view = h.adapter.lastView()
    view.url = SECRET_URL
    view.title = `Sign in - ${SECRET_URL}`
    view.transport.handler = (method) => (method === 'Runtime.evaluate' ? { result: { value: [{ kind: 'input', text: 'user', selector: '#u', visible: true, disabled: false }] } } : {})
    h.runtime['updateTabState'](h.runtime['tab'](1))
    const out = await h.call('browser_get_snapshot', { tab: 1 })
    const json = JSON.stringify(out)
    expect(json).not.toContain('OPAQUECODE123')
    expect(json).not.toContain('SAMLRESP1')
    expect(json).not.toContain('FRAGACC1')
    expect(out.url).toContain('code=****')
    expect(out.title).toContain('#access_token=****')
  })

  it('list_tabs / open / navigate / shellState 走同一个投影', async () => {
    const h = track(makeHarness())
    const openedTab = await h.runtime.open('https://app.example/login')
    h.adapter.lastView().url = SECRET_URL
    h.runtime['updateTabState'](h.runtime['tab'](1))
    const tabs = await h.call('browser_list_tabs')
    const shell = h.runtime.shellState()
    for (const payload of [JSON.stringify(tabs), JSON.stringify(shell.tabs), JSON.stringify(openedTab)]) {
      expect(payload).not.toContain('FRAGACC1')
      expect(payload).not.toContain('SAMLRESP1')
    }
    expect(JSON.stringify(tabs)).toContain('code=****')
  })

  it('干净的 URL 逐字节不变（投影不规范化，也不改写普通地址）', () => {
    expect(stripSensitiveUrl('https://example.com')).toBe('https://example.com')
    expect(stripSensitiveUrl('https://example.com/p?q=1')).toBe('https://example.com/p?q=1')
    expect(stripSensitiveUrl('not a url')).toBe('not a url')
  })

  it('下载名脱敏：名字取自带凭据 URL 时整体打码，url 只掩码凭据部分', async () => {
    const h = track(makeHarness())
    const entry = h.store.addDownload({
      url: `https://files.example/dl/report-DLTOKEN999.zip?token=DLTOKEN999`,
      fileName: 'report-DLTOKEN999.zip',
      path: '.picoaide-downloads/report-DLTOKEN999.zip',
      size: 3,
      group: '',
      actor: 'ai',
    })
    expect(entry.url).toBe('https://files.example/dl/report-DLTOKEN999.zip?token=****')
    expect(entry.fileName).toBe('****')
    // path 是 downloads_open / 文件工具要用的真实句柄：故意保持真实（残留已记录）。
    expect(entry.path).toContain('report-DLTOKEN999.zip')
    const normal = h.store.addDownload({ url: 'https://files.example/plain.zip', fileName: 'plain.zip', path: '.picoaide-downloads/plain.zip', size: 3, group: '', actor: 'ai' })
    expect(normal.fileName).toBe('plain.zip')
  })

  it('拒绝导航的错误文本（模型可见）不再回显明文凭据', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example')
    const err = await h.runtime.navigate(1, 'ftp://u:p@h/cb?token=ERRTOKEN777').catch((e: unknown) => e)
    expect((err as Error).message).toContain('token=****')
    expect((err as Error).message).not.toContain('ERRTOKEN777')
  })

  it('ledger 落盘 url 与 title 都脱敏（url 是同款，title 常是同一个 URL）', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/login')
    const view = h.adapter.lastView()
    view.url = SECRET_URL
    view.title = `Sign in - ${SECRET_URL}`
    h.runtime['updateTabState'](h.runtime['tab'](1))
    h.runtime.saveLedger()
    const ledger = readFileSync(join(h.dir, 'groups.jsonl'), 'utf8')
    expect(ledger).not.toContain('OPAQUECODE123')
    expect(ledger).not.toContain('SAMLRESP1')
    expect(ledger).not.toContain('FRAGACC1')
    expect(ledger).toContain('code=****')
  })

  it('页面文本出口也过值级擦除（页面回显注入的口令时）', async () => {
    const h = track(makeHarness(async () => ({ password: LONG_SECRET })))
    await h.runtime.open('https://app.example/login')
    await injectCredentials(h, 'corp', LONG_SECRET)
    h.adapter.lastView().transport.handler = (method) => (method === 'Runtime.evaluate' ? { result: { value: `your password ${LONG_SECRET} is weak` } } : {})
    const text = await h.call('browser_get_text', { tab: 1 })
    expect(text.text).toBe('your password **** is weak')
  })
})

// -------------------------------------------------------------------- R-2

describe('R-2 注入凭据的 tab：eval 网络写面收敛', () => {
  it('命名了 fetch/XHR/sendBeacon/WebSocket/EventSource 的表达式被拒（静态闸），且一次都没下发', async () => {
    const h = track(makeHarness(async () => ({ password: LONG_SECRET })))
    await h.runtime.open('https://app.example/login')
    await injectCredentials(h, 'corp', LONG_SECRET)
    const view = h.adapter.lastView()
    view.transport.commands.length = 0
    // 刻意不用 `new`（那会先被通用 guardrail 以 eval-policy 拒掉，测不到凭据闸）
    for (const expression of ["fetch('/x')", "typeof XMLHttpRequest", "typeof navigator.sendBeacon", "typeof WebSocket", "typeof EventSource"]) {
      const err = await h.runtime.eval(1, expression).catch((e: unknown) => e)
      expect((err as { code?: string }).code).toBe('policy')
      expect(String((err as Error).message)).toMatch(/blocked on this tab/u)
    }
    expect(view.transport.of('Runtime.evaluate')).toHaveLength(0)
  })

  it('读表达式仍然放行，且包装里装了页面内的 egress shim（含还原）', async () => {
    const h = track(makeHarness(async () => ({ password: LONG_SECRET })))
    await h.runtime.open('https://app.example/login')
    await injectCredentials(h, 'corp', LONG_SECRET)
    h.adapter.lastView().transport.handler = (method) => (method === 'Runtime.evaluate' ? { result: { value: 2 } } : {})
    await expect(h.runtime.eval(1, "document.querySelectorAll('input').length")).resolves.toBe('2')
    const wrapped = wrapEvalExpression("document.querySelectorAll('input').length", { denyEgress: true })
    expect(wrapped).toContain(EVAL_EGRESS_BLOCKED_MARKER)
    expect(wrapped).toContain('__restores')
    expect(wrapped).toContain("'fetch'")
    expect(wrapped).toContain("'XMLHttpRequest'")
    expect(wrapped).toContain("'sendBeacon'")
    expect(wrapped).toContain("'submit'")
    // 未开启时包装保持原样（普通 tab 不受影响）
    expect(wrapEvalExpression('1 + 1')).not.toContain(EVAL_EGRESS_BLOCKED_MARKER)
  })

  it('页面内的 shim 触发时给出策略错误（不是笼统的 page script failed）', async () => {
    const h = track(makeHarness(async () => ({ password: LONG_SECRET })))
    await h.runtime.open('https://app.example/login')
    await injectCredentials(h, 'corp', LONG_SECRET)
    h.adapter.lastView().transport.handler = (method) => (method === 'Runtime.evaluate'
      ? { exceptionDetails: { text: 'Uncaught Error', exception: { description: `${EVAL_EGRESS_BLOCKED_MARKER}: fetch is disabled on this tab` } } }
      : {})
    const err = await h.runtime.eval(1, "window.__relay(document.querySelector('#pw').value)").catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('policy')
    expect(String((err as Error).message)).toMatch(/network API that is blocked/u)
  })

  it('没注入凭据的 tab 依旧允许 fetch（不误伤正常流程）', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/free')
    h.adapter.lastView().transport.handler = (method) => (method === 'Runtime.evaluate' ? { result: { value: 200 } } : {})
    await expect(h.runtime.eval(1, "fetch('/api/x').then((r) => r.status)")).resolves.toBe('200')
    // 凭据闸只对"注入了凭据的 tab"调用；函数本身当然会对 fetch 报错（这正是它的职责）。
    expect(() => assertCredentialTabExpression("fetch('/api/x')")).toThrowError(/blocked on this tab/u)
    expect(() => validateEvalExpression("fetch('/api/x')")).not.toThrow()
  })
})

// -------------------------------------------------------------------- R-3

describe('R-3 短口令不误伤、长口令仍擦除', () => {
  it('短口令：普通文本逐字保留，整值与赋值形态仍打码', async () => {
    const h = track(makeHarness(async () => ({ password: SHORT_SECRET })))
    await h.runtime.open('https://shop.example/order')
    await injectCredentials(h, 'corp', SHORT_SECRET)
    const view = h.adapter.lastView()
    // 注意 eval 出口还有一层"关键词掩码"（serializeEvalResult.maskString）：任何含
    // password/token/… 字样的**整串**会被整体打码，所以这里的用例刻意不含关键词，
    // 测的是值级擦除本身。
    const cases: Array<[string, string]> = [
      [`order ${SHORT_SECRET} confirmed`, `order ${SHORT_SECRET} confirmed`],
      [`x${SHORT_SECRET}y`, `x${SHORT_SECRET}y`],
      [`${SHORT_SECRET} is weak`, `${SHORT_SECRET} is weak`],
      [`${SHORT_SECRET}`, '****'],
      [`pw=${SHORT_SECRET}`, 'pw=****'],
      [`{"pw":"${SHORT_SECRET}"}`, '{"pw":"****"}'],
      [`value = ${SHORT_SECRET} `, 'value = **** '],
      [`user:${SHORT_SECRET}@host`, 'user:****@host'],
      [`[${SHORT_SECRET}]`, '[****]'],
    ]
    for (const [input, expected] of cases) {
      view.transport.handler = (method) => (method === 'Runtime.evaluate' ? { result: { value: input } } : {})
      // eval 出口把结果 JSON 序列化成字符串，解析回来比对原文。
      const raw = await h.runtime.eval(1, 'document.body.innerText')
      expect(JSON.parse(raw), input).toBe(expected)
    }
  })

  it('长口令：嵌在散文/截断头里也擦除（口径不放宽）', async () => {
    const h = track(makeHarness(async () => ({ password: LONG_SECRET })))
    await h.runtime.open('https://shop.example/order')
    await injectCredentials(h, 'corp', LONG_SECRET)
    const view = h.adapter.lastView()
    view.transport.handler = (method) => (method === 'Runtime.evaluate' ? { result: { value: `the stored value ${LONG_SECRET} is weak` } } : {})
    await expect(h.runtime.eval(1, 'document.body.innerText')).resolves.toBe('"the stored value **** is weak"')
    // 截断头（探针把元素文本截到 80 字符）在**快照漏斗**上按整值打码。
    view.transport.handler = (method) => (method === 'Runtime.evaluate'
      ? { result: { value: [{ kind: 'input', text: LONG_SECRET.slice(0, 12), selector: '#pw', visible: true, disabled: false }] } }
      : {})
    const snapshot = await h.runtime.snapshot(1)
    expect(snapshot[0]?.text).toBe('****')
  })
})

// -------------------------------------------------------------------- R-4

const FRAME_URL = 'https://pay.example/frame'
const OOPIF_URL = 'https://pay.example/oopif'

/** A page that mixes a cross-origin (OOPIF) iframe with a same-process one,
 *  with the OOPIF FIRST in the DOM — the shape that made the old index
 *  silently point `frame: 1` at the second iframe. */
function mixedFrameTransport(view: MockView): void {
  view.transport.handler = (method, params, sessionId) => {
    if (method === 'Page.getFrameTree') {
      if (sessionId === 'OOPIF') return { frameTree: { frame: { id: 'OOPIF-FRAME', parentId: 'MAIN', url: OOPIF_URL } } }
      return { frameTree: { frame: { id: 'MAIN', url: 'https://app.example/' }, childFrames: [{ frame: { id: 'IFRAME-1', parentId: 'MAIN', url: FRAME_URL } }] } }
    }
    if (method === 'Target.setAutoAttach') {
      setTimeout(() => {
        view.transport.emitNotification('Target.attachedToTarget', { sessionId: 'OOPIF', targetInfo: { type: 'iframe', url: OOPIF_URL } })
      }, 5)
      return {}
    }
    if (method === 'Runtime.enable') {
      setTimeout(() => {
        view.transport.emitNotification('Runtime.executionContextCreated', { context: { id: 7, auxData: { frameId: 'MAIN', isDefault: true } } })
        view.transport.emitNotification('Runtime.executionContextCreated', { context: { id: 42, auxData: { frameId: 'IFRAME-1', isDefault: true } } })
      }, 5)
      return {}
    }
    if (method === 'Runtime.evaluate') {
      const expression = String(params?.['expression'] ?? '')
      if (expression.includes("querySelectorAll('iframe,frame')")) {
        // Main document: OOPIF first, same-process second. Child document: none.
        return { result: { value: sessionId === 'OOPIF' || params?.['contextId'] === 42 ? [] : [OOPIF_URL, FRAME_URL] } }
      }
      return { result: { value: sessionId === 'OOPIF' ? 'OOPIF-VALUE' : params?.['contextId'] === 42 ? 'IFRAME-VALUE' : 'MAIN-VALUE' } }
    }
    return {}
  }
}

describe('R-4 frame 索引与 DOM 一一对应', () => {
  it('OOPIF 先出现时 frame:1 命中跨源帧（走 flat session），frame:2 命中同源子帧', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/')
    const view = h.adapter.lastView()
    mixedFrameTransport(view)
    await expect(h.runtime.eval(1, 'window.__X__', 1)).resolves.toBe('"OOPIF-VALUE"')
    await expect(h.runtime.eval(1, 'window.__X__', 2)).resolves.toBe('"IFRAME-VALUE"')
    const oopifEval = view.transport.of('Runtime.evaluate').find((command) => command.sessionId === 'OOPIF')
    expect(oopifEval).toBeDefined()
    expect(oopifEval?.params?.['contextId']).toBeUndefined()
    const sameProcess = view.transport.of('Runtime.evaluate').find((command) => command.sessionId === undefined && command.params?.['contextId'] === 42)
    expect(sameProcess).toBeDefined()
  })

  it('帧数一一对应：越界报真实帧数（0..2）', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/')
    mixedFrameTransport(h.adapter.lastView())
    const err = await h.runtime.eval(1, 'window.__X__', 3).catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('not-found')
    expect((err as Error).message).toContain('3 frames: 0-2')
  })

  it('无法一一对应时 fail-loud（不静默指向邻帧）', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/')
    const view = h.adapter.lastView()
    // DOM 有 2 个帧属主，CDP 只给 1 个同源子帧且没有可用的 OOPIF → 拒绝
    view.transport.handler = (method, params) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'MAIN' }, childFrames: [{ frame: { id: 'IFRAME-1', url: FRAME_URL } }] } }
      if (method === 'Runtime.enable') {
        setTimeout(() => view.transport.emitNotification('Runtime.executionContextCreated', { context: { id: 42, auxData: { frameId: 'IFRAME-1', isDefault: true } } }), 5)
        return {}
      }
      if (method === 'Runtime.evaluate' && String(params?.['expression'] ?? '').includes("querySelectorAll('iframe,frame')")) {
        return { result: { value: params?.['contextId'] === 42 ? [] : [OOPIF_URL, FRAME_URL] } }
      }
      return {}
    }
    const err = await h.runtime.eval(1, 'window.__X__', 1).catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('not-found')
    expect((err as Error).message).toContain('frame index is not reliable')
    expect(view.transport.of('Runtime.evaluate').some((command) => String(command.params?.['expression'] ?? '').includes('__X__'))).toBe(false)
  })

  it('没有 iframe 的页面：frame 0 不变，且不装 auto-attach', async () => {
    const h = track(makeHarness())
    await h.runtime.open('https://app.example/')
    const view = h.adapter.lastView()
    view.transport.handler = (method, params) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'MAIN' } } }
      if (method === 'Runtime.evaluate') return { result: { value: String(params?.['expression'] ?? '').includes("querySelectorAll('iframe,frame')") ? [] : 1 } }
      return {}
    }
    await expect(h.runtime.eval(1, '1 + 0')).resolves.toBe('1')
    expect(view.transport.of('Page.getFrameTree')).toHaveLength(0)
    expect(view.transport.of('Target.setAutoAttach')).toHaveLength(0)
    const err = await h.runtime.eval(1, '1 + 0', 1).catch((e: unknown) => e)
    expect((err as Error).message).toContain('1 frames: 0-0')
    expect(view.transport.of('Target.setAutoAttach')).toHaveLength(0)
  })

  it('orderFramesByDom：DOM 顺序映射、重定向后的强制配对、歧义即拒绝', () => {
    const a: FrameCandidate = { frameId: 'A', url: 'https://x/a' }
    const b: FrameCandidate = { frameId: 'B', url: 'about:srcdoc' }
    const ordered = orderFramesByDom(['https://x/a', 'about:srcdoc'], [b, a])
    expect(isFrameOrderProblem(ordered)).toBe(false)
    expect((ordered as FrameCandidate[]).map((f) => f.frameId)).toEqual(['A', 'B'])

    // 帧属主 src 是重定向前的地址，CDP 报的是落地地址 → 唯一剩余对由排除法确定
    const redirected = orderFramesByDom(['https://x/redir', 'about:srcdoc'], [b, { frameId: 'R', url: 'https://x/final' }])
    expect(isFrameOrderProblem(redirected)).toBe(false)
    expect((redirected as FrameCandidate[]).map((f) => f.frameId)).toEqual(['R', 'B'])

    // 两个都无法配对 → 歧义，拒绝
    const ambiguous = orderFramesByDom(['https://x/r1', 'https://x/r2'], [{ frameId: 'R1', url: 'https://x/f' }, { frameId: 'R2', url: 'https://x/f' }])
    expect(isFrameOrderProblem(ambiguous)).toBe(true)
    expect((ambiguous as { reason: string }).reason).toContain('cannot pair')
    // 数量不一致 → 拒绝
    expect(isFrameOrderProblem(orderFramesByDom(['https://x/a'], []))).toBe(true)
  })
})
