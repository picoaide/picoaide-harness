/**
 * 2026-09-15 全量审计 F1/F2/F3 的回归（插件启动期与用户切换）：
 *
 *  · F1：`apply()` 同步跑完，而 `SessionService.restore()` 的赋值/emit 都在
 *    `await` 之后 —— 带持久会话开机时 `currentUser()` 在构造那一刻常为 null，
 *    分区/store 会先落在匿名桶上。旧实现只靠 `pico/session-changed` 纠正，
 *    这正是本轮现场 P0 的同一结构（一次性采样 + 只等一个可能不来的事件）。
 *  · F2：用户切换链把 `closeAll` 放链首，一次抛错就跳过分区/store/交接切换
 *    （界面已换账号、浏览器还在旧账号的数据上）。
 *  · F3：交接表与闸门必须用同一 fence 判据，否则交接"假成功即停表"。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, connectionFenceReady, runSessionSwitch } from '../src/index.ts'


interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (...args: never[]) => unknown
}

let home: string
let routes: Route[]
let sessionListeners: Array<(next: unknown) => void>

interface HarnessOptions {
  restored?: boolean
  /** 动态开关：测试可以在 apply() 之后把它翻成 true 模拟"恢复完成"。 */
  restoredRef?: { value: boolean }
  username?: string | null
  fence?: unknown
}

function harness(options: HarnessOptions = {}): Record<string, unknown> {
  routes = []
  sessionListeners = []
  const session = options.username === undefined || options.username === null
    ? null
    : { username: options.username }
  return {
    get: (name: string) => {
      if (name === 'picoSession') {
        const restored = (): boolean => options.restoredRef?.value ?? options.restored === true
        return { isRestored: restored, getSession: () => session }
      }
      if (name === 'connection') return options.fence
      return undefined
    },
    on: (event: string, listener: (next: unknown) => void) => {
      if (event === 'pico/session-changed') sessionListeners.push(listener)
      return () => {}
    },
    effect: (fn: () => unknown) => {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    webServer: { port: 3080, register: (route: Route) => { routes.push(route); return () => {} } },
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'browser-scope-'))
  process.env.DSH_HOME = home
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('启动期等"会话已恢复"再建浏览器窗口（审计 F1）', () => {
  it('恢复未完成时不建窗口；恢复完成后才 prewarm', async () => {
    const restoredRef = { value: false }
    const warn = vi.fn()
    const ctx = harness({ restoredRef, username: 'alice' })
    ;(ctx.logger as { warn: unknown }).warn = warn
    apply(ctx as never, {})

    // 恢复还没回来：boot prewarm 必须等待（旧实现在这里就建窗口，于是分区/store
    // 先落匿名桶 —— 这正是"登录态慢"时用户看到浏览器/书签换了一套的窗口期）
    await new Promise((resolve) => { setTimeout(resolve, 120) })
    expect(warn).not.toHaveBeenCalled()

    // 恢复完成 → 立刻 prewarm（测试宿主里建窗失败，正好给出可断言的信号）
    restoredRef.value = true
    await new Promise((resolve) => { setTimeout(resolve, 250) })
    expect(warn).toHaveBeenCalledWith('pico-browser: prewarm failed', expect.any(Error))
  })

  it('没有 picoSession 的宿主（headless/单测）不等，照旧立刻 prewarm', async () => {
    const warn = vi.fn()
    const ctx = harness({ username: null })
    ;(ctx.logger as { warn: unknown }).warn = warn
    // 抹掉 picoSession 服务：isRestored 不可用 ⇒ 不等待
    const original = ctx.get as (name: string) => unknown
    ctx.get = (name: string) => name === 'picoSession' ? undefined : original(name)
    apply(ctx as never, {})
    await new Promise((resolve) => { setTimeout(resolve, 150) })
    expect(warn).toHaveBeenCalledWith('pico-browser: prewarm failed', expect.any(Error))
  })
})

describe('用户切换链的容错与顺序（审计 F2）', () => {
  it('closeAll 抛错也必须完成身份切换与重建，只记一条告警', async () => {
    const calls: string[] = []
    const warn = vi.fn()
    await runSessionSwitch({
      applyUserScope: () => { calls.push('scope') },
      closeAll: async () => { calls.push('close'); throw new Error('Object has been destroyed') },
      clearOps: () => { calls.push('ops') },
      prewarm: async () => { calls.push('rebuild') },
      warn,
    })
    // 身份切换必须发生在清理之前，且清理失败后其余步骤照做
    expect(calls).toEqual(['scope', 'close', 'ops', 'rebuild'])
    expect(warn).toHaveBeenCalledWith(
      'pico-browser: closing tabs during the user switch failed',
      expect.any(Error),
    )
  })

  it('正常路径：四步按序执行、不产生告警', async () => {
    const calls: string[] = []
    const warn = vi.fn()
    await runSessionSwitch({
      applyUserScope: () => { calls.push('scope') },
      closeAll: async () => { calls.push('close') },
      clearOps: () => { calls.push('ops') },
      prewarm: async () => { calls.push('rebuild') },
      warn,
    })
    expect(calls).toEqual(['scope', 'close', 'ops', 'rebuild'])
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('fence 判据与闸门同口径（审计 F3）', () => {
  it('服务存在但 requestRejection 不可用时视为未就绪', () => {
    expect(connectionFenceReady(undefined)).toBe(false)
    expect(connectionFenceReady(null)).toBe(false)
    expect(connectionFenceReady({})).toBe(false)
    expect(connectionFenceReady({ requestRejection: 'nope' })).toBe(false)
    expect(connectionFenceReady({ requestRejection: () => undefined })).toBe(true)
  })

  it('fence 只有一半可用时，写面按 503 fail-closed（不是 401）', async () => {
    const ctx = harness({ fence: { requestRejection: 'nope' } })
    apply(ctx as never, {})
    const route = routes.find((r) => r.kind === 'prefix' && r.path === '/api/pico/browser')
    expect(route).toBeDefined()
    let code = 0
    const res = {
      writeHead: (value: number) => { code = value },
      end: () => {},
    } as unknown as never
    await route!.handler({
      method: 'POST',
      url: '/api/pico/browser/takeover',
      headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
      socket: { remoteAddress: '127.0.0.1' },
      [Symbol.asyncIterator]: async function* () { yield Buffer.from('{}') },
    } as never, res)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(code).toBe(503)
  })
})
