/**
 * Address-pinned outbound transport: the ONE place a connector request is
 * allowed to leave the process.
 *
 * ## Why this module exists (audit v2.8.2 → HEAD, C3-06 residual)
 *
 * `outbound.ts` resolves a connector-controlled NAME and refuses the ones that
 * map onto a non-public address, but until this module existed the request was
 * then handed to the global `fetch`, which resolves the name **again** inside
 * the connection stack. Two resolutions mean two answers: a hostile name can
 * answer the policy's query with a public address and the connection's query
 * with `169.254.169.254` / `127.0.0.1` / a `10/8` service (DNS rebinding
 * TOCTOU). The policy's verdict was about an answer nobody used.
 *
 * The transport therefore takes **the policy's own answer** (`OutboundTarget`)
 * and dials exactly that: the socket is created with a `lookup` that ignores
 * the system resolver and returns the verified addresses, while the request
 * line, the `Host` header, the TLS SNI and the certificate identity check keep
 * using the NAME from the URL — so TLS verification stays the ordinary
 * hostname-based check and nothing about the deployment has to change.
 *
 * ## The invariants (each one has a criterion in `tests/audit-1004-pinned-address.spec.ts`)
 *
 * 1. **No second resolution.** The only addresses reachable are the ones in
 *    `target.addresses`; the `lookup` refuses every other hostname and refuses
 *    a family it has no pin for. An empty pin is a refusal, never a fallback to
 *    the system resolver (fail-closed).
 * 2. **Identity is the NAME.** `servername` is the URL host, so SNI and
 *    `checkServerIdentity` see the name the policy judged — connecting to an IP
 *    does not silently relax certificate verification (proved both ways in the
 *    spec: a self-signed cert is refused without its CA, and a cert for another
 *    name is refused).
 * 3. **No redirect following.** The response is delivered as it arrived,
 *    including a 3xx answer: the URL that was checked is the only URL that ever
 *    receives the payload (the call sites keep their `redirect: 'manual'`
 *    contract; this transport simply has no redirect logic at all).
 * 4. **The connector definition cannot weaken any of this.** There is no
 *    definition-reachable option here: `PinnedRequestOptions.tls` exists for
 *    the test that proves invariant 2 and is never fed from a definition.
 *
 * ## Why `node:http`/`node:https` and not an `undici` dispatcher
 *
 * The pinned connection needs a per-request `lookup`. `fetch` (undici) exposes
 * that only through a `Dispatcher` (`Agent({ connect: { lookup } })`), and
 * `undici` is not a dependency this package may add on its own: the lockfile is
 * shared, and a workspace dependency that only resolves inside the packaged app
 * would give the repository a transport it cannot test. `node:http`'s `lookup`
 * option is the same hook at the level below, it is public API with no version
 * coupling, and it keeps the whole path testable in this package.
 *
 * Trade-offs taken deliberately (reported as residual): HTTP/2 and proxy
 * dispatchers are not supported (the client bans system proxies by default; a
 * deployment that relies on one now reaches connectors only through the
 * Chromium stack), and `FormData` bodies are encoded through `Response` rather
 * than through undici's own encoder.
 *
 * @module
 */
