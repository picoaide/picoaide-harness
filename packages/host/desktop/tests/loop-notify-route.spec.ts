import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleDesktopLoopNotifySessionRequest } from '../src/loop-notify-route.ts'

function request(method = 'GET', origin: string | undefined = 'http://127.0.0.1:43120'): IncomingMessage {
  return { method, headers: origin === undefined ? {} : { origin } } as IncomingMessage
}

function response(): ServerResponse & {
  body: string
  end: ReturnType<typeof vi.fn>
  setHeader: ReturnType<typeof vi.fn>
} {
  const res = {
    body: '',
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => { res.body = body ?? '' }),
  }
  return res as unknown as ServerResponse & typeof res
}

describe('loop-notify click-to-jump route', () => {
  function freshRead() {
    return vi.fn(() => ({ sessionId: 'session-abc', requestedAt: 123 }))
  }

  it('serves the pending session for a same-origin GET', async () => {
    const read = freshRead()
    const res = response()
    await handleDesktopLoopNotifySessionRequest(request(), res, 'http://127.0.0.1:43120', read)
    expect(res.statusCode).toBe(200)
    expect(res.setHeader).toHaveBeenCalledWith('content-type', 'application/json; charset=utf-8')
    expect(JSON.parse(res.body)).toEqual({ sessionId: 'session-abc', requestedAt: 123 })
  })

  it('accepts a GET without an Origin header (Chromium same-origin fetch)', async () => {
    const read = freshRead()
    const res = response()
    await handleDesktopLoopNotifySessionRequest(request('GET', undefined), res, 'http://127.0.0.1:43120', read)
    expect(res.statusCode).toBe(200)
  })

  it('rejects a cross-origin GET with 403', async () => {
    const read = freshRead()
    const res = response()
    await handleDesktopLoopNotifySessionRequest(request('GET', 'https://evil.example'), res, 'http://127.0.0.1:43120', read)
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toEqual({ error: 'forbidden' })
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects non-GET methods with 405', async () => {
    const read = freshRead()
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = response()
      await handleDesktopLoopNotifySessionRequest(request(method), res, 'http://127.0.0.1:43120', read)
      expect(res.statusCode).toBe(405)
      expect(JSON.parse(res.body)).toEqual({ error: 'method not allowed' })
      expect(read).not.toHaveBeenCalled()
    }
  })
})
