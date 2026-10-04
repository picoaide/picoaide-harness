/**
 * C3 泳道（2026-10-04 回归审计）四条修复的判据 —— 一个族：**内部等待的求和必须
 * 留在注册的工具预算内**，以及**内容出口只有一条脱敏漏斗**。
 *
 * - **C3-01**（P1）共享的「当前操作 deadline」槽会被前一个操作的 `finally` 覆盖：
 *   池子是串行互斥，排队者会先完成置位、前一个操作随后才 unwind 并把它自己捕获的
 *   `undefined` 写回槽 ⇒ 排队者之后的每条 CDP 命令都拿到完整工具预算（30s）而不是
 *   「deadline − now」，R4-B-15 专门修的收紧在**任何两个操作重叠时整段失效**。
 * - **C3-02**（P2）`browser_screenshot` 的两条抓帧腿只由 `options.timeoutMs` 推导
 *   （常量 8s + 5s），从不看已耗时 ⇒ `排队(≤28s) + 8s + 5s` 结构上越界（审计实测
 *   37.9s / 38.9s，工具预算 30s → 上游 timeout-policy 换成笼统超时）。
 * - **C3-03**（P2）标签槽位等待是固定 5s，同样不按剩余额度收紧（审计实测
 *   `browser_open` 30.9s）：排队 26s 后再等 5s 槽位 + 加载即越界。
 * - **C3-09**（P2）内容出口的「唯一共用漏斗」只接进了 eval 四趟里的第一趟：
 *   `browser_get_text` / `browser_get_snapshot` 仍原样交出 `password=…` /
 *   `Authorization: Bearer …` / `api_key=…`，而 `browser_eval` 四趟齐全 ——
 *   同一份页面文本两个出口两个答案。
 *
 * 每条判据都对准**后果**（槽值、预算值、耗时、出口文本的具体形态），不是"源码里
 * 出现过某个标识符"；变异验证见 `temp/audit-v282/fixes/C3-01-02-03.md`。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import { TabPool } from '../src/pool.ts'
import { applyBrowserTools } from '../src/tools.ts'
import {
  BROWSER_TOOL_TIMEOUT_MS,
  BROWSER_WAIT_FOR_DEADLINE_MS,
  FRAME_INDEX_LEG_MS,
  NAVIGATE_LOAD_BOUND_MS,
  TAB_SLOT_WAIT_TIMEOUT_MS,
  TOOL_DEADLINE_MARGIN_MS,
  USER_GATE_TIMEOUT_MS,
  WAIT_FOR_MAX_MS,
} from '../src/budgets.ts'
import type { ElectronAdapter, NativeBounds, NativeSession, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

// ------------------------------------------------------------------ 测试替身

class MockTransport implements CdpTransport {
  attached = false
  handler: (method: string, params?: Record<string, unknown>) => unknown = () => ({})
  /** Methods that never settle (a wedged renderer). */
  hung = new Set<string>()
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.hung.has(method)) return await new Promise<never>(() => {})
    return this.handler(method, params)
  }
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
  url = ''
  title = 'page'
  destroyed = false
  /** The native capture never settles — the documented hidden-window hang. */
  captureHangs = false
  loadURL = vi.fn(async (u: string) => { this.url = u; this.emit('did-stop-loading') })
  downloadURL = vi.fn()
  goBack = vi.fn()
  goForward = vi.fn()
  reload = vi.fn()
  capturePage = vi.fn(async () => {
    if (this.captureHangs) return await new Promise<never>(() => {})
    return { getSize: () => ({ width: 100, height: 100 }), resize: () => ({}), toJPEG: () => Buffer.from('x') }
  })
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
      stop: () => {},
      getURL: () => this.url,
      getTitle: () => this.title,
      isLoading: () => false,
      on: (event: string, listener: (...args: unknown[]) => void) => {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      },
      removeListener: (event: string, listener: (...args: unknown[]) => void) => {
        this.listeners.set(event, (this.listeners.get(event) ?? []).filter(entry => entry !== listener))
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
  lastView(): MockView { return this.views.at(-1)! }
}

interface Harness {
  runtime: BrowserRuntime
  adapter: MockAdapter
  view: MockView
  root: string
}

