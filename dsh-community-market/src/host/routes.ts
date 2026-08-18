import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BlockList, isIP } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import type { CatalogSourceManifest } from '../contracts/index.js'
import { parseCatalogSource, validateLocalSourceRecords } from '../contracts/validate.js'
import type { CatalogHttpClient } from '../contracts/types.js'
import type { MarketBuiltInProvider, MarketCatalogResponse, MarketSourceMutation, MarketStateResponse } from '../api-types.js'
import {
  createCachedCatalogHttpClient,
  createRestrictedHttpClient,
  restrictedHttpClient,
} from '../network/restricted-http.js'
import {
  DSH_1024STORE_ADAPTER_ID,
  DSH_1024STORE_HOSTNAME,
  DSH_1024STORE_KEY,
  DSH_1024STORE_PROVIDER_ID,
} from '../adapters/dsh-1024store.js'
import { assertStandardSourceTrustRoot } from '../adapters/standard-http.js'
import { BUILT_IN_PROVIDERS, DefaultCatalogService, type CatalogFetchScope } from '../catalog/service.js'
import { SettingsCatalogSourceStore, type MarketSettingsDocument } from '../catalog/source-store.js'
import { MARKET_MEDIA_ASSET_REF_PATTERN } from '../media/ref.js'
import { createRestrictedImageFetcher } from '../media/restricted-image.js'
import { createMarketMediaService } from '../media/service.js'

export const MARKET_SETTINGS_NAMESPACE = settingsNamespace('dsh-community-market')
const SOURCE_SCHEMA = z.object({
  sourceRecordId: z.string().required(),
  registrationKind: z.union(['user-added', 'built-in'] as const).required(),
  adapterId: z.string().required(),
  providerId: z.string().required(),
  manifestUrl: z.string(),
  manifest: z.any(),
  builtInProviderKey: z.string(),
  enabled: z.boolean().required(),
  order: z.number().required(),
})
const SETTINGS_SCHEMA = z.object({
  sources: z.array(SOURCE_SCHEMA).default([]),
}) as unknown as z<MarketSettingsDocument>

const ROUTE_STATE = '/api/community-market/state'
const ROUTE_SOURCES = '/api/community-market/sources'
const ROUTE_CATALOG = '/api/community-market/catalog'
const ROUTE_ASSETS = '/api/community-market/assets'
const MAX_BODY_BYTES = 16 * 1024
// The full registry was already about 6.7 MiB in August 2026. Keep bounded
// headroom without relaxing the 2 MiB default used by user-added sources.
const MAX_DSH_1024STORE_BODY_BYTES = 16 * 1024 * 1024

const dsh1024StoreHttpClient = createCachedCatalogHttpClient(
  createRestrictedHttpClient({
    syntheticProxyHostnames: [DSH_1024STORE_HOSTNAME],
    maxBodyBytes: MAX_DSH_1024STORE_BODY_BYTES,
  }),
)

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

function abortOnDisconnect(req: IncomingMessage, res: ServerResponse, controller: AbortController): () => void {
  const abort = () => controller.abort()
  const abortIfUnfinished = () => {
    if (!res.writableEnded) controller.abort()
  }
  req.once('aborted', abort)
  res.once('close', abortIfUnfinished)
  return () => {
    req.off('aborted', abort)
    res.off('close', abortIfUnfinished)
  }
}

function readJson(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const abortReason = () => signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
  if (signal.aborted) return Promise.reject(abortReason())
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onRequestAbort)
      signal.removeEventListener('abort', onSignalAbort)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        const cause = new Error('body too large')
        finish(() => {
          req.destroy(cause)
          reject(cause)
        })
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        finish(() => resolve(value))
      } catch {
        finish(() => reject(new Error('invalid json')))
      }
    }
    const onError = (cause: Error) => finish(() => reject(cause))
    const onRequestAbort = () => finish(() => reject(new DOMException('The request was aborted', 'AbortError')))
    const onSignalAbort = () => finish(() => reject(abortReason()))
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onRequestAbort)
    signal.addEventListener('abort', onSignalAbort, { once: true })
  })
}

