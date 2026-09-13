/**
 * R7 回归锁（browser）：注入凭据的**作用域与出口**。
 *
 * 2026-09-13 R-4/R-5/R7 修了三轮凭据防线（活性窗口、值级擦除、selector 擦除），
 * 独立复核（`multiagent-bug-audit-r3/VERIFY-A2-client-runtime.md` r7c-1…r7c-4）又实测出
 * 四个残留出口，本文件把它们钉成回归用例（每条都先在修复前跑红）：
 *
 * - **r7c-1** `browser_screenshot` 的活性窗口判定在全局互斥锁**外**，而 `browser_eval`
 *   的在锁内。fill 已持锁等 CDP 回包时发起的 screenshot 读到排队前的旧快照，
 *   随后排在 fill 之后执行，截到已注入凭据的页面。
 * - **r7c-2** 页面可控的 `selector`（`el.id = 口令`）在**交互错误文本**里逐字外泄：
 *   快照出口擦了 selector，`resolveTarget` → locate/type/select 的错误没擦。
 * - **r7c-3** 值集合与窗口记在 **tab** 上，而它们要防的存储（localStorage/cookie）
 *   是 **origin** 级的：同源第二个 tab（普通 `browser_open`）既不被拒也不擦除。
 * - **r7c-4** 80 字符（以及 `get_text` 的 32KiB）截断发生在擦除**之前**，长口令
 *   被窗口切出的尾部残片明文回传。
 *
 * mock 是"按 origin 共享存储"的真实语义（localStorage 跨 tab 可见），页面侧
 * `selectorOf` 的 id 分支按 `src/snapshot.ts` 原样复刻，避免 mock 比真实实现宽松。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserRuntime, CREDENTIAL_WINDOW_EVAL_REFUSAL, CREDENTIAL_WINDOW_SCREENSHOT_REFUSAL } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import { applyBrowserTools } from '../src/tools.ts'

const ID_SAFE_SECRET = 'S3cr3tPassw0rd123'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------------ mocks

class MockTransport {
  attached = false
  log: Array<{ method: string; params?: Record<string, unknown> }> = []
  handler: (method: string, params?: Record<string, unknown>) => unknown = () => ({})
  private listeners: Array<(event: unknown, method: string, params: unknown) => void> = []
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.log.push({ method, ...(params === undefined ? {} : { params }) })
    return await this.handler(method, params)
  }
  on(event: string, listener: (event: unknown, method: string, params: unknown) => void): unknown {
    if (event === 'message') this.listeners.push(listener)
    return this
  }
  removeListener(event: string, listener: (event: unknown, method: string, params: unknown) => void): unknown {
    if (event === 'message') this.listeners = this.listeners.filter((entry) => entry !== listener)
    return this
  }
  emitNotification(method: string, params: unknown): void {
    for (const listener of [...this.listeners]) listener(undefined, method, params)
  }
}

class MockSession {
  partition = 'persist:r7-verify'
  clearStorageData = async (): Promise<void> => {}
  clearCache = async (): Promise<void> => {}
  setPermissionRequestHandler = (): void => {}
  setPermissionCheckHandler = (): void => {}
  on(): void {}
  removeListener(): void {}
}

class MockView {
  transport = new MockTransport()
  session = new MockSession()
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  url = ''
  title = ''
  destroyed = false
  captureCalls = 0
  openHandler: ((details: { url: string }) => unknown) | undefined
  loadURL = async (target: string): Promise<void> => { this.url = target; this.emit('did-stop-loading') }
  downloadURL = (): void => {}
  goBack = (): void => { this.emit('did-finish-load') }
  goForward = (): void => { this.emit('did-finish-load') }
  reload = (): void => { this.emit('did-finish-load') }
  capturePage = async (): Promise<unknown> => {
    this.captureCalls++
    return { getSize: () => ({ width: 8, height: 8 }), resize: () => ({}), toJPEG: () => Buffer.from('JPEG') }
  }
  setWindowOpenHandler = (handler: (details: { url: string }) => unknown): void => { this.openHandler = handler }
  attach(): void {}
  setBounds(): void {}
  setVisible(): void {}
  detach(): void {}
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
        this.listeners.set(event, (this.listeners.get(event) ?? []).filter((entry) => entry !== listener))
      },
      session: this.session,
      setWindowOpenHandler: this.setWindowOpenHandler,
      close: () => { this.destroyed = true },
      isDestroyed: () => this.destroyed,
    } as never
  }
}

class MockAdapter {
  views: MockView[] = []
  masks: MockView[] = []
  partitionSession = new MockSession()
  showSaveDialog = async (): Promise<{ canceled: boolean }> => ({ canceled: true })
  openPath = async (): Promise<Record<string, unknown>> => ({})
  createView(): never { const view = new MockView(); this.views.push(view); return view as never }
  createMaskView(): never { const view = new MockView(); this.masks.push(view); return view as never }
  createBrowserWindow(): never {
    return {
      loadURL: async () => {}, show: () => {}, hide: () => {}, focus: () => {}, isVisible: () => false,
      isDestroyed: () => false, close: () => {}, setTitle: () => {}, getContentSize: () => ({ width: 1100, height: 780 }),
      contentView: { addChildView: () => {}, removeChildView: () => {} },
      onResize: () => () => {}, onClosed: () => () => {}, focusPage: () => {},
    } as never
  }
  getSession(): never { return this.partitionSession as never }
  lastView(): MockView { return this.views.at(-1)! }
}

interface Harness {
  runtime: BrowserRuntime
  adapter: MockAdapter
  dir: string
  call: (name: string, args?: Record<string, unknown>) => Promise<never>
}

const exec = { signal: new AbortController().signal, agent: undefined }

function makeHarness(
  credentials?: (id: string) => Promise<{ username?: string; password?: string } | null>,
): Harness {
  const adapter = new MockAdapter()
  const dir = mkdtempSync(join(tmpdir(), 'r7-browser-'))
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
    dir,
    call: async (name, args = {}) => await tools.get(name)!.execute(args, exec) as never,
  }
}

const live: Harness[] = []
function track(h: Harness): Harness {
  live.push(h)
  return h
}
afterEach(() => {
  for (const h of live.splice(0)) {
    h.runtime.dispose()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

/** `fillCredentials` CDP stub; `gate` (when given) holds the critical section. */
function stubLoginForm(view: MockView, gate?: Promise<void>): void {
  view.transport.handler = async (method, params) => {
    if (method !== 'Runtime.evaluate') return {}
    const expression = String(params?.['expression'] ?? '')
    if (!expression.includes('passField')) return { result: { value: '' } }
    if (gate !== undefined) await gate
    return { result: { value: { filled: 2, username: true, password: true } } }
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

// ----------------------------------------------------------------- r7c-1

describe('r7c-1 screenshot 的凭据窗口判定必须在临界区内（与 eval 对称）', () => {
  it('fill 持锁等 CDP 回包时发起的 screenshot 排到 fill 之后，仍被拒绝', async () => {
    const h = track(makeHarness(async () => ({ username: 'alice', password: ID_SAFE_SECRET })))
    await h.runtime.open('https://login.example/form')
    const view = h.adapter.lastView()
    const gate = deferred()
    stubLoginForm(view, gate.promise)

    const fill = h.runtime.fillCredentials(1, 'connector-x')
    await sleep(20) // fill 已在临界区内 await CDP，窗口还没打开
    expect(h.runtime.credentialWindowOpen(1)).toBe(false)

    // 锁外早退读到的还是旧快照，调用随后排在 fill 之后（这就是 TOCTOU 窗口）。
    const shot = h.runtime.screenshot(1)
    await sleep(20)
    gate.resolve()

    const [fillResult, shotResult] = await Promise.allSettled([fill, shot])
    expect(fillResult.status).toBe('fulfilled')
    expect(h.runtime.credentialWindowOpen(1)).toBe(true)
    // 修复前：fulfilled + captureCalls 1（截到已注入凭据的页面）。
    expect(shotResult.status).toBe('rejected')
    const reason = (shotResult as PromiseRejectedResult).reason as { code?: string; message?: string }
    expect(reason.code).toBe('policy')
    expect(reason.message).toBe(CREDENTIAL_WINDOW_SCREENSHOT_REFUSAL)
    expect(view.captureCalls).toBe(0)
  })

  it('对照组：同一交错下 browser_eval 被拒（锁内判定本来就是对的）', async () => {
    const h = track(makeHarness(async () => ({ username: 'alice', password: ID_SAFE_SECRET })))
    await h.runtime.open('https://login.example/form')
    const view = h.adapter.lastView()
    const gate = deferred()
    stubLoginForm(view, gate.promise)

    const fill = h.runtime.fillCredentials(1, 'connector-x')
    await sleep(20)
    const evaluated = h.runtime.eval(1, 'document.querySelector("#pw").value')
    await sleep(20)
    gate.resolve()

    const [fillResult, evalResult] = await Promise.allSettled([fill, evaluated])
    expect(fillResult.status).toBe('fulfilled')
    expect(evalResult.status).toBe('rejected')
    const reason = (evalResult as PromiseRejectedResult).reason as { code?: string; message?: string }
    expect(reason.code).toBe('policy')
    expect(reason.message).toBe(CREDENTIAL_WINDOW_EVAL_REFUSAL)
  })
})

// ----------------------------------------------------------------- r7c-2

describe('r7c-2 交互错误文本不得回显被当作 selector 的凭据', () => {
  it('页面把口令写成 el.id 时，click 失败文案只出现擦除后的 selector', async () => {
    const h = track(makeHarness(async () => ({ username: 'alice', password: ID_SAFE_SECRET })))
    await h.runtime.open('https://login.example/form')
    const view = h.adapter.lastView()
    view.transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.['expression'] ?? '')
      if (expression.includes('passField')) return { result: { value: { filled: 2, username: true, password: true } } }
      if (expression.includes('kindOf')) {
        return {
          result: {
            value: [
              { kind: 'input', text: 'Password', selector: `#${ID_SAFE_SECRET}`, visible: true, disabled: false },
              { kind: 'button', text: 'Sign in', selector: '#submit', visible: true, disabled: false },
            ],
          },
        }
      }
      // 页面在模型点之前把元素删了：locate 失败，selector 进错误文案。
      if (expression.includes('scrollIntoView')) return { result: { value: { error: 'element not found' } } }
      return { result: { value: '' } }
    }
    await h.runtime.fillCredentials(1, 'connector-x')

    const snapshot = await h.call('browser_get_snapshot', {}) as { elements: Array<{ selector: string }> }
    expect(snapshot.elements[0]!.selector).toBe('#****')

    const error = await h.call('browser_click', { target: 1 }).catch((cause: unknown) => cause as Error)
    expect(error.message).not.toContain(ID_SAFE_SECRET)
    expect(error.message).toContain('****')
  })

  it('短口令（id-safe 但 < 8 字符）走同一个 selector 口径：快照与错误文案都打码', async () => {
    const short = 'abc123'
    const h = track(makeHarness(async () => ({ username: 'alice', password: short })))
    await h.runtime.open('https://login.example/form')
    h.adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.['expression'] ?? '')
      if (expression.includes('passField')) return { result: { value: { filled: 2, username: true, password: true } } }
      if (expression.includes('kindOf')) {
        return { result: { value: [{ kind: 'input', text: 'Password', selector: `#${short}`, visible: true, disabled: false }] } }
      }
      if (expression.includes('scrollIntoView')) return { result: { value: { error: 'element not found' } } }
      return { result: { value: '' } }
    }
    await h.runtime.fillCredentials(1, 'connector-x')

    const snapshot = await h.call('browser_get_snapshot', {}) as { elements: Array<{ selector: string }> }
    expect(snapshot.elements[0]!.selector).toBe('#****')
    const error = await h.call('browser_click', { target: 1 }).catch((cause: unknown) => cause as Error)
    expect(error.message).not.toContain(short)
    expect(error.message).toContain('****')
  })
})

