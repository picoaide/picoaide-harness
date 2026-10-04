/**
 * Which way a connector request leaves the process: **direct** (the pinned
 * transport) or **through the deployment's HTTP proxy** (P8, 2026-10-04).
 *
 * ## Why this module exists
 *
 * The client's product decision is "never use a proxy", with an escape hatch for
 * deployments whose only way to the internet is an authenticated proxy
 * (`docs/decisions/2026-09-22-client-system-proxy-ban.md`). Before the address
 * pinning landed, connector traffic went through the global `fetch`, i.e.
 * through whatever undici dispatcher the process had — and Node installs an
 * env-proxy dispatcher when `NODE_USE_ENV_PROXY` is on. Pinning replaced that
 * with a direct socket, which silently turned the escape hatch OFF for
 * connectors: in such a deployment every connector request went direct and could
 * not reach its endpoint at all.
 *
 * This module restores the routing decision by **reproducing the one undici made
 * before** (not by inventing a new switch):
 *
 *  1. `PICOAI_ALLOW_SYSTEM_PROXY` explicitly false ⇒ direct. It is the product's
 *     own switch (the same one `network-policy.ts` reads) and it is
 *     **bidirectional**: `0`/`false` means "no proxy", whatever the environment
 *     also says.
 *  2. otherwise, if `NODE_USE_ENV_PROXY` is on, Node would have used the
 *     environment proxy for this request — so a proxy URL for the scheme decides
 *     between proxy and direct (no URL = nothing to route through = direct, as
 *     before).
 *  3. otherwise direct (the default, and what undici did).
 *
 * Everything that cannot be read is a **refusal**, never a silent choice: a
 * proxy URL that does not parse or whose scheme this transport cannot tunnel
 * through throws {@link ConnectorProxyRouteError} instead of quietly going
 * direct or quietly using something else.
 *
 * ## What proxy mode costs (stated here because it is a security property)
 *
 * Through a CONNECT tunnel the name is resolved **by the proxy**. The address
 * pin cannot exist in that mode, so the local guarantees shrink to the ones that
 * do not need a resolution: protocol/credential rules, blocked literals,
 * metadata hostnames and reserved (`*.localhost`) names. See
 * `pinned-http.ts`'s `sendViaConnectProxy` and the residual section of
 * `temp/audit-v282/fixes/P8.md`.
 *
 * @module
 */

/**
 * The product's proxy escape hatch (name of `network-policy.ts`'s
 * `ALLOW_SYSTEM_PROXY_ENV`).
 *
 * Duplicated as a literal because this package must not import the desktop shell
 * (the dependency direction would be new). The duplication is held in place by
 * `tests/audit-1004-proxy-connect.spec.ts`, which READS
 * `packages/host/desktop/src/network-policy.ts` and fails if the name or the
 * truthiness rule drifts.
 */
export const ALLOW_SYSTEM_PROXY_ENV = 'PICOAI_ALLOW_SYSTEM_PROXY'

/** Node's "use the environment proxy" flag (name of `network-policy.ts`'s `NODE_ENV_PROXY_FLAG`). */
export const NODE_ENV_PROXY_FLAG = 'NODE_USE_ENV_PROXY'

/**
 * Proxy URL variables, per target scheme, in precedence order.
 *
 * `HTTPS_PROXY` deliberately does NOT fall back to `HTTP_PROXY` (curl semantics:
 * a proxy that speaks plain HTTP to the client is not automatically the right
 * egress for TLS traffic); `ALL_PROXY` is the documented general fallback.
 */
const PROXY_URL_NAMES: Readonly<Record<'http:' | 'https:', readonly string[]>> = {
  'https:': ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'],
  'http:': ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'],
}

/** Why a request goes direct (kept apart so a criterion can name the case). */
export type DirectRouteReason =
  /** No proxy is in play: the default. */
  | 'default'
  /** `PICOAI_ALLOW_SYSTEM_PROXY` is explicitly off. */
  | 'policy-off'
  /** Proxy use is enabled but no proxy URL is configured for this scheme. */
  | 'no-proxy-configured'
  /** `NO_PROXY` covers this host. */
  | 'no-proxy-match'
  /** Loopback targets never go through a proxy (a proxy cannot reach the client's own loopback). */
  | 'loopback'

/** The routing verdict for one request. */
export type ConnectorProxyRoute =
  | { readonly kind: 'direct'; readonly reason: DirectRouteReason }
  | { readonly kind: 'proxy'; readonly url: URL }

/**
 * Thrown when the proxy configuration cannot be read (unparsable URL, or a
 * scheme this transport cannot tunnel through). Fail-closed: the caller reports
 * it, it never becomes a silent direct connection.
 */
export class ConnectorProxyRouteError extends Error {
  /** Stable, locale-independent reason (diagnostics, not user copy). */
  readonly reason: string

  constructor(reason: string, message: string) {
    super(message)
    this.name = 'ConnectorProxyRouteError'
    this.reason = reason
  }
}

/**
 * Truthiness of one switch value, byte-for-byte the rule
 * `network-policy.ts`'s `isEnabledFlag` uses: empty, `0`, `false`, `no`, `off`
 * (trimmed, case-insensitive) are off; anything else non-empty is on.
 * @param value - the raw value.
 * @returns whether the switch is on.
 */
export function isEnabledSwitchValue(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false'
    && normalized !== 'no' && normalized !== 'off'
}

/** Read one variable by its canonical spelling and `process.env`'s lower-case twin. */
function readEnv(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  return env[name] ?? env[name.toLowerCase()]
}

/** Strip the WHATWG brackets around an IPv6 host and the FQDN root dot. */
function bareHost(hostname: string): string {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return bare.toLowerCase().replace(/\.$/u, '')
}