import { Agent as HttpAgent, request as httpRequest, type Agent, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { connect as netConnect, isIP, type LookupFunction, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { Readable } from 'node:stream'
import { urlToHttpOptions } from 'node:url'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import {
  ConnectorProxyRouteError,
  isLoopbackTargetHost,
  resolveConnectorProxyRoute,
  type ConnectorProxyRoute,
} from './proxy-route.ts'

/**
 * One outbound request the policy has already judged: the URL as it will be
 * spoken to, plus the addresses that URL is allowed to connect to.
 *
 * `addresses` is never empty and every entry is an IP literal (the policy
 * produces literals from the resolver's answer or from the URL's own literal
 * host). The transport refuses the request when it is not.
 */
export interface OutboundTarget {
  /** The policy-checked URL (scheme/host/port/path as the remote side named it). */
  readonly url: URL
  /**
   * The addresses `url` may resolve to — the policy's own verified answer.
   *
   * Empty ONLY in proxy mode, where the policy deliberately does not resolve the
   * name locally (the proxy does): see {@link OutboundTarget.route}.
   */
  readonly addresses: readonly string[]
  /**
   * How the request leaves the process, as decided by the gate
   * ({@link resolveConnectorProxyRoute}).
   *
   * Carried with the target so the judgement is made ONCE and the transport uses
   * it, instead of re-reading the environment between the verdict and the
   * connection. Absent when a caller builds a target by hand (tests): the
   * transport then resolves the route itself.
   */
  readonly route?: ConnectorProxyRoute | undefined
}

/** Optional knobs of {@link sendPinned}. */
export interface PinnedRequestOptions {
  /**
   * TLS trust store for the request. **Test seam only** (the spec proves both
   * directions of certificate verification with a self-signed fixture); the
   * plugin never sets it and a connector definition cannot reach it.
   */
  tls?: { ca?: string | Buffer | Array<string | Buffer> } | undefined
  /**
   * Keep-alive cache size. Bounded so a definition that cycles through hosts
   * cannot grow one agent per request without limit; the entries dropped this
   * way are left to the garbage collector (their idle sockets time out on their
   * own), never `destroy()`ed, because `Agent.destroy()` also drops sockets an
   * in-flight request is still using.
   */
  maxAgents?: number | undefined
}

/**
 * The pinned `lookup` shape Node's `net.connect` accepts (`dns.lookup`'s own
 * contract). Both answer shapes are implemented below — `{ all: true }` (what
 * modern Node asks for, so happy-eyeballs can try every verified address) and
 * the single-address form.
 */
type PinnedLookup = LookupFunction

/** Strip the WHATWG brackets around an IPv6 host and drop the FQDN root dot. */
function bareHost(value: string): string {
  const withoutBrackets = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  return withoutBrackets.toLowerCase().replace(/\.$/u, '')
}

/** One error shape for every "this connection may not happen" case. */
function pinRefusal(detail: string): Error {
  const error = new Error(`pinned transport refused the connection: ${detail}`)
  error.name = 'PinnedTransportError'
  return error
}

/**
 * Build the `lookup` that binds one request to its verified addresses.
 *
 * Refusals (all fail-closed, all surfaced as a connection error — the request
 * never falls back to the system resolver):
 *  - a hostname other than the one the policy judged (the socket must belong to
 *    the checked URL, nothing else);
 *  - no address of the requested family (`family: 6` against an IPv4-only pin is
 *    a refusal, not a licence to re-resolve);
 *  - an entry that is not an IP literal (the policy only produces literals, so
 *    this is a contract break, and it must not become a DNS query).
 * @param target - the policy-checked target.
 * @returns the `lookup` for `net.connect` (handles both the `all` and the
 *   single-address callback shape of `dns.lookup`).
 */
function pinnedLookupOf(target: OutboundTarget): PinnedLookup {
  const wanted = bareHost(target.url.hostname)
  const entries: Array<{ address: string, family: 4 | 6 }> = []
  for (const raw of target.addresses) {
    const address = bareHost(raw)
    const family = isIP(address)
    if (family !== 4 && family !== 6) {
      throw pinRefusal(`the verified address ${JSON.stringify(raw)} is not an IP literal`)
    }
    entries.push({ address, family })
  }
  if (entries.length === 0) {
    // The core fail-closed rule: no pin means no connection. Falling back to the
    // resolver here would recreate exactly the window this module removes.
    throw pinRefusal(`no verified address for ${wanted}`)
  }
  return (hostname, options, callback) => {
    if (bareHost(hostname) !== wanted) {
      // The second argument is required by the type and ignored by Node whenever
      // the first one is an error (its own resolver callbacks pass one argument).
      callback(pinRefusal(`${hostname} was not the verified host (${wanted})`), '')
      return
    }
    const family = options?.family
    const usable = family === 4 || family === 6 ? entries.filter(entry => entry.family === family) : entries
    if (usable.length === 0) {
      callback(pinRefusal(`no verified address of family ${String(family)} for ${wanted}`), '')
      return
    }
    if (options?.all === true) {
      callback(null, usable)
      return
    }
    const first = usable[0] as { address: string, family: 4 | 6 }
    callback(null, first.address, first.family)
  }
}

/** Keep-alive agents, keyed by origin + pin + trust store (see `maxAgents`). */
const agentCache = new Map<string, Agent>()
const DEFAULT_MAX_AGENTS = 32

function agentFor(target: OutboundTarget, lookup: PinnedLookup, options: PinnedRequestOptions): Agent | false {
  const tls = options.tls
  // A trust store override is a test seam: one throwaway agent per request is
  // both correct and obviously not shared with a production request.
  if (tls !== undefined) return false
  const key = `${target.url.protocol}//${target.url.host}|${[...target.addresses].sort().join(',')}`
  const existing = agentCache.get(key)
  if (existing !== undefined) {
    // Refresh recency (Map keeps insertion order).
    agentCache.delete(key)
    agentCache.set(key, existing)
    return existing
  }
  const agent = target.url.protocol === 'https:'
    ? new HttpsAgent({ keepAlive: true, lookup })
    : new HttpAgent({ keepAlive: true, lookup })
  agentCache.set(key, agent)
  const limit = options.maxAgents ?? DEFAULT_MAX_AGENTS
  while (agentCache.size > limit) {
    const oldest = agentCache.keys().next()
    if (oldest.done === true) break
    // Deliberately NOT `destroy()`d: Node's `Agent.destroy()` also destroys
    // sockets that are currently in use, which would cut a request in flight
    // (an SSE stream, typically) for the sake of cache bookkeeping.
    agentCache.delete(oldest.value)
  }
  return agent
}

/** One header list as a plain record Node's `http.request` accepts. */
function headerRecord(headers: HeadersInit | undefined): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = {}
  if (headers === undefined) return record
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, name) => { record[name] = value })
    return record
  }
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) record[String(name)] = String(value)
    return record
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    record[name] = Array.isArray(value) ? value.map(String) : String(value)
  }
  return record
}

