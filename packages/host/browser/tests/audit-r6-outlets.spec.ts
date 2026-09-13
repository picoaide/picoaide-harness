/**
 * R-6（2026-09-13，修复第五轮对抗复核 F1–F8 的出口泄漏）。
 *
 * 第五轮独立复核（真 Electron + 真 CDP，报告 temp/r5-verify-browser/REPORT.md）
 * 证明「凭据不外泄」仍被 8 条通道击穿。本文件把这些通道钉成无需 Electron 的
 * 回归用例，真机证据在 `tests/probes/r6-outlet-probe.mjs`
 * （`bash tests/probes/run-realmachine.sh [--pristine]`，红/绿两态都由它给出）。
 *
 * 设计口径（主控拍板）：
 * - **值级擦除的生命周期 = tab 生命周期**：`fill_credentials` 注入过的值集合在
 *   该 tab 关闭前一直保留，不再随凭据活性窗口（主帧跨文档导航）清空。窗口语义
 *   （窗口内 eval/截图拒绝）不变。
 * - 所有**文本出口**都过值级擦除：title（F1）、URL（F3/F7）、下载名/路径（F4）、
 *   出窗后的 get_text/eval/history/ledger/oplog（F5/F6）。
 * - 脱敏表补口（F8）：等号两侧空白、HTML 实体、全角等号、JSON 冒号对；URL 里
 *   不吞后续路径；短口令"值后同句继续"。
 * - **诚实边界（F2，声明而非解决）**：值级擦除只覆盖逐字出现。页面把值 base64/
 *   反转/逐字符分隔后再渲染，本方案看不见——工具描述里已声明，探针把它作为
 *   "已知残留"断言（不声称已解决）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore, maskSensitiveKeyValueText, stripSensitiveText, stripSensitiveUrl } from '../src/store.ts'
import { applyBrowserTools } from '../src/tools.ts'
import type { ElectronAdapter, NativeBounds, NativeSession, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

// ------------------------------------------------------------------ mocks

class MockTransport implements CdpTransport {
  attached = false
  commands: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = []
  handler: (method: string, params?: Record<string, unknown>, sessionId?: string) => unknown = () => ({})
  private readonly messageListeners: Array<(event: unknown, method: string, params: unknown, sessionId?: string) => void> = []
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  async sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    this.commands.push({ method, ...(params === undefined ? {} : { params }), ...(sessionId === undefined ? {} : { sessionId }) })
    return this.handler(method, params, sessionId)
  }
  on(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void): unknown {
    if (event === 'message') this.messageListeners.push(listener)
    return this
  }
  removeListener(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void): unknown {
    if (event === 'message') {
      const idx = this.messageListeners.indexOf(listener)
      if (idx >= 0) this.messageListeners.splice(idx, 1)
    }
    return this
  }
  emitNotification(method: string, params: unknown, sessionId?: string): void {
    for (const listener of [...this.messageListeners]) listener(undefined, method, params, sessionId)
  }
}

class MockSession implements NativeSession {
  partition = 'persist:agent-browser-r6'
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
  partition = 'persist:agent-browser-r6'
  loadURL = vi.fn(async (u: string) => { this.url = u; this.emit('did-stop-loading') })
  downloadURL = vi.fn()
  goBack = vi.fn(() => { this.emit('did-finish-load') })
  goForward = vi.fn(() => { this.emit('did-finish-load') })
  reload = vi.fn(() => { this.emit('did-finish-load') })
  capturePage = vi.fn(async () => ({ getSize: () => ({ width: 100, height: 100 }), resize: () => ({}), toJPEG: () => Buffer.from('x') }))
  windowOpenHandler: ((details: { url: string }) => { action: 'deny' }) | undefined
  setWindowOpenHandler = vi.fn((handler: (details: { url: string }) => { action: 'deny' }) => { this.windowOpenHandler = handler })
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

const SECRET = 'V4ult-Pass!x7'
const SHORT = 'abc123'
const exec = { signal: new AbortController().signal, agent: undefined }

function makeHarness(credentials?: (id: string) => Promise<{ username?: string; password?: string } | null>): Harness {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.audit-r6-store-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(adapter as never, { downloadDir: join(dir, 'downloads') }, credentials as never, undefined, { store })
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
async function injectCredentials(h: Harness, password: string): Promise<void> {
  h.adapter.lastView().transport.handler = (method, params) => {
    if (method !== 'Runtime.evaluate') return {}
    const expression = String(params?.['expression'] ?? '')
    if (expression.includes('passField')) return { result: { value: { filled: 2, username: true, password: true } } }
    return { result: { value: '' } }
  }
  await expect(h.runtime.fillCredentials(1, 'corp')).resolves.toEqual({ username: true, password: true })
  void password
}

/** The model-facing shape of a page read: the tool's own return value. */
const evalPage = async (h: Harness, expression: string): Promise<string> => {
  const out = await h.call('browser_eval', { tab: 1, expression }) as { result: string }
  return out.result
}

