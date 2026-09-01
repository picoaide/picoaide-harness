import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { HostCronService } from '../src/host-service.ts'
import { makeCronRoutes } from '../src/host-routes.ts'
import { CRON_API_PREFIX } from '../src/protocol.ts'

interface FakeService {
  snapshot: ReturnType<typeof vi.fn>
  apply: ReturnType<typeof vi.fn>
  eventPayload: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
}

function fakeService(): FakeService {
  return {
    snapshot: vi.fn(() => ({ schemaVersion: 2, revision: 1, jobs: [], scheduler: { timeZone: 'local' } })),
    apply: vi.fn(() => ({ schemaVersion: 2, revision: 2, jobs: [], scheduler: { timeZone: 'local' } })),
    eventPayload: vi.fn(() => ({ revision: 1, scheduler: { timeZone: 'local' } })),
    subscribe: vi.fn(() => () => {}),
  }
}

function route(kind: 'state' | 'action' | 'events') {
  return makeCronRoutes(fakeService() as unknown as HostCronService).find(r => r.path === `${CRON_API_PREFIX}/${kind}`)!
}

function request(partial: {
  method?: string
  remoteAddress?: string
  host?: string
  origin?: string
  contentType?: string
  body?: string
}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (partial.host !== undefined) headers.host = partial.host
  if (partial.origin !== undefined) headers.origin = partial.origin
  if (partial.contentType !== undefined) headers['content-type'] = partial.contentType
  const req = {
    method: partial.method ?? 'GET',
    headers,
    socket: { remoteAddress: partial.remoteAddress ?? '127.0.0.1' },
    once: vi.fn(),
  } as unknown as IncomingMessage & { [Symbol.asyncIterator]?: () => AsyncIterator<Buffer> }
  if (partial.body !== undefined) {
    const chunks = [Buffer.from(partial.body)]
    req[Symbol.asyncIterator] = () => {
      let i = 0
      return {
        next: async () => (i < chunks.length ? { value: chunks[i++]!, done: false } : { value: undefined, done: true }),
      }
    }
  }
  return req
}

function response(): ServerResponse & { body: string; header: Record<string, string | number> } {
  const res = {
    body: '',
    statusCode: 200,
    header: {},
    writeHead: vi.fn((status: number, h: Record<string, string | number>) => {
      res.statusCode = status
      res.header = h
    }),
    write: vi.fn((chunk?: string) => { res.body += chunk ?? '' }),
    end: vi.fn((body?: string) => { res.body += body ?? '' }),
    once: vi.fn(),
  }
  return res as unknown as ServerResponse & typeof res
}

function loopbackRequest(method = 'GET'): IncomingMessage {
  return request({ method, host: 'localhost:43120', origin: 'http://localhost:43120' })
}

describe('cron host routes', () => {
  it('state serves the service snapshot for a guarded GET', async () => {
    const res = response()
    await route('state').handler(loopbackRequest(), res)
    expect(res.statusCode).toBe(200)
    expect(res.header['content-type']).toMatch(/application\/json/)
    expect(JSON.parse(res.body).revision).toBe(1)
  })

  it('state rejects unguarded requests with 403 and no leak', async () => {
    const res = response()
    await route('state').handler(request({ host: 'example.com' }), res)
    expect(res.statusCode).toBe(403)
    expect(res.body).toContain('forbidden')
    const res2 = response()
    await route('state').handler(request({ method: 'POST', host: 'localhost:43120' }), res2)
    expect(res2.statusCode).toBe(405)
  })

  it('action applies a validated envelope', async () => {
    const res = response()
    const body = JSON.stringify({ requestId: 'req-1', action: { kind: 'delete', jobId: 'job-1' } })
    await route('action').handler(
      request({ method: 'POST', host: 'localhost:43120', origin: 'http://localhost:43120', contentType: 'application/json', body }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).revision).toBe(2)
  })

  it('action rejects wrong method, missing JSON content-type, and invalid payloads', async () => {
    const cases: Array<{ req: IncomingMessage; status: number; error: string }> = [
      { req: request({ method: 'GET', host: 'localhost:43120' }), status: 405, error: 'method-not-allowed' },
      { req: request({ method: 'POST', host: 'example.com', contentType: 'application/json', body: '{}' }), status: 403, error: 'forbidden' },
      { req: request({ method: 'POST', host: 'localhost:43120', origin: 'http://localhost:43120', contentType: 'text/plain', body: '{}' }), status: 415, error: 'json-required' },
      { req: request({ method: 'POST', host: 'localhost:43120', origin: 'http://localhost:43120', contentType: 'application/json', body: '{"requestId":"r","action":{"kind":"nope"}}' }), status: 400, error: 'invalid-action' },
      { req: request({ method: 'POST', host: 'localhost:43120', origin: 'http://localhost:43120', contentType: 'application/json', body: '{oops' }), status: 400, error: 'JSON' },
    ]
    for (const c of cases) {
      const res = response()
      await route('action').handler(c.req, res)
      expect(res.statusCode).toBe(c.status)
      expect(res.body).toContain(c.error)
      const parsed = JSON.parse(res.body) as { ok: boolean; error: string }
      expect(parsed.ok).toBe(false)
    }
  })

  it('action rejects oversized bodies with 413', async () => {
    const res = response()
    const big = JSON.stringify({ requestId: 'req-1', action: { kind: 'delete', jobId: 'x' }, pad: 'a'.repeat(70 * 1024) })
    await route('action').handler(
      request({ method: 'POST', host: 'localhost:43120', origin: 'http://localhost:43120', contentType: 'application/json', body: big }),
      res,
    )
    expect(res.statusCode).toBe(413)
  })

  it('events streams an initial frame and heartbeats on a timer', async () => {
    vi.useFakeTimers()
    try {
      const res = response()
      await route('events').handler(loopbackRequest(), res)
      expect(res.header['content-type']).toBe('text/event-stream; charset=utf-8')
      expect(res.body).toContain('data:')
      // Advance past the heartbeat; the res.write call count grows.
      const writes = (res.write as ReturnType<typeof vi.fn>).mock.calls.length
      vi.advanceTimersByTime(16_000)
      expect((res.write as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(writes)
    } finally {
      vi.useRealTimers()
    }
  })

  it('events rejects non-GET methods and unguarded requests', async () => {
    const res = response()
    await route('events').handler(request({ method: 'POST', host: 'localhost:43120' }), res)
    expect(res.statusCode).toBe(405)
    const res2 = response()
    await route('events').handler(request({ host: 'example.com' }), res2)
    expect(res2.statusCode).toBe(403)
  })
})
