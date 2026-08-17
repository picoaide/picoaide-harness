import dns from 'node:dns'
import { isIP } from 'node:net'
import https from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { CatalogHttpClient, CatalogHttpResponse } from '../contracts/types.js'

const MAX_REDIRECTS = 3
const MAX_BODY_BYTES = 2 * 1024 * 1024
const CONNECT_TIMEOUT_MS = 8_000
const FIRST_BYTE_TIMEOUT_MS = 12_000
const TOTAL_TIMEOUT_MS = 30_000

export class CatalogNetworkError extends Error {
  constructor(readonly code: 'invalid-url' | 'blocked-address' | 'redirect' | 'timeout' | 'http' | 'response') {
    super(`catalog request failed: ${code}`)
    this.name = 'CatalogNetworkError'
  }
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && b >= 18 && b <= 19)
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%', 1)[0] ?? address.toLowerCase()
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('ff')) return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8')
    || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true
  const mapped = normalized.match(/^(?:0:){5}ffff:(\d+\.\d+\.\d+\.\d+)$/u)
  return mapped !== null && isBlockedIpv4(mapped[1]!)
}

interface PinnedAddress {
  readonly address: string
  readonly family: 4 | 6
}

function assertSafeAddress(address: string): 4 | 6 {
  const family = isIP(address)
  if (family === 4 ? isBlockedIpv4(address) : family === 6 ? isBlockedIpv6(address) : true) {
    throw new CatalogNetworkError('blocked-address')
  }
  return family as 4 | 6
}

export function pinnedLookupResult(options: { readonly all?: boolean | undefined }, pinned: PinnedAddress): PinnedAddress | PinnedAddress[] {
  return options.all ? [pinned] : pinned
}

function validateUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CatalogNetworkError('invalid-url')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443') {
    throw new CatalogNetworkError('invalid-url')
  }
  return url
}

function readBody(response: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    response.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        response.destroy(new CatalogNetworkError('response'))
        return
      }
      chunks.push(buffer)
    })
    response.once('end', () => resolve(Buffer.concat(chunks)))
    response.once('error', reject)
  })
}

async function resolvePinnedAddress(hostname: string): Promise<PinnedAddress> {
  if (isIP(hostname)) return { address: hostname, family: assertSafeAddress(hostname) }
  const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0) throw new CatalogNetworkError('blocked-address')
  for (const entry of addresses) assertSafeAddress(entry.address)
  const first = addresses[0]!
  return { address: first.address, family: assertSafeAddress(first.address) }
}

function requestOnce(url: URL, signal: AbortSignal, pinned: PinnedAddress): Promise<{ response: IncomingMessage; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let settled = false
    let firstByteTimer: NodeJS.Timeout | undefined
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      if (firstByteTimer !== undefined) clearTimeout(firstByteTimer)
      callback()
    }
    const request = https.request(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'identity',
        'user-agent': 'dsh-community-market/0.1',
      },
      servername: url.hostname,
      lookup: (_hostname, options, callback) => {
        const result = pinnedLookupResult(options, pinned)
        if (Array.isArray(result)) callback(null, result)
        else callback(null, result.address, result.family)
      },
      signal,
      timeout: CONNECT_TIMEOUT_MS,
    }, response => {
      firstByteTimer = setTimeout(() => {
        request.destroy(new CatalogNetworkError('timeout'))
      }, FIRST_BYTE_TIMEOUT_MS)
      void readBody(response).then(
        body => finish(() => resolve({ response, body })),
        cause => finish(() => reject(cause)),
      )
    })
    request.once('error', cause => finish(() => reject(cause)))
    request.once('timeout', () => request.destroy(new CatalogNetworkError('timeout')))
    request.end()
  })
}

async function fetchJson(start: string, signal: AbortSignal, redirectCount = 0): Promise<CatalogHttpResponse> {
  if (signal.aborted) throw new CatalogNetworkError('timeout')
  const url = validateUrl(start)
  if (redirectCount > MAX_REDIRECTS) throw new CatalogNetworkError('redirect')
  const pinned = await resolvePinnedAddress(url.hostname)
  const totalController = new AbortController()
  const onAbort = () => totalController.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  const totalTimer = setTimeout(() => totalController.abort(), TOTAL_TIMEOUT_MS)
  try {
    const { response, body } = await requestOnce(url, totalController.signal, pinned)
    const status = response.statusCode ?? 0
    if (status >= 300 && status < 400) {
      const location = response.headers.location
      if (location === undefined) throw new CatalogNetworkError('redirect')
      return await fetchJson(new URL(location, url).href, signal, redirectCount + 1)
    }
    if (status < 200 || status >= 300) throw new CatalogNetworkError('http')
    const contentType = response.headers['content-type'] ?? ''
    const encoding = response.headers['content-encoding']
    if (!/^(?:application\/json|application\/[^;]+\+json)(?:;|$)/iu.test(contentType)
      || encoding !== undefined && encoding !== 'identity') {
      throw new CatalogNetworkError('response')
    }
    let value: unknown
    try {
      value = JSON.parse(body.toString('utf8')) as unknown
    } catch {
      throw new CatalogNetworkError('response')
    }
    return { value, finalUrl: url.href }
  } finally {
    clearTimeout(totalTimer)
    signal.removeEventListener('abort', onAbort)
  }
}

export const restrictedHttpClient: CatalogHttpClient = {
  getJson: (url, signal) => fetchJson(url, signal),
}
