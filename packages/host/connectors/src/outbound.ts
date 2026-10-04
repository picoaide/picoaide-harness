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
 * CN-9 adds the third: a NAME has to be resolved before it can be judged
 * ({@link resolveOutboundTarget}), and since C3-06 (2026-10-04) a name whose
 * resolution cannot be VERIFIED (resolver error, resolution deadline, empty
 * answer) is refused exactly like a name that resolves into a non-public range
 * — the two are reported apart, but neither is a pass.
 *
 * The fourth is the one that closes the TOCTOU the third left open: the verdict
 * is not an opinion about an answer somebody else will fetch again — it IS the
 * connection's input. {@link resolveOutboundTarget} returns the verified
 * addresses with the URL, and {@link sendPinned} dials exactly those, with the
 * NAME kept for the request line, the `Host` header and TLS (`servername`), so
 * certificate verification stays an ordinary hostname check. There is no second
 * resolution on any connector outbound path, and no path that falls back to the
 * system resolver: an empty or unusable pin is a refusal.
 *
 * The fifth (P8, 2026-10-04) is the deployment's proxy escape hatch. The client
 * bans proxies by default but lets a deployment enable them
 * (`docs/decisions/2026-09-22-client-system-proxy-ban.md`); pinning replaced the
 * global `fetch`, which had silently turned that hatch off for connectors. The
 * route is therefore decided in the SAME judgement ({@link resolveOutboundTarget}
 * calls `resolveConnectorProxyRoute` and carries the verdict on the target):
 *  - **direct** (the default) — unchanged: resolve, verify, pin, fail-closed;
 *  - **proxy** — the local resolution is SKIPPED (the proxy resolves the name,
 *    so a local lookup would decide nothing) and the syntax verdict is all this
 *    layer guarantees; the transport tunnels via HTTP CONNECT and says so once
 *    in the log. An unreadable proxy configuration is a refusal, never a silent
 *    choice of route.
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
import { lookup as lookupHostname } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { hostname as osHostname } from 'node:os'
import { DEFAULT_HOST_LOCALE, hostT, stepLabel, type HostLocale } from './host-copy.ts'
import { sendPinned, type OutboundTarget } from './pinned-http.ts'
import { resolveConnectorProxyRoute } from './proxy-route.ts'

export type { OutboundTarget }

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
export class OutboundTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutboundTimeoutError'
  }
}

/**
 * Stable, locale-independent reasons of
 * {@link OutboundResolutionUnverifiedError} (audit C3-06).
 *
 * `resolution-failed` = the resolver answered with an error; `resolution-timeout`
 * = it did not answer inside {@link OUTBOUND_RESOLUTION_TIMEOUT_MS};
 * `resolution-empty` = it answered without a single address;
 * `resolution-malformed` = it answered with something that is not a readable list
 * of address literals (not a list at all, a non-string entry, or a string that
 * is not an IP). All four mean the same thing to the policy (the address class
 * is UNKNOWN) but a different thing to whoever has to fix the deployment, so the
 * code travels with the error.
 *
 * `resolution-malformed` deliberately gets its own code instead of reusing
 * `resolution-failed`: nothing FAILED — an answer arrived and the gate could not
 * read it — and instead of the closest existing code (`resolution-empty`, "the
 * answer carried no usable entry") it stays separate because the two have
 * different owners (an empty answer is a DNS/deployment answer, a malformed one
 * is the seam contract being broken). It must never be reported as a BLOCKED
 * ADDRESS either: the pre-fix gate fed unreadable entries to
 * {@link isBlockedResolvedAddress}, whose fail-closed `isIP === 0 ⇒ true` turned
 * `['not-an-ip']` into "你的域名解析到内网地址" — a verdict about the target that
 * the policy never actually reached (audit C3-06 gap ②, 2026-10-04).
 */
export const OUTBOUND_RESOLUTION_CODES = [
  'resolution-failed',
  'resolution-timeout',
  'resolution-empty',
  'resolution-malformed',
] as const

/** One stable reason code of {@link OutboundResolutionUnverifiedError}. */
export type OutboundResolutionCode = (typeof OUTBOUND_RESOLUTION_CODES)[number]

