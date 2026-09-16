/**
 * TabPool (v4.2 单池) unit tests: flat tab pool, global serial mutex with the
 * user gate, tab quota (reserve/wait/timeout/cancel), ledger round-trips and
 * lifecycle events.
 */
import { describe, expect, it } from 'vitest'
import { TabPool } from '../src/pool.ts'
import { BrowserError } from '../src/errors.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('TabPool — basics', () => {
  it('registers tabs and tracks the active tab', () => {
    const pool = new TabPool()
    pool.registerTab(1, 'https://a', 'A')
    pool.registerTab(2, 'https://b', 'B')
    expect(pool.activeTab).toBe(2)  // new tab becomes active
    expect(pool.has(1)).toBe(true)
    expect(pool.get(2)?.url).toBe('https://b')
    pool.setActiveTab(2)
    expect(pool.activeTab).toBe(2)
    expect(pool.list().find((t) => t.id === 2)?.active).toBe(true)
  })

  it('rejects setActiveTab for unknown tabs with browserError not-found', () => {
    const pool = new TabPool()
    pool.registerTab(1, '', '')
    expect(() => pool.setActiveTab(404)).toThrow(BrowserError)
    try {
      pool.setActiveTab(404)
    } catch (e) {
      expect((e as BrowserError).code).toBe('not-found')
    }
  })

  it('removes tabs and shifts the active tab', () => {
    const pool = new TabPool()
    pool.registerTab(1, '', '')
    pool.registerTab(2, '', '')
    pool.registerTab(3, '', '')
    pool.setActiveTab(2)
    pool.removeTab(2)
    expect(pool.has(2)).toBe(false)
    expect(pool.activeTab).toBe(3)
    pool.removeTab(3)
    pool.removeTab(1)
    expect(pool.activeTab).toBeUndefined()
    expect(pool.list()).toEqual([])
  })

  it('emits change events (tab/tab-meta/busy/takeover/release)', () => {
    const pool = new TabPool()
    const events: string[] = []
    pool.onChange((e) => events.push(e))
    pool.registerTab(1, '', '')
    pool.updateTabMeta(1, 'https://a', 'A')
    pool.setUserControl(true)
    pool.setUserControl(false)
    expect(events).toContain('tab')
    expect(events).toContain('tab-meta')
    expect(events).toContain('takeover')
    expect(events).toContain('release')
    const off = pool.onChange(() => events.push('extra'))
    off()
    pool.updateTabMeta(1, 'https://b', 'B')
    expect(events.filter((e) => e === 'extra').length).toBe(0)
  })
})

describe('TabPool — user gate & mutex', () => {
  it('user takeover pauses operations until release', async () => {
    const pool = new TabPool()
    let entered = false
    pool.setUserControl(true)
    const run = pool.withOperation('browser_navigate', async () => { entered = true })
    await sleep(80)
    expect(entered).toBe(false)
    pool.setUserControl(false)
    await run
    expect(entered).toBe(true)
  })

  it('aborting during takeover rejects window-controlled', async () => {
    const pool = new TabPool()
    pool.setUserControl(true)
    const ctrl = new AbortController()
    const run = pool.withOperation('browser_click', async () => {}, ctrl.signal).catch((e: unknown) => e)
    ctrl.abort()
    const err = await run
    expect(err).toBeInstanceOf(BrowserError)
    expect((err as BrowserError).code).toBe('window-controlled')
  })

  it('serializes concurrent operations (FIFO ordering)', async () => {
    const pool = new TabPool()
    const order: number[] = []
    const p1 = pool.withOperation('a', async () => { await sleep(30); order.push(1) })
    const p2 = pool.withOperation('b', async () => { order.push(2) })
    await Promise.all([p1, p2])
    expect(order).toEqual([1, 2])
    expect(pool.isBusy()).toBe(false)
  })
})