// ------------------------------------------------- F1: title 出口值级脱敏

describe('R-6 F1：title（list_tabs / snapshot）值级脱敏', () => {
  it('页面把注入值写进 document.title ⇒ list_tabs / snapshot 的 title 都是 ****', async () => {
    const h = track(makeHarness(async () => ({ password: SECRET })))
    await h.runtime.open('https://app.example/login')
    await injectCredentials(h, SECRET)
    const view = h.adapter.lastView()
    // 页面在 fill 派发的 input/change 里 document.title = pw.value。
    view.title = SECRET
    h.runtime['updateTabState'](h.runtime['tab'](1))
    // 窗口仍开着（同文档），title 也必须已被擦除——这正是第五轮 F1 的明文通道。
    expect(h.runtime.credentialWindowOpen(1)).toBe(true)
    const tabs = await h.call('browser_list_tabs') as { tabs: Array<{ id: number; title: string }> }
    expect(tabs.tabs.find((t) => t.id === 1)?.title).toBe('****')
    const snapshot = await h.call('browser_get_snapshot', { tab: 1 }) as { title: string }
    expect(snapshot.title).toBe('****')
    expect(h.runtime.shellState().tabs[0]?.title).toBe('****')
    // 窗口关闭后（导航离开）标题通道不会复活。
    view.transport.emitNotification('Page.frameNavigated', { frame: { id: 'MAIN', url: 'https://app.example/after' } })
    view.title = `Sign in ${SECRET}`
    h.runtime['updateTabState'](h.runtime['tab'](1))
    expect((await h.call('browser_list_tabs') as { tabs: Array<{ id: number; title: string }> }).tabs[0]?.title).toBe('Sign in ****')
  })

  it('普通 tab 的 title 逐字节不变（不误伤）', async () => {
    const h = track(makeHarness(async () => ({ password: SECRET })))
    await h.runtime.open('https://app.example/free')
    const view = h.adapter.lastView()
    view.title = 'Sign in — Corp SSO'
    h.runtime['updateTabState'](h.runtime['tab'](1))
    expect((await h.call('browser_list_tabs') as { tabs: Array<{ title: string }> }).tabs[0]?.title).toBe('Sign in — Corp SSO')
  })
})

// -------------------------------------- F3 / F7: URL 出口（含 fragment、路径段）

