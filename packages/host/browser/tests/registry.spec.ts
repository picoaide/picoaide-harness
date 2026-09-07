import { describe, expect, it } from 'vitest'
import { GroupRegistry } from '../src/registry.ts'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Extract the stable error code thrown by a synchronous call. */
function errorCodeOf(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

/** Helper: acquire a group, reserve+register one tab (round trip). */
async function tabOf(reg: GroupRegistry, key: string, tabId: number, url = '', title = ''): Promise<void> {
  await reg.reserveTab(key)
  reg.registerTab(key, tabId, url, title)
}

describe('GroupRegistry (v4)', () => {
  it('defaults to the design quota table {4,8,16,60000}', () => {
    const reg = new GroupRegistry()
    expect(reg.options.maxGroups).toBe(4)
    expect(reg.options.maxTabsPerGroup).toBe(8)
    expect(reg.options.maxTabsTotal).toBe(16)
    expect(reg.options.waitTimeoutMs).toBe(60_000)
    expect(reg.options.archiveRetentionMs).toBe(24 * 60 * 60 * 1000)
    reg.dispose()
  })

  it('acquireGroup creates the group immediately while slots are free', async () => {
    const reg = new GroupRegistry({ maxGroups: 2 })
    const g1 = await reg.acquireGroup('s1', '第一个')
    expect(g1.status).toBe('active')
    expect(g1.key).toBe('s1')
    expect(g1.label).toBe('第一个')
    expect(reg.get('s1')).toBe(g1)
    // An already-open group returns the same group (no second slot).
    const again = await reg.acquireGroup('s1', undefined)
    expect(again).toBe(g1)
    expect(reg.list()).toHaveLength(1)
    reg.dispose()
  })

  it('acquireGroup FIFO-waits past maxGroups and cancels via abort (group-quota)', async () => {
    const reg = new GroupRegistry({ maxGroups: 2 })
    await reg.acquireGroup('s1')
    await reg.acquireGroup('s2')
    let settled = false
    const ac = new AbortController()
    const waiter = reg.acquireGroup('s3', undefined, ac.signal).catch((error) => {
      settled = true
      throw error
    })
    await sleep(30)
    // Still queueing: the cap is reached, s3 must wait for a slot.
    expect(settled).toBe(false)
    expect(reg.get('s3')).toBeUndefined()
    ac.abort()
    await expect(waiter).rejects.toMatchObject({ code: 'group-quota' })
    expect(reg.get('s3')).toBeUndefined()
    reg.dispose()
  })

  it('rejects an immediately-aborted acquireGroup with group-quota', async () => {
    const reg = new GroupRegistry({ maxGroups: 1 })
    await reg.acquireGroup('s1')
    const ac = new AbortController()
    ac.abort()
    await expect(reg.acquireGroup('s2', undefined, ac.signal)).rejects.toMatchObject({ code: 'group-quota' })
    reg.dispose()
  })

  it('reserveTab enforces the per-group cap and is cancellable', async () => {
    const reg = new GroupRegistry({ maxTabsPerGroup: 2, maxTabsTotal: 16 })
    await reg.acquireGroup('s1')
    await tabOf(reg, 's1', 1, 'https://a.example', 'A')
    await tabOf(reg, 's1', 2, 'https://b.example', 'B')
    expect(reg.tryReserveTab('s1')).toBe(false) // user path fails fast
    let settled = false
    const ac = new AbortController()
    const waiter = reg.reserveTab('s1', ac.signal).catch((error) => {
      settled = true
      throw error
    })
    await sleep(30)
    expect(settled).toBe(false)
    ac.abort()
    await expect(waiter).rejects.toMatchObject({ code: 'group-quota' })
    reg.dispose()
  })

  it('reserveTab enforces the global cap across groups', async () => {
    const reg = new GroupRegistry({ maxTabsPerGroup: 8, maxTabsTotal: 3 })
    await reg.acquireGroup('s1')
    await reg.acquireGroup('s2')
    await tabOf(reg, 's1', 1)
    await tabOf(reg, 's1', 2)
    await tabOf(reg, 's2', 3)
    // Per-group headroom exists in s2, but the global pool is exhausted.
    expect(reg.tryReserveTab('s2')).toBe(false)
    expect(reg.tryReserveTab('s1')).toBe(false)
    let settled = false
    const ac = new AbortController()
    const waiter = reg.reserveTab('s2', ac.signal).catch((error) => {
      settled = true
      throw error
    })
    await sleep(30)
    expect(settled).toBe(false)
    ac.abort()
    await expect(waiter).rejects.toMatchObject({ code: 'group-quota' })
    reg.dispose()
  })

  it('tryReserveTab fails fast for unknown groups and never queues', async () => {
    const reg = new GroupRegistry()
    expect(reg.tryReserveTab('nope')).toBe(false)
    await reg.acquireGroup('s1')
    expect(reg.tryReserveTab('s1')).toBe(true)
    // The reservation is consumed by registerTab.
    reg.registerTab('s1', 1, '', '')
    expect(reg.get('s1')?.tabs.has(1)).toBe(true)
    reg.dispose()
  })

  it('withGroup serializes ops within one group (call order = completion order)', async () => {
    const reg = new GroupRegistry()
    await reg.acquireGroup('s1')
    const order: string[] = []
    const first = reg.withGroup('s1', 'browser_first', async () => {
      order.push('first-start')
      await sleep(40)
      order.push('first-end')
    })
    const second = reg.withGroup('s1', 'browser_second', async () => {
      order.push('second-start')
      await sleep(5)
      order.push('second-end')
    })
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end'])
    reg.dispose()
  })

  it('different groups drive in parallel (no cross-group serialization)', async () => {
    const reg = new GroupRegistry()
    await reg.acquireGroup('s1')
    await reg.acquireGroup('s2')
    const order: string[] = []
    const p1 = reg.withGroup('s1', 't1', async () => {
      order.push('a')
      await sleep(30)
      order.push('A')
    })
    const p2 = reg.withGroup('s2', 't2', async () => {
      order.push('b')
      await sleep(5)
      order.push('B')
    })
    await Promise.all([p1, p2])
    expect(order).toEqual(['a', 'b', 'B', 'A'])
    reg.dispose()
  })

  it('withGroup marks busy/busyTool while running and clears them after', async () => {
    const reg = new GroupRegistry()
    await reg.acquireGroup('s1')
    const op = reg.withGroup('s1', 'browser_reload', async () => {
      await sleep(20)
    })
    // Busy is set synchronously on entry (queued + in-flight both count).
    expect(reg.isBusy('s1')).toBe(true)
    expect(reg.busyToolOf('s1')).toBe('browser_reload')
    await op
    expect(reg.isBusy('s1')).toBe(false)
    expect(reg.busyToolOf('s1')).toBe('')
    reg.dispose()
  })

  it('withGroup rejects unknown or archived groups', async () => {
    const reg = new GroupRegistry()
    await expect(reg.withGroup('nope', 't', async () => {})).rejects.toMatchObject({ code: 'group-not-found' })
    await reg.acquireGroup('s1')
    reg.archive('s1')
    await expect(reg.withGroup('s1', 't', async () => {})).rejects.toMatchObject({ code: 'group-archived' })
    reg.dispose()
  })

  it('user gate blocks withGroup until release, then continues', async () => {
    const reg = new GroupRegistry()
    await reg.acquireGroup('s1')
    reg.setUserControl(true)
    expect(reg.controlled).toBe(true)
    let started = false
    let settled = false
    const op = reg.withGroup('s1', 'browser_navigate', async () => {
      started = true
    }).then(() => {
      settled = true
    })
    await sleep(40)
    // Paused at the queue head: not started, not finished.
    expect(started).toBe(false)
    expect(settled).toBe(false)
    reg.setUserControl(false)
    await op
    expect(started).toBe(true)
    expect(settled).toBe(true)
    expect(reg.controlled).toBe(false)
    reg.dispose()
  })

  it('aborting while the user gate is on rejects window-controlled', async () => {
    const reg = new GroupRegistry()
    await reg.acquireGroup('s1')
    reg.setUserControl(true)
    const ac = new AbortController()
    const op = reg.withGroup('s1', 'browser_x', async () => {}, ac.signal)
    await sleep(30)
    ac.abort()
    await expect(op).rejects.toMatchObject({ code: 'window-controlled' })
    reg.dispose()
  })

  it('registerTab/removeTab: removing the last tab closes the group', async () => {
    const reg = new GroupRegistry()
    await reg.acquireGroup('s1')
    await tabOf(reg, 's1', 1, 'https://a.example', 'A')
    await tabOf(reg, 's1', 2, 'https://b.example', 'B')
    expect(reg.get('s1')?.tabs.size).toBe(2)
    expect(reg.removeTab(1)).toBe('s1')
    expect(reg.get('s1')?.tabs.size).toBe(1)
    expect(reg.get('s1')).toBeDefined()
    const closed = reg.removeTab(2)
    expect(closed).toBe('s1')
    expect(reg.get('s1')).toBeUndefined()
    expect(reg.list()).toHaveLength(0)
    reg.dispose()
  })

  it('archive schedules an automatic recycle after archiveRetentionMs', async () => {
    const reg = new GroupRegistry({ archiveRetentionMs: 50 })
    await reg.acquireGroup('s1')
    await tabOf(reg, 's1', 1, 'https://a.example', 'A')
    const tabIds = reg.archive('s1')
    expect(tabIds).toEqual([1])
    expect(reg.get('s1')?.status).toBe('archived')
    // Metadata survives the archive; only the view is dropped.
    expect(reg.get('s1')?.tabs.size).toBe(1)
    await sleep(150)
    expect(reg.get('s1')).toBeUndefined() // recycled by the retention timer
    reg.dispose()
  })

  it('reactivate cancels the recycle timer and restores active status', async () => {
    const reg = new GroupRegistry({ archiveRetentionMs: 40 })
    await reg.acquireGroup('s1')
    await tabOf(reg, 's1', 1, 'https://a.example', 'A')
    reg.archive('s1')
    expect(reg.reactivate('s1')).toBe(true)
    expect(reg.get('s1')?.status).toBe('active')
    await sleep(120) // well past the retention window: timer was cancelled
    expect(reg.get('s1')).toBeDefined()
    expect(reg.get('s1')?.tabs.has(1)).toBe(true)
    // The reopened group is acquirable again.
    await expect(reg.acquireGroup('s1')).resolves.toMatchObject({ key: 's1', status: 'active' })
    reg.dispose()
  })

  it('snapshotLedger/restoreLedger round-trips groups (archived until reopened)', async () => {
    const reg = new GroupRegistry({ archiveRetentionMs: 60_000 })
    await reg.acquireGroup('s1', '会话 One')
    await tabOf(reg, 's1', 7, 'https://a.example', 'A')
    reg.archive('s1')
    const ledger = reg.snapshotLedger()
    expect(ledger.version).toBe(1)
    expect(ledger.groups).toHaveLength(1)
    const saved = ledger.groups[0]!
    expect(saved.key).toBe('s1')
    expect(saved.label).toBe('会话 One')
    expect(saved.status).toBe('archived')
    expect(saved.tabs).toHaveLength(1)
    expect(saved.tabs[0]).toMatchObject({ tabId: 7, url: 'https://a.example', title: 'A' })

    // A fresh registry restores the ledger exactly.
    const reg2 = new GroupRegistry()
    reg2.restoreLedger(ledger)
    const restored = reg2.get('s1')!
    expect(restored.status).toBe('archived')
    expect(restored.label).toBe('会话 One')
    expect(restored.tabs.size).toBe(1)
    expect(restored.activeTabId).toBe(7)

    // Even an 'active' ledger entry is downgraded to archived-until-reopened.
    const reg3 = new GroupRegistry()
    reg3.restoreLedger({ version: 1, groups: [{ ...saved, status: 'active' }], savedAt: Date.now() })
    expect(reg3.get('s1')?.status).toBe('archived')
    reg3.reactivate('s1')
    expect(reg3.get('s1')?.status).toBe('active')
    reg.dispose()
    reg2.dispose()
    reg3.dispose()
  })

  it('assertOwner enforces group existence, ownership and archive state', async () => {
    const reg = new GroupRegistry()
    await reg.acquireGroup('s1')
    await tabOf(reg, 's1', 1, 'https://a.example', 'A')
    await tabOf(reg, 's1', 2, 'https://b.example', 'B')
    expect(() => reg.assertOwner('s1', 1)).not.toThrow()
    expect(errorCodeOf(() => reg.assertOwner('s1', 99))).toBe('foreign-tab')
    expect(errorCodeOf(() => reg.assertOwner('nope', 1))).toBe('group-not-found')
    expect(reg.tabOwner(1)).toBe('s1')
    expect(reg.tabOwner(2)).toBe('s1')
    expect(reg.tabOwner(99)).toBeUndefined()
    reg.archive('s1')
    expect(errorCodeOf(() => reg.assertOwner('s1', 1))).toBe('group-archived')
    reg.dispose()
  })

  it('activeTabOf defaults to the first registered tab; setActiveTab switches it', async () => {
    const reg = new GroupRegistry()
    await reg.acquireGroup('s1')
    expect(reg.activeTabOf('s1')).toBeUndefined()
    await tabOf(reg, 's1', 1)
    await tabOf(reg, 's1', 2)
    expect(reg.activeTabOf('s1')).toBe(1) // first tab activates
    reg.setActiveTab('s1', 2)
    expect(reg.activeTabOf('s1')).toBe(2)
    expect(errorCodeOf(() => reg.setActiveTab('s1', 99))).toBe('foreign-tab')
    reg.dispose()
  })

  it('fires onChange events for lifecycle transitions and detaches cleanly', async () => {
    const reg = new GroupRegistry()
    const events: string[] = []
    const off = reg.onChange((event) => events.push(event))
    await reg.acquireGroup('s1')
    await tabOf(reg, 's1', 1)
    reg.setActiveTab('s1', 1)
    reg.setUserControl(true)
    reg.setUserControl(false)
    reg.setForeground('s1')
    reg.setForeground(undefined)
    reg.archive('s1')
    off()
    const before = events.length
    reg.reactivate('s1')
    expect(events.length).toBe(before) // detached: no further events
    expect(events).toContain('group')
    expect(events).toContain('tab')
    expect(events).toContain('takeover')
    expect(events).toContain('release')
    expect(events).toContain('foreground')
    reg.dispose()
  })

  it('closeGroup returns the tab ids, deletes the group and clears foreground', async () => {
    const reg = new GroupRegistry()
    await reg.acquireGroup('s1')
    await tabOf(reg, 's1', 5, 'https://a.example', 'A')
    reg.setForeground('s1')
    expect(reg.foreground).toBe('s1')
    const tabIds = reg.closeGroup('s1')
    expect(tabIds).toEqual([5])
    expect(reg.get('s1')).toBeUndefined()
    expect(reg.foreground).toBeUndefined()
    expect(reg.closeGroup('s1')).toEqual([]) // idempotent
    reg.dispose()
  })

  it('list returns active groups first, then archived, by recency', async () => {
    const reg = new GroupRegistry({ maxGroups: 4 })
    await reg.acquireGroup('s1')
    await reg.acquireGroup('s2')
    await sleep(5)
    reg.touch('s1')
    reg.archive('s2')
    const list = reg.list()
    expect(list.map((g) => g.key)).toEqual(['s1', 's2'])
    expect(list[0]?.status).toBe('active')
    expect(list[1]?.status).toBe('archived')
    reg.dispose()
  })

  it('dispose rejects queued waiters and clears listeners', async () => {
    const reg = new GroupRegistry({ maxGroups: 1 })
    await reg.acquireGroup('s1')
    const waiter = reg.acquireGroup('s2')
    await sleep(20)
    reg.dispose()
    await expect(waiter).rejects.toMatchObject({ code: 'interrupted' })
    expect(reg.list()).toHaveLength(1) // metadata survives; timers/waiters gone
  })

  // --------------------------------------------------------------------------
  // Quota release pumps: a queued waiter must resume when a slot frees up.
  // --------------------------------------------------------------------------

  it('wakes the FIFO group waiter after closeGroup frees a slot', async () => {
    const reg = new GroupRegistry({ maxGroups: 2 })
    await reg.acquireGroup('s1')
    await reg.acquireGroup('s2')
    let done = false
    const waiter = reg.acquireGroup('s3').then((g) => {
      done = true
      return g
    })
    await sleep(20)
    expect(done).toBe(false)
    expect(reg.get('s3')).toBeUndefined()
    reg.closeGroup('s1')
    await expect(waiter).resolves.toMatchObject({ key: 's3', status: 'active' })
    expect(reg.get('s3')?.status).toBe('active')
    reg.dispose()
  })

  it('wakes the FIFO group waiter after archive frees a slot', async () => {
    const reg = new GroupRegistry({ maxGroups: 2 })
    await reg.acquireGroup('s1')
    await reg.acquireGroup('s2')
    const waiter = reg.acquireGroup('s3')
    await sleep(20)
    reg.archive('s1')
    await expect(waiter).resolves.toMatchObject({ key: 's3' })
    expect(reg.get('s3')).toBeDefined()
    reg.dispose()
  })

  it('wakes multiple queued group waiters strictly in FIFO order', async () => {
    const reg = new GroupRegistry({ maxGroups: 2 })
    await reg.acquireGroup('s1')
    await reg.acquireGroup('s2')
    let firstDone = false
    let secondDone = false
    const first = reg.acquireGroup('s3').then((g) => {
      firstDone = true
      return g
    })
    const second = reg.acquireGroup('s4').then((g) => {
      secondDone = true
      return g
    })
    await sleep(20)
    expect(firstDone).toBe(false)
    expect(secondDone).toBe(false)
    reg.closeGroup('s1')
    await expect(first).resolves.toMatchObject({ key: 's3' })
    // One slot freed → exactly the head of the queue wakes.
    expect(secondDone).toBe(false)
    expect(reg.get('s4')).toBeUndefined()
    reg.closeGroup('s2')
    await expect(second).resolves.toMatchObject({ key: 's4' })
    expect(reg.get('s4')).toBeDefined()
    reg.dispose()
  })

  it('wakes a tab waiter after removeTab frees a per-group slot', async () => {
    const reg = new GroupRegistry({ maxTabsPerGroup: 2, maxTabsTotal: 16 })
    await reg.acquireGroup('s1')
    await tabOf(reg, 's1', 1)
    await tabOf(reg, 's1', 2)
    let done = false
    const waiter = reg.reserveTab('s1').then(() => {
      done = true
    })
    await sleep(20)
    expect(done).toBe(false)
    reg.removeTab(1)
    await waiter
    expect(done).toBe(true)
    reg.dispose()
  })

  it('wakes a tab waiter after a global-cap release across groups', async () => {
    const reg = new GroupRegistry({ maxTabsPerGroup: 8, maxTabsTotal: 3 })
    await reg.acquireGroup('s1')
    await reg.acquireGroup('s2')
    await tabOf(reg, 's1', 1)
    await tabOf(reg, 's1', 2)
    await tabOf(reg, 's2', 3)
    let done = false
    const waiter = reg.reserveTab('s2').then(() => {
      done = true
    })
    await sleep(20)
    expect(done).toBe(false)
    reg.removeTab(1) // frees the global pool
    await waiter
    expect(done).toBe(true)
    // The reservation is consumable now.
    reg.registerTab('s2', 4, '', '')
    expect(reg.get('s2')?.tabs.size).toBe(2)
    reg.dispose()
  })

  it('times queued tickets out at waitTimeoutMs (group and tab)', async () => {
    const reg = new GroupRegistry({ maxGroups: 1, maxTabsPerGroup: 1, maxTabsTotal: 1, waitTimeoutMs: 50 })
    await reg.acquireGroup('s1')
    const start = Date.now()
    await expect(reg.acquireGroup('s2')).rejects.toMatchObject({ code: 'group-quota' })
    await expect(reg.acquireGroup('s3')).rejects.toMatchObject({ code: 'group-quota' })
    expect(Date.now() - start).toBeLessThan(1000)
    // Tab quota times out the same way.
    await reg.reserveTab('s1')
    reg.registerTab('s1', 1, '', '')
    const tabStart = Date.now()
    await expect(reg.reserveTab('s1')).rejects.toMatchObject({ code: 'group-quota' })
    expect(Date.now() - tabStart).toBeLessThan(1000)
    reg.dispose()
  })
})