describe('TabPool — quota', () => {
  it('enforces the flat tab cap and waits FIFO, then pumps on release', async () => {
    const pool = new TabPool({ maxTabs: 2, waitTimeoutMs: 5000 })
    pool.registerTab(1, '', '')
    pool.registerTab(2, '', '')
    let third = false
    const waiting = pool.reserveTab().then(() => { third = true })
    await sleep(60)
    expect(third).toBe(false)
    pool.removeTab(1)
    await waiting
    expect(third).toBe(true)
    pool.releaseReservation()
    pool.registerTab(3, '', '')
  })

  it('times out waiting for a slot with code quota', async () => {
    const pool = new TabPool({ maxTabs: 1, waitTimeoutMs: 60 })
    pool.registerTab(1, '', '')
    const err = await pool.reserveTab().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrowserError)
    expect((err as BrowserError).code).toBe('quota')
  })

  it('cancels a wait on abort', async () => {
    const pool = new TabPool({ maxTabs: 1, waitTimeoutMs: 5000 })
    pool.registerTab(1, '', '')
    const ctrl = new AbortController()
    const pending = pool.reserveTab(ctrl.signal).catch((e: unknown) => e)
    ctrl.abort()
    const err = await pending
    expect((err as BrowserError).code).toBe('quota')
  })

  it('tryReserveTab is fail-fast', () => {
    const pool = new TabPool({ maxTabs: 1 })
    expect(pool.tryReserveTab()).toBeDefined()
    expect(pool.tryReserveTab()).toBeUndefined()
    pool.releaseReservation()
    expect(pool.tryReserveTab()).toBeDefined()
  })

  it('用户接管后 agent 操作不再无限期挂住（2026-09-15 审计 P0-1）', async () => {
    // 暂停是产品意图，但必须有预算：否则用户点「我来操作」后一直不点「交给 AI」，
    // 模型回合会无声地永远挂着。超时以明确错误结束这次调用（不抢控制权）。
    const pool = new TabPool({ userGateTimeoutMs: 60 })
    pool.setUserControl(true)
    const started = Date.now()
    const err = await pool.withOperation('browser_open', async () => 'never').catch((cause: unknown) => cause)
    const waited = Date.now() - started
    expect((err as { code?: string }).code).toBe('window-controlled')
    expect(String((err as Error).message)).toContain('等待用户交还浏览器超时')
    expect(waited).toBeGreaterThanOrEqual(50)
    // 用户交还后队列恢复可用
    pool.setUserControl(false)
    await expect(pool.withOperation('browser_open', async () => 'ok')).resolves.toBe('ok')
  })

  it('闸门拒绝的文案必须告诉模型怎么解开（2026-09-16）', async () => {
    // 现场：只看到 timeout-policy 的 "tool call timed out after 30000ms"，模型
    // 把"用户正拿着控制权"误判成页面卡死。凡是被闸门拒绝的出口，都要说清
    // 「我来操作」/「交给 AI」这两个按钮。
    const pool = new TabPool({ userGateTimeoutMs: 40 })
    pool.setUserControl(true)
    const timeout = await pool.withOperation('browser_eval', async () => 'never').catch((cause: unknown) => cause)
    expect(String((timeout as Error).message)).toContain('交给 AI')
    expect(String((timeout as Error).message)).toContain('我来操作')

    const ctrl = new AbortController()
    const pending = pool.withOperation('browser_click', async () => {}, ctrl.signal).catch((cause: unknown) => cause)
    ctrl.abort()
    const abort = await pending
    expect((abort as BrowserError).code).toBe('window-controlled')
    expect(String((abort as Error).message)).toContain('交给 AI')
  })

  it('清空池子同时结束"用户持有"状态（2026-09-16 P1）', () => {
    // 池子被清空 = 关闭浏览器 / 窗口销毁 / 切换会话或分区 / 清数据。与
    // 2026-09-15 P1-1 的会话切换修复同一口径：`controlled` 不能比池子活得久
    // ——否则蒙版不再上锁、agent 变成静默超时，而「交给 AI」按钮随窗口一起没了。
    const pool = new TabPool()
    const events: string[] = []
    pool.onChange((event) => events.push(event))
    pool.registerTab(1, 'https://a', 'A')
    pool.setUserControl(true)
    expect(pool.controlled).toBe(true)
    pool.clear()
    expect(pool.controlled).toBe(false)
    expect(events).toContain('release')
    expect(pool.list()).toEqual([])
    // 已经交还后再清空不再发 release（幂等，不制造假事件）
    const before = events.filter((e) => e === 'release').length
    pool.clear()
    expect(events.filter((e) => e === 'release').length).toBe(before)
  })

  it('预留令牌一次性：导航失败后的兜底释放不能把容量吃掉（2026-09-15 P0）', () => {
    // 现场形态：open() 预留 → createTabReal 里 registerTab（兑现预留）→
    // navigateInternal 抛 navigation-blocked → catch 里 removeTab，调用方再
    // releaseReservation 一次。旧实现只有计数器，第二次释放会把这一次预留
    // 凭空抹掉 ⇒ 池子静默缩容，最终"再也开不出新标签页"，只能重启客户端。
    const pool = new TabPool({ maxTabs: 1 })
    const reservation = pool.tryReserveTab()
    expect(reservation).toBeDefined()
    pool.registerTab(7, '', '', reservation) // 兑现
    pool.removeTab(7)                        // 导航失败：视图销毁、tab 移除
    pool.releaseReservation(reservation)     // 调用方兜底释放 → 必须是 no-op
    // 容量 1 仍然可用：池子没有被静默缩容
    expect(pool.tryReserveTab()).toBeDefined()
  })

  it('预留令牌：重复退还是 no-op，未兑现的预留可以正常退还', () => {
    const pool = new TabPool({ maxTabs: 1 })
    const first = pool.tryReserveTab()
    expect(first).toBeDefined()
    pool.releaseReservation(first)
    pool.releaseReservation(first) // 重复退还：no-op
    const second = pool.tryReserveTab()
    expect(second).toBeDefined()
    pool.registerTab(1, '', '', second)
    // 已兑现的令牌再退也不能把 tab 的槽位算掉
    pool.releaseReservation(second)
    pool.removeTab(1)
    expect(pool.tryReserveTab()).toBeDefined()
  })
})