describe('R-6 F3/F7：URL 出口值级脱敏（页面自选键、裸 fragment、路径段）', () => {
  it('replaceState("?pw=" + v) / location.hash = v ⇒ list_tabs URL 打码', async () => {
    const h = track(makeHarness(async () => ({ password: SECRET })))
    await h.runtime.open('https://app.example/evil')
    await injectCredentials(h, SECRET)
    const view = h.adapter.lastView()
    view.url = 'https://app.example/evil?pw=' + SECRET
    h.runtime['updateTabState'](h.runtime['tab'](1))
    expect((await h.call('browser_list_tabs') as { tabs: Array<{ url: string }> }).tabs[0]?.url).toBe('https://app.example/evil?pw=****')
    view.url = 'https://app.example/evil#' + SECRET
    h.runtime['updateTabState'](h.runtime['tab'](1))
    expect(h.runtime.tabState(1).url).toBe('https://app.example/evil#****')
    // 路径段同样覆盖（页面自己拼 /<value>/next）。
    view.url = `https://app.example/${SECRET}/next`
    h.runtime['updateTabState'](h.runtime['tab'](1))
    expect(h.runtime.tabState(1).url).toBe('https://app.example/****/next')
  })

  it('window.open 子 tab 继承开窗者的值集合（F7：子 tab URL 不再明文）', async () => {
    const h = track(makeHarness(async () => ({ password: SECRET })))
    await h.runtime.open('https://app.example/login')
    await injectCredentials(h, SECRET)
    const opener = h.adapter.lastView()
    // 页面在 fill 之后 window.open('/popup?pw=' + v)。
    opener.windowOpenHandler?.({ url: `https://app.example/popup?pw=${SECRET}` })
    await vi.waitFor(() => { expect(h.adapter.views.length).toBeGreaterThan(1) })
    const child = h.adapter.views.at(-1)!
    child.url = `https://app.example/popup?pw=${SECRET}`
    h.runtime['updateTabState'](h.runtime['tab'](2))
    // 子 tab 不在凭据窗口内（没被注入过），但 URL 出口照旧值级擦除。
    expect(h.runtime.credentialWindowOpen(2)).toBe(false)
    expect(h.runtime.tabState(2).url).toBe('https://app.example/popup?pw=****')
    expect(h.runtime.tab(2).filledSecrets).toEqual([SECRET])
  })
})

// ------------------------------------------- F5 / F6: 出窗后全出口仍擦除

describe('R-6 F5/F6：主帧导航出窗后，值集合按 tab 生命周期保留', () => {
  it('出窗后 get_text / title / snapshot / eval / history / ledger / oplog 仍无明文', async () => {
    const h = track(makeHarness(async () => ({ password: SECRET })))
    await h.runtime.open('https://app.example/login')
    await injectCredentials(h, SECRET)
    const view = h.adapter.lastView()
    // 页面在 fill 的 input 里把值存进 sessionStorage，然后导航出窗。
    view.transport.emitNotification('Page.frameNavigated', { frame: { id: 'MAIN', url: 'https://app.example/after' } })
    view.url = 'https://app.example/after'
    view.title = SECRET
    h.runtime['updateTabState'](h.runtime['tab'](1))

    // 窗口关闭（eval/截图恢复），值集合保留。
    expect(h.runtime.credentialWindowOpen(1)).toBe(false)
    expect(h.runtime.tab(1).filledSecrets).toEqual([SECRET])

    // 页面把 sessionStorage 里的留存副本渲染出来：三个文本出口全打码。
    view.transport.handler = (method) => (method === 'Runtime.evaluate'
      ? { result: { value: `stashed: ${SECRET}` } }
      : {})
    expect(await evalPage(h, "sessionStorage.getItem('pw')")).toBe('"stashed: ****"')
    const text = await h.call('browser_get_text', { tab: 1 }) as { text: string }
    expect(text.text).toBe('stashed: ****')
    expect((await h.call('browser_get_text', { tab: 1 }) as { text: string }).text).not.toContain(SECRET)
    expect((await h.call('browser_list_tabs') as { tabs: Array<{ title: string }> }).tabs[0]?.title).toBe('****')

    // snapshot（表单 textarea 里塞了 base64 之外的原值）也走同一把尺子。
    view.transport.handler = (method) => (method === 'Runtime.evaluate'
      ? { result: { value: [{ kind: 'textarea', text: SECRET, selector: '#t', visible: true, disabled: false }] } }
      : {})
    const snapshot = await h.call('browser_get_snapshot', { tab: 1 }) as { elements: Array<{ text: string }>; title: string }
    expect(JSON.stringify(snapshot)).not.toContain(SECRET)
    expect(snapshot.elements[0]?.text).toBe('****')

    // F6：落盘 history 与 history_search、ledger、oplog 都不含明文。
    await h.runtime.navigate(1, `https://app.example/next?pw=${SECRET}`)
    h.runtime.saveLedger()
    const history = readFileSync(join(h.dir, 'history.jsonl'), 'utf8')
    const ledger = readFileSync(join(h.dir, 'groups.jsonl'), 'utf8')
    expect(history).not.toContain(SECRET)
    expect(ledger).not.toContain(SECRET)
    expect(JSON.stringify(h.runtime.opLog)).not.toContain(SECRET)
    expect(JSON.stringify(h.runtime.history({}))).not.toContain(SECRET)
    const search = await h.call('browser_history_search', { q: 'next' }) as { entries: unknown[] }
    expect(JSON.stringify(search)).not.toContain(SECRET)
  })

  it('tab 关闭后值集合随之消失（生命周期就是 tab）', async () => {
    const h = track(makeHarness(async () => ({ password: SECRET })))
    await h.runtime.open('https://app.example/login')
    await injectCredentials(h, SECRET)
    await h.runtime.closeTab(1)
    expect(h.runtime.listTabs()).toHaveLength(0)
    // 新 tab 不继承已关闭 tab 的值集合。
    await h.runtime.open('https://app.example/free')
    expect(h.runtime.tab(2).filledSecrets).toEqual([])
  })
})