const loopbackAddresses = new BlockList()
loopbackAddresses.addSubnet('127.0.0.0', 8, 'ipv4')
loopbackAddresses.addSubnet('::1', 128, 'ipv6')

export interface MarketRequestContext {
  readonly remoteAddress: string | undefined
  readonly origin: string | undefined
  readonly host: string | undefined
  readonly secFetchSite?: string | undefined
  readonly expectedPort: number
}

function marketAuthority(context: MarketRequestContext): URL | undefined {
  if (context.remoteAddress === undefined || context.host === undefined) return undefined
  const address = context.remoteAddress.replace(/^\[|\]$/gu, '').split('%', 1)[0]!
  const family = isIP(address)
  if (family === 0 || !loopbackAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6')) return undefined
  let authority: URL
  try {
    authority = new URL(`http://${context.host}`)
  } catch {
    return undefined
  }
  if (
    authority.protocol !== 'http:'
    || Number(authority.port || '80') !== context.expectedPort
    || authority.hostname !== '127.0.0.1'
    || context.secFetchSite === 'cross-site'
  ) return undefined
  return authority
}

export function marketRequestAllowed(context: MarketRequestContext): boolean {
  return marketAuthority(context) !== undefined
}

export function marketMutationAllowed(context: MarketRequestContext): boolean {
  const authority = marketAuthority(context)
  if (authority === undefined || context.origin === undefined) return false
  try {
    const origin = new URL(context.origin)
    return origin.protocol === 'http:' && origin.host === authority.host && origin.pathname === '/'
  } catch {
    return false
  }
}

function requestContext(req: IncomingMessage, expectedPort: number): MarketRequestContext {
  const secFetchSite = req.headers['sec-fetch-site']
  return {
    remoteAddress: req.socket.remoteAddress,
    origin: req.headers.origin,
    host: req.headers.host,
    ...(typeof secFetchSite === 'string' ? { secFetchSite } : {}),
    expectedPort,
  }
}

function requestAllowed(req: IncomingMessage, expectedPort: number): boolean {
  return marketRequestAllowed(requestContext(req, expectedPort))
}

function mutationAllowed(req: IncomingMessage, expectedPort: number): boolean {
  return marketMutationAllowed({
    ...requestContext(req, expectedPort),
  })
}

function asMutation(value: unknown): MarketSourceMutation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid mutation')
  const mutation = value as Record<string, unknown>
  if (mutation.action === 'add-builtin' && mutation.key === DSH_1024STORE_KEY) return { action: 'add-builtin', key: DSH_1024STORE_KEY }
  if (mutation.action === 'add-standard' && typeof mutation.manifestUrl === 'string') return { action: 'add-standard', manifestUrl: mutation.manifestUrl }
  if (mutation.action === 'select' && typeof mutation.sourceRecordId === 'string') {
    return { action: 'select', sourceRecordId: mutation.sourceRecordId }
  }
  if (
    mutation.action === 'move'
    && typeof mutation.sourceRecordId === 'string'
    && (mutation.direction === 'up' || mutation.direction === 'down')
  ) {
    return { action: 'move', sourceRecordId: mutation.sourceRecordId, direction: mutation.direction }
  }
  if (mutation.action === 'remove' && typeof mutation.sourceRecordId === 'string') return { action: 'remove', sourceRecordId: mutation.sourceRecordId }
  throw new Error('unsupported mutation')
}

function viewBuiltIns(): readonly MarketBuiltInProvider[] {
  return BUILT_IN_PROVIDERS.map(provider => ({ ...provider }))
}

