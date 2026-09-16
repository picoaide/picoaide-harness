/**
 * Shared outbound-URL policy for every connector-controlled endpoint.
 *
 * FIX-20 (P1): the connector's OAuth discovery chain follows URLs handed out
 * by whatever answered the previous hop (`WWW-Authenticate: resource_metadata`,
 * `authorization_servers[0]`, the RFC 8414 document's `token_endpoint`, and the
 * MCP `url` itself). Before this module existed, a hostile MCP endpoint could
 * point the flow at any host — including link-local metadata services and
 * private networks — and the authorization code plus the PKCE verifier were
 * POSTed there.
 *
 * The rule mirrors the enterprise server-URL guard
 * (`packages/host/enterprise/src/server-connector/auth.ts:71-82`,
 * `assertServerURLAllowed`): **https, or http restricted to loopback**. On top
 * of that it refuses non-public IP literals (private / link-local / metadata /
 * multicast / reserved) for BOTH protocols, because a discovery document may
 * name an address the protocol check alone would let through.
 *
 * Residual C adds the second half of the rule: checking the URL is not enough
 * while `fetch` follows redirects. Every request goes through
 * {@link outboundFetch}, which pins `redirect: 'manual'` and refuses a 3xx
 * answer instead of delivering the body (code + PKCE verifier) to a host the
 * policy would have refused as an initial URL.
 *
 * Cross-package note: the enterprise guard is owned by another workstream and
 * lives in a package this one must not depend on (the dependency direction
 * would be new and the file is out of scope). The semantics above are therefore
 * implemented here once for every connectors call site; if enterprise later
 * learns the same private-range rule, both should collapse into one shared
 * module.
 *
 * @module
 */
import { BlockList, isIP } from 'node:net'
import { hostname as osHostname } from 'node:os'
import { DEFAULT_HOST_LOCALE, hostT, stepLabel, type HostLocale } from './host-copy.ts'

/** Thrown when a connector-controlled URL is outside the allowed outbound set. */
export class OutboundUrlBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutboundUrlBlockedError'
  }
}

/**
 * Thrown when a connector-controlled request outlived its deadline (conn-1,
 * audit R7 P1).
 *
 * A deadline breach is NOT a policy refusal: call sites that keep working with
 * a stale credential on an `OutboundUrlBlockedError` (`refreshOAuthToken`) must
 * still see a timeout, and the lifecycle task that awaits them must unwind
 * rather than stay parked on a socket. The message names the flow step and the
 * deadline so the row's error text is diagnosable.
 */
class OutboundTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutboundTimeoutError'
  }
}

/**
 * Deadline of ONE connector outbound request, in milliseconds.
 *
 * Before this existed the request had no deadline at all, so an endpoint that
 * accepted the TCP connection and never answered parked the request until
 * undici's own `headersTimeout` — measured at **300 798 ms**. Because the
 * plugin's lifecycle (boot restore / logout / user switch) is ONE serial chain,
 * a logout queued behind such a request did not run for up to ~5 minutes: the
 * previous user's MCP servers stayed registered and every later operation
 * stacked up. 30 s is far below that window and still generous for a metadata
 * document or a token exchange (the OAuth code exchange keeps its own 60 s
 * budget by passing `timeoutMs` explicitly).
 */
export const OUTBOUND_REQUEST_TIMEOUT_MS = 30_000

/** Optional outbound knobs. `timeoutMs` must be a positive, finite number. */
export interface OutboundFetchOptions {
  /**
   * Deadline override (tests, and a deployment that knows its endpoints are
   * slower). Never fed from a connector definition: a definition must not be
   * able to widen or shorten its own deadline.
   */
  timeoutMs?: number
  /**
   * Locale for the error text this request may throw. Omitted callers get
   * {@link DEFAULT_HOST_LOCALE} (the pre-i18n behaviour); every plugin call
   * site passes the locale resolved from `desktopRuntime` for THIS request.
   */
  locale?: HostLocale
}

/**
 * Non-public IPv4/IPv6 ranges. Loopback is handled separately: it is the one
 * non-public range the policy deliberately allows over http (local development
 * servers), matching the enterprise rule.
 */
function buildBlockedList(): BlockList {
  const list = new BlockList()
  // IPv4: unspecified, private, CGNAT, link-local/metadata, documentation,
  // benchmarking, multicast, reserved/broadcast.
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    list.addSubnet(network, prefix, 'ipv4')
  }
  // IPv6: unspecified, IPv4-mapped (re-checked as IPv4 below), NAT64,
  // discard-only, documentation, unique-local, link-local, multicast.
  for (const [network, prefix] of [
    ['::', 128],
    ['64:ff9b::', 96],
    ['100::', 64],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) {
    list.addSubnet(network, prefix, 'ipv6')
  }
  return list
}

function buildLoopbackList(): BlockList {
  const list = new BlockList()
  list.addSubnet('127.0.0.0', 8, 'ipv4')
  list.addSubnet('::1', 128, 'ipv6')
  return list
}

