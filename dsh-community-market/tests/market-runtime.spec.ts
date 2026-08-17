import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import { describe, expect, it, vi } from 'vitest'
import { dsh1024StoreAdapter, DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_KEY, DSH_1024STORE_PROVIDER_ID } from '../src/adapters/dsh-1024store.js'
import { standardHttpAdapter } from '../src/adapters/standard-http.js'
import { DefaultCatalogService } from '../src/catalog/service.js'
import { MemoryCatalogSourceStore } from '../src/catalog/source-store.js'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {
  CatalogHttpClient,
  CatalogProviderPage,
  CatalogSourceManifest,
  LocalSourceRecord,
} from '../src/contracts/index.js'
import type { MarketSettingsDocument } from '../src/catalog/source-store.js'
import {
  createMarketSourceMutator,
  marketMutationAllowed,
  marketRequestAllowed,
  marketRoutes,
  readStandardSourceManifest,
  registerMarketRoutes,
} from '../src/host/routes.js'
import {
  CatalogNetworkError,
  createCachedCatalogHttpClient,
  createRestrictedHttpClient,
  pinnedLookupResult,
  restrictedHttpClient,
} from '../src/network/restricted-http.js'

const source = (overrides: Partial<LocalSourceRecord> = {}): LocalSourceRecord => ({
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
  registrationKind: 'built-in',
  adapterId: DSH_1024STORE_ADAPTER_ID,
  providerId: DSH_1024STORE_PROVIDER_ID,
  builtInProviderKey: DSH_1024STORE_KEY,
  enabled: true,
  order: 0,
  ...overrides,
})

const publisherAssetRef = 'mktimg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const pluginAssetRef = 'mktimg_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const renamedAssetRef = 'mktimg_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD'
const fixtureAssetRef = 'mktimg_EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE'

const rawCatalog = {
  name: 'dsh-1024store-catalog',
  meta: {
    total: 1,
    generatedAt: '2026-08-17T15:49:53.062Z',
    revision: 'sha256:fixture',
  },
  packages: [{
    id: 'anywhere-labs/deepseek-harness-desktop/dsh-plugin-desktop',
    name: 'deepseek-harness-desktop',
    owner: 'anywhere-labs',
    url: 'https://github.com/anywhere-labs/deepseek-harness-desktop',
    category: 'dev',
    description: { en: 'Desktop shell', zh: '桌面外壳' },
    pushedAt: '2026-08-17T05:45:19Z',
    stars: 11_402,
    installCount: 7,
    install: 'dsh plugin --profile web add unsafe-value-that-must-be-ignored',
  }],
}

function contractFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../docs/examples/${name}.json`, import.meta.url), 'utf8')) as unknown
}

describe('1024Store adapter', () => {
  it('projects reviewed fields and never forwards remote install strings', async () => {
    const http: CatalogHttpClient = { getJson: vi.fn(async () => ({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })) }
    const register = vi.fn(() => publisherAssetRef)
    const snapshot = await dsh1024StoreAdapter.fetch(
      { locale: 'en-US' },
      { source: source(), signal: new AbortController().signal, http, media: { register } },
    )

    expect(snapshot.items[0]).toMatchObject({
      id: rawCatalog.packages[0]!.id,
      summary: 'Desktop shell',
      repository: {
        url: 'https://github.com/anywhere-labs/deepseek-harness-desktop',
        subdirectory: 'dsh-plugin-desktop',
      },
      media: { icon: { assetRef: publisherAssetRef, role: 'publisher-avatar', alt: 'anywhere-labs' } },
      provenance: { sourceRecordId: source().sourceRecordId },
    })
    expect(JSON.stringify(snapshot)).not.toContain('unsafe-value')
    expect(snapshot.source).toMatchObject({
      providerGeneratedAt: '2026-08-17T15:49:53.062Z',
      providerRevision: 'sha256:fixture',
    })
    expect(register).toHaveBeenCalledWith({
      remoteUrl: 'https://github.com/anywhere-labs.png?size=96',
      role: 'publisher-avatar',
      alt: 'anywhere-labs',
      sourceRecordId: source().sourceRecordId,
      itemId: rawCatalog.packages[0]!.id,
      allowedHostnames: ['github.com', 'avatars.githubusercontent.com'],
    })
    expect(http.getJson).toHaveBeenCalledWith(
      'https://deepseek1024.com/api/v1/plugins',
      expect.any(AbortSignal),
      { allowedOrigin: 'https://deepseek1024.com' },
    )
  })

  it('prefers an explicit provider icon over the GitHub publisher avatar fallback', async () => {
    const item = {
      ...rawCatalog.packages[0]!,
      media: { icon: { url: 'https://avatars.githubusercontent.com/u/1?v=4', alt: 'Plugin logo' } },
    }
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: { ...rawCatalog, packages: [item] },
        finalUrl: 'https://deepseek1024.com/api/v1/plugins',
      })),
    }
    const register = vi.fn(() => pluginAssetRef)
    const snapshot = await dsh1024StoreAdapter.fetch(
      {},
      { source: source(), signal: new AbortController().signal, http, media: { register } },
    )

    expect(snapshot.items[0]?.media).toEqual({
      icon: { assetRef: pluginAssetRef, role: 'plugin-icon', alt: 'Plugin logo' },
    })
    expect(register).toHaveBeenCalledOnce()
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      remoteUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      role: 'plugin-icon',
    }))
  })

  it('rejects a 1024Store response that leaves the reviewed provider origin', async () => {
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({ value: rawCatalog, finalUrl: 'https://attacker.example/api/v1/plugins' })),
    }
    await expect(dsh1024StoreAdapter.fetch({}, {
      source: source(),
      signal: new AbortController().signal,
      http,
      media: { register: () => publisherAssetRef },
    })).rejects.toThrow(/reviewed provider origin/u)
  })

  it('uses the canonical repository URL after a provider item ID rename', async () => {
    const item = {
      ...rawCatalog.packages[0]!,
      id: 'former-owner/former-repository',
      owner: 'current-owner',
      url: 'https://github.com/current-owner/current-repository',
    }
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: { ...rawCatalog, packages: [item] },
        finalUrl: 'https://deepseek1024.com/api/v1/plugins',
      })),
    }
    const register = vi.fn(() => renamedAssetRef)

    const snapshot = await dsh1024StoreAdapter.fetch({}, {
      source: source(),
      signal: new AbortController().signal,
      http,
      media: { register },
    })

    expect(snapshot.items[0]).toMatchObject({
      id: 'former-owner/former-repository',
      repository: { url: 'https://github.com/current-owner/current-repository' },
      publisher: { name: 'current-owner', url: 'https://github.com/current-owner' },
    })
    expect(snapshot.items[0]?.repository).not.toHaveProperty('subdirectory')
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      remoteUrl: 'https://github.com/current-owner.png?size=96',
      role: 'publisher-avatar',
    }))
  })

  it('keeps legacy GitHub owners that end in a hyphen', async () => {
    const item = {
      ...rawCatalog.packages[0]!,
      id: 'tianxia--/fixture',
      owner: 'tianxia--',
      url: 'https://github.com/tianxia--/fixture',
    }
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: { ...rawCatalog, packages: [item] },
        finalUrl: 'https://deepseek1024.com/api/v1/plugins',
      })),
    }
    const register = vi.fn(() => 'mktimg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC')

    const snapshot = await dsh1024StoreAdapter.fetch({}, {
      source: source(),
      signal: new AbortController().signal,
      http,
      media: { register },
    })

    expect(snapshot.items[0]?.publisher).toEqual({
      name: 'tianxia--',
      url: 'https://github.com/tianxia--',
    })
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      remoteUrl: 'https://github.com/tianxia--.png?size=96',
    }))
  })

  it('browses the complete registry locally with filtering, sorting, and cursor paging', async () => {
    const low = {
      ...rawCatalog.packages[0]!,
      id: 'example/low-plugin',
      name: 'Low Plugin',
      owner: 'example',
      url: 'https://github.com/example/low-plugin',
      category: 'tools',
      stars: 1,
    }
    const high = {
      ...rawCatalog.packages[0]!,
      id: 'example/high-plugin',
      name: 'High Plugin',
      owner: 'example',
      url: 'https://github.com/example/high-plugin',
      category: 'tools',
      stars: 100,
    }
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: { ...rawCatalog, meta: { ...rawCatalog.meta, total: 3 }, packages: [{ invalid: true }, low, high] },
        finalUrl: 'https://deepseek1024.com/api/v1/plugins',
      })),
    }

    const first = await dsh1024StoreAdapter.fetch(
      { q: 'plugin', category: ['tools'], limit: 1, locale: 'en-US' },
      { source: source(), signal: new AbortController().signal, http, media: { register: () => fixtureAssetRef } },
    )
    const second = await dsh1024StoreAdapter.fetch(
      {
        q: 'plugin',
        category: ['tools'],
        limit: 1,
        ...(first.page.nextCursor === undefined ? {} : { cursor: first.page.nextCursor }),
        locale: 'en-US',
      },
      { source: source(), signal: new AbortController().signal, http, media: { register: () => fixtureAssetRef } },
    )

    expect(first.items.map(item => item.id)).toEqual(['example/high-plugin'])
    expect(first.page).toEqual({ nextCursor: '1', total: 2 })
    expect(second.items.map(item => item.id)).toEqual(['example/low-plugin'])
    expect(second.page).toEqual({ total: 2 })
  })
})

describe('standard catalog adapter media boundary', () => {
  const standardAssetRef = 'mktimg_ssssssssssssssssssssssssssssssss'
  const standardSource = (): LocalSourceRecord => ({
    sourceRecordId: '038f1f77-a5c4-7b73-a9ae-0242ac120004',
    registrationKind: 'user-added',
    adapterId: standardHttpAdapter.adapterId,
    providerId: 'org.example.community-catalog',
    manifestUrl: 'https://plugins.example.org/catalog-source.json',
    manifest: contractFixture('catalog-source.example') as CatalogSourceManifest,
    enabled: true,
    order: 0,
  })

  it('turns a same-origin provider icon into an opaque Host asset reference', async () => {
    const http: CatalogHttpClient = {
      getJson: vi.fn()
        .mockResolvedValueOnce({ value: contractFixture('catalog-source.example'), finalUrl: standardSource().manifestUrl! })
        .mockResolvedValueOnce({ value: contractFixture('catalog-provider-page.example'), finalUrl: 'https://plugins.example.org/v1/plugins?limit=20' }),
    }
    const register = vi.fn(() => standardAssetRef)

    const snapshot = await standardHttpAdapter.fetch({}, {
      source: standardSource(),
      signal: new AbortController().signal,
      http,
      media: { register },
    })

    expect(snapshot.items[0]?.media).toEqual({
      icon: { assetRef: standardAssetRef, role: 'plugin-icon', alt: 'Better Sidebar plugin icon' },
    })
    expect(register).toHaveBeenCalledWith({
      remoteUrl: 'https://plugins.example.org/assets/better-sidebar.png',
      role: 'plugin-icon',
      alt: 'Better Sidebar plugin icon',
      sourceRecordId: standardSource().sourceRecordId,
      itemId: 'better-sidebar',
      allowedHostnames: ['plugins.example.org'],
    })
    expect(JSON.stringify(snapshot)).not.toContain('better-sidebar.png')
  })

  it('writes the canonical repository identity into the normalized snapshot', async () => {
    const page = contractFixture('catalog-provider-page.example') as CatalogProviderPage
    page.items[0]!.repository = { url: 'https://github.com/Example/DSH-Plugin-Better-Sidebar.git/' }
    const http: CatalogHttpClient = {
      getJson: vi.fn()
        .mockResolvedValueOnce({ value: contractFixture('catalog-source.example'), finalUrl: standardSource().manifestUrl! })
        .mockResolvedValueOnce({ value: page, finalUrl: 'https://plugins.example.org/v1/plugins?limit=20' }),
    }

    const snapshot = await standardHttpAdapter.fetch({}, {
      source: standardSource(),
      signal: new AbortController().signal,
      http,
      media: { register: () => standardAssetRef },
    })

    expect(snapshot.items[0]?.repository).toEqual({
      url: 'https://github.com/example/dsh-plugin-better-sidebar',
    })
  })

  it('omits an invalid cross-origin icon without dropping the catalog item', async () => {
    const page = contractFixture('catalog-provider-page.example') as {
      items: Array<{ media?: { icon: { url: string; alt?: string } } }>
    }
    page.items[0]!.media!.icon.url = 'https://tracker.example/icon.png'
    const http: CatalogHttpClient = {
      getJson: vi.fn()
        .mockResolvedValueOnce({ value: contractFixture('catalog-source.example'), finalUrl: standardSource().manifestUrl! })
        .mockResolvedValueOnce({ value: page, finalUrl: 'https://plugins.example.org/v1/plugins?limit=20' }),
    }
    const register = vi.fn()

    const snapshot = await standardHttpAdapter.fetch({}, {
      source: standardSource(),
      signal: new AbortController().signal,
      http,
      media: { register },
    })

    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]?.media).toBeUndefined()
    expect(register).not.toHaveBeenCalled()
  })

  it('uses provider defaultLimit when the manifest does not support a limit parameter', async () => {
    const manifest = contractFixture('catalog-source.example') as CatalogSourceManifest
    manifest.query.supported = manifest.query.supported.filter(field => field !== 'limit')
    manifest.query.defaultLimit = 1
    const page = contractFixture('catalog-provider-page.example') as CatalogProviderPage
    const second = structuredClone(page.items[0]!)
    second.id = 'second-plugin'
    second.name = 'second-plugin'
    second.displayName = 'Second Plugin'
    page.items.push(second)
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: manifest, finalUrl: standardSource().manifestUrl! })
      .mockResolvedValueOnce({ value: page, finalUrl: 'https://plugins.example.org/v1/plugins' })

    await expect(standardHttpAdapter.fetch({ limit: 100 }, {
      source: standardSource(),
      signal: new AbortController().signal,
      http: { getJson },
      media: { register: () => standardAssetRef },
    })).rejects.toThrow(/effective query limit of 1/u)

    expect(getJson).toHaveBeenCalledTimes(2)
    expect(getJson.mock.calls[1]?.[0]).toBe('https://plugins.example.org/v1/plugins')
  })

  it('rejects a manifest whose provider identity drifts after registration', async () => {
    const manifest = contractFixture('catalog-source.example') as CatalogSourceManifest
    manifest.providerId = 'org.example.changed-catalog'
    const getJson = vi.fn().mockResolvedValueOnce({
      value: manifest,
      finalUrl: standardSource().manifestUrl!,
    })

    await expect(standardHttpAdapter.fetch({}, {
      source: standardSource(),
      signal: new AbortController().signal,
      http: { getJson },
      media: { register: () => standardAssetRef },
    })).rejects.toThrow(/provider identity changed/u)
    expect(getJson).toHaveBeenCalledOnce()
  })

  it.each([
    ['manifest final URL', 'manifest-final', 1],
    ['manifest endpoint', 'endpoint', 1],
    ['provider page final URL', 'page-final', 2],
  ] as const)('rejects a cross-origin %s', async (_label, variant, expectedRequests) => {
    const manifest = contractFixture('catalog-source.example') as CatalogSourceManifest
    if (variant === 'endpoint') manifest.transport.endpoint = 'https://other.example/v1/plugins'
    const getJson = vi.fn().mockResolvedValueOnce({
      value: manifest,
      finalUrl: variant === 'manifest-final'
        ? 'https://other.example/catalog-source.json'
        : standardSource().manifestUrl!,
    })
    if (variant === 'page-final') {
      getJson.mockResolvedValueOnce({
        value: contractFixture('catalog-provider-page.example'),
        finalUrl: 'https://other.example/v1/plugins?limit=20',
      })
    }

    await expect(standardHttpAdapter.fetch({}, {
      source: standardSource(),
      signal: new AbortController().signal,
      http: { getJson },
      media: { register: () => standardAssetRef },
    })).rejects.toThrow(/changed the registered source origin/u)
    expect(getJson).toHaveBeenCalledTimes(expectedRequests)
  })
})

describe('standard source registration trust boundary', () => {
  it('pins the manifest response and endpoint to the user-approved origin', async () => {
    const manifest = contractFixture('catalog-source.example') as CatalogSourceManifest
    const http: CatalogHttpClient = {
      getJson: vi.fn(async () => ({
        value: manifest,
        finalUrl: 'https://plugins.example.org/redirected/catalog-source.json',
      })),
    }

    await expect(readStandardSourceManifest(
      'https://plugins.example.org/catalog-source.json',
      new AbortController().signal,
      http,
    )).resolves.toMatchObject({ providerId: 'org.example.community-catalog' })

    await expect(readStandardSourceManifest(
      'https://plugins.example.org/catalog-source.json',
      new AbortController().signal,
      {
        getJson: vi.fn(async () => ({
          value: manifest,
          finalUrl: 'https://attacker.example/catalog-source.json',
        })),
      },
    )).rejects.toThrow(/changed the registered source origin/u)
  })

  it('rejects a nonstandard manifest port before making a request', async () => {
    const getJson = vi.fn()
    await expect(readStandardSourceManifest(
      'https://plugins.example.org:8443/catalog-source.json',
      new AbortController().signal,
      { getJson },
    )).rejects.toThrow(/standard HTTPS port 443/u)
    expect(getJson).not.toHaveBeenCalled()
  })
})

describe('catalog aggregation', () => {
  it('globally bounds concurrent source reads across overlapping catalog requests', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([
      source(),
      source({ sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003', order: 1 }),
      source({ sourceRecordId: '038f1f77-a5c4-7b73-a9ae-0242ac120004', order: 2 }),
    ])
    let active = 0
    let peak = 0
    const releases: Array<() => void> = []
    const getJson = vi.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>(resolve => { releases.push(resolve) })
      active -= 1
      return { value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' }
    })
    const service = new DefaultCatalogService(store, { getJson }, { maxConcurrentSources: 2 })

    const first = service.fetch({}, new AbortController().signal)
    const second = service.fetch({}, new AbortController().signal)
    await vi.waitFor(() => { expect(getJson).toHaveBeenCalledTimes(2) })
    expect(peak).toBe(2)
    for (let expectedCalls = 3; expectedCalls <= 6; expectedCalls += 1) {
      releases.shift()?.()
      await vi.waitFor(() => { expect(getJson).toHaveBeenCalledTimes(expectedCalls) })
    }
    releases.splice(0).forEach(release => release())
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.any(Array),
      expect.any(Array),
    ])
    expect(peak).toBe(2)
  })

  it('performs zero network requests with no enabled sources', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([{ ...source(), enabled: false }])
    const http: CatalogHttpClient = { getJson: vi.fn() }
    const service = new DefaultCatalogService(store, http)

    await expect(service.fetch({}, new AbortController().signal)).resolves.toEqual([])
    expect(http.getJson).not.toHaveBeenCalled()
  })

  it('keeps successful source results when another source fails', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([
      source(),
      source({ sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003', order: 1 }),
    ])
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
      .mockRejectedValueOnce(new Error('offline'))
    const service = new DefaultCatalogService(store, { getJson })
    const results = await service.fetch({}, new AbortController().signal)

    expect(results).toHaveLength(2)
    expect(results[0]?.snapshot?.items).toHaveLength(1)
    expect(results[1]?.error).toBe('source unavailable')
  })

  it('marks a last-good cache as stale after a later failure', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
      .mockRejectedValueOnce(new Error('offline'))
    const service = new DefaultCatalogService(store, { getJson })

    await service.fetch({}, new AbortController().signal)
    const [result] = await service.fetch({}, new AbortController().signal)
    expect(result).toMatchObject({ stale: true, error: 'source unavailable' })
    expect(result?.snapshot?.items).toHaveLength(1)
  })

  it('does not serve a last-good snapshot after its cache TTL expires', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
      .mockRejectedValueOnce(new Error('offline'))
    let now = 1_000
    const service = new DefaultCatalogService(store, { getJson }, {
      cacheTtlMs: 60_000,
      now: () => now,
    })

    await service.fetch({}, new AbortController().signal)
    now += 60_001
    const [result] = await service.fetch({}, new AbortController().signal)
    expect(result).toMatchObject({ stale: false, error: 'source unavailable' })
    expect(result?.snapshot).toBeUndefined()
  })

  it('revokes media and stale catalog data when a source is invalidated', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
      .mockRejectedValueOnce(new Error('offline'))
    const unregisterSource = vi.fn()
    const service = new DefaultCatalogService(store, { getJson }, {
      media: { register: () => publisherAssetRef, unregisterSource },
    })

    await expect(service.fetch({}, new AbortController().signal)).resolves.toMatchObject([{
      stale: false,
      snapshot: { items: [{ media: { icon: { assetRef: publisherAssetRef } } }] },
    }])
    service.invalidateSource(source().sourceRecordId)
    const [result] = await service.fetch({}, new AbortController().signal)

    expect(unregisterSource).toHaveBeenCalledWith(source().sourceRecordId)
    expect(result).toMatchObject({ stale: false, error: 'source unavailable' })
    expect(result?.snapshot).toBeUndefined()
  })

  it('aborts an in-flight catalog request when its source is invalidated', async () => {
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    let observedSignal: AbortSignal | undefined
    const getJson = vi.fn((_url: string, signal: AbortSignal) => {
      observedSignal = signal
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const service = new DefaultCatalogService(store, { getJson })

    const pending = service.fetch({}, new AbortController().signal)
    await vi.waitFor(() => { expect(getJson).toHaveBeenCalledOnce() })
    service.invalidateSource(source().sourceRecordId)

    await expect(pending).resolves.toEqual([])
    expect(observedSignal?.aborted).toBe(true)
  })

  it('does not accept a stale enabled record returned by a racing source load', async () => {
    let releaseLoad: ((records: readonly LocalSourceRecord[]) => void) | undefined
    const load = vi.fn(() => new Promise<readonly LocalSourceRecord[]>(resolve => { releaseLoad = resolve }))
    const getJson = vi.fn()
    const service = new DefaultCatalogService({ load }, { getJson })

    const pending = service.fetch({}, new AbortController().signal)
    await vi.waitFor(() => { expect(load).toHaveBeenCalledOnce() })
    service.invalidateSource(source().sourceRecordId)
    releaseLoad?.([source()])

    await expect(pending).resolves.toEqual([])
    expect(getJson).not.toHaveBeenCalled()
  })

  it('drops a completed source result if it is invalidated while another source is pending', async () => {
    const first = source()
    const second = source({ sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003', order: 1 })
    const store = new MemoryCatalogSourceStore()
    await store.save([first, second])
    let releaseSecond: (() => void) | undefined
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
    const getJson = vi.fn(async () => {
      if (getJson.mock.calls.length === 2) await secondGate
      return { value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' }
    })
    const service = new DefaultCatalogService(store, { getJson })

    const pending = service.fetch({}, new AbortController().signal)
    await vi.waitFor(() => { expect(getJson).toHaveBeenCalledTimes(2) })
    service.invalidateSource(first.sourceRecordId)
    releaseSecond?.()

    const results = await pending
    expect(results).toHaveLength(1)
    expect(results[0]?.source.sourceRecordId).toBe(second.sourceRecordId)
  })

  it('bounds the last-good catalog cache', async () => {
    const first = source()
    const second = source({ sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003' })
    const store = new MemoryCatalogSourceStore()
    await store.save([first])
    const getJson = vi.fn()
      .mockResolvedValueOnce({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
      .mockResolvedValueOnce({ value: rawCatalog, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
      .mockRejectedValueOnce(new Error('offline'))
    const service = new DefaultCatalogService(store, { getJson }, { maxCacheEntries: 1 })

    await service.fetch({}, new AbortController().signal)
    await store.save([second])
    await service.fetch({}, new AbortController().signal)
    await store.save([first])
    const [result] = await service.fetch({}, new AbortController().signal)

    expect(result).toMatchObject({ stale: false, error: 'source unavailable' })
    expect(result?.snapshot).toBeUndefined()
  })
})

describe('source mutation boundary', () => {
  it('retains and exposes a standard source manifest disclosure before enablement', async () => {
    const manifest = contractFixture('catalog-source.example') as CatalogSourceManifest
    let document: MarketSettingsDocument = { sources: [] }
    const scope = {
      get: () => document,
      update: async (patch: { sources: readonly LocalSourceRecord[] }) => { document = { sources: patch.sources } },
    } as unknown as SettingsScope<MarketSettingsDocument>
    const readManifest = vi.fn(async () => manifest)
    const mutate = createMarketSourceMutator(scope, undefined, readManifest)

    await mutate(
      { action: 'add-standard', manifestUrl: 'https://plugins.example.org/catalog-source.json' },
      new AbortController().signal,
    )

    expect(document.sources[0]).toMatchObject({
      providerId: manifest.providerId,
      manifest,
      enabled: false,
    })
    const service = new DefaultCatalogService({ load: async () => document.sources }, restrictedHttpClient)
    await expect(service.listSources()).resolves.toEqual([
      expect.objectContaining({
        name: manifest.name,
        description: manifest.description,
        endpoint: manifest.transport.endpoint,
        attribution: manifest.attribution,
        partnership: false,
      }),
    ])
  })

  it('serializes source writes so concurrent changes cannot overwrite each other', async () => {
    const first = { ...source(), enabled: false }
    const second: LocalSourceRecord = {
      sourceRecordId: '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      registrationKind: 'user-added',
      adapterId: 'market.standard-http-v1',
      providerId: 'fixture.second',
      manifestUrl: 'https://catalog.example/manifest.json',
      manifest: {
        ...(contractFixture('catalog-source.example') as CatalogSourceManifest),
        providerId: 'fixture.second',
        transport: { kind: 'https-json', endpoint: 'https://catalog.example/v1/plugins', method: 'GET' },
      },
      enabled: false,
      order: 1,
    }
    let document: MarketSettingsDocument = { sources: [first, second] }
    let releaseFirst: (() => void) | undefined
    const firstWrite = new Promise<void>(resolve => { releaseFirst = resolve })
    const update = vi.fn(async (patch: { sources: readonly LocalSourceRecord[] }) => {
      if (update.mock.calls.length === 1) await firstWrite
      document = { sources: patch.sources.map(record => ({ ...record })) }
    })
    const scope = {
      get: () => document,
      update,
    } as unknown as SettingsScope<MarketSettingsDocument>
    const mutate = createMarketSourceMutator(scope)

    const one = mutate({ action: 'set-enabled', sourceRecordId: first.sourceRecordId, enabled: true }, new AbortController().signal)
    const two = mutate({ action: 'set-enabled', sourceRecordId: second.sourceRecordId, enabled: true }, new AbortController().signal)
    await vi.waitFor(() => { expect(update).toHaveBeenCalledTimes(1) })
    releaseFirst?.()
    await Promise.all([one, two])

    expect(update).toHaveBeenCalledTimes(2)
    expect(document.sources.map(record => record.enabled)).toEqual([true, true])
  })

  it('preserves a user-defined source order when another source is removed', async () => {
    const manifest = contractFixture('catalog-source.example') as CatalogSourceManifest
    const standardSource = (
      sourceRecordId: string,
      providerId: string,
      origin: string,
      order: number,
    ): LocalSourceRecord => ({
      sourceRecordId,
      registrationKind: 'user-added',
      adapterId: 'market.standard-http-v1',
      providerId,
      manifestUrl: `${origin}/catalog-source.json`,
      manifest: {
        ...manifest,
        providerId,
        name: providerId,
        attribution: { name: providerId, url: origin },
        transport: { kind: 'https-json', endpoint: `${origin}/v1/plugins`, method: 'GET' },
      },
      enabled: false,
      order,
    })
    const first = { ...source(), enabled: false }
    const second = standardSource(
      '028f1f77-a5c4-7b73-a9ae-0242ac120003',
      'fixture.second',
      'https://second.example',
      1,
    )
    const third = standardSource(
      '038f1f77-a5c4-7b73-a9ae-0242ac120004',
      'fixture.third',
      'https://third.example',
      2,
    )
    let document: MarketSettingsDocument = { sources: [first, second, third] }
    const scope = {
      get: () => document,
      update: async (patch: { sources: readonly LocalSourceRecord[] }) => {
        document = { sources: patch.sources }
      },
    } as unknown as SettingsScope<MarketSettingsDocument>
    const mutate = createMarketSourceMutator(scope)

    await mutate(
      { action: 'move', sourceRecordId: third.sourceRecordId, direction: 'up' },
      new AbortController().signal,
    )
    await mutate(
      { action: 'remove', sourceRecordId: first.sourceRecordId },
      new AbortController().signal,
    )

    expect(document.sources.map(record => [record.providerId, record.order])).toEqual([
      ['fixture.third', 0],
      ['fixture.second', 1],
    ])
  })

  it('rejects an aborted mutation before it reaches the serialized write', async () => {
    const record = { ...source(), enabled: false }
    let document: MarketSettingsDocument = { sources: [record] }
    let releaseFirst: (() => void) | undefined
    const firstWrite = new Promise<void>(resolve => { releaseFirst = resolve })
    const update = vi.fn(async (patch: { sources: readonly LocalSourceRecord[] }) => {
      await firstWrite
      document = { sources: patch.sources }
    })
    const scope = { get: () => document, update } as unknown as SettingsScope<MarketSettingsDocument>
    const mutate = createMarketSourceMutator(scope)
    const first = mutate({ action: 'set-enabled', sourceRecordId: record.sourceRecordId, enabled: true }, new AbortController().signal)
    await vi.waitFor(() => { expect(update).toHaveBeenCalledOnce() })
    const queued = new AbortController()
    const second = mutate({ action: 'set-enabled', sourceRecordId: record.sourceRecordId, enabled: false }, queued.signal)
    queued.abort()
    releaseFirst?.()

    await first
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    expect(update).toHaveBeenCalledOnce()
    expect(document.sources[0]?.enabled).toBe(true)
  })

  it.each([
    { action: 'remove' as const },
    { action: 'set-enabled' as const, enabled: false },
  ])('invalidates Host data only after a source $action is persisted', async (mutation) => {
    const record = source()
    let document: MarketSettingsDocument = { sources: [record] }
    const events: string[] = []
    const scope = {
      get: () => document,
      update: async (patch: { sources: readonly LocalSourceRecord[] }) => {
        document = { sources: patch.sources }
        events.push('saved')
      },
    } as unknown as SettingsScope<MarketSettingsDocument>
    const onUnavailable = vi.fn((sourceRecordId: string) => { events.push(`revoked:${sourceRecordId}`) })
    const mutate = createMarketSourceMutator(scope, onUnavailable)

    await mutate({ ...mutation, sourceRecordId: record.sourceRecordId }, new AbortController().signal)

    if (mutation.action === 'remove') expect(document.sources).toEqual([])
    else expect(document.sources).toEqual([{ ...record, enabled: false }])
    expect(onUnavailable).toHaveBeenCalledWith(record.sourceRecordId)
    expect(events).toEqual(['saved', `revoked:${record.sourceRecordId}`])
  })

  it('aborts an in-flight source mutation when the plugin generation is disposed', async () => {
    type RouteHandler = (req: EventEmitter & Record<string, any>, res: EventEmitter & Record<string, any>) => Promise<void>
    const handlers = new Map<string, RouteHandler>()
    const routeDisposers: ReturnType<typeof vi.fn>[] = []
    const ctx = {
      webServer: {
        port: 43_120,
        register: vi.fn((route: { path: string; handler: RouteHandler }) => {
          handlers.set(route.path, route.handler)
          const routeDispose = vi.fn()
          routeDisposers.push(routeDispose)
          return routeDispose
        }),
      },
    }
    const update = vi.fn()
    const scope = {
      get: () => ({ sources: [] }),
      update,
    } as unknown as SettingsScope<MarketSettingsDocument>
    const dispose = registerMarketRoutes(ctx as never, scope)
    const request = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: marketRoutes.sources,
      headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
      end: vi.fn(),
    })
    const pending = handlers.get(marketRoutes.sources)!(request, response)

    dispose()
    dispose()
    await pending

    expect(update).not.toHaveBeenCalled()
    expect(response.end).not.toHaveBeenCalled()
    for (const event of ['data', 'end', 'error', 'aborted']) expect(request.listenerCount(event)).toBe(0)
    expect(routeDisposers).toHaveLength(4)
    for (const routeDispose of routeDisposers) expect(routeDispose).toHaveBeenCalledOnce()
  })

  it.each([
    ['127.0.0.1'],
    ['::ffff:7f00:1'],
  ])('allows loopback address %s only with the Desktop authority and a matching origin', (remoteAddress) => {
    const origin = 'http://127.0.0.1:43120'
    const host = '127.0.0.1:43120'
    expect(marketMutationAllowed({ remoteAddress, origin, host, expectedPort: 43_120 })).toBe(true)
  })

  it.each([
    [undefined, 'http://localhost:43120', 'localhost:43120'],
    ['127.0.0.1', undefined, 'localhost:43120'],
    ['127.0.0.1', 'http://attacker.example', 'localhost:43120'],
    ['104.21.87.154', 'http://localhost:43120', 'localhost:43120'],
    ['127.0.0.1', 'http://evil.example:43120', 'evil.example:43120'],
    ['127.0.0.1', 'http://localhost:43121', 'localhost:43121'],
  ])('rejects incomplete or non-local mutation context', (remoteAddress, origin, host) => {
    expect(marketMutationAllowed({ remoteAddress, origin, host, expectedPort: 43_120 })).toBe(false)
  })

  it('allows same-authority reads without Origin but rejects cross-site fetch metadata', () => {
    const base = {
      remoteAddress: '127.0.0.1',
      origin: undefined,
      host: '127.0.0.1:43120',
      expectedPort: 43_120,
    }
    expect(marketRequestAllowed(base)).toBe(true)
    expect(marketRequestAllowed({ ...base, secFetchSite: 'cross-site' })).toBe(false)
  })
})

describe('restricted HTTP boundary', () => {
  it('starts the first-byte deadline before response headers arrive', async () => {
    vi.useFakeTimers()
    const request = new EventEmitter()
    const destroy = vi.fn((cause?: Error) => { request.emit('error', cause) })
    Object.assign(request, { destroy, end: vi.fn() })
    const requestSpy = vi.spyOn(https, 'request').mockImplementation((() => request) as never)
    try {
      const client = createRestrictedHttpClient({
        resolveAddress: async () => ({ address: '93.184.216.34', family: 4 }),
      })
      const result = expect(client.getJson(
        'https://catalog.example/v1/plugins',
        new AbortController().signal,
      )).rejects.toMatchObject({ code: 'timeout' })

      await vi.advanceTimersByTimeAsync(0)
      expect(requestSpy).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(11_999)
      expect(destroy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await result
      expect(destroy).toHaveBeenCalledOnce()
    } finally {
      requestSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('allows proxy fake-IP DNS only for an exact reviewed hostname', async () => {
    const lookupAddresses = vi.fn(async () => [{ address: '198.18.0.38', family: 4 as const }])
    const request = vi.fn(async () => ({
      body: Buffer.from('{"packages":[]}'),
      headers: { 'content-type': 'application/json' },
      statusCode: 200,
    }))
    const trusted = createRestrictedHttpClient({
      syntheticProxyHostnames: ['deepseek1024.com'],
      lookupAddresses,
      request,
    })

    await expect(trusted.getJson(
      'https://deepseek1024.com/api/v1/plugins',
      new AbortController().signal,
    )).resolves.toMatchObject({ value: { packages: [] } })
    expect(request).toHaveBeenCalledOnce()

    const strict = createRestrictedHttpClient({ lookupAddresses, request })
    await expect(strict.getJson(
      'https://deepseek1024.com/api/v1/plugins',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'blocked-address' })
    await expect(trusted.getJson(
      'https://deepseek1024.com.attacker.example/api/v1/plugins',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'blocked-address' })
    await expect(trusted.getJson(
      'https://198.18.0.38/api/v1/plugins',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'blocked-address' })
  })

  it('caches a completed fixed-catalog response and collapses concurrent reads', async () => {
    let now = 1_000
    let release: ((value: { value: object; finalUrl: string }) => void) | undefined
    const pending = new Promise<{ value: object; finalUrl: string }>(resolve => { release = resolve })
    const delegate: CatalogHttpClient = { getJson: vi.fn(async () => await pending) }
    const client = createCachedCatalogHttpClient(delegate, { ttlMs: 300_000, now: () => now })
    const first = client.getJson('https://deepseek1024.com/api/v1/plugins', new AbortController().signal)
    const second = client.getJson('https://deepseek1024.com/api/v1/plugins', new AbortController().signal)

    expect(delegate.getJson).toHaveBeenCalledOnce()
    release?.({ value: { packages: [] }, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    await client.getJson('https://deepseek1024.com/api/v1/plugins', new AbortController().signal)
    expect(delegate.getJson).toHaveBeenCalledOnce()

    now += 300_001
    const refreshed = client.getJson('https://deepseek1024.com/api/v1/plugins', new AbortController().signal)
    expect(delegate.getJson).toHaveBeenCalledTimes(2)
    await expect(refreshed).resolves.toMatchObject({ value: { packages: [] } })
  })

  it('aborts a shared fixed-catalog request after its last waiter leaves', async () => {
    let delegateSignal: AbortSignal | undefined
    const delegate: CatalogHttpClient = {
      getJson: vi.fn(async (_url, signal) => await new Promise<never>((_resolve, reject) => {
        delegateSignal = signal
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })),
    }
    const client = createCachedCatalogHttpClient(delegate)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = client.getJson('https://deepseek1024.com/api/v1/plugins', firstController.signal)
    const second = client.getJson('https://deepseek1024.com/api/v1/plugins', secondController.signal)
    const firstResult = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const secondResult = expect(second).rejects.toMatchObject({ name: 'AbortError' })

    firstController.abort()
    expect(delegateSignal?.aborted).toBe(false)
    secondController.abort()
    expect(delegateSignal?.aborted).toBe(true)
    await Promise.all([firstResult, secondResult])
    expect(delegate.getJson).toHaveBeenCalledOnce()
  })

  it('does not let an abandoned shared request overwrite its replacement', async () => {
    const releases: Array<(response: { value: object; finalUrl: string }) => void> = []
    const delegate: CatalogHttpClient = {
      getJson: vi.fn(async () => await new Promise<{ value: object; finalUrl: string }>(resolve => { releases.push(resolve) })),
    }
    const client = createCachedCatalogHttpClient(delegate)
    const abandonedController = new AbortController()
    const abandoned = client.getJson('https://deepseek1024.com/api/v1/plugins', abandonedController.signal)
    const abandonedResult = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })
    abandonedController.abort()
    await abandonedResult

    const replacement = client.getJson('https://deepseek1024.com/api/v1/plugins', new AbortController().signal)
    expect(delegate.getJson).toHaveBeenCalledTimes(2)
    releases[0]?.({ value: { revision: 'abandoned' }, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
    releases[1]?.({ value: { revision: 'replacement' }, finalUrl: 'https://deepseek1024.com/api/v1/plugins' })
    await expect(replacement).resolves.toMatchObject({ value: { revision: 'replacement' } })
    await expect(client.getJson(
      'https://deepseek1024.com/api/v1/plugins',
      new AbortController().signal,
    )).resolves.toMatchObject({ value: { revision: 'replacement' } })
    expect(delegate.getJson).toHaveBeenCalledTimes(2)
  })

  it('keeps one total deadline across redirects', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn((url: URL, signal: AbortSignal) => {
        if (url.hostname === 'catalog.example') {
          return new Promise<{ body: Buffer; headers: { location: string }; statusCode: number }>((resolve) => {
            setTimeout(() => resolve({
              body: Buffer.alloc(0),
              headers: { location: 'https://redirect.example/catalog.json' },
              statusCode: 302,
            }), 20)
          })
        }
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      })
      const client = createRestrictedHttpClient({
        request,
        resolveAddress: async () => ({ address: '104.21.87.154', family: 4 }),
        totalTimeoutMs: 30,
      })

      const result = expect(client.getJson(
        'https://catalog.example/catalog.json',
        new AbortController().signal,
      )).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(20)
      expect(request).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(10)
      await result
    } finally {
      vi.useRealTimers()
    }
  })

  it('enforces the total deadline while DNS resolution remains pending', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn()
      let releaseLookup: ((addresses: readonly [{ address: string; family: 4 }]) => void) | undefined
      const lookup = new Promise<readonly [{ address: string; family: 4 }]>(resolve => { releaseLookup = resolve })
      const client = createRestrictedHttpClient({
        lookupAddresses: vi.fn(async () => await lookup),
        request,
        totalTimeoutMs: 30,
      })
      const result = expect(client.getJson(
        'https://catalog.example/catalog.json',
        new AbortController().signal,
      )).rejects.toMatchObject({ code: 'timeout' })

      await vi.advanceTimersByTimeAsync(30)
      await result
      releaseLookup?.([{ address: '93.184.216.34', family: 4 }])
      await vi.advanceTimersByTimeAsync(0)
      expect(request).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('revalidates every redirect target before the next request', async () => {
    const resolveAddress = vi.fn(async (hostname: string) => {
      if (hostname === 'private.example') throw new CatalogNetworkError('blocked-address')
      return { address: '104.21.87.154', family: 4 as const }
    })
    const request = vi.fn(async () => ({
      body: Buffer.alloc(0),
      headers: { location: 'https://private.example/catalog.json' },
      statusCode: 302,
    }))
    const client = createRestrictedHttpClient({ request, resolveAddress })

    await expect(client.getJson(
      'https://catalog.example/catalog.json',
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'blocked-address' })
    expect(resolveAddress).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects a standard-source cross-origin redirect before contacting it', async () => {
    const resolveAddress = vi.fn(async () => ({ address: '104.21.87.154', family: 4 as const }))
    const request = vi.fn(async () => ({
      body: Buffer.alloc(0),
      headers: { location: 'https://other.example/v1/plugins' },
      statusCode: 302,
    }))
    const client = createRestrictedHttpClient({ request, resolveAddress })

    await expect(client.getJson(
      'https://catalog.example/v1/plugins',
      new AbortController().signal,
      { allowedOrigin: 'https://catalog.example' },
    )).rejects.toMatchObject({ code: 'redirect' })
    expect(resolveAddress).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledOnce()
  })

  it('returns an address list when Node requests an all-address lookup', () => {
    const pinned = { address: '104.21.87.154', family: 4 as const }
    expect(pinnedLookupResult({ all: true }, pinned)).toEqual([pinned])
    expect(pinnedLookupResult({ all: false }, pinned)).toEqual(pinned)
  })

  it.each(['http://example.com/catalog.json', 'https://127.0.0.1/catalog.json', 'https://169.254.169.254/latest'])('rejects unsafe URL %s before requesting it', async (url) => {
    await expect(restrictedHttpClient.getJson(url, new AbortController().signal)).rejects.toThrow(/catalog request failed/u)
  })

  it.each([
    'https://[::ffff:7f00:1]/catalog.json',
    'https://[::ffff:a9fe:a9fe]/latest',
  ])('rejects IPv4-mapped IPv6 URL %s before connecting', async (url) => {
    await expect(restrictedHttpClient.getJson(url, AbortSignal.timeout(250))).rejects.toMatchObject({
      code: 'blocked-address',
    })
  })
})