/** Response headers as the fetch `Headers` object, duplicating nothing. */
function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : String(value))
  }
  return headers
}

/** Body shapes the transport writes itself; anything else is a refusal. */
function bodyOf(init: RequestInit): { write: (request: ReturnType<typeof httpRequest>) => Promise<void> } | null {
  const body = init.body
  if (body === undefined || body === null) return null
  if (typeof body === 'string') {
    return { write: async request => { request.end(body) } }
  }
  if (body instanceof URLSearchParams) {
    return {
      write: async request => {
        if (request.getHeader('content-type') === undefined) {
          request.setHeader('content-type', 'application/x-www-form-urlencoded;charset=UTF-8')
        }
        request.end(body.toString())
      },
    }
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return { write: async request => { request.end(Buffer.from(await body.arrayBuffer())) } }
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    // Node's own multipart encoder, reached through a throwaway Response so the
    // boundary and the content-type stay in one implementation.
    return {
      write: async request => {
        const encoded = new Response(body)
        const contentType = encoded.headers.get('content-type')
        if (contentType !== null && request.getHeader('content-type') === undefined) {
          request.setHeader('content-type', contentType)
        }
        request.end(Buffer.from(await encoded.arrayBuffer()))
      },
    }
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes = body instanceof ArrayBuffer ? Buffer.from(body) : Buffer.from(body.buffer, body.byteOffset, body.byteLength)
    return { write: async request => { request.end(bytes) } }
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return {
      write: async request => {
        // `pipeline` semantics: the request errors when the source errors, and
        // the source is destroyed when the request dies.
        await new Promise<void>((resolve, reject) => {
          Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])
            .on('error', reject)
            .pipe(request)
            .on('error', reject)
            .on('finish', resolve)
        })
      },
    }
  }
  if (body instanceof Readable) {
    return {
      write: async request => {
        await new Promise<void>((resolve, reject) => {
          body.on('error', reject).pipe(request).on('error', reject).on('finish', resolve)
        })
      },
    }
  }
  throw new TypeError('pinned transport: unsupported request body shape')
}