const opened: Harness[] = []
afterEach(() => {
  for (const entry of opened.splice(0)) {
    entry.runtime.dispose()
    rmSync(entry.root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Runtime with one agent-opened tab, a mocked adapter and the given budgets. */
async function makeRuntime(options: { timeoutMs: number, maxTabs?: number }): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'c3-fix-'))
  mkdirSync(join(root, 'downloads'), { recursive: true })
  const store = new BrowserStore({ dir: join(root, 'user-a') })
  const adapter = new MockAdapter()
  const runtime = new BrowserRuntime(
    adapter as never,
    {
      downloadUrl: undefined,
      downloadDir: join(root, 'downloads'),
      timeoutMs: options.timeoutMs,
      loadTimeoutMs: options.timeoutMs,
      ...(options.maxTabs === undefined ? {} : { maxTabs: options.maxTabs }),
    } as never,
    undefined,
    `persist:agent-browser-c3-${String(Math.random()).slice(2)}`,
    { store, locale: () => 'en' },
  )
  const harness: Harness = { runtime, adapter, view: adapter.lastView(), root }
  opened.push(harness)
  await runtime.open('https://example.com/page')
  harness.view = adapter.lastView()
  return harness
}

/** Private-surface accessor for the budget/deadline internals under test. */
interface BudgetInternals {
  activeOperationDeadlineAt: number | undefined
  cdpCallBudgetMs: () => number
  operationRemainingMs: () => number
  screenshotPrimaryBudgetMs: () => number
  screenshotFallbackBudgetMs: () => number
  screenshotLegsBudgetMs: () => { primary: number, fallback: number }
}
const internals = (runtime: BrowserRuntime): BudgetInternals => runtime as unknown as BudgetInternals

// ==================================================================== C3-01

describe('C3-01：deadline 按操作隔离（排队者不能被前一个操作的 unwind 抹掉）', () => {
  it('运行中的操作始终拥有槽；排队者进入临界区后槽仍是它自己的值，CDP 预算按剩余额度收紧', async () => {
    const timeoutMs = 30_000
    const { runtime } = await makeRuntime({ timeoutMs })
    const slot = internals(runtime)
    const seen: {
      holdAtEntry?: number
      holdWhileQueued?: number
      secondAtEntry?: number
      secondLate?: number
      budgetLate?: number
    } = {}

    const hold = runtime.runGated('probe-hold', async () => {
      seen.holdAtEntry = slot.activeOperationDeadlineAt
      await sleep(400)
      // 排队者此时已经登记过自己的 deadline：正在跑的这个操作仍然是槽的主人
      // （把排队者的值暴露给前一个操作是一次放松 —— 前者的预算可能更长）。
      seen.holdWhileQueued = slot.activeOperationDeadlineAt
    })
    await sleep(50)
    const second = runtime.runGated('probe-second', async () => {
      seen.secondAtEntry = slot.activeOperationDeadlineAt
      // 400/500ms 之后前一个操作必然已经 unwind 完（它在 400ms 处退出体）。
      await sleep(500)
      seen.secondLate = slot.activeOperationDeadlineAt
      seen.budgetLate = slot.cdpCallBudgetMs()
    })
    await second
    await hold

    expect(seen.holdWhileQueued, '运行中的操作不许把槽让给排队者').toBe(seen.holdAtEntry)
    expect(seen.secondLate, '排队者进入临界区后必须仍然拥有槽').not.toBeUndefined()
    expect(seen.secondLate, '前一个操作的 unwind 不得覆盖后来者的 deadline').toBe(seen.secondAtEntry)
    // 后果：每条 CDP 命令的预算是「deadline − now」，不是整个工具预算（收紧前的
    // 形态是 30000ms，于是渲染器卡死时挂满工具预算、诊断被上游超时换掉）。
    expect(seen.budgetLate, 'CDP 预算必须按剩余额度收紧').toBeLessThan(timeoutMs)
    const remainingAtRead = (seen.secondLate ?? 0) - Date.now()
    expect(Math.abs((seen.budgetLate ?? 0) - remainingAtRead), 'CDP 预算 ≈ 槽里那份 deadline 的剩余额度').toBeLessThan(200)
  }, 30_000)
})

// ==================================================================== C3-02

describe('C3-02：两条抓帧腿按剩余额度收紧（序号关系：两腿之和 ≤ 剩余额度）', () => {
  it('常量段逐值不变，临界区内耗掉额度后两条腿之和收进剩余额度', async () => {
    // 14000ms 是**最小**能复现该缺陷的预算：只有 budget ≥ 14s 时常量段才会取满
    // 8s + 5s（更小的预算下两条腿被 1s 下限夹住，缺陷在结构上不可见 —— 这也是
    // 审计探针必须用生产 30s 配置的原因）。
    const timeoutMs = 14_000
    const { runtime } = await makeRuntime({ timeoutMs })
    const legs = internals(runtime)

    // ① 常量段（没有排队/等闸消耗）：收紧前逐值不变。
    expect(legs.screenshotPrimaryBudgetMs()).toBe(8_000)
    expect(legs.screenshotFallbackBudgetMs()).toBe(5_000)

    // ② 临界区内先花掉一段额度：两腿之和必须 ≤ 剩余额度（收紧前恒为 13000）。
    let primary = 0
    let fallback = 0
    let remaining = 0
    await runtime.runGated('probe-hold', async () => {
      await sleep(1_500)
      primary = legs.screenshotPrimaryBudgetMs()
      fallback = legs.screenshotFallbackBudgetMs()
      remaining = legs.operationRemainingMs()
    })
    expect(remaining, '前置条件：临界区内确实还剩额度').toBeGreaterThan(0)
    expect(primary).toBeGreaterThan(0)
    expect(fallback).toBeGreaterThan(0)
    expect(primary + fallback, `两腿之和 ${String(primary + fallback)} 必须收进剩余额度 ${String(remaining)}`).toBeLessThanOrEqual(remaining + 50)
    expect(primary + fallback, '前置条件：这次排队确实吃掉了额度（否则判据咬不到）').toBeLessThan(13_000)
  }, 30_000)

  it('渲染器永不产帧时总耗时 ≤ 工具预算，且失败是工具自己的文案（排 7s 队 + 挂死的原生/CDP 抓帧）', async () => {
    const timeoutMs = 14_000
    const { runtime, view } = await makeRuntime({ timeoutMs })
    view.captureHangs = true
    view.transport.hung.add('Page.getLayoutMetrics')
    view.transport.hung.add('Page.captureScreenshot')

    // 合法的前一个操作占住全局互斥 7s（它的 queue 预算允许：14 − 1 − 1 = 12s）。
    // 排队时长必须**足以**让"常量段 8s 原生预算"自己就越过剩余额度，否则这条
    // 判据会被 CDP 腿的收紧兜住而看不出差别（变异实测：排 2s 时收紧前的形态
    // 也能落在预算内 —— 回落那条 CDP 命令被 `cdpCallBudgetMs` 提前拒掉）。
    const hold = runtime.runGated('probe-hold', async () => { await sleep(7_000) })
    await sleep(100)

    const started = Date.now()
    const error = await runtime.screenshot(1).then(() => null, (cause: unknown) => cause as Error)
    const elapsed = Date.now() - started
    await hold

    // 收紧前的形态：排队 7s + 原生 8s = 15s > 14s 预算（更别说再加回落 5s），
    // 工具自己的「哪一段卡住」被上游 timeout-policy 换成笼统的
    // `tool call timed out`。
    expect(elapsed, `本次抓帧耗时 ${String(elapsed)}ms 必须留在工具预算 ${String(timeoutMs)}ms 内`).toBeLessThanOrEqual(timeoutMs)
    expect(error, '必须失败，而不是一直挂着').not.toBeNull()
    // 两条腿的原因都要留下：原生那条 + 渲染器回落那条（模型据此换工具/重试）。
    expect(error?.message).toMatch(/did not settle within/u)
    expect(error?.message).toMatch(/renderer-side fallback/u)
    expect(runtime.opLog.find((entry) => entry.tool === 'browser_screenshot')?.failed).toBe(true)
  }, 40_000)
})

// ==================================================================== C3-03

describe('C3-03：标签槽位等待也按剩余额度收紧（池子满 + 排队）', () => {
  it('池子满且排在长操作后面时，browser_open 在工具预算内抛出池子自己的可执行文案', async () => {
    const timeoutMs = 3_000
    const { runtime } = await makeRuntime({ timeoutMs, maxTabs: 1 })
    // 前一个操作合法占住互斥 800ms（queue 预算 = 3000 − 1000 − 1000 = 1000ms）。
    const hold = runtime.runGated('probe-hold', async () => { await sleep(800) })
    await sleep(50)
    const started = Date.now()
    const error = await runtime.open('https://second.example').then(() => null, (cause: unknown) => cause)
    const elapsed = Date.now() - started
    await hold

    expect(error, '池子满时开页必须失败').not.toBeNull()
    expect((error as { code?: string }).code).toBe('quota')
    // 池子自己那句可执行文案（模型据此知道要关标签）。
    expect((error as Error).message).toMatch(/timed out waiting for a tab slot/u)
    expect((error as Error).message).toMatch(/close a tab first/u)
    // 收紧前是 800(排队) + 5000(固定槽位预算) ≈ 5.8s，越过 3s 注册预算 ⇒ 文案被
    // 上游 timeout-policy 换掉（审计实测生产配置下 30.9s / 预算 30s）。
    expect(elapsed, `本次开页耗时 ${String(elapsed)}ms 必须留在工具预算 ${String(timeoutMs)}ms 内`).toBeLessThan(timeoutMs + 500)
    // 文案里的等待上限必须是**实际**生效的那个（被收紧时不足 1s），否则文案说谎。
    expect((error as Error).message).toMatch(/\(\d+ms, 1 tabs open\)/u)
  }, 20_000)
})

// ============================================== 序关系不变量（每个工具逐个断言）

interface RegisteredTool { name: string, timeoutMs?: number }

/** 一条静态等待腿的**种类**；腿的毫秒数一律从单一真源派生，不写第二份数字。 */
type WaitLegKind = 'slot' | 'load' | 'condition' | 'capture' | 'frame'

/**
 * 每个注册工具**先后**发生的静态内部等待（除用户闸之外的腿）—— 这张表就是
 * "还有哪些腿可能吃掉预算"的登记面。
 *
 * **没有 `default` 分支**：新注册的工具必须在这里明确登记自己的腿（哪怕是"没有静态
 * 腿"），否则下面的判据直接红（死条目同样红）。修复前这张表对没列出的工具返回空数组，
 * 于是 `browser_wait_for` 的 40s 条件等待整条掉出登记面 —— 把 `WAIT_FOR_MAX_MS` 调成
 * 90s、注册 deadline 钉在 55s（2026-10-04 复审 M5 变异），判据仍然绿（实测 NO-TEETH）；
 * `browser_eval` 的帧索引腿（≤650ms）是同一个缺口。
 *
 * CDP 腿与两条抓帧腿**不逐条累加**（每条命令都按剩余额度重新收紧），所以这里只登记
 * "同一次调用里先后发生、各自吃固定额度"的腿。
 */
const TOOL_WAIT_LEGS: Readonly<Record<string, readonly WaitLegKind[]>> = {
  browser_open: ['slot', 'load'],
  browser_navigate: ['load'],
  browser_reload: ['load'],
  browser_go_back: ['load'],
  browser_go_forward: ['load'],
  browser_wait_for: ['condition'],
  browser_screenshot: ['capture'],
  browser_eval: ['frame'],
  // 以下是"没有静态腿"的工具：等待都是按剩余额度收紧的 CDP 命令 / 队列预算。
  browser_list_tabs: [],
  browser_switch_tab: [],
  browser_close_tab: [],
  browser_click: [],
  browser_type: [],
  browser_select: [],
  browser_press: [],
  browser_scroll: [],
  browser_fill_form: [],
  browser_upload_file: [],
  browser_get_snapshot: [],
  browser_get_text: [],
  browser_bookmarks_add: [],
  browser_bookmarks_list: [],
  browser_bookmarks_remove: [],
  browser_history_search: [],
  browser_download: [],
  browser_downloads_list: [],
  browser_downloads_remove: [],
  browser_takeover: [],
  browser_fill_credentials: [],
  browser_credentials_list: [],
  browser_clear_data: [],
}

/**
 * 每条腿**必须**出现在哪些工具的登记里 —— 腿的**内容**判据面（2026-10-04 P3 补）。
 *
 * 它与上面那张表**方向相反**（按腿种类列工具，而不是按工具列腿），所以不是它的副本：
 * 上面那张表是"被审的登记"，这一张是"实现里真的会等这一段的地方"。每个条目都在下面
 * 注明实现锚点，改这张表时先回去读那一处：
 *
 * - `slot`：`runtime.open` 在池子满时 `pool.reserveTab(budget)`（`pool.ts` 的
 *   `waitTimeoutMs` 缺省 = `TAB_SLOT_WAIT_TIMEOUT_MS`）；只有开页会等槽位。
 * - `load`：`runtime.navigate/reload/goBack/goForward` 的
 *   `waitForLoad(...)(this.loadBoundMs(deadlineAt))`（`runtime.ts` 的四处调用点），
 *   `open` 经 `navigateInternal` 走同一条 ⇒ 五个工具都有加载腿。
 * - `condition`：`browser_wait_for` 的 `waitMs = min(timeoutMs, WAIT_FOR_MAX_MS)`
 *   （`tools.ts`）—— 这张表里唯一"按工具参数放大到 WAIT_FOR_MAX_MS"的腿。
 * - `capture`：`runtime.screenshot` 的原生抓帧 + 渲染器回落两条腿。
 * - `frame`：`runtime.eval(tabId, expr, frame)` 的等 OOPIF 上报 + 重新对账
 *   （`FRAME_CONTEXT_WAIT_MS` + `FRAME_INDEX_SETTLE_MS`）。
 *
 * **没有 `default`**：新注册的工具若要在这里点名，必须连同实现锚点一起写清楚。
 */
const REQUIRED_LEGS_BY_KIND: Readonly<Record<WaitLegKind, readonly string[]>> = {
  slot: ['browser_open'],
  load: ['browser_open', 'browser_navigate', 'browser_reload', 'browser_go_back', 'browser_go_forward'],
  condition: ['browser_wait_for'],
  capture: ['browser_screenshot'],
  frame: ['browser_eval'],
}

/** 注册**全部**工具（工具定义在注册期求值，runtime 只需要一个惰性桩）。 */
function registerAllTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>()
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub, construct: () => stub })
  const ctx = {
    tools: { register: (definition: RegisteredTool) => { tools.set(definition.name, definition); return () => {} } },
    systemPrompt: { section: () => () => {} },
  } as unknown as Parameters<typeof applyBrowserTools>[0]
  applyBrowserTools(ctx, stub as BrowserRuntime)
  return tools
}