/**
 * Thrown when the resolution gate could **not verify** what a NAME resolves to
 * (audit C3-06, 2026-10-04).
 *
 * Deliberately NOT an {@link OutboundUrlBlockedError}: that one is a verdict
 * about the target ("this address is non-public"), while this one is a failure
 * to OBTAIN the facts. Both refuse the request — since C3-06 "could not verify"
 * is never a pass — but they must stay tellable apart:
 *  - the messages name different causes (`outbound.blockedResolved` vs
 *    `outbound.resolutionFailed|Timeout|Empty`), so a user reading the connector
 *    row knows whether to fix their DNS or their URL;
 *  - `auth.ts`'s `isClassifiedStepFailure` deliberately classifies only the
 *    former as "authorize again". Clearing a DNS hiccup by telling the user to
 *    re-authorize is the exact misdiagnosis that rule was narrowed for
 *    (2026-09-16 R2 audit), so an unverified NAME must not ride in on it.
 */
export class OutboundResolutionUnverifiedError extends Error {
  /** Stable, locale-independent reason this verification failed. */
  readonly code: OutboundResolutionCode

  constructor(code: OutboundResolutionCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OutboundResolutionUnverifiedError'
    this.code = code
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
  /**
   * Test seam for the resolution gate (CN-9): how a hostname is resolved. The
   * plugin never sets it — a definition must not be able to replace the
   * resolver the policy judges with.
   */
  resolve?: OutboundHostResolver
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
  //
  // C3-07 (2026-10-04 audit) added the four siblings of `64:ff9b::/96` that the
  // v2.8.1 list missed — every one of them carries or reaches a non-public
  // address while looking like an ordinary global unicast literal:
  //   - `2002::/16` (6to4, RFC 3056) wraps the IPv4 GATEWAY in bits 16–47, so
  //     `2002:7f00:1::` reaches 127.0.0.1 and `2002:a9fe:a9fe::` reaches
  //     169.254.169.254; deprecated by RFC 7526.
  //   - `2001::/32` (Teredo, RFC 4380) wraps the Teredo server IPv4 at bits
  //     32–63 and the client IPv4 (bitwise-complemented) in the last 32 bits.
  //   - `64:ff9b:1::/48` (local-use NAT64, RFC 8215) is the private sibling of
  //     the well-known `64:ff9b::/96` already refused above.
  //   - `fec0::/10` (site-local, deprecated by RFC 3879) is the fixed-address
  //     ancestor of `fc00::/7`.
  // Verdict口径 for all four is "refuse the whole prefix", i.e. exactly what
  // `64:ff9b::/96` has done since v2.8.1, and for the same reason: the prefix
  // exists to WRAP an IPv4 address, so "which address does this reach" is
  // decided by an embedded field, not by the prefix. Decoding that field would
  // let `2002:0808:0808::` through (a public IPv4) while the gate's real answer
  // — "this name reaches a host only through a transition mechanism the policy
  // cannot observe" — stays unknown; it would also add an IPv6 bit-parser to a
  // security verdict. The availability cost is nil in this product's surface:
  // 6to4/Teredo are deprecated transition mechanisms (Windows 10 removed 6to4),
  // `fec0::/10` is deprecated, and DNS64/NAT64 networks already have every
  // translated name refused by `64:ff9b::/96`.
  for (const [network, prefix] of [
    ['::', 128],
    ['2001::', 32],
    ['2002::', 16],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
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

/**
 * Address ranges a **resolved DNS name** may not map onto (CN-9, audit
 * 2026-09-23).
 *
 * Deliberately narrower than {@link BLOCKED_ADDRESSES}: the syntax list also
 * refuses the documentation / benchmarking ranges because they can never carry
 * a real service, while a NAME that resolves into them is a legitimate
 * deployment shape. `198.18.0.0/15` is the standard fake-IP range of
 * transparent proxies (Clash/TUN, and this project's own development box) —
 * refusing it by name would break every connector for a customer running one,
 * while the syntax rule for a literal in that range stays in force. Everything
 * that can reach a real non-public service (loopback, unspecified, private,
 * link-local/metadata, CGNAT, multicast, reserved) is refused.
 *
 * C3-07: the IPv6 transition/translation siblings added to
 * {@link buildBlockedList} are refused here too — a NAME resolving into
 * `2002::/16`, `2001::/32`, `64:ff9b:1::/48` or `fec0::/10` reaches the same
 * wrapped non-public address as its literal spelling, and whichever of the two
 * spellings a hostile definition uses is not a distinction the policy may make.
 * The口径 (why the whole prefix instead of decoding the embedded IPv4) is
 * written once, on `buildBlockedList`.
 */
function buildResolvedNameBlockedList(): BlockList {
  const list = new BlockList()
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    list.addSubnet(network, prefix, 'ipv4')
  }
  for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['2001::', 32],
    ['2002::', 16],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ] as const) {
    list.addSubnet(network, prefix, 'ipv6')
  }
  return list
}

const RESOLVED_NAME_BLOCKED = buildResolvedNameBlockedList()

/**
 * Whether one resolved address may NOT be connected to for a DNS-named host.
 *
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) reaches the IPv4 stack, so the embedded
 * address is re-checked exactly like {@link classifyHost} does for literals.
 *
 * A value that is not an IP literal at all is `true` (fail-CLOSED) for direct
 * callers. The gate does not lean on that default for its verdict: it classifies
 * an unreadable answer shape as `resolution-malformed` BEFORE calling this, so
 * the refusal names the real cause instead of pretending the target resolved
 * into a non-public range.
 * @param address - one address as the resolver returned it.
 * @returns true when the address is non-public enough to refuse.
 */
export function isBlockedResolvedAddress(address: string): boolean {
  const bare = bareHostname(address.trim()).toLowerCase()
  const family = isIP(bare)
  if (family === 0) return true
  const type = family === 4 ? 'ipv4' : 'ipv6'
  if (RESOLVED_NAME_BLOCKED.check(bare, type)) return true
  if (type === 'ipv6' && bare.startsWith('::ffff:')) {
    const mapped = bare.slice('::ffff:'.length)
    if (isIP(mapped) === 4) return RESOLVED_NAME_BLOCKED.check(mapped, 'ipv4')
  }
  return false
}

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
 * Deadline of the policy's OWN name resolution.
 *
 * A resolver that never answers must not park the request: the request keeps
 * its own deadline ({@link OUTBOUND_REQUEST_TIMEOUT_MS}) and reports a timeout
 * from there. A breach of THIS budget means "could not verify" — which since
 * C3-06 is a REFUSAL ({@link OutboundResolutionUnverifiedError}), not a pass.
 *
 * Magnitude is part of the contract (audit C3-06 gap ①, 2026-10-04): the gate
 * runs BEFORE the request's own deadline starts (`outboundFetch` resolves the
 * name first, then arms `AbortSignal.timeout`), and it runs on the same serial
 * plugin lifecycle chain (boot restore / logout / user switch) that conn-1 was
 * about — so this budget cannot be allowed to converge with, let alone exceed,
 * one request deadline. Concretely: at most half of
 * `OUTBOUND_REQUEST_TIMEOUT_MS` and at most 10 s. Widening it to "an hour"
 * would park exactly the chain this deadline exists to protect, which is why
 * `tests/audit-1004-outbound-resolution-gate.spec.ts` pins both the ratio and
 * the ceiling against the constants themselves (and proves the DEFAULT budget
 * really fires without any `timeoutMs` override).
 */
