import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { standardHttpAdapter } from '../src/adapters/standard-http.js'
import type { CatalogHttpClient, LocalSourceRecord } from '../src/contracts/index.js'

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as unknown
}

const source: LocalSourceRecord = {
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
  registrationKind: 'user-added',
  adapterId: standardHttpAdapter.adapterId,
  providerId: 'org.example.community-catalog',
  manifestUrl: 'https://plugins.example.org/catalog-source.json',
  enabled: true,
  order: 0,
}

describe('standard HTTP catalog adapter', () => {
  it('loads the source manifest before requesting its declared catalog query', async () => {
    const getJson = vi.fn<CatalogHttpClient['getJson']>()
      .mockResolvedValueOnce({
        value: fixture('../docs/examples/catalog-source.example.json'),
        finalUrl: source.manifestUrl!,
      })
      .mockResolvedValueOnce({
        value: fixture('../docs/examples/catalog-provider-page.example.json'),
        finalUrl: 'https://plugins.example.org/v1/plugins?q=sidebar&category=interface&limit=100&sort=updated&locale=zh-CN',
      })

    await standardHttpAdapter.fetch({
      q: ' sidebar ',
      category: ['interface'],
      limit: 80,
      sort: 'updated',
      locale: 'zh-CN',
    }, {
      source,
      signal: new AbortController().signal,
      http: { getJson },
    })

    expect(getJson).toHaveBeenCalledTimes(2)
    expect(getJson.mock.calls[0]?.[0]).toBe(source.manifestUrl)
    const catalogUrl = new URL(getJson.mock.calls[1]![0])
    expect(catalogUrl.origin + catalogUrl.pathname).toBe('https://plugins.example.org/v1/plugins')
    expect(Object.fromEntries(catalogUrl.searchParams)).toEqual({
      q: 'sidebar',
      category: 'interface',
      limit: '80',
      sort: 'updated',
      locale: 'zh-CN',
    })
  })
})
