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

/** Thrown when a connector-controlled URL is outside the allowed outbound set. */
export class OutboundUrlBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutboundUrlBlockedError'
  }
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
  const bare = bareHostname(hostname).toLowerCase()
  const family = isIP(bare)
  if (family === 0) return METADATA_HOSTNAMES.has(bare) ? 'blocked' : 'name'
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
 * @returns the parsed URL when it is allowed.
 * @throws {OutboundUrlBlockedError} when the URL is malformed or outside the policy.
 */
export function assertOutboundUrlAllowed(rawUrl: string, what: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new OutboundUrlBlockedError(`${what} 不是合法 URL: ${rawUrl}`)
  }
  const isHttps = parsed.protocol === 'https:'
  const isHttp = parsed.protocol === 'http:'
  if (!isHttps && !isHttp) {
    throw new OutboundUrlBlockedError(`${what} 只允许 https（或本地回环 http）: ${parsed.protocol}//${parsed.host}`)
  }
  // Credentials in the authority are never legitimate for a discovered
  // endpoint and are a classic way to make a hostile host look trustworthy.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new OutboundUrlBlockedError(`${what} 不允许在 URL 中携带用户名/密码: ${parsed.host}`)
  }
  const kind = classifyHost(parsed.hostname)
  if (kind === 'blocked') {
    throw new OutboundUrlBlockedError(`${what} 指向内网/链路本地/元数据地址，已拒绝: ${parsed.host}`)
  }
  if (isHttp && kind !== 'loopback') {
    throw new OutboundUrlBlockedError(`${what} 使用 http 但主机不是回环地址: ${parsed.host}`)
  }
  if (kind === 'name' && parsed.hostname.toLowerCase() === osHostname().toLowerCase()) {
    // The local machine's own name resolves to a local interface in most
    // deployments; treat it as non-public rather than trusting DNS here.
    throw new OutboundUrlBlockedError(`${what} 指向本机主机名，已拒绝: ${parsed.host}`)
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