/**
 * Whether a URL host is a loopback target (literal or RFC 6761 reserved name).
 *
 * Loopback traffic is never proxied: a CONNECT proxy cannot reach the client's
 * own loopback, and every proxy convention (`NO_PROXY`, curl, undici) excludes
 * it. This is the transport's own copy of a notion the policy also has
 * (`outbound.ts`'s `classifyHost` returns `loopback`); the gate passes ITS
 * verdict in, so the two can only disagree on the transport's standalone path —
 * and `tests/audit-1004-proxy-connect.spec.ts` pins both paths to "direct".
 * @param hostname - `URL.hostname` (brackets allowed).
 * @returns true for loopback literals, `localhost` and `*.localhost`.
 */
export function isLoopbackTargetHost(hostname: string): boolean {
  const bare = bareHost(hostname)
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true
  if (bare === '::1') return true
  const mapped = bare.startsWith('::ffff:') ? bare.slice('::ffff:'.length) : bare
  const parts = mapped.split('.')
  if (parts.length !== 4) return false
  if (!parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)) return false
  return parts[0] === '127'
}

/**
 * Whether `NO_PROXY` covers one URL.
 *
 * Supported entry forms (the ones deployments actually write): `*`, a bare host
 * or `host:port`, a leading-dot domain (`.example.com`), and a plain domain that
 * also matches its subdomains. An entry with a port matches only that port. IP
 * literals match exactly; CIDR notation is deliberately NOT treated as a match
 * (an unparsed entry must not silently grant a bypass — an entry nobody
 * understands simply does not match, and the request goes through the proxy).
 * @param noProxy - the raw `NO_PROXY` value.
 * @param url - the target URL.
 * @returns true when the host must bypass the proxy.
 */
export function noProxyCovers(noProxy: string | undefined, url: URL): boolean {
  if (noProxy === undefined) return false
  const host = bareHost(url.hostname)
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  for (const rawEntry of noProxy.split(',')) {
    let entry = rawEntry.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    // `http://host` / `https://host` shapes: keep the host part only.
    const schemeSplit = entry.indexOf('://')
    if (schemeSplit >= 0) entry = entry.slice(schemeSplit + 3)
    entry = entry.replace(/\/.*$/u, '')
    let entryPort: string | undefined
    const portSplit = entry.lastIndexOf(':')
    if (portSplit > 0 && /^\d+$/u.test(entry.slice(portSplit + 1))) {
      entryPort = entry.slice(portSplit + 1)
      entry = entry.slice(0, portSplit)
    }
    // `[::1]` brackets, a FQDN root dot and the leading dot of `.example.com`
    // all describe the same entry.
    entry = entry.replace(/^\[/u, '').replace(/\]$/u, '').replace(/^\./u, '').replace(/\.$/u, '')
    if (entry === '') continue
    if (entryPort !== undefined && entryPort !== port) continue
    if (host === entry) return true
    // `.example.com` and `example.com` both cover `a.example.com`.
    if (host.endsWith(`.${entry}`)) return true
  }
  return false
}

/**
 * Decide how one connector request leaves the process.
 *
 * @param env - the process environment (read-only; `process.env` in production).
 * @param url - the policy-approved target URL.
 * @param options - `loopback` lets the CALLER (the gate, which already classified
 *   the host) state its verdict instead of this function re-deriving it.
 * @returns the route; `direct` carries the reason so a criterion can name it.
 * @throws {ConnectorProxyRouteError} when proxy use is in force and the
 *   configuration cannot be read (unparsable URL, unsupported scheme) — the
 *   request must fail loudly rather than pick a route nobody chose.
 */
export function resolveConnectorProxyRoute(
  env: Readonly<Record<string, string | undefined>>,
  url: URL,
  options: { loopback?: boolean | undefined } = {},
): ConnectorProxyRoute {
  const loopback = options.loopback ?? isLoopbackTargetHost(url.hostname)
  if (loopback) return { kind: 'direct', reason: 'loopback' }

  const allowSwitch = readEnv(env, ALLOW_SYSTEM_PROXY_ENV)
  if (allowSwitch !== undefined && !isEnabledSwitchValue(allowSwitch)) {
    return { kind: 'direct', reason: 'policy-off' }
  }
  const nodeEnvProxy = isEnabledSwitchValue(readEnv(env, NODE_ENV_PROXY_FLAG))
  // The product switch alone is not a route: it only says a proxy MAY be used.
  // What made the pre-pinning code go through a proxy is Node's env-proxy agent,
  // i.e. this flag. Anything else was direct then and stays direct now.
  if (!nodeEnvProxy) return { kind: 'direct', reason: 'default' }

  const scheme = url.protocol === 'http:' ? 'http:' : 'https:'
  let raw: string | undefined
  for (const name of PROXY_URL_NAMES[scheme]) {
    const value = env[name]
    if (value !== undefined && value.trim() !== '') {
      raw = value
      break
    }
  }
  if (raw === undefined) return { kind: 'direct', reason: 'no-proxy-configured' }
  if (noProxyCovers(readEnv(env, 'NO_PROXY'), url)) return { kind: 'direct', reason: 'no-proxy-match' }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ConnectorProxyRouteError('proxy-url-unparsable', `connector proxy URL for ${scheme} is not a URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // No silent fallback to direct: a deployment that names a SOCKS/other proxy
    // must be told that this transport cannot tunnel through it.
    throw new ConnectorProxyRouteError(
      'proxy-scheme-unsupported',
      `connector proxy URL scheme ${parsed.protocol} is not supported (only http: and https: CONNECT proxies)`,
    )
  }
  if (parsed.hostname === '') {
    throw new ConnectorProxyRouteError('proxy-host-missing', 'connector proxy URL has no host')
  }
  return { kind: 'proxy', url: parsed }
}