/** The stream a response body is read from, decoding a compressed answer. */
function bodyStream(message: IncomingMessage, headers: Headers): ReadableStream<Uint8Array> | null {
  const status = message.statusCode ?? 0
  // 1xx/204/205/304 carry no body, and the `Response` constructor refuses one.
  if (status < 200 || status === 204 || status === 205 || status === 304) {
    message.resume()
    return null
  }
  const encoding = (headers.get('content-encoding') ?? '').toLowerCase()
  const decoder = encoding === 'gzip' || encoding === 'x-gzip'
    ? createGunzip()
    : encoding === 'deflate'
      ? createInflate()
      : encoding === 'br'
        ? createBrotliDecompress()
        : null
  const stream: Readable = decoder === null ? message : message.pipe(decoder)
  if (decoder !== null) {
    // The decoded bytes are what the caller sees: an encoding header it cannot
    // act on (and the compressed length) would be a lie.
    headers.delete('content-encoding')
    headers.delete('content-length')
  }
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
}

/**
 * Sink for the ONE-LINE, process-wide notices this transport may emit (P8).
 *
 * Two of them exist, each at most once per process: taking the proxy route
 * (address pinning is unavailable there) and finding proxy use enabled with no
 * proxy URL for the scheme (so the request stays direct). They are operator
 * diagnostics — the point is that a degraded outbound posture is never silent.
 *
 * The default sink writes to `process.stderr`, so an unwired composition still
 * shows the line; the plugin registers `ctx.logger.warn` (which lands in the
 * app's log file) at apply time. Tests register their own sink.
 */
let noticeSink: ((message: string) => void) | undefined = message => { process.stderr.write(`${message}\n`) }
let emittedNotices = new Set<string>()

/**
 * Replace (or clear, with `undefined`) the notice sink.
 *
 * Registering a sink also starts a fresh notice EPOCH: production registers
 * exactly once (the plugin's apply), so "at most one line per notice" is still
 * per process; a test (or a composition that swaps its logger) gets to observe
 * each notice again instead of inheriting a flag from an earlier one.
 * @param sink - receives each notice's full text, or `undefined` to drop them.
 */
export function setConnectorOutboundNoticeSink(sink: ((message: string) => void) | undefined): void {
  noticeSink = sink
  emittedNotices = new Set<string>()
}

/** Emit one notice by tag, at most once per process. */
function noticeOnce(tag: string, message: string): void {
  if (emittedNotices.has(tag)) return
  emittedNotices.add(tag)
  noticeSink?.(message)
}

/**
 * The notice text for the proxy route. Stable ASCII tag first so it can be
 * grepped in the app log whatever the host locale is.
 * @param route - the proxy route in force.
 * @returns the one-line notice.
 */
function proxyModeNotice(route: Extract<ConnectorProxyRoute, { kind: 'proxy' }>): string {
  return 'connector outbound proxy mode: 地址钉扎不可达（域名由代理解析），本地仅保留字面量/保留名判定'
    + ` [proxy=${route.url.host}]`
}

/**
 * Perform one policy-approved request against a pinned address.
 *
 * The socket is created with {@link pinnedLookupOf}'s `lookup`, so the answer
 * the policy verified IS the answer the connection uses. The URL keeps its NAME
 * for the request line, the `Host` header and TLS (`servername`), which is what
 * keeps certificate verification an ordinary hostname check.
 * @param target - the policy-checked URL plus its verified addresses.
 * @param init - request options; `method`, `headers`, `body` and `signal` are
 *   honoured, redirect-related fields are ignored (this transport never
 *   follows a redirect).
 * @param options - TLS seam and keep-alive cache bound.
 * @returns the response as it arrived, redirects included.
 * @throws {Error} (`PinnedTransportError`) when the request cannot be pinned at
 *   all — never a silent fallback to the system resolver.
 * @throws {TypeError} for an unusable body shape, mirroring `fetch`'s own
 *   "failed to construct" failures.
 */
