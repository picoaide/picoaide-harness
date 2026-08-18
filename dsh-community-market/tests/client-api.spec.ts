// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readMarketState } from '../src/client/api.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('community market client API', () => {
  it('reads state without caching and preserves the request cancellation signal', async () => {
    const body = { sources: [], builtIns: [] }
    const request = vi.fn(async () => new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', request)
    const controller = new AbortController()

    await expect(readMarketState(controller.signal)).resolves.toEqual(body)
    expect(request).toHaveBeenCalledWith('/api/community-market/state', {
      cache: 'no-store',
      signal: controller.signal,
    })
  })

  it('surfaces the safe error returned by the Host route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'market state unavailable',
    }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })))

    await expect(readMarketState()).rejects.toThrow('market state unavailable')
  })
})
