/**
 * P2-22 regression: a usage snapshot is bound to the account that requested
 * it. Logout/user switch aborts the in-flight request (epoch guard), a request
 * for a DIFFERENT account never joins the previous account's single flight,
 * and the loopback route refuses to serve a snapshot when the session changed
 * while its gateway round-trip was in flight.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { UsageService, type UsagePayload } from './usage-service.ts'

const enterpriseAuth = vi.hoisted(() => ({ fetchJSON: vi.fn() }))
vi.mock('@picoaide/dsh-enterprise/server-connector/auth', () => ({ fetchJSON: enterpriseAuth.fetchJSON }))

function payload(monthly_cost: number): UsagePayload {
  return {
    balance_money: 88.5, balance_activated: true, balance_enabled: true,
    balance_monthly: 100, balance_mode: 'add',
    is_admin: false, monthly_usage: 0, monthly_cost,
    today_usage: 0, today_cost: 0, yesterday_usage: 0, yesterday_cost: 0,
    total_usage: 0, total_cost: 0,
  }
}

const USER_A = { serverURL: 'https://a.example', username: 'A', token: 'tok-a' }
const USER_B = { serverURL: 'https://b.example', username: 'B', token: 'tok-b' }

describe('UsageService account binding (P2-22)', () => {
  it('clear() aborts the in-flight request and never publishes its result', async () => {
    let release: (() => void) | undefined
    const service = new UsageService({
      fetchFn: async () => {
        await new Promise<void>(resolve => { release = resolve })
        return payload(999)
      },
    })
    const inFlight = service.refreshNow(USER_A)
    service.clear()
    expect(service.get().data).toBeNull()
    release?.()
    await inFlight
    expect(service.get()).toEqual({ data: null, fetchedAt: 0, state: 'idle', error: null, authExpired: false })
  })

  it('does not hand account A in-flight request to account B', async () => {
    const seen: string[] = []
    const releases: Array<() => void> = []
    const service = new UsageService({
      fetchFn: async (_url, _path, opts) => {
        seen.push(String(opts.token))
        await new Promise<void>(resolve => { releases.push(resolve) })
        return payload(opts.token === 'tok-b' ? 2 : 1)
      },
    })
    const first = service.refreshNow(USER_A)
    const second = service.refreshNow(USER_B)
    // A's request was aborted, not joined: B issues its own gateway call.
    expect(seen).toEqual(['tok-a', 'tok-b'])
    for (const release of releases) release()
    await Promise.all([first, second])
    expect(service.get().data?.monthly_cost).toBe(2)
  })

  it('joins an identical account request (single flight preserved)', async () => {
    let release: (() => void) | undefined
    const fetchFn = vi.fn(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return payload(1)
    })
    const service = new UsageService({ fetchFn })
    const first = service.refreshNow(USER_A)
    const second = service.refreshNow({ ...USER_A })
    release?.()
    await Promise.all([first, second])
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

interface RouteEntry {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** 本机路由的 authority。 */
const AUTHORITY = 'localhost:43120'

/** 上游 `browser-auth` 的 cookie 名（`dsh-auth-<authority>`）。 */
function proofCookie(authority = AUTHORITY): string {
  return `dsh-auth-${authority}=v1.signature`
}

/** 上游 `connection.requestRejection()` 的行为替身（见 `../src/index.spec.ts` 的同形桩）。 */
function browserFence(): { requestRejection: (r: { headers: Record<string, unknown> }) => 401 | 403 | undefined } {
  return {
    requestRejection: (r) => {
      const headers = r.headers
      const host = headers['host']
      if (typeof host !== 'string' || !/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) return 403
      if (headers['sec-fetch-site'] === 'cross-site') return 403
      const origin = headers['origin']
      if (typeof origin === 'string' && new URL(origin).host !== host) return 403
      return headers['cookie'] === proofCookie(host) ? undefined : 401
    },
  }
}

function request(): IncomingMessage {
  return {
    method: 'GET',
    url: '/api/pico/account/usage?refresh=1',
    headers: {
      host: AUTHORITY,
      origin: `http://${AUTHORITY}`,
      // FIX-42②：`?refresh=1` 是消费型 GET ⇒ 这一发必须持持有性证明。
      cookie: proofCookie(),
    },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage
}

function response(): ServerResponse & { body: string } {
  const res = {
    body: '',
    statusCode: 200,
    writeHead: vi.fn((code: number) => { res.statusCode = code }),
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => { res.body = body ?? '' }),
  }
  return res as unknown as ServerResponse & typeof res
}

describe('account-card route binds the response to the requesting session (P2-22)', () => {
  it('answers 401 when the session changed during the gateway round-trip', async () => {
    const { apply } = await import('./index.ts')
    let current: typeof USER_A | null = USER_A
    let registered: RouteEntry | undefined
    const ctx = {
      picoSession: { getSession: () => current },
      get: (name: string) => (name === 'connection' ? browserFence() : undefined),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      on: vi.fn(() => () => {}),
      effect: vi.fn((fn: () => void | (() => void)) => { fn(); return () => {} }),
      webServer: { register: vi.fn((route: RouteEntry) => { registered = route }) },
    } as unknown as Context

    let release: (() => void) | undefined
    enterpriseAuth.fetchJSON.mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return payload(7)
    })
    apply(ctx)
    const res = response()
    const pending = registered!.handler(request(), res)
    // The user switches accounts while the gateway call is still in flight.
    current = USER_B
    release?.()
    await pending
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toEqual({ error: 'session changed' })
  })
})
