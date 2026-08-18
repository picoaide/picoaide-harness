// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readMarketCatalog, readMoreMarketCatalog } from '../src/client/api.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('community market client API', () => {
  it('binds the initial page to one source, requests 50 items, and repeats category parameters', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      json: async () => ({ query: {}, results: [], fetchedAt: '2026-08-18T00:00:00Z' }),
    } as Response))
    vi.stubGlobal('fetch', fetch)

    await readMarketCatalog('source-record-1', '  terminal  ', 'zh-CN', ['tools', 'interface'])

    const url = fetch.mock.calls[0]?.[0] as URL
    expect(url.pathname).toBe('/api/community-market/catalog')
    expect(url.searchParams.get('sourceRecordId')).toBe('source-record-1')
    expect(url.searchParams.get('q')).toBe('terminal')
    expect(url.searchParams.get('limit')).toBe('50')
    expect(url.searchParams.get('locale')).toBe('zh-CN')
    expect(url.searchParams.getAll('category')).toEqual(['tools', 'interface'])
    expect(url.searchParams.has('cursor')).toBe(false)
  })

  it('binds a later page to the same source and its opaque cursor', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      json: async () => ({ query: {}, results: [], fetchedAt: '2026-08-18T00:00:00Z' }),
    } as Response))
    vi.stubGlobal('fetch', fetch)

    await readMoreMarketCatalog('source-record-2', 'opaque cursor/2', '', 'en', ['tools'])

    const url = fetch.mock.calls[0]?.[0] as URL
    expect(url.searchParams.get('sourceRecordId')).toBe('source-record-2')
    expect(url.searchParams.get('cursor')).toBe('opaque cursor/2')
    expect(url.searchParams.get('limit')).toBe('50')
    expect(url.searchParams.getAll('category')).toEqual(['tools'])
  })
})
