import { describe, expect, it } from 'vitest'
import { AuthError } from '@picoaide/dsh-enterprise/server-connector/auth'
import { UsageService, isAuthExpired, type UsagePayload, type UsageFetcher } from './usage-service.ts'

const SESSION = { serverURL: 'https://gw.example.com', username: 'alice', token: 'tok-1' }

const PAYLOAD: UsagePayload = {
  balance_money: 90.8,
  balance_activated: true,
  balance_enabled: true,
  balance_monthly: 100,
  balance_mode: 'add',
  is_admin: false,
  monthly_usage: 120_000,
  monthly_cost: 9.2,
  today_usage: 4_000,
  today_cost: 0.35,
  yesterday_usage: 10_000,
  yesterday_cost: 0.8,
  total_usage: 500_000,
  total_cost: 40.1,
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
    expect(service.get()).toEqual({ data: null, fetchedAt: 0, state: 'idle', error: null, authExpired: false })
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
    expect(service.get().data?.balance_money).toBe(90.8)
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
    // 契约解析会返回归一化后的新对象(运行时校验),比较形状而非引用。
    expect(a.data).toStrictEqual(PAYLOAD)
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
    expect(seen).toEqual({ serverURL: 'https://gw.example.com', path: '/api/client/v2/auth/usage', token: 'tok-1' })
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

  // 审计 2026-09-12 P1-5(回归):令牌失效必须与网络抖动分开。
  // 改前两者都走 `{...this.snapshot, state:'error'}` —— 旧余额被保留,
  // 而 UI 的 stale 判据还要求 data===null ⇒ 过期金额照常渲染。
  describe('authExpired 标记(FIX-21)', () => {
    it('鉴权失败:丢弃旧数据并置 authExpired(不再静默展示过期余额)', async () => {
      const service = new UsageService({
        fetchFn: async () => { throw new AuthError('auth_expired') },
      })
      // 先成功一次,制造"有旧余额"的前置
      const good = makeFetcher()
      service['fetch'] = good.fn
      await service.refreshNow(SESSION)
      expect(service.get().data?.balance_money).toBe(90.8)

      // 令牌失效:数据必须被丢弃(旧余额属于上一个有效令牌)
      service['fetch'] = async () => { throw new AuthError('auth_expired') }
      const snap = await service.refreshNow(SESSION)
      expect(snap.authExpired).toBe(true)
      expect(snap.data).toBeNull()
      expect(snap.state).toBe('error')
      expect(snap.error).toContain('登录已过期')
    })

    it('网络错误:保留旧快照且 authExpired=false(不把余额闪成空白)', async () => {
      const service = new UsageService({ fetchFn: makeFetcher().fn })
      await service.refreshNow(SESSION)
      expect(service.get().data).not.toBeNull()

      service['fetch'] = async () => { throw new AuthError('network', 'network down') }
      const snap = await service.refreshNow(SESSION)
      expect(snap.authExpired).toBe(false)
      expect(snap.state).toBe('error')
      expect(snap.data?.balance_money).toBe(90.8)
    })

    it('isAuthExpired:AuthError kind 优先,消息兜底覆盖裸 401', () => {
      expect(isAuthExpired(new AuthError('auth_expired'))).toBe(true)
      expect(isAuthExpired(new AuthError('network', 'network down'))).toBe(false)
      expect(isAuthExpired(new Error('HTTP 401'))).toBe(true)
      expect(isAuthExpired(new Error('Unauthorized'))).toBe(true)
      expect(isAuthExpired(new Error('boom'))).toBe(false)
    })

    it('恢复成功一次即清除 authExpired', async () => {
      const service = new UsageService({ fetchFn: async () => { throw new AuthError('auth_expired') } })
      await service.refreshNow(SESSION)
      expect(service.get().authExpired).toBe(true)
      service['fetch'] = makeFetcher().fn
      await service.refreshNow(SESSION)
      expect(service.get().authExpired).toBe(false)
      expect(service.get().data?.balance_money).toBe(90.8)
    })
  })
})