export async function sendPinned(
  target: OutboundTarget,
  init: RequestInit = {},
  options: PinnedRequestOptions = {},
): Promise<Response> {
  const protocol = target.url.protocol
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw pinRefusal(`unsupported protocol ${protocol}`)
  }
  const route = target.route ?? resolveConnectorProxyRoute(process.env, target.url, {
    loopback: isLoopbackTargetHost(target.url.hostname),
  })
  if (route.kind === 'proxy') {
    noticeOnce('proxy-mode', proxyModeNotice(route))
    return await sendViaConnectProxy(route.url, target, init, options)
  }
  if (route.reason === 'no-proxy-configured') {
    noticeOnce('no-proxy-configured',
      'connector outbound: proxy use is enabled but no proxy URL is configured for this scheme; staying direct')
  }
  return await sendDirectPinned(target, init, options)
}

/**
 * The pinned direct transport: dial the policy's verified addresses.
 * @param target - the policy-checked target (non-empty pin required).
 * @param init - request options.
 * @param options - TLS seam and keep-alive cache bound.
 * @returns the response as it arrived.
 */
async function sendDirectPinned(
  target: OutboundTarget,
  init: RequestInit,
  options: PinnedRequestOptions,
): Promise<Response> {
  const protocol = target.url.protocol
  const lookup = pinnedLookupOf(target)
  const headers = headerRecord(init.headers)
  // Compression is negotiated in ONE place, and only with encodings this
  // transport really decodes (`bodyStream`). The default mirrors what the global
  // fetch this replaces used to send, so a deployment does not silently start
  // receiving uncompressed bodies; a caller that sets its own value keeps it —
  // the decoder follows the RESPONSE's `content-encoding`, not this header.
  let negotiated = false
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== 'accept-encoding') continue
    negotiated = true
    if (name === 'accept-encoding') continue
    // Same header, different spelling: header names are case-insensitive, and
    // keeping both keys would make the wire value depend on object key order.
    const value = headers[name]
    delete headers[name]
    if (value !== undefined) headers['accept-encoding'] = value
  }
  if (!negotiated) headers['accept-encoding'] = 'gzip, deflate'
  const requestOptions = {
    ...urlToHttpOptions(target.url),
    method: (init.method ?? 'GET').toUpperCase(),
    headers,
    lookup,
    // **Security invariant, not style.** This key must ALWAYS be present — a
    // real pinned Agent in production, `false` for the TLS test seam — because
    // it is the key's ABSENCE that changes the route: Node then falls back to
    // the process-wide `http(s).globalAgent`, and under `NODE_USE_ENV_PROXY=1`
    // that global agent is the environment proxy. The proxy gets the NAME
    // (absolute-form request line / `CONNECT host:port`) and resolves it
    // itself, so the verified address never reaches a socket — the exact
    // DNS-rebinding TOCTOU this module closes, reopened silently. `agent:
    // false` is safe (Node builds a fresh default agent and does not consult
    // the global one); omitting the key is not. `agentFor` answers a pinned
    // keep-alive Agent in production and `false` only for the TLS seam, so
    // "always an explicit value" holds on every path. Pinned by the criterion
    // "never takes the process-wide agent route, so an ambient proxy cannot
    // void the pin" — deleting this line leaves the rest of the suite green.
    agent: agentFor(target, lookup, options),
    ...(init.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
    ...(protocol === 'https:' ? { servername: bareHost(target.url.hostname) || target.url.hostname } : {}),
    ...(options.tls === undefined ? {} : { ca: options.tls.ca }),
  }
  const body = bodyOf(init)
  const message = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = protocol === 'https:' ? httpsRequest(requestOptions, resolve) : httpRequest(requestOptions, resolve)
    request.on('error', reject)
    if (body === null) {
      request.end()
      return
    }
    void body.write(request).catch((error: unknown) => {
      request.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  return respondWith(message, target.url)
}


/**
 * Read one line-terminated HTTP head from a socket, bounded.
 * @param socket - the connected socket.
 * @param limit - maximum bytes accepted before the head is called unusable.
 * @returns the raw head bytes (without the terminating CRLFCRLF).
 */
function readHttpHead(socket: Socket, limit: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk)
      size += chunk.length
      const head = Buffer.concat(chunks)
      const end = head.indexOf('\r\n\r\n')
      if (end >= 0) {
        cleanup()
        resolve(head.subarray(0, end))
        return
      }
      if (size > limit) {
        cleanup()
        reject(new ConnectorProxyRouteError('proxy-head-too-large', 'connector proxy CONNECT answer head is too large'))
      }
    }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const onClose = (): void => { cleanup(); reject(new Error('connector proxy closed the connection during CONNECT')) }
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

/** `Basic` credentials of a proxy URL, when it carries any. */
function proxyAuthorization(proxy: URL): string | null {
  if (proxy.username === '' && proxy.password === '') return null
  const user = decodeURIComponent(proxy.username)
  const password = decodeURIComponent(proxy.password)
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
}

/**
 * Open a CONNECT tunnel through the deployment's proxy (P8).
 *
 * `Host` (both on the CONNECT line and on the tunnelled request) and, for https,
 * the TLS `servername` stay the NAME from the policy-checked URL, so the proxy
 * and the network see exactly the request the policy judged and the certificate
 * is verified against the same name as in direct mode.
 *
 * **Address pinning does not exist in this mode**: the proxy resolves the name.
 * The local guarantees are the ones that need no resolution (see
 * `proxy-route.ts`), and a one-line notice says so.
 *
 * Fail-closed at every step: a proxy that cannot be reached, refuses the
 * CONNECT, answers something that is not a 2xx, or an unusable TLS handshake all
 * reject. There is deliberately **no fallback to a direct connection** — that
 * would be the silent bypass this module exists to prevent.
 * @param proxy - the proxy URL (http: or https:).
 * @param target - the policy-checked target (its `addresses` are unused here).
 * @param init - request options.
 * @param options - TLS seam (tests) and unused keep-alive bound.
 * @returns the response as it arrived.
 * @throws {ConnectorProxyRouteError} when the proxy could not be used.
 */
async function sendViaConnectProxy(
  proxy: URL,
  target: OutboundTarget,
  init: RequestInit,
  options: PinnedRequestOptions,
): Promise<Response> {
  const protocol = target.url.protocol
  const targetHost = bareHost(target.url.hostname)
  const targetPort = target.url.port === '' ? (protocol === 'https:' ? 443 : 80) : Number(target.url.port)
  const proxyPort = proxy.port === '' ? (proxy.protocol === 'https:' ? 443 : 80) : Number(proxy.port)
  const signal = init.signal ?? undefined
  if (signal?.aborted === true) throw new Error('connector proxy CONNECT aborted')
  let tunnel: Socket
  try {
    tunnel = await new Promise<Socket>((resolve, reject) => {
      const onConnect = (): void => { resolve(socket) }
      const onError = (error: Error): void => { reject(error) }
      const socket = proxy.protocol === 'https:'
        ? tlsConnect({ host: bareHost(proxy.hostname), port: proxyPort, servername: bareHost(proxy.hostname), ...(signal === undefined ? {} : { signal }) }, onConnect)
        : netConnect({ host: bareHost(proxy.hostname), port: proxyPort, ...(signal === undefined ? {} : { signal }) }, onConnect)
      socket.once('error', onError)
    })
  } catch (cause) {
    throw new ConnectorProxyRouteError('proxy-unreachable',
      `connector proxy ${proxy.host} could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const head = [`CONNECT ${targetHost}:${String(targetPort)} HTTP/1.1`, `Host: ${targetHost}:${String(targetPort)}`]
  const authorization = proxyAuthorization(proxy)
  if (authorization !== null) head.push(`Proxy-Authorization: ${authorization}`)
  tunnel.write(`${head.join('\r\n')}\r\n\r\n`)
  let answer: Buffer
  try {
    answer = await readHttpHead(tunnel, 16 * 1024)
  } catch (cause) {
    tunnel.destroy()
    throw cause instanceof ConnectorProxyRouteError ? cause : new ConnectorProxyRouteError('proxy-connect-failed',
      `connector proxy ${proxy.host} did not answer CONNECT: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const statusLine = answer.toString('latin1').split('\r\n')[0] ?? ''
  const status = Number(/^HTTP\/\d\.\d (\d{3})/u.exec(statusLine)?.[1] ?? '0')
  if (status < 200 || status >= 300) {
    tunnel.destroy()
    throw new ConnectorProxyRouteError('proxy-connect-refused',
      `connector proxy ${proxy.host} refused CONNECT ${targetHost}:${String(targetPort)} (${statusLine.slice(0, 80)})`)
  }
  // For https the tunnel carries an end-to-end TLS session: the proxy sees
  // ciphertext, and the certificate is verified against the SAME name the policy
  // checked (in direct mode the same check runs against the pinned socket).
  let transport: Socket = tunnel
  if (protocol === 'https:') {
    try {
      transport = await new Promise<Socket>((resolve, reject) => {
        const socket = tlsConnect({
          socket: tunnel,
          servername: targetHost,
          ...(options.tls === undefined ? {} : { ca: options.tls.ca }),
        }, () => { resolve(socket) })
        socket.once('error', reject)
      })
    } catch (cause) {
      tunnel.destroy()
      throw cause instanceof Error ? cause : new Error(String(cause))
    }
  }
  const headers = headerRecord(init.headers)
  let negotiated = false
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== 'accept-encoding') continue
    negotiated = true
    if (name === 'accept-encoding') continue
    const value = headers[name]
    delete headers[name]
    if (value !== undefined) headers['accept-encoding'] = value
  }
  if (!negotiated) headers['accept-encoding'] = 'gzip, deflate'
  const requestOptions = {
    host: targetHost,
    port: targetPort,
    path: `${target.url.pathname}${target.url.search}`,
    method: (init.method ?? 'GET').toUpperCase(),
    headers,
    // The socket is already connected (through the proxy): no lookup, no agent.
    // `agent` is deliberately OMITTED (not `false`): Node only honours
    // `createConnection` while `options.agent` is nullish — with `agent: false`
    // it builds a default agent, ignores this socket and dials the name itself
    // (probe: temp/p3-probe/connect-probe.mjs, `agent:false` ⇒ ECONNRESET).
    createConnection: () => transport,
    ...(signal === undefined ? {} : { signal }),
  }
  const body = bodyOf(init)
  const message = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = protocol === 'https:' ? httpsRequest(requestOptions, resolve) : httpRequest(requestOptions, resolve)
    request.on('error', reject)
    if (body === null) {
      request.end()
      return
    }
    void body.write(request).catch((error: unknown) => {
      request.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  return respondWith(message, target.url)
}

/** Wrap one received message as the fetch-shaped response callers consume. */
function respondWith(message: IncomingMessage, url: URL): Response {
  const responseHeadersObject = responseHeaders(message)
  const response = new Response(bodyStream(message, responseHeadersObject), {
    status: message.statusCode ?? 200,
    statusText: message.statusMessage ?? '',
    headers: responseHeadersObject,
  })
  // `fetch` reports the URL it spoke to; a caller that logs or routes on it must
  // not see an empty string here.
  Object.defineProperty(response, 'url', { value: url.href, enumerable: false })
  return response
}

