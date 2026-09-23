/**
 * 2026-09-23 独立审计 D（浏览器）—— BR-1 / BR-2 / BR-3 的回归用例。
 *
 * 三条都是"绿门禁抓不到"的形态：BR-1 只在**换号与在飞导航交叠**时发生、BR-2 需要
 * 页面**确定性**杀死渲染进程、BR-3 是常量之间的算术关系（旧用例只钉了配对不等式）。
 * 因此这里的三组断言各自对应审计探针的判据，并额外给出**正向对照**（同一段流程在
 * 不换号时必须照常落库），避免"把功能改没了也算绿"。
 *
 * 变异验证（改回旧行为必红）：
 *  · BR-1：删掉 `navigateInternal`/`createTabReal` 里的 `assertScopeUnchanged` 调用
 *    ⇒ 第一组红（旧账号 URL 出现在新账号 history/op log）；
 *  · BR-2：把 `render-process-gone` 处理改回无条件 `loadURL` ⇒ 第二组红（重载次数
 *    远超上限、崩溃 op 刷满）；
 *  · BR-3：把 `sleep(this.loadBoundMs(deadlineAt))` 改回 `sleep(this.options.loadTimeoutMs)`
 *    ⇒ 第三组的"挂起加载 + 400ms 剩余额度"用例红（变成等满 4s 配置上限）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import {
  BROWSER_TOOL_TIMEOUT_MS,
  NAVIGATE_LOAD_BOUND_MS,
  TAB_SLOT_WAIT_TIMEOUT_MS,
  TOOL_DEADLINE_MARGIN_MS,
  USER_GATE_TIMEOUT_MS,
} from '../src/budgets.ts'
import type { ElectronAdapter, NativeBounds, NativeSession, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

const PREV_URL = 'https://prev-account.example/secret-page'

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
  destroyed = false
  url = ''
  title = 'page'
  /** Never settles by default ⇒ the runtime's load race takes its 'pending' branch. */
  hangLoad = true
  /** `isLoading()` 的返回值：true 时 waitForLoad 必须等一个永不到来的事件。 */
  reportLoading = false
  crashOnLoad = false
  loadCalls = 0
  loadURL = vi.fn((u: string) => {
    this.loadCalls += 1
    this.url = u
    this.emit('did-stop-loading')
    if (this.hangLoad) return new Promise<void>(() => {})
    if (this.crashOnLoad) {
      queueMicrotask(() => { this.emit('render-process-gone') })
    }
    return Promise.resolve()
  })
  downloadURL = vi.fn()
  goBack = vi.fn()
  goForward = vi.fn()
  reload = vi.fn()
  capturePage = vi.fn(async () => ({ getSize: () => ({ width: 0, height: 0 }), resize: () => ({}), toJPEG: () => Buffer.from('') }))
  setWindowOpenHandler = vi.fn()
  attach(): void {}
  setBounds(_b: NativeBounds): void {}
  setVisible(_v: boolean): void {}
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
      isLoading: () => this.reportLoading,
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

class MockAdapter implements ElectronAdapter {
  views: MockView[] = []
  createView(): NativeView { const view = new MockView(); this.views.push(view); return view }
  createMaskView(): NativeView { return new MockView() }
  // 本组用例不碰原生对话框；接口要求它们在场，所以给最小实现（不是 `any` 绕过）。
  showSaveDialog(): Promise<{ canceled: boolean, filePath?: string }> { return Promise.resolve({ canceled: true }) }
  openPath(): Promise<{ error?: string }> { return Promise.resolve({}) }
  createBrowserWindow(): never {
    return {
      loadURL: async () => {}, show: () => {}, hide: () => {}, focus: () => {}, isVisible: () => false,
      isDestroyed: () => false, close: () => {}, setTitle: () => {}, getContentSize: () => ({ width: 1100, height: 780 }),
      contentView: { addChildView: () => {}, removeChildView: () => {} },
      onResize: () => () => {}, onClosed: () => () => {}, onFocus: () => () => {}, focusPage: () => {},
    } as never
  }
  getSession(): NativeSession { return new MockSession() }
}

const opened: Array<{ runtime: BrowserRuntime, root: string }> = []
afterEach(() => {
  for (const entry of opened.splice(0)) {
    entry.runtime.dispose()
    rmSync(entry.root, { recursive: true, force: true })
  }
})

