import { describe, expect, it } from 'vitest'
import { UsageService, type UsagePayload, type UsageFetcher } from './usage-service.ts'

const SESSION = { serverURL: 'https://gw.example.com', username: 'alice', token: 'tok-1' }

const PAYLOAD: UsagePayload = {
  is_admin: false,
  quota_tokens: 1_000_000,
  quota_money: 100,
  monthly_usage: 120_000,
  monthly_cost: 9.2,
  remaining_tokens: 880_000,
  remaining_money: 90.8,
  today_usage: 4_000,
  today_cost: 0.35,
  yesterday_usage: 10_000,
  yesterday_cost: 0.8,
  total_usage: 500_000,
  total_cost: 40.1,
  dept_budgets: [],
}

function makeFetcher(impl?: UsageFetcher): { fn: UsageFetcher } & { calls: () => number } {
  const calls = { count: 0 }
  const fn: UsageFetcher = impl ?? (async () => {
    calls.count += 1
    return PAYLOAD
  })
  return { fn, calls: () => calls.count }
}

describe('UsageService', () => {
  it('starts with an empty snapshot', () => {
    const service = new UsageService()
    expect(service.get()).toEqual({ data: null, fetchedAt: 0, state: 'idle', error: null })
  })

  it('refresh is a no-op while logged out', async () => {
    const { fn, calls } = makeFetcher()
    const service = new UsageService({ debounceMs: 1, fetchFn: fn })
    service.refresh(null)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(calls()).toBe(0)
    expect(service.get().state).toBe('idle')
  })

  it('debounces a burst of refresh calls into one fetch', async () => {
    const { fn, calls } = makeFetcher()
    const service = new UsageService({ debounceMs: 50, fetchFn: fn })
    service.refresh(SESSION)
    service.refresh(SESSION)
    service.refresh(SESSION)
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(calls()).toBe(1)
    expect(service.get().state).toBe('idle')
    expect(service.get().data?.remaining_money).toBe(90.8)
    expect(service.get().fetchedAt).toBeGreaterThan(0)
  })

  it('refreshNow is single-flight: concurrent callers share one fetch', async () => {
    let release: () => void = () => {}
    const { fn } = makeFetcher(() => new Promise<UsagePayload>(resolve => {
      release = () => resolve(PAYLOAD)
    }))
    const service = new UsageService({ fetchFn: fn })
    const first = service.refreshNow(SESSION)
    const second = service.refreshNow(SESSION)
    const third = service.refreshNow(SESSION)
    release()
    const [a, b, c] = await Promise.all([first, second, third])
    expect(a.data).toBe(PAYLOAD)
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('keeps the previous snapshot and records error state on failure', async () => {
    const { fn } = makeFetcher(async () => {
      throw new Error('network down')
    })
    const service = new UsageService({ debounceMs: 1, fetchFn: fn })
    await service.refreshNow(SESSION)
    expect(service.get().state).toBe('error')
    expect(service.get().error).toBe('network down')
    expect(service.get().data).toBeNull()

    // A later success recovers and clears the error.
    const good = makeFetcher()
    service['fetch'] = good.fn
    await service.refreshNow(SESSION)
    expect(service.get().state).toBe('idle')
    expect(service.get().error).toBeNull()
    expect(service.get().data?.monthly_cost).toBe(9.2)
  })

  it('refreshNow passes the session token to the gateway', async () => {
    let seen: { serverURL: string; path: string; token?: string } | null = null
    const service = new UsageService({
      fetchFn: async (serverURL, path, opts) => {
        seen = opts.token === undefined
          ? { serverURL, path }
          : { serverURL, path, token: opts.token }
        return PAYLOAD
      },
    })
    await service.refreshNow(SESSION)
    expect(seen).toEqual({ serverURL: 'https://gw.example.com', path: '/api/auth/usage', token: 'tok-1' })
  })

  it('dispose cancels a pending debounced refresh', async () => {
    const { fn, calls } = makeFetcher()
    const service = new UsageService({ debounceMs: 50, fetchFn: fn })
    service.refresh(SESSION)
    service.dispose()
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(calls()).toBe(0)
  })

  it('clear drops the cached snapshot and cancels a pending refresh', async () => {
    const { fn } = makeFetcher()
    const service = new UsageService({ debounceMs: 50, fetchFn: fn })
    await service.refreshNow(SESSION)
    expect(service.get().data).not.toBeNull()
    service.refresh(SESSION)
    service.clear()
    expect(service.get().data).toBeNull()
    expect(service.get().state).toBe('idle')
    // The debounced fetch fired by refresh() was cancelled by clear().
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(service.get().data).toBeNull()
  })
})
