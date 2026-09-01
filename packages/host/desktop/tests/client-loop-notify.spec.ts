// @vitest-environment node
/** Desktop loop-notify client poller tests. */

import { describe, expect, it, vi } from 'vitest'
import {
  applyLoopNotifyClient,
  fetchLoopNotifySession,
} from '../src/client/loop-notify.tsx'

function validResponse(sessionId: string | null, requestedAt: number): Response {
  return Response.json({ sessionId, requestedAt })
}

describe('desktop loop-notify client', () => {
  it('parses a valid session request and rejects malformed bodies', async () => {
    const request = vi.fn(async () => validResponse('session-1', 123))
    const state = await fetchLoopNotifySession(request)
    expect(state).toEqual({ sessionId: 'session-1', requestedAt: 123 })

    const invalid = vi.fn(async () => Response.json({ nope: true }))
    await expect(fetchLoopNotifySession(invalid)).resolves.toBeNull()

    const failing = vi.fn(async () => { throw new Error('offline') })
    await expect(fetchLoopNotifySession(failing)).resolves.toBeNull()

    const nonOk = vi.fn(async () => new Response('', { status: 500 }))
    await expect(fetchLoopNotifySession(nonOk)).resolves.toBeNull()
  })

  it('opens a session once for a fresh request and ignores duplicates', async () => {
    let requestedAt = 100
    const request = vi.fn(async () => validResponse('session-jump', requestedAt))
    const open = vi.fn()
    const ctx = {
      sessions: { open },
      effect: (register: () => () => void) => {
        const dispose = register()
        // interval + initial poll happen inside the component effect; run a few ticks
        return () => dispose()
      },
    } as unknown as Parameters<typeof applyLoopNotifyClient>[0]

    vi.stubGlobal('window', { fetch: request, setInterval: vi.fn(() => 1), clearInterval: vi.fn() })

    applyLoopNotifyClient(ctx)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/^session-jump$/))

    // A duplicate fetch for the same requestedAt must not reopen.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(open).toHaveBeenCalledTimes(1)
  })
})