// ----------------------------------------------------------------- r7c-3

describe('r7c-3 凭据记账按 origin（值集合 + 活性窗口），不再按 tab', () => {
  it('同源第二个 tab 继承值集合与窗口：eval 被拒、get_text 擦除', async () => {
    const originStore = new Map<string, string>() // localStorage 语义：按 origin 共享
    const stubPage = (view: MockView): void => {
      view.transport.handler = (method, params) => {
        if (method !== 'Runtime.evaluate') return {}
        const expression = String(params?.['expression'] ?? '')
        if (expression.includes('passField')) {
          originStore.set('k', ID_SAFE_SECRET)
          return { result: { value: { filled: 2, username: true, password: true } } }
        }
        if (expression.includes('localStorage.getItem')) return { result: { value: originStore.get('k') ?? null } }
        if (expression.includes('kindOf')) return { result: { value: [] } }
        if (expression.includes('innerText')) return { result: { value: `remembered value is ${originStore.get('k') ?? ''}` } }
        return { result: { value: '' } }
      }
    }
    const h = track(makeHarness(async () => ({ username: 'alice', password: ID_SAFE_SECRET })))
    await h.runtime.open('https://app.example/login')
    stubPage(h.adapter.lastView())
    await h.runtime.fillCredentials(1, 'connector-x')

    // 普通 agent 路径开同源第二个 tab（不是 window.open，没有 inheritSecretsFrom）。
    const second = await h.runtime.open('https://app.example/other')
    stubPage(h.adapter.views[1]!)
    expect(h.runtime.credentialWindowOpen(second.id)).toBe(true)

    const evaluated = await h.call('browser_eval', { tab: second.id, expression: 'localStorage.getItem("k")' })
      .catch((cause: unknown) => cause as { code?: string; message?: string })
    expect((evaluated as { code?: string }).code).toBe('policy')

    const text = await h.call('browser_get_text', { tab: second.id }) as { text: string }
    expect(text.text).not.toContain(ID_SAFE_SECRET)
    expect(text.text).toContain('****')

    // 另一个 origin 的 tab 不受影响（作用域是 origin，不是"全局封锁"）。
    const third = await h.runtime.open('https://other.example/page')
    stubPage(h.adapter.views[2]!)
    await expect(h.runtime.eval(third.id, '1 + 1')).resolves.toBeTypeOf('string')
  })

  it('注入前就开着的同源 tab 也被记账（fill 时扇出到同 origin 的每个 tab）', async () => {
    const stubPage = (view: MockView, value: string): void => {
      view.transport.handler = (method, params) => {
        if (method !== 'Runtime.evaluate') return {}
        const expression = String(params?.['expression'] ?? '')
        if (expression.includes('passField')) return { result: { value: { filled: 2, username: true, password: true } } }
        if (expression.includes('innerText')) return { result: { value: value } }
        return { result: { value: '' } }
      }
    }
    const h = track(makeHarness(async () => ({ username: 'alice', password: ID_SAFE_SECRET })))
    await h.runtime.open('https://app.example/first')
    await h.runtime.open('https://app.example/second') // 先于注入存在
    expect(h.runtime.credentialWindowOpen(2)).toBe(false)
    stubPage(h.adapter.views[0]!, '')
    stubPage(h.adapter.views[1]!, `stashed: ${ID_SAFE_SECRET}`)

    await h.runtime.fillCredentials(1, 'connector-x')

    expect(h.runtime.tab(2).filledSecrets).toEqual([ID_SAFE_SECRET])
    expect(h.runtime.credentialWindowOpen(2)).toBe(true)
    const text = await h.call('browser_get_text', { tab: 2 }) as { text: string }
    expect(text.text).toBe('stashed: ****')
  })

  it('注入 tab 的主帧导航结束 origin 窗口（eval 恢复），但值集合仍留在 origin 上', async () => {
    const stubPage = (view: MockView, value: string): void => {
      view.transport.handler = (method, params) => {
        if (method !== 'Runtime.evaluate') return {}
        const expression = String(params?.['expression'] ?? '')
        if (expression.includes('passField')) return { result: { value: { filled: 2, username: true, password: true } } }
        if (expression.includes('innerText')) return { result: { value: value } }
        return { result: { value: '' } }
      }
    }
    const h = track(makeHarness(async () => ({ username: 'alice', password: ID_SAFE_SECRET })))
    await h.runtime.open('https://app.example/login')
    stubPage(h.adapter.views[0]!, '')
    await h.runtime.fillCredentials(1, 'connector-x')
    expect(h.runtime.credentialWindowOpen(1)).toBe(true)

    // R-4 口径不变：注入它的 tab 一旦主帧跨文档导航，窗口就结束。
    const view = h.adapter.views[0]!
    view.transport.emitNotification('Page.frameNavigated', { frame: { id: 'MAIN', url: 'https://app.example/dashboard' } })
    view.url = 'https://app.example/dashboard'
    h.runtime['updateTabState'](h.runtime['tab'](1))
    expect(h.runtime.credentialWindowOpen(1)).toBe(false)

    // 值集合按 origin 保留：出窗后的文本出口照旧打码，后开的同源 tab 也继承它
    // （窗口不继承：credential 已不在任何文档里，R-4 的可见性口径不变）。
    stubPage(view, `stashed: ${ID_SAFE_SECRET}`)
    const text = await h.call('browser_get_text', { tab: 1 }) as { text: string }
    expect(text.text).toBe('stashed: ****')
    const later = await h.runtime.open('https://app.example/later')
    stubPage(h.adapter.views[1]!, `stashed: ${ID_SAFE_SECRET}`)
    expect(h.runtime.credentialWindowOpen(later.id)).toBe(false)
    expect(h.runtime.tab(later.id).filledSecrets).toEqual([ID_SAFE_SECRET])
    const laterText = await h.call('browser_get_text', { tab: later.id }) as { text: string }
    expect(laterText.text).toBe('stashed: ****')
  })
})

