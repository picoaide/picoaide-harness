import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleDesktopLoopNotifySessionRequest } from '../src/loop-notify-route.ts'
import type { WriteProofDeps } from '../src/write-proof.ts'

const RENDERER_ORIGIN = 'http://127.0.0.1:43120'
const AUTHORITY = '127.0.0.1:43120'
/** 渲染层经 launch-token 换票拿到的 BrowserAuth cookie（名字由 Host 派生）。 */
const PROOF_COOKIE = `dsh-auth-${AUTHORITY}=v1.signature`

/** 与上游 `connection.requestRejection()` 同判据的替身（见 write-proof.ts 的契约）。 */
function proofWithFence(): WriteProofDeps {
  return {
    fence: () => ({
      requestRejection: (request: { headers: IncomingMessage['headers'] }) => {
        const headers = request.headers as Record<string, unknown>
        if (headers['host'] !== undefined && headers['host'] !== AUTHORITY) return 403
        const origin = headers['origin']
        if (typeof origin === 'string' && new URL(origin).host !== AUTHORITY) return 403
        return headers['cookie'] === PROOF_COOKIE ? undefined : 401
      },
    }),
    label: 'test',
  }
}

interface RequestOptions {
  /** `undefined` = 不带 Origin（Chromium 的同源 GET 就是这个形态）。 */
  readonly origin?: string | undefined
  /** 缺省 = 不带 cookie（本机任意进程的原始形态）。 */
  readonly cookie?: string
}

function request(method = 'GET', options: RequestOptions = {}): IncomingMessage {
  const headers: Record<string, string> = { host: AUTHORITY }
  if (options.origin !== undefined) headers['origin'] = options.origin
  if (options.cookie !== undefined) headers['cookie'] = options.cookie
  return { method, headers } as IncomingMessage
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

  it('serves the pending session for a same-origin GET holding the proof', async () => {
    const read = freshRead()
    const res = response()
    await handleDesktopLoopNotifySessionRequest(
      request('GET', { origin: RENDERER_ORIGIN, cookie: PROOF_COOKIE }),
      res,
      RENDERER_ORIGIN,
      read,
      proofWithFence(),
    )
    expect(res.statusCode).toBe(200)
    expect(res.setHeader).toHaveBeenCalledWith('content-type', 'application/json; charset=utf-8')
    expect(JSON.parse(res.body)).toEqual({ sessionId: 'session-abc', requestedAt: 123 })
  })

  it('accepts a GET without an Origin header (Chromium same-origin fetch)', async () => {
    const read = freshRead()
    const res = response()
    await handleDesktopLoopNotifySessionRequest(
      request('GET', { cookie: PROOF_COOKIE }),
      res,
      RENDERER_ORIGIN,
      read,
      proofWithFence(),
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ sessionId: 'session-abc', requestedAt: 123 })
  })

  it('refuses a bare GET (no Origin, no cookie) without consuming the pending jump', async () => {
    // FIX-36：消费是写 ⇒ 裸 GET 既不能拿到待跳转会话，也不能把它清空。
    const read = freshRead()
    const res = response()
    await handleDesktopLoopNotifySessionRequest(request('GET'), res, RENDERER_ORIGIN, read, proofWithFence())
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toBe('browser session proof required')
    expect(res.body).not.toContain('session-abc')
    expect(read).not.toHaveBeenCalled()
  })

  it('fails closed when the proof dependency is not wired', async () => {
    const read = freshRead()
    const res = response()
    await handleDesktopLoopNotifySessionRequest(
      request('GET', { cookie: PROOF_COOKIE }),
      res,
      RENDERER_ORIGIN,
      read,
      undefined,
    )
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).error).toBe('browser session proof unavailable')
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects a cross-origin GET with 403', async () => {
    const read = freshRead()
    const res = response()
    await handleDesktopLoopNotifySessionRequest(
      request('GET', { origin: 'https://evil.example', cookie: PROOF_COOKIE }),
      res,
      RENDERER_ORIGIN,
      read,
      proofWithFence(),
    )
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toEqual({ error: 'forbidden' })
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects non-GET methods with 405', async () => {
    const read = freshRead()
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = response()
      await handleDesktopLoopNotifySessionRequest(
        request(method, { cookie: PROOF_COOKIE }),
        res,
        RENDERER_ORIGIN,
        read,
        proofWithFence(),
      )
      expect(res.statusCode).toBe(405)
      expect(JSON.parse(res.body)).toEqual({ error: 'method not allowed' })
      expect(read).not.toHaveBeenCalled()
    }
  })
})