export const OUTBOUND_RESOLUTION_TIMEOUT_MS = 5_000

/** Test seam: how the policy resolves a hostname (defaults to `dns.lookup`). */
export type OutboundHostResolver = (hostname: string) => Promise<readonly string[]>

const defaultHostResolver: OutboundHostResolver = async (hostname) => {
  const answers = await lookupHostname(hostname, { all: true, verbatim: true })
  return answers.map(answer => answer.address)
}

/**
 * Whether one entry of a resolver answer is an address literal the policy can
 * judge: a string that `isIP` accepts once trimmed (the same normalization
 * {@link isBlockedResolvedAddress} applies).
 *
 * Deliberately NOT "anything {@link isBlockedResolvedAddress} can survive":
 * that predicate answers fail-closed `true` for unreadable input, so a shape
 * gate built on it could only report "blocked", never "unreadable".
 */
function isAddressLiteralEntry(entry: unknown): entry is string {
  return typeof entry === 'string' && isIP(entry.trim()) !== 0
}

/**
 * Bounded, throw-free description of a resolver answer (or one entry of it) for
 * the `resolution-malformed` message. Never echoes more than a few characters
 * of caller-controlled data, and never calls a method that may not exist.
 */
function describeResolutionAnswer(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'string') return `string "${value.slice(0, 60)}"`
  return typeof value
}