// ----------------------------------------------------------------- r7c-4

describe('r7c-4 擦除必须先于截断（快照 80 字符 / get_text 32KiB）', () => {
  it('元素文本被 80 字符窗口切到口令中部时，回传的是打码后的文本', async () => {
    const head = 'Audit note: '.padEnd(70, '.') // 70 个普通字符后才是口令（87 字符 → 被切）
    const h = track(makeHarness(async () => ({ username: 'alice', password: ID_SAFE_SECRET })))
    await h.runtime.open('https://login.example/form')
    h.adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.['expression'] ?? '')
      if (expression.includes('passField')) return { result: { value: { filled: 2, username: true, password: true } } }
      if (expression.includes('kindOf')) {
        return { result: { value: [{ kind: 'input', text: head + ID_SAFE_SECRET, selector: '#plain', visible: true, disabled: false }] } }
      }
      return { result: { value: '' } }
    }
    await h.runtime.fillCredentials(1, 'connector-x')

    const snapshot = await h.call('browser_get_snapshot', {}) as { elements: Array<{ text: string }> }
    const text = snapshot.elements[0]!.text
    expect(text).not.toContain(ID_SAFE_SECRET.slice(0, 10)) // 修复前：'S3cr3tPass' 明文残片
    expect(text).toContain('****')
    expect(text.length).toBeLessThanOrEqual(80)
  })

  it('get_text 的 32KiB 窗口同样先擦后截，尾部不再是口令残片', async () => {
    const big = 'x'.repeat(32 * 1024 - 4) + ID_SAFE_SECRET
    const h = track(makeHarness(async () => ({ username: 'alice', password: ID_SAFE_SECRET })))
    await h.runtime.open('https://login.example/form')
    h.adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.['expression'] ?? '')
      if (expression.includes('passField')) return { result: { value: { filled: 2, username: true, password: true } } }
      if (expression.includes('innerText')) return { result: { value: big } }
      return { result: { value: '' } }
    }
    await h.runtime.fillCredentials(1, 'connector-x')

    const out = await h.call('browser_get_text', {}) as { text: string; truncated: boolean }
    expect(out.text).not.toContain(ID_SAFE_SECRET.slice(0, 4)) // 修复前尾部 'S3cr' 明文
    expect(out.text.endsWith('****')).toBe(true)
    expect(out.text.length).toBe(32 * 1024)
    expect(out.truncated).toBe(true)
  })

  it('上游已切断的头部片段不再被启发式猜除；未截断的文本不被改写（F-2 诚实边界）', async () => {
    // 审计员 repro2e 的形状：页面/上游把 `Authorization: Bearer <120 字符令牌>`
    // 先切到 80 字符再交给浏览器出口——擦除方拿到的尾部只有口令的前 60 个字符。
    //
    // R7 曾用「文本结尾等于某个注入值的前缀」来猜这种残片
    // （`maskTruncatedSecretTail`），代价是**未截断**的正常事实被永久改写：
    // 口令 `Security123!` 会把 `Privacy and Security` 变成 `Privacy and ****`，
    // 把持久化的 `https://app.example/help/Security` 变成 `/help/****`（历史、
    // op log、地址栏全线；F-2，2026-09-13 第二轮复核）。启发式已删除，改为让每个
    // 出口**先擦后截**（本文件前两条用例 + `audit-r7-credential-scope-round2.spec.ts`
    // 的 F-5 用例），因此这里锁定两件事：
    //   1) 上游已经切断的文本按逐字出现判定——`Authorization: Bearer ` 之后的
    //      60 字符残片与页面自己写的普通散文形状相同，值级擦除无法识别（声明过的
    //      HONEST BOUNDARY，与 `browser_get_snapshot` 的 tool 描述同款口径）；
    //   2) 这种文本**不会**被启发式改写成 `****`（信息不再是错的）。
    const token = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555FFFF6666GGGG7777HHHH8888IIII9999JJJJ0000KKKK1111LLLL2222MMMM'
    const alreadyCut = `Authorization: Bearer ${token}`.slice(0, 80)
    expect(alreadyCut).not.toContain(token) // 前提：交进来的文本确实已被切断
    const h = track(makeHarness(async () => ({ username: 'alice', password: token })))
    await h.runtime.open('https://login.example/form')
    h.adapter.lastView().transport.handler = (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.['expression'] ?? '')
      if (expression.includes('passField')) return { result: { value: { filled: 2, username: true, password: true } } }
      if (expression.includes('kindOf')) {
        return { result: { value: [{ kind: 'link', text: alreadyCut, selector: '#a', visible: true, disabled: false }] } }
      }
      return { result: { value: '' } }
    }
    await h.runtime.fillCredentials(1, 'connector-x')

    const snapshot = await h.call('browser_get_snapshot', {}) as { elements: Array<{ text: string }> }
    expect(snapshot.elements[0]!.text).toBe(alreadyCut)
    // 对照：同一个值只要**逐字完整**出现，就仍被整串擦除（前两条用例的完整口径）。
  })
})
