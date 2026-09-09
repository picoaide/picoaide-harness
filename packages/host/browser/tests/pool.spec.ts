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
    expect(pool.tryReserveTab()).toBe(true)
    expect(pool.tryReserveTab()).toBe(false)
    pool.releaseReservation()
    expect(pool.tryReserveTab()).toBe(true)
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
