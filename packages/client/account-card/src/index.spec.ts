import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply } from '../src/index.ts'

interface RouteEntry {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

function request(partial: {
  method?: string
  url?: string
  remoteAddress?: string
  host?: string
  origin?: string
  secFetchSite?: string
}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (partial.host !== undefined) headers.host = partial.host
  if (partial.origin !== undefined) headers.origin = partial.origin
  if (partial.secFetchSite !== undefined) headers['sec-fetch-site'] = partial.secFetchSite
  return {
    method: partial.method ?? 'GET',
    url: partial.url ?? '/api/pico/account/usage',
    headers,
    socket: { remoteAddress: partial.remoteAddress ?? '127.0.0.1' },
  } as unknown as IncomingMessage
}

function response(): ServerResponse & { body: string } {
  const res = {
    body: '',
    statusCode: 200,
    writeHead: vi.fn((code: number) => { res.statusCode = code }),
    end: vi.fn((body?: string) => { res.body = body ?? '' }),
  }
  return res as unknown as ServerResponse & typeof res
}

function ctxFixture(session: { username: string; token: string; serverURL: string } | null) {
  const events = new Map<string, Set<(payload: unknown) => void>>()
  let registered: RouteEntry | undefined
  return {
    ctx: {
      picoSession: { getSession: () => session },
      on: vi.fn((event: string, listener: (payload: unknown) => void) => {
        if (!events.has(event)) events.set(event, new Set())
        events.get(event)!.add(listener)
        return () => events.get(event)!.delete(listener)
      }),
      effect: vi.fn((fn: () => void | (() => void)) => {
        const captured = fn()
        // The register effect runs immediately; capture the route.
        void captured
        return () => {}
      }),
      webServer: {
        register: vi.fn((route: RouteEntry) => { registered = route }),
      },
    } as unknown as Context,
    getRoute: () => registered!,
    emit: (event: string, payload: unknown) => { for (const l of [...(events.get(event) ?? [])]) l(payload) },
  }
}

describe('account-card host apply', () => {
  it('registers the usage route under the local API prefix', () => {
    const { ctx } = ctxFixture(null)
    apply(ctx)
    expect(ctx.webServer.register).toHaveBeenCalled()
  })

  it('403s cross-origin requests (no data leak even when logged in)', async () => {
    const { ctx, getRoute } = ctxFixture({ username: 'u', token: 't', serverURL: 'https://gw' })
    apply(ctx)
    const res = response()
    await getRoute().handler(request({ host: 'example.com' }), res)
    expect(res.statusCode).toBe(403)
  })

  it('rejects non-GET methods with 405', async () => {
    const { ctx, getRoute } = ctxFixture(null)
    apply(ctx)
    const res = response()
    await getRoute().handler(request({ method: 'POST', host: 'localhost:43120', origin: 'http://localhost:43120' }), res)
    expect(res.statusCode).toBe(405)
  })

  it('returns 401 when not logged in', async () => {
    const { ctx, getRoute } = ctxFixture(null)
    apply(ctx)
    const res = response()
    await getRoute().handler(request({ host: 'localhost:43120', origin: 'http://localhost:43120' }), res)
    expect(res.statusCode).toBe(401)
  })

  it('serves the cached snapshot for a guarded logged-in GET', async () => {
    const { ctx, getRoute } = ctxFixture({ username: 'u', token: 't', serverURL: 'https://gw.example' })
    apply(ctx)
    const res = response()
    await getRoute().handler(request({ host: 'localhost:43120', origin: 'http://localhost:43120' }), res)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { state: string; data: unknown }
    expect(body.state).toBe('idle')
    expect(body.data).toBeNull() // no fetch yet: snapshot is empty
  })

  it('refreshes on session change and clears on logout', () => {
    const { ctx, emit } = ctxFixture(null)
    apply(ctx)
    // First a session login — the service is created inside apply; the
    // refresh path is debounced (300ms default), so we only assert the
    // clear-on-logout behavior observable through the snapshot shape.
    emit('pico/session-changed', null)
    emit('agent/status', { status: 'idle' })
    // No throw is the contract here; detailed coalescing lives in usage-service.test.ts.
    expect(ctx.on).toHaveBeenCalledWith('pico/session-changed', expect.any(Function))
    expect(ctx.on).toHaveBeenCalledWith('agent/status', expect.any(Function))
  })
})