describe('TabPool — ledger', () => {
  it('round-trips the tab ledger (url/title/active)', () => {
    const pool = new TabPool()
    pool.registerTab(1, 'https://a', 'A')
    pool.registerTab(2, 'https://b', 'B')
    pool.setActiveTab(2)
    const ledger = pool.snapshotLedger()
    const restored = new TabPool()
    restored.restoreLedger(ledger)
    expect(restored.list().map((t) => t.id)).toEqual([1, 2])
    expect(restored.activeTab).toBe(2)
    expect(restored.get(1)?.url).toBe('https://a')
  })

  it('ignores malformed ledgers', () => {
    const pool = new TabPool()
    pool.restoreLedger({ version: 1, activeTabId: 5, tabs: [{ tabId: 'x' } as never], savedAt: 0 })
    expect(pool.list()).toEqual([])
  })
})

describe('TabPool — mutex cancellation (2026-09-08 P0-4)', () => {
  it('aborts a queued operation while the previous one is still running', async () => {
    const pool = new TabPool()
    let releaseFirst!: () => void
    const first = pool.withOperation('first', () => new Promise<void>((resolve) => { releaseFirst = resolve }))
    const controller = new AbortController()
    const second = pool.withOperation('second', async () => 'ran', controller.signal)
    await sleep(20)
    controller.abort()
    await expect(second).rejects.toMatchObject({ code: 'interrupted' })
    releaseFirst()
    await first
    // The mutex tail must still be released so later calls proceed.
    await expect(pool.withOperation('third', async () => 'ok')).resolves.toBe('ok')
    expect(pool.isBusy()).toBe(false)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const pool = new TabPool()
    const controller = new AbortController()
    controller.abort()
    await expect(pool.withOperation('queued', async () => 'ran', controller.signal))
      .rejects.toMatchObject({ code: 'interrupted' })
    expect(pool.isBusy()).toBe(false)
  })
})