/** 静态腿的毫秒数 —— 唯一真源：池子的实际缺省 / `budgets.ts` 的常量 / runtime 的抓帧腿。 */
function legMilliseconds(screenshotLegs: number): Record<WaitLegKind, number> {
  return {
    slot: new TabPool().options.waitTimeoutMs,
    load: NAVIGATE_LOAD_BOUND_MS,
    condition: WAIT_FOR_MAX_MS,
    capture: screenshotLegs,
    frame: FRAME_INDEX_LEG_MS,
  }
}

/** 截图两条腿的常量段取值（从实现读，不写第二份数字）。 */
function screenshotLegMillis(): number {
  const legs = internals(new BrowserRuntime(new MockAdapter() as never, { timeoutMs: BROWSER_TOOL_TIMEOUT_MS } as never, undefined, undefined, { store: new BrowserStore({ dir: mkdtempSync(join(tmpdir(), 'c3-legs-')) }) }))
  return legs.screenshotPrimaryBudgetMs() + legs.screenshotFallbackBudgetMs()
}

describe('预算序关系：内部等待之和必须在每个工具的注册预算之内（budgets.ts 的硬约束）', () => {
  it('逐个工具断言 闸门 + 本工具自己的等待腿 + 余量 ≤ 注册预算（登记面必须完整）', () => {
    const tools = registerAllTools()
    expect(tools.size, '前置条件：注册面非空（否则这条判据空转）').toBeGreaterThan(20)
    // 截图的两条腿是常量段的真实取值（从实现读，不写第二份数字）。
    const legs = internals(new BrowserRuntime(new MockAdapter() as never, { timeoutMs: BROWSER_TOOL_TIMEOUT_MS } as never, undefined, undefined, { store: new BrowserStore({ dir: mkdtempSync(join(tmpdir(), 'c3-legs-')) }) }))
    const screenshotLegs = legs.screenshotPrimaryBudgetMs() + legs.screenshotFallbackBudgetMs()
    expect(screenshotLegs, '前置条件：截图常量段是 8s + 5s').toBe(13_000)
    const ms = legMilliseconds(screenshotLegs)

    const unregistered: string[] = []
    const dead: string[] = []
    const over: string[] = []
    for (const [name, tool] of tools) {
      const kinds = TOOL_WAIT_LEGS[name]
      if (kinds === undefined) { unregistered.push(name); continue }
      const waits = USER_GATE_TIMEOUT_MS + kinds.reduce((sum, kind) => sum + ms[kind], 0)
      const budget = tool.timeoutMs ?? BROWSER_TOOL_TIMEOUT_MS
      if (waits + TOOL_DEADLINE_MARGIN_MS > budget) {
        over.push(`${name}: ${String(waits)}ms + ${String(TOOL_DEADLINE_MARGIN_MS)}ms 余量 > ${String(budget)}ms`)
      }
    }
    for (const name of Object.keys(TOOL_WAIT_LEGS)) if (!tools.has(name)) dead.push(name)
    expect(unregistered, '新注册的工具必须在 TOOL_WAIT_LEGS 里登记自己的等待腿').toEqual([])
    expect(dead, '登记表里不许有已经不存在的工具（死条目）').toEqual([])
    expect(over).toEqual([])
  })

  it('常量真源对得上：池子的槽位预算与矩形的加载上限都取自 budgets.ts', () => {
    expect(new TabPool().options.waitTimeoutMs).toBe(TAB_SLOT_WAIT_TIMEOUT_MS)
    expect(NAVIGATE_LOAD_BOUND_MS).toBe(BROWSER_TOOL_TIMEOUT_MS - USER_GATE_TIMEOUT_MS - TAB_SLOT_WAIT_TIMEOUT_MS - TOOL_DEADLINE_MARGIN_MS)
    // `browser_wait_for` 的注册 deadline 必须罩住 闸门 + 最长条件等待 + 余量 —— 上面那张
    // 表把 `condition` 记进它的腿，这条把两侧的取值也钉住（只读一处就会漏）。
    expect(BROWSER_WAIT_FOR_DEADLINE_MS).toBeGreaterThanOrEqual(USER_GATE_TIMEOUT_MS + WAIT_FOR_MAX_MS + TOOL_DEADLINE_MARGIN_MS)
    // 帧索引腿 = 等 OOPIF 上报 + 一次重新对账，两条都在 budgets.ts 里。
    expect(FRAME_INDEX_LEG_MS).toBeLessThanOrEqual(WAIT_FOR_MAX_MS)
  })

  it('腿的**内容**也锚到实现：腿名必须来自真源，且每条腿的归属与实现点名的那份逐条相等（清空/换名/漏登记都红）', () => {
    const tools = registerAllTools()
    const ms = legMilliseconds(screenshotLegMillis())

    // ① 腿名的取值面必须封闭。腿名写错（不在 `WaitLegKind` 里）时 `ms[kind]` 无从取值，
    //    求和会变成 `NaN`/`0` 并让"预算够用"恒成立 —— 那正是这条判据要挡的第一种形态。
    const unknown: string[] = []
    for (const [name, kinds] of Object.entries(TOOL_WAIT_LEGS)) {
      for (const kind of kinds) if (!(kind in ms)) unknown.push(`${name}: ${String(kind)}`)
    }
    expect(unknown, '腿名必须是 budgets.ts 真源里的那几种（写错的名字不得被静默当成"没有这条腿"）').toEqual([])

    // ② 双向对拍：登记表里每条腿的归属，必须与"实现里真的会等这一段"的那份**逐条相等**。
    //    · 腿被清空 / 少登记一条 ⇒ 反向红（实现点名了它，登记里没有）；
    //    · 腿名换成另一种**合法**腿、或凭空空降一条腿 / 重复一条腿 ⇒ 正向红（两边不等）。
    const requiredFor = (name: string): string[] =>
      (Object.keys(REQUIRED_LEGS_BY_KIND) as WaitLegKind[])
        .filter(kind => REQUIRED_LEGS_BY_KIND[kind].includes(name))
        .sort()
    const names = new Set([...Object.keys(TOOL_WAIT_LEGS), ...Object.values(REQUIRED_LEGS_BY_KIND).flat()])
    const mismatched: string[] = []
    for (const name of [...names].sort()) {
      const declared = [...(TOOL_WAIT_LEGS[name] ?? [])].sort()
      const required = requiredFor(name)
      if (declared.join('|') !== required.join('|')) {
        mismatched.push(`${name}: 登记 [${declared.join(', ') || '（空）'}] ≠ 实现锚点表 [${required.join(', ') || '（空）'}]`)
      }
    }
    expect(mismatched, '腿的归属必须与实现一致（清空/换名/漏登记/多登记都红）').toEqual([])

    // ③ 反向驱动：`browser_wait_for` 的注册预算罩的就是"闸门 + 最长条件等待 + 余量"。
    //    上面那条 `over` 只判"够用"，这条把两侧的取值也钉在一起：把 `WAIT_FOR_MAX_MS`
    //    调大而注册 deadline 不动，两条判据会**同时**红（真实回归的形态）。
    const waitFor = tools.get('browser_wait_for')
    expect(waitFor?.timeoutMs, '前置条件：browser_wait_for 有独立注册预算').toBe(BROWSER_WAIT_FOR_DEADLINE_MS)
    const conditionLeg = (TOOL_WAIT_LEGS.browser_wait_for ?? []).reduce((sum, kind) => sum + (ms[kind] ?? 0), 0)
    expect(conditionLeg, 'browser_wait_for 的腿必须覆盖它真的会等的那一段（WAIT_FOR_MAX_MS）').toBeGreaterThanOrEqual(WAIT_FOR_MAX_MS)
    expect(USER_GATE_TIMEOUT_MS + conditionLeg + TOOL_DEADLINE_MARGIN_MS,
      '注册预算必须罩住 闸门 + 条件腿 + 余量').toBeLessThanOrEqual(BROWSER_WAIT_FOR_DEADLINE_MS)
  })
})

