import { randomUUID } from 'node:crypto'
import type { CatalogQuery, CatalogSnapshot } from '../contracts/index.js'
import { applyScopedCatalogCursor, normalizeCatalogQuery, scopeCatalogCursor } from '../contracts/query.js'
import { parseCatalogSnapshot } from '../contracts/validate.js'
import type { CatalogAdapter, CatalogHttpClient, CatalogMediaRegistry, LocalSourceRecord, ScopedCatalogCursor } from '../contracts/types.js'
import type { MarketCatalogSourceResult, MarketSourceView } from '../api-types.js'
import { DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_ENDPOINT, DSH_1024STORE_KEY, DSH_1024STORE_PROVIDER_ID, dsh1024StoreAdapter } from '../adapters/dsh-1024store.js'
import { standardHttpAdapter } from '../adapters/standard-http.js'

export interface BuiltInProviderDefinition {
  readonly key: string
  readonly name: string
  readonly description: string
  readonly providerId: string
  readonly adapterId: string
  readonly endpoint: string
  readonly attribution: {
    readonly name: string
    readonly url: string
    readonly notice?: string
  }
  readonly partnership: boolean
}

export const BUILT_IN_PROVIDERS: readonly BuiltInProviderDefinition[] = [{
  key: DSH_1024STORE_KEY,
  name: 'DSH 1024Store',
  description: '合作提供方目录。需要用户明确添加并启用。目录收录不代表插件经过审核或推荐。',
  providerId: DSH_1024STORE_PROVIDER_ID,
  adapterId: DSH_1024STORE_ADAPTER_ID,
  endpoint: DSH_1024STORE_ENDPOINT,
  attribution: {
    name: 'DSH 1024Store',
    url: 'https://deepseek1024.com',
    notice: 'Community catalog data provided by a cooperating provider.',
  },
  partnership: true,
}]

const adapters = new Map<string, CatalogAdapter>([
  [standardHttpAdapter.adapterId, standardHttpAdapter],
  [dsh1024StoreAdapter.adapterId, dsh1024StoreAdapter],
])

function sourceView(record: LocalSourceRecord): MarketSourceView {
  const builtIn = record.builtInProviderKey === undefined
    ? undefined
    : BUILT_IN_PROVIDERS.find(provider => provider.key === record.builtInProviderKey)
  const description = builtIn?.description ?? record.manifest?.description
  const attribution = builtIn?.attribution ?? record.manifest?.attribution
  return {
    ...record,
    name: builtIn?.name ?? record.manifest?.name ?? record.providerId,
    ...(description === undefined ? {} : { description }),
    endpoint: builtIn?.endpoint
      ?? record.manifest?.transport.endpoint
      ?? (record.manifestUrl === undefined ? record.providerId : new URL(record.manifestUrl).origin),
    ...((record.manifest?.homepage) === undefined ? {} : { homepage: record.manifest.homepage }),
    ...(attribution === undefined ? {} : { attribution }),
    partnership: builtIn?.partnership ?? false,
  }
}

function cacheKey(source: LocalSourceRecord, query: CatalogQuery): string {
  return `${source.sourceRecordId}:${JSON.stringify(query)}`
}

function safeError(cause: unknown): string {
  if (cause instanceof Error && cause.message.startsWith('catalog request failed: ')) return cause.message.slice(23)
  if (cause instanceof Error && cause.name === 'CatalogContractError') return 'invalid catalog data'
  return 'source unavailable'
}

export interface CatalogService {
  listSources(): Promise<readonly MarketSourceView[]>
  fetch(
    query: unknown,
    signal: AbortSignal,
    scope?: CatalogFetchScope,
  ): Promise<readonly MarketCatalogSourceResult[]>
  invalidateSource(sourceRecordId: string): void
}

/** A provider cursor may only be replayed against the active source that issued it. */
export interface CatalogFetchScope {
  readonly sourceRecordId: string
  readonly cursor?: string
}

export interface CatalogServiceOptions {
  readonly cacheTtlMs?: number
  readonly cursorTtlMs?: number
  readonly now?: () => number
  readonly maxCacheEntries?: number
  readonly maxCursorEntries?: number
  readonly maxConcurrentSources?: number
  readonly adapterHttpClients?: ReadonlyMap<string, CatalogHttpClient>
  readonly media?: CatalogMediaRegistry
}

const unavailableMedia: CatalogMediaRegistry = {
  register() {
    throw new Error('catalog media service is unavailable')
  },
  unregisterSource() {},
}

interface CatalogCacheEntry {
  readonly sourceRecordId: string
  readonly snapshot: CatalogSnapshot
  readonly savedAt: number
}

interface CatalogCursorEntry {
  readonly cursor: ScopedCatalogCursor
  readonly generation: number
  readonly savedAt: number
}

interface CatalogFetchOutcome {
  readonly sourceRecordId: string
  readonly generation: number
  readonly result: MarketCatalogSourceResult
}