export async function readStandardSourceManifest(
  manifestUrl: string,
  signal: AbortSignal,
  http: CatalogHttpClient = restrictedHttpClient,
): Promise<CatalogSourceManifest> {
  const url = new URL(manifestUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('manifest URL must use credential-free standard HTTPS port 443')
  }
  const response = await http.getJson(url.href, signal, { allowedOrigin: url.origin })
  const manifest = parseCatalogSource(response.value)
  assertStandardSourceTrustRoot(url.href, response.finalUrl, manifest.transport.endpoint)
  return manifest
}

async function mutateSources(
  scope: SettingsScope<MarketSettingsDocument>,
  mutation: MarketSourceMutation,
  signal: AbortSignal,
  onUnavailable?: (sourceRecordId: string) => void,
  readManifest: (
    manifestUrl: string,
    signal: AbortSignal,
  ) => Promise<CatalogSourceManifest> = readStandardSourceManifest,
): Promise<void> {
  signal.throwIfAborted()
  const store = new SettingsCatalogSourceStore(scope)
  const records = [...await store.load()]
  const unavailableSourceRecordIds = new Set<string>()
  const nextOrder = records.reduce((maximum, record) => Math.max(maximum, record.order), -1) + 1
  if (mutation.action === 'add-builtin') {
    if (records.some(record => record.builtInProviderKey === mutation.key)) throw new Error('source already added')
    records.push({
      sourceRecordId: randomUUID(),
      registrationKind: 'built-in',
      adapterId: DSH_1024STORE_ADAPTER_ID,
      providerId: DSH_1024STORE_PROVIDER_ID,
      builtInProviderKey: mutation.key,
      enabled: false,
      order: nextOrder,
    })
  } else if (mutation.action === 'add-standard') {
    const manifest = await readManifest(mutation.manifestUrl, signal)
    signal.throwIfAborted()
    if (records.some(record => record.manifestUrl === mutation.manifestUrl)) throw new Error('source already added')
    records.push({
      sourceRecordId: randomUUID(),
      registrationKind: 'user-added',
      adapterId: 'market.standard-http-v1',
      providerId: manifest.providerId,
      manifestUrl: mutation.manifestUrl,
      manifest,
      enabled: false,
      order: nextOrder,
    })
  } else if (mutation.action === 'select' || mutation.action === 'remove') {
    const index = records.findIndex(record => record.sourceRecordId === mutation.sourceRecordId)
    if (index < 0) throw new Error('source not found')
    if (mutation.action === 'remove') {
      unavailableSourceRecordIds.add(records[index]!.sourceRecordId)
      records.splice(index, 1)
      records.sort((left, right) => left.order - right.order)
      records.forEach((record, order) => { records[order] = { ...record, order } })
    } else {
      for (const [recordIndex, record] of records.entries()) {
        const enabled = record.sourceRecordId === mutation.sourceRecordId
        if (record.enabled && !enabled) unavailableSourceRecordIds.add(record.sourceRecordId)
        records[recordIndex] = { ...record, enabled }
      }
    }
  } else {
    const ordered = [...records].sort((left, right) => left.order - right.order)
    const index = ordered.findIndex(record => record.sourceRecordId === mutation.sourceRecordId)
    if (index < 0) throw new Error('source not found')
    const targetIndex = mutation.direction === 'up' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= ordered.length) throw new Error('source cannot move further')
    const current = ordered[index]!
    const target = ordered[targetIndex]!
    const currentRecordIndex = records.findIndex(record => record.sourceRecordId === current.sourceRecordId)
    const targetRecordIndex = records.findIndex(record => record.sourceRecordId === target.sourceRecordId)
    records[currentRecordIndex] = { ...current, order: target.order }
    records[targetRecordIndex] = { ...target, order: current.order }
  }
  validateLocalSourceRecords(records)
  signal.throwIfAborted()
  await store.save(records)
  for (const sourceRecordId of unavailableSourceRecordIds) onUnavailable?.(sourceRecordId)
}