function makeRoot(label: string): string {
  const root = join(process.cwd(), 'tests', `.audit0923-${label}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  return root
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Harness {
  runtime: BrowserRuntime
  adapter: MockAdapter
  store: BrowserStore
  root: string
}

function harness(label: string, options: { loadTimeoutMs: number }): Harness {
  const root = makeRoot(label)
  const store = new BrowserStore({ dir: join(root, 'user-a') })
  const adapter = new MockAdapter()
  const runtime = new BrowserRuntime(
    adapter as never,
    { downloadDir: join(root, 'downloads'), loadTimeoutMs: options.loadTimeoutMs },
    undefined,
    'persist:agent-browser-userA',
    // 模型面文案按 locale 出（`hostCopy`）；用例断言的是**语义**，固定 en 以免
    // 将来改默认语言时整组假红。
    { store, locale: () => 'en' },
  )
  opened.push({ runtime, root })
  return { runtime, adapter, store, root }
}

describe('BR-1 换号期间在飞的导航不得落进新账号（2026-09-23 审计）', () => {
  it('正向对照：不换号时同一条流程照常写 history 与 op log', async () => {
    const h = harness('br1-control', { loadTimeoutMs: 40 })
    await h.runtime.open(PREV_URL)
    expect(h.store.queryHistory({}).map((entry) => entry.url)).toContain(PREV_URL)
    expect((h.runtime as unknown as { ops: Array<{ tool: string }> }).ops.some((op) => op.tool === 'browser_open')).toBe(true)
  })

  it('换号后：旧账号 URL 不落新 store，也不进新账号的 op log', async () => {
    const h = harness('br1-switch', { loadTimeoutMs: 80 })
    const nextDir = join(h.root, 'user-b')
    mkdirSync(nextDir, { recursive: true })
    const storeNext = new BrowserStore({ dir: nextDir })

    // 1. agent 开始一次会挂起的导航（经典"页面一直不 settle"）。
    const inflight = h.runtime.open(PREV_URL).catch((cause: unknown) => cause)
    await sleep(30)

    // 2. 换号：host 的 runSessionSwitch 顺序（closeAll → 换分区/store → 换账本 → 清 op log）。
    await h.runtime.closeAll(true)
    h.runtime.setPartition('persist:agent-browser-userB')
    h.runtime.setStore(storeNext)
    h.runtime.restoreLedger()
    h.runtime.saveLedger()
    ;(h.runtime as unknown as { clearOps: () => void }).clearOps()

    // 3. 被放弃的加载竞速在加载上限到点后恢复执行。
    await sleep(200)
    const outcome = await inflight

    expect(h.store.queryHistory({}).map((entry) => entry.url)).not.toContain(PREV_URL)
    expect(storeNext.queryHistory({}).map((entry) => entry.url)).not.toContain(PREV_URL)
    const ops = (h.runtime as unknown as { ops: Array<{ tool: string, summary: string }> }).ops
    expect(ops.some((op) => op.summary.includes(PREV_URL))).toBe(false)
    // 结果本身必须是**明确的**中断错误，而不是"看起来成功了"或一个内部串。
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as { code?: string }).code).toBe('interrupted')
    expect((outcome as Error).message).toContain('session changed')
  })

  it('reload 的同族路径：换号后不把旧账号地址写进新 op log', async () => {
    const h = harness('br1-reload', { loadTimeoutMs: 80 })
    await h.runtime.open(PREV_URL)
    const view = h.adapter.views[0]!
    // 让 reload 的等待真的挂起（`isLoading()` 为真 ⇒ 等一个永不到来的 dom-ready），
    // 这样"等待期间换号"是确定性的，不靠调度巧合。
    view.reportLoading = true
    const reloading = h.runtime.reload(1).catch((cause: unknown) => cause)
    await sleep(10)
    h.runtime.setStore(new BrowserStore({ dir: join(h.root, 'user-b2') }))
    const outcome = await reloading
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as { code?: string }).code).toBe('interrupted')
    expect((outcome as Error).message).toContain('session changed')
  })
})

describe('BR-2 渲染进程崩溃必须有界（2026-09-23 审计）', () => {
  it('确定性崩溃页面：自动重载有上限、终态可诊断，显式 reload 才重置', async () => {
    const h = harness('br2-crash', { loadTimeoutMs: 200 })
    await h.runtime.open('https://crashy.example/page')
    const view = h.adapter.views[0]!
    view.hangLoad = false
    view.crashOnLoad = true
    const before = view.loadCalls

    view.emit('render-process-gone')
    await sleep(1_200)

    const reloads = view.loadCalls - before
    const ops = (h.runtime as unknown as { ops: Array<{ tool: string, summary: string, failed: boolean }> }).ops
    const crashOps = ops.filter((op) => op.tool === 'browser_page_crash')
    expect(reloads).toBeLessThanOrEqual(2)
    // 第一次立即重载 + 一次退避重载 + 一条终态记录（不是无界刷屏）。
    expect(crashOps.length).toBeLessThanOrEqual(3)
    expect(crashOps.at(-1)?.summary).toContain('automatic reload stopped')
    expect(crashOps.at(-1)?.summary).toContain('browser_reload')
    expect(crashOps.at(-1)?.failed).toBe(true)
    // 终态对模型可见（browser_list_tabs 的 crashed 列）。
    expect(h.runtime.tabState(1).crashed).toBe(true)

    // 显式重试 = 新的机会：计数归零、crashed 复位。
    await h.runtime.reload(1)
    expect(h.runtime.tabState(1).crashed).toBe(false)
    const afterReset = view.loadCalls
    view.emit('render-process-gone')
    await sleep(200)
    expect(view.loadCalls - afterReset).toBe(1)
  })

  it('换号/关标签会取消退避中的重载（不许加载进已销毁的视图）', async () => {
    const h = harness('br2-teardown', { loadTimeoutMs: 200 })
    await h.runtime.open('https://crashy.example/page')
    const view = h.adapter.views[0]!
    view.hangLoad = false
    view.crashOnLoad = true
    view.emit('render-process-gone')
    // 第二次崩溃会排一个退避定时器；在它到点前关掉浏览器。
    await sleep(120)
    await h.runtime.closeAll(true)
    const after = view.loadCalls
    await sleep(600)
    expect(view.loadCalls).toBe(after)
    expect(h.runtime.listTabs()).toHaveLength(0)
  })
})

describe('BR-3 内部等待之和必须留在注册预算内（2026-09-23 审计）', () => {
  it('闸门 + 槽位 + 加载上限 + 余量 ≤ 工具预算（唯一真源是 budgets.ts）', () => {
    expect(USER_GATE_TIMEOUT_MS + NAVIGATE_LOAD_BOUND_MS).toBeLessThan(BROWSER_TOOL_TIMEOUT_MS)
    expect(TAB_SLOT_WAIT_TIMEOUT_MS + USER_GATE_TIMEOUT_MS + NAVIGATE_LOAD_BOUND_MS + TOOL_DEADLINE_MARGIN_MS)
      .toBeLessThanOrEqual(BROWSER_TOOL_TIMEOUT_MS)
    // 旧实现用的是各自独立的 20s 加载上限 ⇒ 这两条不等式都不成立（30s == 预算、35s > 预算）。
    expect(NAVIGATE_LOAD_BOUND_MS).toBeLessThan(20_000)
  })

  it('加载等待按**剩余额度**收紧：剩余 400ms 时不会等满配置上限', async () => {
    // 配置上限刻意放大到 4s、且大于剩余额度 ⇒ 只有"按 deadline 收紧"才能让它早返回。
    const h = harness('br3-deadline', { loadTimeoutMs: 4_000 })
    const view = h.adapter.views[0]
    void view
    const started = Date.now()
    const deadline = started + 400 + TOOL_DEADLINE_MARGIN_MS
    const state = await h.runtime.open(PREV_URL, undefined, false, undefined, deadline)
    const elapsed = Date.now() - started
    expect(state.url).toBe(PREV_URL)
    expect(elapsed).toBeLessThan(2_000)
  }, 20_000)

  it('没有 deadline 时仍受预算序关系约束（不是各自独立的 20s）', async () => {
    const h = harness('br3-static', { loadTimeoutMs: 60_000 })
    const started = Date.now()
    await h.runtime.open(PREV_URL)
    const elapsed = Date.now() - started
    // 配置了 60s，但静态上限 NAVIGATE_LOAD_BOUND_MS（14s）才是真正生效的那个。
    // 这里只断言"没有等满配置值"，避免用例本身变成 14s 的长跑。
    expect(elapsed).toBeLessThan(15_000)
  }, 30_000)
})