/** Internal sentinel: the gate's own resolution deadline fired (not a resolver error). */
class ResolutionDeadlineExceededError extends Error {}

async function withResolutionDeadline<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ResolutionDeadlineExceededError('outbound resolution deadline exceeded')),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Addresses a loopback NAME (`localhost`, `*.localhost`) is pinned to.
 *
 * The policy classifies these names as loopback by the RFC 6761 reservation
 * without resolving them (the enterprise guard does the same), which used to
 * mean the CONNECTION could still resolve them — and `*.localhost` is only
 * loopback if the resolver says so: with `hosts: files dns` and nothing in
 * `/etc/hosts`, a hostile or intercepted resolver answers `evil.localhost` with
 * anything, including `169.254.169.254`. Pinning the reserved names to loopback
 * makes the syntax verdict true by construction. Both families are offered so a
 * local server listening on either one is still reached.
 */
const LOOPBACK_PIN_ADDRESSES: readonly string[] = ['127.0.0.1', '::1']

/**
 * Resolve one connector-controlled URL and return the addresses it may connect
 * to — the single judgement point of the outbound policy.
 *
 * {@link assertOutboundUrlAllowed} is a pure-syntax verdict: a DNS name is
 * `name` and an `https` name is allowed, so `https://attacker.example/` that
 * resolves to `169.254.169.254`, to a `10/8` service or to loopback passed every
 * rule above. This is the resolution half of the policy, called by
 * {@link outboundFetch} and by the MCP transport fence before a request leaves
 * the process.
 *
 * The returned addresses are the pin: the callers hand the whole
 * {@link OutboundTarget} to `sendPinned`, so the connection cannot resolve the
 * name a second time (DNS rebinding TOCTOU, closed 2026-10-04; the previous
 * revision resolved for the verdict and then let `fetch`/undici resolve again).
 *
 * Fail-CLOSED (C3-06, 2026-10-04 audit): "could not verify" is a refusal.
 * Nothing downstream re-checks the address class, so the pre-fix `catch { return }`
 * let a hostile name through exactly when its DNS made THIS query fail or run
 * late (the attacker's own resolver decides). The four unverifiable shapes
 * (resolver error, resolution deadline, empty answer, unreadable answer shape)
 * now throw {@link OutboundResolutionUnverifiedError} with a stable `code`,
 * which is a different error class from the "resolution succeeded and the
 * address is non-public" verdict ({@link OutboundUrlBlockedError}) so the two
 * are distinguishable by message, by class and by code.
 *
 * Fast paths kept (they are verdicts, not "could not verify"): an IP literal is
 * pinned to itself, and `localhost`/`*.localhost` is pinned to loopback — see
 * {@link LOOPBACK_PIN_ADDRESSES}. Every other name is resolved on every call —
 * there is no positive cache, and this change does not add one.
 * @param rawUrl - the URL as the remote side supplied it.
 * @param what - the flow step naming the URL in the error (e.g. `MCP 端点`).
 * @param locale - locale for the error text (defaults to the product default).
 * @param options - resolution seam and deadline (tests inject a resolver so the
 *   verdict never depends on the runner's DNS).
 * @returns the parsed, policy-approved URL, the addresses it may connect to
 *   (never empty in direct mode, always IP literals; deliberately empty in proxy
 *   mode, where the proxy resolves the name) and the route the transport must
 *   take.
 * @throws {OutboundUrlBlockedError} when the URL is malformed, outside the
 *   syntax policy or resolving onto a non-public address.
 * @throws {OutboundResolutionUnverifiedError} when the name's addresses could
 *   not be established (resolver error, deadline, empty answer) or the answer
 *   could not be read as a list of address literals (`resolution-malformed`).
 */