const BLOCKED_ADDRESSES = buildBlockedList()
const LOOPBACK_ADDRESSES = buildLoopbackList()

/** Hostnames that name a cloud metadata service by name rather than by IP. */
const METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
])

/** Strip the brackets the WHATWG URL parser keeps around IPv6 hosts. */
function bareHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/**
 * Loopback check for one BARE hostname (brackets already stripped): any 127/8
 * address, `::1`, or its IPv4-mapped form. Named `…Literal` to stay distinct
 * from `loopback.ts`'s `isLoopbackHostname`, which serves the HTTP trust fence
 * and expects the URL's bracketed shape.
 */
function isLoopbackLiteral(hostname: string): boolean {
  const bare = bareHostname(hostname).toLowerCase()
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true
  const family = isIP(bare)
  if (family === 0) return false
  return LOOPBACK_ADDRESSES.check(bare, family === 4 ? 'ipv4' : 'ipv6')
}

type AddressClass = 'name' | 'loopback' | 'blocked' | 'public'

/** Classify a URL hostname (IP literal or DNS name). */
function classifyHost(hostname: string): AddressClass {
  // 去掉 FQDN 的根点(`metadata.google.internal.` 与 `localhost.` 都是绝对名):
  // 不归一的话,末尾一个点就能同时绕过元数据主机名单与回环名单
  // (2026-09-13 审计 R3;Go 侧 connectorURLAllowed 同款 TrimSuffix)。
  const bare = bareHostname(hostname).toLowerCase().replace(/\.$/u, '')
  const family = isIP(bare)
  if (family === 0) {
    if (METADATA_HOSTNAMES.has(bare)) return 'blocked'
    // `localhost` / `*.localhost` 是 RFC 6761 保留名,按回环处理:与 Go 侧
    // `connectorURLAllowed` 的 `EqualFold(host,"localhost") || HasSuffix(".localhost")`
    // 同口径(2026-09-13 审计 R3)。此前这里直接返回 'name',于是
    // `http://localhost:PORT/mcp` 被下面"http 但主机不是回环"判掉 —— 管理员能在
    // webadmin 保存,客户端却静默丢弃,一条合法的本地 MCP 连接器永远连不上。
    if (isLoopbackLiteral(bare)) return 'loopback'
    return 'name'
  }
  if (isLoopbackLiteral(bare)) return 'loopback'
  const type = family === 4 ? 'ipv4' : 'ipv6'
  if (BLOCKED_ADDRESSES.check(bare, type)) return 'blocked'
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) reaches the IPv4 stack: re-check the
  // embedded address so the private-range rule cannot be bypassed by wrapping.
  if (type === 'ipv6' && bare.startsWith('::ffff:')) {
    const mapped = bare.slice('::ffff:'.length)
    if (isIP(mapped) === 4) {
      if (LOOPBACK_ADDRESSES.check(mapped, 'ipv4')) return 'loopback'
      return BLOCKED_ADDRESSES.check(mapped, 'ipv4') ? 'blocked' : 'public'
    }
  }
  // A public IP literal: DNS names were handled above, so nothing more to
  // resolve here.
  return 'public'
}

/**
 * Parse and check one connector-controlled URL.
 * @param rawUrl - the URL as the remote side supplied it.
 * @param what - the flow step naming the URL in the error (e.g. `MCP 端点`).
 * @param locale - locale for the error text (defaults to the product default).
 * @returns the parsed URL when it is allowed.
 * @throws {OutboundUrlBlockedError} when the URL is malformed or outside the policy.
 */
export function assertOutboundUrlAllowed(rawUrl: string, what: string, locale: HostLocale = DEFAULT_HOST_LOCALE): URL {
  // The step label and every sentence below are rendered HERE, from the locale
  // this call was given — never from a module-level constant.
  const label = stepLabel(locale, what)
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new OutboundUrlBlockedError(hostT(locale, 'outbound.notUrl', { what: label, url: rawUrl }))
  }
  const isHttps = parsed.protocol === 'https:'
  const isHttp = parsed.protocol === 'http:'
  if (!isHttps && !isHttp) {
    throw new OutboundUrlBlockedError(hostT(locale, 'outbound.notHttps', { what: label, target: `${parsed.protocol}//${parsed.host}` }))
  }
  // Credentials in the authority are never legitimate for a discovered
  // endpoint and are a classic way to make a hostile host look trustworthy.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new OutboundUrlBlockedError(hostT(locale, 'outbound.credentials', { what: label, target: parsed.host }))
  }
  const kind = classifyHost(parsed.hostname)
  if (kind === 'blocked') {
    throw new OutboundUrlBlockedError(hostT(locale, 'outbound.blocked', { what: label, target: parsed.host }))
  }
  if (isHttp && kind !== 'loopback') {
    throw new OutboundUrlBlockedError(hostT(locale, 'outbound.notLoopback', { what: label, target: parsed.host }))
  }
  if (kind === 'name' && parsed.hostname.toLowerCase().replace(/\.$/u, '') === osHostname().toLowerCase()) {
    // The local machine's own name resolves to a local interface in most
    // deployments; treat it as non-public rather than trusting DNS here.
    throw new OutboundUrlBlockedError(hostT(locale, 'outbound.localHostname', { what: label, target: parsed.host }))
  }
  return parsed
}