// ------------------------------------------------------ F4: 下载名与路径

describe('R-6 F4：下载名/路径值级擦除（path 在 store 里保持真实句柄）', () => {
  it('<a download=pw + ".txt">：downloads_list 的 fileName 与 path 都打码，downloads_open 仍能打开真实文件', async () => {
    const h = track(makeHarness(async () => ({ password: SECRET })))
    await h.runtime.open('https://app.example/login')
    await injectCredentials(h, SECRET)
    const recorder = h.runtime['downloadRecorder']()
    const realPath = join(h.dir, 'downloads', `${SECRET}.txt`)
    const id = recorder.add({
      url: 'https://app.example/dl', fileName: `${SECRET}.txt`, path: '', size: 0,
      status: 'in-progress', group: '', actor: 'ai',
    })
    recorder.update(id, { status: 'done', path: realPath })
    const listed = h.runtime.downloads({})
    expect(listed[0]?.fileName).not.toContain(SECRET)
    expect(listed[0]?.path).not.toContain(SECRET)
    expect(listed[0]?.path).toContain('****')
    // store 里仍是真实路径（downloads_open / 文件工具要用它）。
    expect(h.store.queryDownloads({})[0]?.path).toBe(realPath)
    await h.runtime.openDownloadPath(id)
    expect(h.adapter.openPath).toHaveBeenCalledWith(realPath)
  })

  it('普通下载（无注入）名与路径逐字节不变', async () => {
    const h = track(makeHarness(async () => ({ password: SECRET })))
    await h.runtime.open('https://app.example/login')
    const recorder = h.runtime['downloadRecorder']()
    const realPath = join(h.dir, 'downloads', 'report.txt')
    const id = recorder.add({ url: 'https://app.example/dl', fileName: 'report.txt', path: '', size: 0, status: 'in-progress', group: '', actor: 'ai' })
    recorder.update(id, { status: 'done', path: realPath })
    expect(h.runtime.downloads({})[0]).toMatchObject({ fileName: 'report.txt', path: realPath })
  })
})

// ------------------------------------------------------------ F8: 脱敏表