export async function resolveOutboundTarget(
  rawUrl: string,
  what: string,
  locale: HostLocale = DEFAULT_HOST_LOCALE,
  options: { resolve?: OutboundHostResolver | undefined; timeoutMs?: number | undefined } = {},
): Promise<OutboundTarget> {
  const url = assertOutboundUrlAllowed(rawUrl, what, locale)
  const bare = bareHostname(url.hostname).toLowerCase().replace(/\.$/u, '')
  // The route is part of the judgement, not a transport detail: it is decided
  // here, carried on the target, and used by `sendPinned` — so a request cannot
  // be judged direct and then leave through a proxy (or the other way round).
  // `classifyHost` already knows the loopback verdict; pass it in rather than
  // re-deriving it.
  const route = resolveConnectorProxyRoute(process.env, url, { loopback: classifyHost(url.hostname) === 'loopback' })
  if (route.kind === 'proxy') {
    // Proxy mode: the proxy resolves the name, so a local answer would not be
    // the address the connection uses and pinning it would be a fiction. The
    // syntax verdict above (protocol, credentials, blocked literals, metadata
    // hostnames, reserved names) is what remains — stated once in the log by the
    // transport, and in the residual section of temp/audit-v282/fixes/P8.md.
    return { url, addresses: [], route }
  }
  if (isIP(bare) !== 0) return { url, addresses: [bare], route }
  if (isLoopbackLiteral(bare)) return { url, addresses: LOOPBACK_PIN_ADDRESSES, route }
  const resolve = options.resolve ?? defaultHostResolver
  const budgetMs = options.timeoutMs ?? OUTBOUND_RESOLUTION_TIMEOUT_MS
  const label = stepLabel(locale, what)
  let addresses: readonly string[]
  try {
    addresses = await withResolutionDeadline(Promise.resolve(resolve(bare)), budgetMs)
  } catch (cause) {
    if (cause instanceof ResolutionDeadlineExceededError) {
      throw new OutboundResolutionUnverifiedError('resolution-timeout', hostT(locale, 'outbound.resolutionTimeout', {
        what: label,
        target: url.host,
        timeoutMs: String(budgetMs),
      }), { cause })
    }
    throw new OutboundResolutionUnverifiedError('resolution-failed', hostT(locale, 'outbound.resolutionFailed', {
      what: label,
      target: url.host,
      reason: (cause instanceof Error ? cause.message : String(cause)).slice(0, 200),
    }), { cause })
  }
  // Shape gate (C3-06 gap ②, 2026-10-04). The seam is TYPED `readonly string[]`
  // but a runtime answer can be anything, and before this gate the two illegal
  // shapes had no semantics of their own: a non-string entry (`[undefined]`,
  // `[123]`, `[{address,family}]`) crashed out of `isBlockedResolvedAddress` as a
  // bare `TypeError` (`address.trim is not a function`), and a string that is not
  // an IP (`['not-an-ip']`) rode the predicate's fail-closed default into the
  // "resolves to a non-public address" verdict — a target verdict for facts the
  // policy never obtained. Both are "could not verify", so both are refused here
  // with their own code, in the same family as empty/failed. Nothing is fetched.
  //
  // The "is it even a list" half comes FIRST: `addresses.length` below is the
  // first thing that would throw on `undefined`/`null`.
  const answer: unknown = addresses
  if (!Array.isArray(answer)) {
    throw new OutboundResolutionUnverifiedError('resolution-malformed', hostT(locale, 'outbound.resolutionMalformed', {
      what: label,
      target: url.host,
      detail: describeResolutionAnswer(answer),
    }))
  }
  if (addresses.length === 0) {
    // An answer with no address verifies nothing; treat it like a failure to
    // answer rather than like "no non-public address was found".
    throw new OutboundResolutionUnverifiedError('resolution-empty', hostT(locale, 'outbound.resolutionEmpty', {
      what: label,
      target: url.host,
    }))
  }
  const malformedIndex = answer.findIndex((entry: unknown) => !isAddressLiteralEntry(entry))
  if (malformedIndex >= 0) {
    throw new OutboundResolutionUnverifiedError('resolution-malformed', hostT(locale, 'outbound.resolutionMalformed', {
      what: label,
      target: url.host,
      detail: `[${malformedIndex}] ${describeResolutionAnswer(answer[malformedIndex])}`,
    }))
  }
  const blocked = addresses.find(address => isBlockedResolvedAddress(address))
  if (blocked === undefined) return { url, addresses, route }
  throw new OutboundUrlBlockedError(hostT(locale, 'outbound.blockedResolved', {
    what: label,
    target: url.host,
    address: blocked,
  }))
}