// ==================================================================== C3-09

/** 页面回显的凭据形态（公开仓纪律：一律用明显的假值）。 */
const PAGE_TEXT = [
  'Request failed — password=hunter2xyz',
  'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123',
  'api_key=sk-live-abcdef123456',
  'token=TOK-9876543210',
].join('\n')

/** get_text / snapshot / eval 三个出口读到的都是这段页面文本。 */
function wirePageText(view: MockView): void {
  view.transport.handler = (method, params) => {
    if (method !== 'Runtime.evaluate') return {}
    const expression = String(params?.expression ?? '')
    if (expression.includes('querySelectorAll')) {
      return { result: { value: [{ kind: 'input', text: PAGE_TEXT, selector: '#dumped', visible: true, disabled: false }] } }
    }
    return { result: { value: PAGE_TEXT } }
  }
}

describe('C3-09：三个内容出口只走同一条脱敏漏斗（同一份页面文本同口径）', () => {
  it('browser_get_text 交出脱敏后的形态（password/认证头/api_key/token 的值不出窗）', async () => {
    const { runtime, view } = await makeRuntime({ timeoutMs: 30_000 })
    wirePageText(view)
    const text = await runtime.text(1, undefined)
    expect(text).toContain('password=****')
    expect(text).toContain('Authorization: ****')
    expect(text).toContain('api_key=****')
    expect(text).toContain('token=****')
    for (const secret of ['hunter2xyz', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123', 'sk-live-abcdef123456', 'TOK-9876543210']) {
      expect(text, `browser_get_text 不得交出 ${secret}`).not.toContain(secret)
    }
  }, 20_000)

  it('browser_get_snapshot 的元素文本同口径（注入凭据窗口之外也生效）', async () => {
    const { runtime, view } = await makeRuntime({ timeoutMs: 30_000 })
    wirePageText(view)
    const elements = await runtime.snapshot(1)
    const serialized = JSON.stringify(elements)
    for (const secret of ['hunter2xyz', 'sk-live-abcdef123456', 'TOK-9876543210']) {
      expect(serialized, `browser_get_snapshot 不得交出 ${secret}`).not.toContain(secret)
    }
    expect(elements[0]?.text).toContain('password=****')
  }, 20_000)

  it('browser_get_text 与 browser_eval 对同一段页面文本给出**同一个**答案', async () => {
    const { runtime, view } = await makeRuntime({ timeoutMs: 30_000 })
    wirePageText(view)
    const viaText = await runtime.text(1, undefined)
    const viaEval = JSON.parse(await runtime.eval(1, 'readText("#dumped")')) as string
    expect(viaEval).toContain('password=****')
    expect(viaText).toBe(viaEval)
  }, 20_000)

  it('普通正文不被误伤（收窄不等于放开：URL/键值列表逐字节保留）', async () => {
    const { runtime, view } = await makeRuntime({ timeoutMs: 30_000 })
    const ordinary = 'see https://docs.example.com/?keyword=hello for details; width=100; height=200'
    view.transport.handler = (method) => (method === 'Runtime.evaluate' ? { result: { value: ordinary } } : {})
    expect(await runtime.text(1, undefined)).toBe(ordinary)
  }, 20_000)
})
