/**
 * C3-02 残段（2026-10-05 回归审计）的判据：**抓帧总耗时 ≤ 注册预算**必须是
 * 结构不变量，不是"常量挑得好"。
 *
 * 残段的形态（复审实测，生产 30s 配置、排队导致的不同剩余额度）：
 *
 * | 排队 | 修复前 | 修复后 |
 * |---|---|---|
 * | 26.0s | 29002ms（在预算内） | ≤ 28000ms |
 * | 26.5s | **34685ms** | ≤ 28000ms |
 * | 27.0s | **35167 / 35161ms** | ≤ 28000ms |
 * | 27.6s | **35775ms** | ≤ 28000ms |
 *
 * 断崖在 `剩余额度 < 2 × SCREENSHOT_MIN_LEG_BUDGET_MS`：两腿回落常量 `8s + 5s`，
 * 于是「排队 + 两腿」越过注册的 30s，上游 `timeout-policy` 把工具自己的诊断
 * （`capture did not settle within …ms`）整条换成笼统的
 * `tool call timed out after 30000ms` —— 与 2026-09-16 客户现场同一失败形态。
 *
 * 判据有三层，缺一不可：
 *  1. **总额度逐档**（注入 deadline，毫秒级算术）：0 … 注册预算的每一档都断言
 *     `两腿之和 ≤ 剩余额度` 且 `排队 + 两腿 + 余量 ≤ 注册预算`；
 *  2. **端到端（假时钟）**：真的走 `runtime.screenshot` 的完整路径（排队 → 临界区 →
 *     两条腿），在实测的那几个排队档上量**真实耗时**，断言 ≤ 注册预算，且失败文案是
 *     工具自己的那句；
 *  3. **额度不足 ⇒ 快速结构化失败**：错误必须是 `BrowserError`（code `timeout`）+
 *     可执行文案，而不是被上游替换的笼统超时。
 *
 * 变异验证（隔离副本，见 `temp/audit-v282/fixes/C3-02-residual.md`）：
 *  ① 把常量下限段加回去 ⇒ 第 1、2 层必红；
 *  ② 把 `primary` 的钳位上限去掉 ⇒ 第 1 层的"额度充足时恰好 8s + 5s"必红。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'
import { BrowserError } from '../src/errors.ts'
import { BROWSER_TOOL_TIMEOUT_MS, TOOL_DEADLINE_MARGIN_MS } from '../src/budgets.ts'
import type { ElectronAdapter, NativeBounds, NativeSession, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'

/** 工具面上注册的抓帧预算（ms）—— `browser_screenshot` 注册的就是它。 */
const REGISTERED_MS = BROWSER_TOOL_TIMEOUT_MS

// ------------------------------------------------------------------ 测试替身

class MockTransport implements CdpTransport {
  attached = false
  handler: (method: string, params?: Record<string, unknown>) => unknown = () => ({})
  /** 永不 settle 的方法（渲染器不产帧的形态）。 */
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
  /** 原生抓帧永不 settle（隐藏窗口的真实形态）。 */
  captureHangs = true
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

interface Harness { runtime: BrowserRuntime, adapter: MockAdapter, view: MockView, root: string }

const opened: Harness[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const entry of opened.splice(0)) {
    entry.runtime.dispose()
    rmSync(entry.root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

async function makeRuntime(configMs: number, track = true): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'c3-02-'))
  mkdirSync(join(root, 'downloads'), { recursive: true })
  const store = new BrowserStore({ dir: join(root, 'user-a') })
  const adapter = new MockAdapter()
  const runtime = new BrowserRuntime(
    adapter as never,
    { downloadUrl: undefined, downloadDir: join(root, 'downloads'), timeoutMs: configMs, loadTimeoutMs: configMs } as never,
    undefined,
    `persist:agent-browser-c302-${String(Math.random()).slice(2)}`,
    { store, locale: () => 'en' },
  )
  const harness: Harness = { runtime, adapter, view: adapter.lastView(), root }
  if (track) opened.push(harness)
  await runtime.open('https://example.com/page')
  harness.view = adapter.lastView()
  return harness
}

