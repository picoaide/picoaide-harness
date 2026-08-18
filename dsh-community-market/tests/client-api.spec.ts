// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readMarketCatalog, readMarketState } from '../src/client/api.js'

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

  it('builds a normalized catalog query with the active locale', async () => {
    const body = { query: {}, results: [], fetchedAt: '2026-08-18T04:00:00.000Z' }
    const request = vi.fn(async () => new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', request)
    const controller = new AbortController()

    await expect(readMarketCatalog('  sidebar  ', 'zh-CN', controller.signal)).resolves.toEqual(body)
    const [url, init] = request.mock.calls[0]!
    expect(url).toBeInstanceOf(URL)
    expect((url as URL).pathname).toBe('/api/community-market/catalog')
    expect(Object.fromEntries((url as URL).searchParams)).toEqual({
      q: 'sidebar',
      limit: '20',
      locale: 'zh-CN',
    })
    expect(init).toEqual({ cache: 'no-store', signal: controller.signal })
  })
})