describe('R-6 F8：脱敏表补口（等号变体 / JSON 对 / 路径边界 / 短口令同句）', () => {
  it('四种未覆盖形态逐条命中，且不吞后续路径/文本', () => {
    expect(maskSensitiveKeyValueText('token = T12')).toBe('token = ****')
    expect(maskSensitiveKeyValueText('token&#61;T12')).toBe('token&#61;****')
    expect(maskSensitiveKeyValueText('token&#x3d;T12')).toBe('token&#x3d;****')
    expect(maskSensitiveKeyValueText('token&equals;T12')).toBe('token&equals;****')
    expect(maskSensitiveKeyValueText('token＝T12')).toBe('token＝****')
    expect(maskSensitiveKeyValueText('{"code":"T14"}')).toBe('{"code":"****"}')
    // 过度吞掉后续路径/文本：修前是 https://x/token=****（/next 一起没了）。
    expect(stripSensitiveUrl('https://x/token=T12/next')).toBe('https://x/token=****/next')
    expect(maskSensitiveKeyValueText('see token=T12 for details')).toBe('see token=**** for details')
  })

  it('反向核查：普通文本/URL 仍逐字节不变（冒号规则不误伤散文）', () => {
    for (const text of ['', 'Sign in — Corp SSO', 'notes about passwords', 'https://h/cb?q=hello&id=2', 'Time: 12:30', 'encoded: 0', 'decoder: x', 'consider: this', 'outside: now']) {
      expect(stripSensitiveText(text), text).toBe(text)
    }
    // 既有命中不退化。
    expect(stripSensitiveText('Login failed: code=T14&state=x')).toBe('Login failed: code=****&state=x')
    expect(stripSensitiveText('Sign in /cb?%73id=T11')).toBe('Sign in /cb?%73id=****')
    expect(stripSensitiveText('Authorization: Bearer abc')).toBe('Authorization: **** abc')
  })

  it('短口令"值后同句继续"：password=abc123 next line ⇒ 只擦值，保留后续文本', async () => {
    const h = track(makeHarness(async () => ({ password: SHORT })))
    await h.runtime.open('https://app.example/short')
    await injectCredentials(h, SHORT)
    const view = h.adapter.lastView()
    view.transport.handler = (method) => (method === 'Runtime.evaluate'
      ? { result: { value: `password=${SHORT} next line` } }
      : {})
    const text = await h.call('browser_get_text', { tab: 1 }) as { text: string }
    expect(text.text).toBe('password=**** next line')
    // 散文里的短口令照旧保留（R-3 口径不退化）。
    view.transport.handler = (method) => (method === 'Runtime.evaluate'
      ? { result: { value: `Item (${SHORT}) shipped` } }
      : {})
    expect((await h.call('browser_get_text', { tab: 1 }) as { text: string }).text).toBe(`Item (${SHORT}) shipped`)
  })
})

// ------------------------------------------- F2: 声明的残留（不是已解决）

describe('R-6 F2：变形文本是已声明残留（诚实边界）', () => {
  it('逐字出现被擦除；base64/反转/分隔形态按声明仍是明文（不声称已解决）', async () => {
    const h = track(makeHarness(async () => ({ password: SECRET })))
    await h.runtime.open('https://app.example/login')
    await injectCredentials(h, SECRET)
    const view = h.adapter.lastView()
    const b64 = Buffer.from(SECRET, 'utf8').toString('base64')
    const reversed = [...SECRET].reverse().join('')
    const spaced = [...SECRET].join(' ')
    view.transport.handler = (method, params) => (method === 'Runtime.evaluate'
      ? { result: { value: `${SECRET}\n${b64}\n${reversed}\n${spaced}` } }
      : {})
    const text = (await h.call('browser_get_text', { tab: 1 }) as { text: string }).text
    expect(text).toContain('****')
    expect(text).not.toContain(SECRET)
    // 声明：值级擦除只覆盖逐字出现——这三种变形在窗口关闭后仍然可读。
    view.transport.emitNotification('Page.frameNavigated', { frame: { id: 'MAIN', url: 'https://app.example/after' } })
    const after = (await h.call('browser_get_text', { tab: 1 }) as { text: string }).text
    expect(after).toContain(b64)
    expect(after).toContain(reversed)
    expect(after).toContain(spaced)
    expect(after).not.toContain(SECRET)
  })

  it('工具描述声明该残留（不能说"values stay redacted"就完事）', async () => {
    const h = track(makeHarness(async () => ({ password: SECRET })))
    const fill = h.tools.get('browser_fill_credentials') as unknown as { description: string }
    const text = h.tools.get('browser_get_text') as unknown as { description: string }
    expect(fill.description).toMatch(/verbatim|逐字|transformed/u)
    expect(fill.description).not.toMatch(/values stay redacted/u)
    expect(text.description).toMatch(/verbatim|transformed|transform/iu)
  })
})