/** 预算内部面（与 C3 主判据同一套只读投影 + 注入点）。 */
interface BudgetInternals {
  activeOperationDeadlines: Array<{ at: number }>
  operationRemainingMs: () => number
  toolBudgetMs: () => number
  screenshotTotalBudgetMs: () => number
  screenshotLegsBudgetMs: () => { primary: number, fallback: number }
}
const internals = (runtime: BrowserRuntime): BudgetInternals => runtime as unknown as BudgetInternals

/**
 * 在**假时钟**下量一次"排队 queueMs 后抓帧"，真的走完整路径（排队 → 临界区 →
 * 两条永不 settle 的抓帧腿）。生产 30s 配置因此不必真等 30s：时间由
 * `vi.advanceTimersByTimeAsync` 推进，断言里的耗时就是假时钟读到的耗时。
 */
async function measureQueuedScreenshot(configMs: number, queueMs: number): Promise<{ elapsed: number, error: Error, opLog: BrowserRuntime['opLog'] }> {
  const { runtime, view, root } = await makeRuntime(configMs, false)
  view.captureHangs = true
  view.transport.hung.add('Page.getLayoutMetrics')
  view.transport.hung.add('Page.captureScreenshot')
  vi.useFakeTimers()
  try {
    const hold = runtime.runGated('probe-hold', async () => { await sleep(queueMs) })
    await vi.advanceTimersByTimeAsync(10)
    const started = Date.now()
    let settled = false
    const shot = runtime.screenshot(1).then(
      () => { settled = true; return new Error('screenshot unexpectedly succeeded') },
      (cause: unknown) => { settled = true; return cause as Error },
    )
    // 循环上限必须**大于**残段的实测耗时（排队 + 13s + 一条 CDP 命令），否则变异体
    // 会在上限处停下、断言读到的是上限而不是真实耗时（假绿）。
    const cap = queueMs + 20_000
    while (!settled && Date.now() - started < cap) await vi.advanceTimersByTimeAsync(25)
    const error = await shot
    const elapsed = Date.now() - started
    await vi.advanceTimersByTimeAsync(50)
    await hold.catch(() => {})
    return { elapsed, error, opLog: [...runtime.opLog] }
  } finally {
    vi.useRealTimers()
    runtime.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

// ============================================================ ① 总额度逐档

describe('C3-02 残段①：抓帧总额度逐档都收在剩余额度内（不许回落常量）', () => {
  it('额度充足时两条腿恰好是 8s + 5s（上限不随额度增长）', async () => {
    const { runtime } = await makeRuntime(REGISTERED_MS)
    const budget = internals(runtime)
    expect(budget.toolBudgetMs(), '前置条件：生产配置推导出的工具预算是注册预算').toBe(REGISTERED_MS)

    // 没有活动操作（用户路径 / 事件回调腿）：总额度 = 配置 − 余量 = 29s ⇒ 常量段。
    expect(budget.screenshotLegsBudgetMs()).toEqual({ primary: 8_000, fallback: 5_000 })

    // 剩余额度 25s（> 13s）：仍然恰好是 8s + 5s —— 两腿有**上限**，不随额度增长。
    budget.activeOperationDeadlines.length = 0
    budget.activeOperationDeadlines.push({ at: Date.now() + 25_000 + TOOL_DEADLINE_MARGIN_MS })
    expect(budget.screenshotLegsBudgetMs()).toEqual({ primary: 8_000, fallback: 5_000 })
  })

  it('剩余额度从 0 到注册预算逐档：两腿之和 ≤ 剩余额度，且 排队 + 两腿 + 余量 ≤ 注册预算', async () => {
    const { runtime } = await makeRuntime(REGISTERED_MS)
    const budget = internals(runtime)
    // 实测点（复审 2026-10-04 的断崖就在 26.0 ↔ 26.5 之间）+ 全域扫描点。
    // 扫描面只到**可达**的最大排队时长：队列自己的预算是
    // `注册预算 − 2 × 余量`（`withAgentAttribution`），再长的排队会先抛池子的
    // "timed out waiting for the running browser operation"。
    const maxQueueMs = REGISTERED_MS - 2 * TOOL_DEADLINE_MARGIN_MS
    const queued = [
      ...Array.from({ length: maxQueueMs / 500 + 1 }, (_value, index) => index * 500),
      26_000, 26_500, 27_000, 27_600, 28_000,
    ]
    const rows: string[] = []
    const overRemaining: string[] = []
    const overRegistered: string[] = []
    let extreme = 0
    for (const queueMs of queued) {
      budget.activeOperationDeadlines.length = 0
      budget.activeOperationDeadlines.push({ at: Date.now() + REGISTERED_MS - TOOL_DEADLINE_MARGIN_MS - queueMs })
      // 先读剩余额度、后读两腿：两条腿在更晚的时刻求值，剩余额度只会更小。
      const remaining = budget.operationRemainingMs()
      const legs = budget.screenshotLegsBudgetMs()
      const sum = legs.primary + legs.fallback
      if (remaining < 1_000) extreme++
      rows.push(`queue=${String(queueMs)} remaining=${String(remaining)} legs=${String(legs.primary)}+${String(legs.fallback)}=${String(sum)}`)
      if (sum > Math.max(0, remaining)) overRemaining.push(`${String(queueMs)}: ${String(sum)} > ${String(remaining)}`)
      if (queueMs + sum + TOOL_DEADLINE_MARGIN_MS > REGISTERED_MS) overRegistered.push(`${String(queueMs)}: ${String(queueMs + sum + TOOL_DEADLINE_MARGIN_MS)} > ${String(REGISTERED_MS)}`)
    }
    budget.activeOperationDeadlines.length = 0
    // eslint-disable-next-line no-console
    console.log(`\n[C3-02 rows]\n${rows.filter((_row, index) => index % 7 === 0 || index >= rows.length - 7).join('\n')}\n`)
    expect(extreme, '前置条件：扫描面必须覆盖"剩余额度 < 一条腿下限"的极端档（否则判据空转）').toBeGreaterThan(0)
    expect(overRemaining, '两腿之和必须 ≤ 剩余额度（残段就在这里回落成 13s）').toEqual([])
    expect(overRegistered, '排队 + 两腿 + 余量必须 ≤ 注册预算').toEqual([])
  }, 20_000)
})

// ==================================================== ② 端到端（假时钟）

describe('C3-02 残段②：排队后的抓帧总耗时 ≤ 注册预算（端到端，假时钟）', () => {
  // 断崖两侧 + 极端档：修复前 26.5/27.0/27.6 分别实测 34685 / 35167 / 35775ms。
  it.each([20_000, 26_000, 26_500, 27_000, 27_600])('排队 %i ms 后：总耗时 ≤ 注册预算，失败是工具自己的文案', async (queueMs) => {
    const { elapsed, error, opLog } = await measureQueuedScreenshot(REGISTERED_MS, queueMs)
    // eslint-disable-next-line no-console
    console.log(`[C3-02 e2e] queue=${String(queueMs)} elapsed=${String(elapsed)} over=${String(elapsed > REGISTERED_MS)} code=${String((error as BrowserError).code ?? '')} message=${error.message.slice(0, 120)}`)
    expect(elapsed, `排队 ${String(queueMs)}ms 后抓帧耗时 ${String(elapsed)}ms 必须留在注册预算 ${String(REGISTERED_MS)}ms 内`).toBeLessThanOrEqual(REGISTERED_MS)
    expect(elapsed, '前置条件：确实等过排队那一段（否则量到的不是这条路径）').toBeGreaterThanOrEqual(queueMs)
    // 工具自己的诊断（两条腿各自的原因或"额度不够，没抓"），不是上游那句笼统超时。
    expect(error.message).not.toMatch(/tool call timed out/u)
    expect(error.message).toMatch(/did not settle within|screenshot skipped/u)
    expect(error.message).toMatch(/browser/u)
    expect(opLog.find((entry) => entry.tool === 'browser_screenshot')?.failed, '失败必须进 op log').toBe(true)
  }, 60_000)
})

// ============================================ ③ 额度不足 ⇒ 快速结构化失败

describe('C3-02 残段③：额度不足时在尝试抓帧之前快速结构化失败', () => {
  it('剩余不足一条腿下限：报工具自己的 timeout 错误 + 可执行文案，且不花掉抓帧预算', async () => {
    const { runtime, view } = await makeRuntime(REGISTERED_MS)
    view.captureHangs = true
    view.transport.hung.add('Page.getLayoutMetrics')
    view.transport.hung.add('Page.captureScreenshot')
    vi.useFakeTimers()
    try {
      const hold = runtime.runGated('probe-hold', async () => { await sleep(27_600) })
      await vi.advanceTimersByTimeAsync(10)
      const started = Date.now()
      let settled = false
      const shot = runtime.screenshot(1).then(
        () => { settled = true; return new Error('screenshot unexpectedly succeeded') },
        (cause: unknown) => { settled = true; return cause as Error },
      )
      while (!settled && Date.now() - started < 40_000) await vi.advanceTimersByTimeAsync(25)
      const error = await shot
      const elapsed = Date.now() - started
      await vi.advanceTimersByTimeAsync(50)
      await hold.catch(() => {})

      expect(error, '必须失败').toBeInstanceOf(BrowserError)
      expect((error as BrowserError).code, '结构化错误码（不是笼统超时）').toBe('timeout')
      expect(error.message).toMatch(/screenshot skipped/u)
      expect(error.message).toMatch(/only \d+ms/u)
      expect(error.message, '文案必须可执行').toMatch(/retry the screenshot now that the browser is idle/u)
      expect(error.message).not.toMatch(/tool call timed out/u)
      expect(elapsed, `总耗时 ${String(elapsed)}ms 必须留在注册预算内`).toBeLessThanOrEqual(REGISTERED_MS)
      expect(elapsed, '没有尝试任何抓帧 ⇒ 只花掉排队那一段（残段的常量段是 13s）').toBeLessThan(28_500)
      const op = runtime.opLog.find((entry) => entry.tool === 'browser_screenshot')
      expect(op?.failed, '快速失败必须进 op log（活动面板/留痕）').toBe(true)
      expect(op?.summary).toMatch(/skipped/u)
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)
})

// ================================================ ④ Config.timeoutMs 越界（残余③）

describe('C3-02 残余③：Config.timeoutMs 大于注册预算时不得越过它', () => {
  it('timeoutMs = 60s 的部署，排队 26.5s 后的抓帧仍 ≤ 注册的 30s', async () => {
    const { elapsed, error } = await measureQueuedScreenshot(60_000, 26_500)
    // eslint-disable-next-line no-console
    console.log(`[C3-02 residual-3] config=60000 queue=26500 elapsed=${String(elapsed)} over=${String(elapsed > REGISTERED_MS)}`)
    // 复审实测（修复前）：37917 / 37922 / 37929ms > 注册 30000ms。
    expect(elapsed, `配置 60s 时排队抓帧 ${String(elapsed)}ms 仍必须留在注册预算 ${String(REGISTERED_MS)}ms 内`).toBeLessThanOrEqual(REGISTERED_MS)
    expect(error.message).toMatch(/did not settle within|screenshot skipped/u)
  }, 60_000)

  it('内部推导的 deadline 认注册预算为上限（配置只能调小，不能调大）', async () => {
    const { runtime } = await makeRuntime(60_000)
    expect(internals(runtime).toolBudgetMs()).toBe(REGISTERED_MS)
  })
})