interface ConcurrencyWaiter {
  readonly signal: AbortSignal
  readonly resolve: () => void
  readonly reject: (cause: unknown) => void
  readonly onAbort: () => void
}

class ConcurrencyGate {
  private active = 0
  private readonly waiting: ConcurrencyWaiter[] = []

  constructor(private readonly limit: number) {}

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    }
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(waiter)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
      }
      const waiter: ConcurrencyWaiter = { signal, resolve, reject, onAbort }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(waiter)
    })
  }

  private release(): void {
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
        continue
      }
      waiter.resolve()
      return
    }
    this.active -= 1
  }

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    await this.acquire(signal)
    try {
      return await task()
    } finally {
      this.release()
    }
  }
}

export class DefaultCatalogService implements CatalogService {
  private readonly cache = new Map<string, CatalogCacheEntry>()
  private readonly cursors = new Map<string, CatalogCursorEntry>()
  private readonly sourceGenerations = new Map<string, number>()
  private readonly sourceControllers = new Map<string, Set<AbortController>>()
  private readonly cacheTtlMs: number
  private readonly cursorTtlMs: number
  private readonly maxCacheEntries: number
  private readonly maxCursorEntries: number
  private readonly sourceConcurrency: ConcurrencyGate
  private readonly now: () => number
  private readonly adapterHttpClients: ReadonlyMap<string, CatalogHttpClient>
  private readonly media: CatalogMediaRegistry

  constructor(
    private readonly store: { load(): Promise<readonly LocalSourceRecord[]> },
    private readonly http: CatalogHttpClient,
    options: CatalogServiceOptions = {},
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1000
    this.cursorTtlMs = options.cursorTtlMs ?? 30 * 60 * 1000
    this.maxCacheEntries = options.maxCacheEntries ?? 256
    this.maxCursorEntries = options.maxCursorEntries ?? 512
    const maxConcurrentSources = options.maxConcurrentSources ?? 4
    if (!Number.isSafeInteger(this.maxCacheEntries) || this.maxCacheEntries < 1) {
      throw new TypeError('invalid catalog cache entry limit')
    }
    if (!Number.isSafeInteger(this.maxCursorEntries) || this.maxCursorEntries < 1) {
      throw new TypeError('invalid catalog cursor entry limit')
    }
    if (!Number.isFinite(this.cursorTtlMs) || this.cursorTtlMs <= 0) {
      throw new TypeError('invalid catalog cursor TTL')
    }
    if (!Number.isSafeInteger(maxConcurrentSources) || maxConcurrentSources < 1) {
      throw new TypeError('invalid catalog source concurrency limit')
    }
    this.sourceConcurrency = new ConcurrencyGate(maxConcurrentSources)
    this.now = options.now ?? Date.now
    this.adapterHttpClients = options.adapterHttpClients ?? new Map()
    this.media = options.media ?? unavailableMedia
  }

  async listSources(): Promise<readonly MarketSourceView[]> {
    const records = await this.store.load()
    return [...records].sort((left, right) => left.order - right.order).map(sourceView)
  }

  invalidateSource(sourceRecordId: string): void {
    this.sourceGenerations.set(sourceRecordId, (this.sourceGenerations.get(sourceRecordId) ?? 0) + 1)
    for (const controller of this.sourceControllers.get(sourceRecordId) ?? []) {
      controller.abort(new DOMException('Catalog source was disabled or removed', 'AbortError'))
    }
    this.sourceControllers.delete(sourceRecordId)
    for (const [key, entry] of this.cache) {
      if (entry.sourceRecordId === sourceRecordId) this.cache.delete(key)
    }
    for (const [token, entry] of this.cursors) {
      if (entry.cursor.sourceRecordId === sourceRecordId) this.cursors.delete(token)
    }
    this.media.unregisterSource(sourceRecordId)
  }

  private purgeExpiredCursors(): void {
    const now = this.now()
    for (const [token, entry] of this.cursors) {
      if (now - entry.savedAt >= this.cursorTtlMs) this.cursors.delete(token)
    }
  }

  private issueCursor(
    rawCursor: string,
    sourceRecordId: string,
    query: CatalogQuery,
    generation: number,
  ): string {
    this.purgeExpiredCursors()
    let token = randomUUID()
    while (this.cursors.has(token)) token = randomUUID()
    this.cursors.set(token, {
      cursor: scopeCatalogCursor(rawCursor, sourceRecordId, query),
      generation,
      savedAt: this.now(),
    })
    while (this.cursors.size > this.maxCursorEntries) {
      const oldest = this.cursors.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.cursors.delete(oldest)
    }
    return token
  }

  private applyCursor(
    token: string,
    sourceRecordId: string,
    query: CatalogQuery,
    generation: number,
  ): CatalogQuery {
    this.purgeExpiredCursors()
    const entry = this.cursors.get(token)
    if (entry === undefined || entry.generation !== generation) {
      if (entry !== undefined) this.cursors.delete(token)
      throw new Error('catalog cursor is unknown or expired')
    }
    return applyScopedCatalogCursor(entry.cursor, sourceRecordId, query)
  }