/**
 * Verdict-only form of {@link resolveOutboundTarget}: same gate, same refusals,
 * pin discarded.
 *
 * Kept for call sites and criteria that only need "is this URL allowed" (the
 * address pin matters to whoever performs the request, and every such caller
 * uses {@link resolveOutboundTarget} so it can hand the pin to `sendPinned`).
 * @param url - the parsed, syntax-approved URL.
 * @param what - the flow step naming the URL in the error.
 * @param locale - locale for the error text.
 * @param options - resolution seam and deadline.
 */
export async function assertResolvedOutboundAddressAllowed(
  url: URL,
  what: string,
  locale: HostLocale = DEFAULT_HOST_LOCALE,
  options: { resolve?: OutboundHostResolver | undefined; timeoutMs?: number | undefined } = {},
): Promise<void> {
  await resolveOutboundTarget(url.href, what, locale, options)
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
 * Marker behind which a value carries the outbound origins it may reach.
 *
 * The MCP transport fence cannot know which connector a live transport belongs
 * to, and the SDK's 401 path follows URLs handed out by the RESOURCE server
 * (`WWW-Authenticate: resource_metadata`, then `authorization_servers[0]`).
 * The only component that knows the policy-checked authorization-server facts
 * is the OAuth provider, so the provider attaches them to itself
 * ({@link attachOutboundOrigins}) and the fence reads them back off the
 * transport's provider slot — `_oauthProvider` when the SDK adapted an OAuth
 * provider, `_authProvider` for the `AuthProvider` face the production
 * construction passes ({@link allowedOutboundOriginsOf}). A `Symbol` keeps
 * this out of the provider's public shape and out of JSON.
 */
export const OUTBOUND_ALLOWED_ORIGINS = Symbol('picoaide.connectors.outbound.allowed-origins')

/** The origin of one URL, or null when it does not parse. */
export function originOfUrl(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

/**
 * Attach the outbound origins `target` is allowed to reach besides its own.
 *
 * Origins that do not parse are dropped (the caller passes definition- or
 * discovery-supplied spellings); duplicates collapse.
 * @param target - the object to tag (the OAuth provider).
 * @param origins - candidate URLs/origins.
 * @returns the same object, for chaining.
 */
export function attachOutboundOrigins<T extends object>(
  target: T,
  origins: Iterable<string | undefined | null>,
): T {
  const allowed = new Set<string>()
  for (const candidate of origins) {
    const origin = originOfUrl(candidate)
    if (origin !== null) allowed.add(origin)
  }
  Object.defineProperty(target, OUTBOUND_ALLOWED_ORIGINS, { value: allowed, enumerable: false })
  return target
}

/**
 * The origins attached by {@link attachOutboundOrigins}, or null when the value
 * carries none (an unknown/foreign provider): callers then fall back to the
 * general policy instead of pretending to know a scope.
 * @param value - the provider (or anything).
 * @returns the origin set, or null.
 */
export function allowedOutboundOriginsOf(value: unknown): ReadonlySet<string> | null {
  if (typeof value !== 'object' || value === null) return null
  const attached = (value as { [OUTBOUND_ALLOWED_ORIGINS]?: unknown })[OUTBOUND_ALLOWED_ORIGINS]
  return attached instanceof Set ? attached : null
}

/**
 * Fetch a connector-controlled URL with the outbound policy AND the redirect
 * fence applied in one place, so no call site can perform one without the
 * other.
 *
 * The request is performed by {@link sendPinned} against the addresses
 * {@link resolveOutboundTarget} verified — the same judgement, used, instead of
 * a verdict something else re-resolves. `redirect: 'manual'` stays part of the
 * contract even though the pinned transport has no redirect logic: the policy
 * is stated in one place, and a future transport change cannot silently
 * reintroduce following.
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
  // CN-9 + pinning: the syntax verdict cannot see what a NAME resolves to, so
  // the resolution gate runs before any byte of the request leaves the process —
  // and its answer is what the connection uses.
  const target = await resolveOutboundTarget(
    rawUrl,
    what,
    locale,
    options.resolve === undefined ? {} : { resolve: options.resolve },
  )
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
    response = await sendPinned(target, {
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
        host: target.url.host,
      }))
    }
    throw cause
  }
  if (isRedirectResponse(response)) {
    throw new OutboundUrlBlockedError(
      hostT(locale, 'outbound.redirect', { what: label, detail: describeRedirect(response), host: target.url.host }),
    )
  }
  return response
}