export function createMarketSourceMutator(
  scope: SettingsScope<MarketSettingsDocument>,
  onUnavailable?: (sourceRecordId: string) => void,
  readManifest?: (manifestUrl: string, signal: AbortSignal) => Promise<CatalogSourceManifest>,
): (
  mutation: MarketSourceMutation,
  signal: AbortSignal,
) => Promise<void> {
  let tail = Promise.resolve()
  return (mutation, signal) => {
    const pending = tail.then(async () => {
      signal.throwIfAborted()
      await mutateSources(scope, mutation, signal, onUnavailable, readManifest)
    })
    tail = pending.catch(() => {})
    return pending
  }
}

export function registerMarketRoutes(ctx: Context, scope: SettingsScope<MarketSettingsDocument>): () => void {
  const expectedPort = ctx.webServer.port
  const generationController = new AbortController()
  const store = new SettingsCatalogSourceStore(scope)
  const media = createMarketMediaService({
    fetchImage: createRestrictedImageFetcher({
      // These are compiled-in adapter hosts, not names supplied by a remote source.
      syntheticProxyHostnames: [DSH_1024STORE_HOSTNAME, 'github.com', 'avatars.githubusercontent.com'],
    }),
  })
  const service = new DefaultCatalogService(store, restrictedHttpClient, {
    adapterHttpClients: new Map([[DSH_1024STORE_ADAPTER_ID, dsh1024StoreHttpClient]]),
    media,
  })
  const mutateSource = createMarketSourceMutator(scope, sourceRecordId => service.invalidateSource(sourceRecordId))
  const routes = [
    ctx.webServer.register({ kind: 'exact', path: ROUTE_STATE, handler: async (_req, res) => {
      if (generationController.signal.aborted) return
      if (!requestAllowed(_req, expectedPort)) {
        sendJson(res, 403, { error: 'market request authority rejected' })
        return
      }
      try {
        const response: MarketStateResponse = { sources: await service.listSources(), builtIns: viewBuiltIns() }
        if (!generationController.signal.aborted && !res.destroyed) sendJson(res, 200, response)
      } catch {
        if (!generationController.signal.aborted && !res.destroyed) sendJson(res, 500, { error: 'market state unavailable' })
      }
    }}),
    ctx.webServer.register({ kind: 'exact', path: ROUTE_CATALOG, handler: async (req, res) => {
      if (!requestAllowed(req, expectedPort)) {
        sendJson(res, 403, { error: 'market request authority rejected' })
        return
      }
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, generationController.signal])
      const stopWatching = abortOnDisconnect(req, res, controller)
      try {
        const requestUrl = new URL(req.url ?? '/', 'http://localhost')
        const query: Record<string, unknown> = {}
        const q = requestUrl.searchParams.get('q')?.trim()
        if (q) query.q = q
        const categories = requestUrl.searchParams.getAll('category')
        if (categories.length) query.category = categories
        const limit = Number(requestUrl.searchParams.get('limit') ?? 50)
        if (Number.isInteger(limit)) query.limit = limit
        const sort = requestUrl.searchParams.get('sort')
        if (sort) query.sort = sort
        const locale = requestUrl.searchParams.get('locale')
        if (locale) query.locale = locale

        const sourceRecordIds = requestUrl.searchParams.getAll('sourceRecordId')
        const cursors = requestUrl.searchParams.getAll('cursor')
        if (sourceRecordIds.length > 1 || cursors.length > 1 || cursors.length > sourceRecordIds.length) {
          throw new Error('catalog cursor requires exactly one source record')
        }
        const scope: CatalogFetchScope | undefined = sourceRecordIds.length === 0
          ? undefined
          : {
              sourceRecordId: sourceRecordIds[0]!,
              ...(cursors.length === 0 ? {} : { cursor: cursors[0]! }),
            }
        const results = await service.fetch(query, signal, scope)
        const responseQuery = scope === undefined
          ? query
          : {
              ...query,
              sourceRecordId: scope.sourceRecordId,
              ...(scope.cursor === undefined ? {} : { cursor: scope.cursor }),
            }
        const response: MarketCatalogResponse = { query: responseQuery, results, fetchedAt: new Date().toISOString() }
        if (!signal.aborted && !res.destroyed) sendJson(res, 200, response)
      } catch {
        if (!signal.aborted && !res.destroyed) sendJson(res, 400, { error: 'invalid catalog query' })
      } finally {
        stopWatching()
      }
    }}),
    ctx.webServer.register({ kind: 'exact', path: ROUTE_ASSETS, handler: async (req, res) => {
      if (!requestAllowed(req, expectedPort)) {
        sendJson(res, 403, { error: 'market request authority rejected' })
        return
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'market media requires GET' })
        return
      }
      const requestUrl = new URL(req.url ?? '/', 'http://localhost')
      const refs = requestUrl.searchParams.getAll('ref')
      const assetRef = refs.length === 1 ? refs[0] : undefined
      if (assetRef === undefined || !MARKET_MEDIA_ASSET_REF_PATTERN.test(assetRef)) {
        sendJson(res, 404, { error: 'market media unavailable' })
        return
      }
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, generationController.signal])
      const stopWatching = abortOnDisconnect(req, res, controller)
      try {
        const asset = await media.resolve(assetRef, signal)
        if (signal.aborted || res.destroyed) return
        if (asset === undefined) {
          sendJson(res, 404, { error: 'market media unavailable' })
          return
        }
        res.setHeader('cache-control', 'private, max-age=3600')
        res.setHeader('content-type', asset.contentType)
        res.setHeader('content-length', String(asset.body.byteLength))
        res.setHeader('content-disposition', 'inline')
        res.setHeader('etag', asset.etag)
        res.setHeader('x-content-type-options', 'nosniff')
        res.setHeader('cross-origin-resource-policy', 'same-origin')
        res.setHeader('content-security-policy', "default-src 'none'; sandbox")
        res.setHeader('referrer-policy', 'no-referrer')
        if (req.headers['if-none-match'] === asset.etag) {
          res.statusCode = 304
          res.removeHeader('content-length')
          res.end()
          return
        }
        res.statusCode = 200
        res.end(asset.body)
      } catch {
        if (!signal.aborted && !res.destroyed) sendJson(res, 404, { error: 'market media unavailable' })
      } finally {
        stopWatching()
      }
    }}),
    ctx.webServer.register({ kind: 'exact', path: ROUTE_SOURCES, handler: async (req, res) => {
      if (req.method !== 'POST' || !mutationAllowed(req, expectedPort)) {
        sendJson(res, 405, { error: 'source changes require a local same-origin POST' })
        return
      }
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, generationController.signal])
      const stopWatching = abortOnDisconnect(req, res, controller)
      try {
        const mutation = asMutation(await readJson(req, signal))
        await mutateSource(mutation, signal)
        if (!signal.aborted && !res.destroyed) sendJson(res, 200, { sources: await service.listSources() })
      } catch (cause) {
        if (!signal.aborted && !res.destroyed) {
          sendJson(res, 400, { error: cause instanceof Error ? cause.message : 'source change failed' })
        }
      } finally {
        stopWatching()
      }
    }}),
  ]
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    generationController.abort(new DOMException('Market plugin generation was disposed', 'AbortError'))
    media.dispose()
    routes.forEach(dispose => dispose())
  }
}

export function registerMarketSettings(ctx: Context): SettingsScope<MarketSettingsDocument> {
  return ctx.settings.register(MARKET_SETTINGS_NAMESPACE, SETTINGS_SCHEMA, { applies: 'live' })
}

export const marketRoutes = { state: ROUTE_STATE, sources: ROUTE_SOURCES, catalog: ROUTE_CATALOG, assets: ROUTE_ASSETS }