  private exposeSnapshot(
    snapshot: CatalogSnapshot,
    sourceRecordId: string,
    query: CatalogQuery,
    generation: number,
  ): CatalogSnapshot {
    const rawCursor = snapshot.page.nextCursor
    if (rawCursor === undefined) return snapshot
    return {
      ...snapshot,
      page: {
        ...snapshot.page,
        nextCursor: this.issueCursor(rawCursor, sourceRecordId, query, generation),
      },
    }
  }

  private saveCache(key: string, sourceRecordId: string, snapshot: CatalogSnapshot): void {
    this.cache.delete(key)
    this.cache.set(key, { sourceRecordId, snapshot, savedAt: this.now() })
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  async fetch(
    value: unknown,
    signal: AbortSignal,
    scope?: CatalogFetchScope,
  ): Promise<readonly MarketCatalogSourceResult[]> {
    if (scope !== undefined && (
      typeof scope.sourceRecordId !== 'string'
      || scope.sourceRecordId.length === 0
      || scope.cursor !== undefined && (
        typeof scope.cursor !== 'string'
        || scope.cursor.length === 0
      )
    )) {
      throw new Error('catalog source scope is invalid')
    }
    const baseQuery = normalizeCatalogQuery(value)
    if (baseQuery.cursor !== undefined) {
      throw new Error('catalog cursor requires an explicit source scope')
    }
    // Capture before the asynchronous store read. A disable/remove that races
    // with that read must invalidate the returned record, not become its new
    // accepted baseline generation.
    const generationsAtLoadStart = new Map(this.sourceGenerations)
    const orderedRecords = [...await this.store.load()]
      .sort((left, right) => left.order - right.order)
    const activeSource = orderedRecords.find(record => record.enabled)
    if (scope !== undefined && activeSource?.sourceRecordId !== scope.sourceRecordId) {
      throw new Error('catalog source is not active')
    }
    const activeGeneration = activeSource === undefined
      ? 0
      : generationsAtLoadStart.get(activeSource.sourceRecordId) ?? 0
    const query = scope?.cursor === undefined
      ? baseQuery
      : this.applyCursor(scope.cursor, scope.sourceRecordId, baseQuery, activeGeneration)
    const records = activeSource === undefined ? [] : [activeSource]
    const outcomes = await Promise.all(records.map(async source => await this.sourceConcurrency.run(signal, async () => {
      const generation = generationsAtLoadStart.get(source.sourceRecordId) ?? 0
      const outcome = (result: MarketCatalogSourceResult): CatalogFetchOutcome => ({
        sourceRecordId: source.sourceRecordId,
        generation,
        result,
      })
      const adapter = adapters.get(source.adapterId)
      if (adapter === undefined) return outcome({ source: sourceView(source), stale: false, error: 'adapter unavailable' })
      if ((this.sourceGenerations.get(source.sourceRecordId) ?? 0) !== generation) {
        return outcome({ source: sourceView(source), stale: false, error: 'source unavailable' })
      }
      const invalidationController = new AbortController()
      const controllers = this.sourceControllers.get(source.sourceRecordId) ?? new Set<AbortController>()
      controllers.add(invalidationController)
      this.sourceControllers.set(source.sourceRecordId, controllers)
      const sourceSignal = AbortSignal.any([signal, invalidationController.signal])
      const key = cacheKey(source, query)
      try {
        const http = this.adapterHttpClients.get(source.adapterId) ?? this.http
        const snapshot = parseCatalogSnapshot(await adapter.fetch(query, { signal: sourceSignal, source, http, media: this.media }))
        if ((this.sourceGenerations.get(source.sourceRecordId) ?? 0) !== generation) {
          this.media.unregisterSource(source.sourceRecordId)
          throw new Error('source invalidated during catalog fetch')
        }
        this.saveCache(key, source.sourceRecordId, snapshot)
        return outcome({
          source: sourceView(source),
          snapshot: this.exposeSnapshot(snapshot, source.sourceRecordId, query, generation),
          stale: false,
        })
      } catch (cause) {
        const cached = this.cache.get(key)
        if (cached !== undefined && this.now() - cached.savedAt < this.cacheTtlMs) {
          return outcome({
            source: sourceView(source),
            snapshot: this.exposeSnapshot(cached.snapshot, source.sourceRecordId, query, generation),
            stale: true,
            error: safeError(cause),
          })
        }
        this.cache.delete(key)
        return outcome({ source: sourceView(source), stale: false, error: safeError(cause) })
      } finally {
        controllers.delete(invalidationController)
        if (controllers.size === 0 && this.sourceControllers.get(source.sourceRecordId) === controllers) {
          this.sourceControllers.delete(source.sourceRecordId)
        }
      }
    })))
    return outcomes
      .filter(outcome => (this.sourceGenerations.get(outcome.sourceRecordId) ?? 0) === outcome.generation)
      .map(outcome => outcome.result)
  }
}