/**
 * Boolean form for call sites that validate a definition instead of performing
 * a request (the server catalog parser drops the entry on `false`).
 * @param rawUrl - candidate URL.
 * @returns true when {@link assertOutboundUrlAllowed} would accept it.
 */
export function isOutboundUrlAllowed(rawUrl: string): boolean {
  try {
    assertOutboundUrlAllowed(rawUrl, 'url')
    return true
  } catch {
    return false
  }
}

/**
 * Redirect policy every connector-controlled request must use (residual C).
 *
 * Checking the URL the plugin *asks* for is not enough: `fetch` follows
 * redirects by default, so an endpoint that passes the policy could answer
 * `307` with a `Location` the policy refuses and still receive the POST body —
 * the OAuth authorization code and the PKCE `code_verifier` included. Requests
 * therefore never follow a redirect: the URL that was checked is the only URL
 * that may receive the payload.
 */
const OUTBOUND_REDIRECT_POLICY = 'manual' as const

/**
 * Whether a response is a redirect this policy refused to follow. Node's
 * undici returns the real 3xx response for `redirect: 'manual'` (the
 * `opaqueredirect` filtered form of the browser spec has status 0), so both
 * shapes are recognized.
 * @param response - the response to classify.
 * @returns true for a redirect, or for an opaque redirect answer.
 */
function isRedirectResponse(response: Response): boolean {
  if (response.type === 'opaqueredirect') return true
  return response.status >= 300 && response.status < 400
}

/** Human-readable redirect detail for error messages (never echoes the body). */
function describeRedirect(response: Response): string {
  let location = ''
  try {
    location = response.headers.get('location') ?? ''
  } catch {
    location = ''
  }
  const status = response.status === 0 ? 'opaqueredirect' : String(response.status)
  const target = location === '' ? '' : ` -> ${location.slice(0, 200)}`
  return `${status}${target}`
}

/**
 * Fetch a connector-controlled URL with the outbound policy AND the redirect
 * fence applied in one place, so no call site can perform one without the
 * other.
 *
 * Every request also carries a deadline (conn-1): `init.signal` can only
 * SHORTEN it (the abort fires when either the caller's signal or the deadline
 * fires), never extend it, so a hung endpoint cannot park the caller's serial
 * lifecycle chain. A breach throws {@link OutboundTimeoutError} — the ordinary
 * failure path, so the caller reports it instead of silently continuing.
 * @param rawUrl - the URL as the remote side supplied it.
 * @param what - the flow step naming the URL in the error (e.g. `OAuth token 端点`).
 * @param init - request options; `redirect` is forced to `manual`.
 * @param options - deadline override (defaults to {@link OUTBOUND_REQUEST_TIMEOUT_MS})
 *   and the locale for this request's error text.
 * @returns the response, which is guaranteed not to be a redirect.
 * @throws {OutboundUrlBlockedError} when the URL is outside the policy or the
 *   remote side answered with a redirect.
 * @throws {OutboundTimeoutError} when the request outlived its deadline.
 */
export async function outboundFetch(
  rawUrl: string,
  what: string,
  init: RequestInit = {},
  options: OutboundFetchOptions = {},
): Promise<Response> {
  const locale = options.locale ?? DEFAULT_HOST_LOCALE
  const label = stepLabel(locale, what)
  const target = assertOutboundUrlAllowed(rawUrl, what, locale)
  const deadlineMs = options.timeoutMs ?? OUTBOUND_REQUEST_TIMEOUT_MS
  // `AbortSignal.timeout` answers a bare RangeError for these; name the option
  // instead so a misconfigured deployment sees what to fix.
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new RangeError(hostT(locale, 'outbound.badDeadline', { timeoutMs: String(deadlineMs) }))
  }
  const deadline = AbortSignal.timeout(deadlineMs)
  const caller = init.signal ?? null
  let response: Response
  try {
    response = await fetch(target, {
      ...init,
      redirect: OUTBOUND_REDIRECT_POLICY,
      signal: caller === null ? deadline : AbortSignal.any([caller, deadline]),
    })
  } catch (cause) {
    // A caller abort (user cancel, teardown) is that caller's own outcome and
    // keeps its own error; only the deadline becomes a deadline report.
    if (deadline.aborted && !(caller?.aborted ?? false)) {
      throw new OutboundTimeoutError(hostT(locale, 'outbound.timeout', {
        what: label,
        timeoutMs: String(deadlineMs),
        host: target.host,
      }))
    }
    throw cause
  }
  if (isRedirectResponse(response)) {
    throw new OutboundUrlBlockedError(
      hostT(locale, 'outbound.redirect', { what: label, detail: describeRedirect(response), host: target.host }),
    )
  }
  return response
}
