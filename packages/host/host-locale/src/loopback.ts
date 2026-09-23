/**
 * Loopback trust fence for the host-side local API routes: socket address,
 * Host header, and browser same-origin markers. The socket address is
 * authoritative and X-Forwarded-For is never trusted. Every local route must
 * pass `isLoopbackRequest` before serving; state-changing endpoints
 * additionally require an explicit HTTP method (see the route handlers).
 *
 * 2026-09-23：本文件是**唯一实现**。此前 `packages/host/{connectors,enterprise,
 * browser,cron}/src/loopback.ts` 各持一份（connectors ≡ enterprise 逐字节相同，
 * browser 只差 3 个 `export` 关键字，cron 只差注释），四份互为独立实现意味着
 * 「一处收紧、其余三处不跟」——对信任边界，这种漂移是不对称的。四个包现在各自
 * 保留 `src/loopback.ts` 作为**同名 re-export**（对外子路径与导出面不变；
 * `@picoaide/dsh-enterprise/loopback` 是 `packages/client/account-card` 在消费的
 * 外部契约）。改判定请只改本文件。
 *
 * 出处署名：设计移植自 dsh-web-ui `shared/host`（Apache-2.0）。
 */
import type { IncomingMessage } from 'node:http'

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
export function isIPv4Loopback(v4: string): boolean {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level trust fence: a loopback socket address AND a loopback Host
 * header, plus browser same-origin markers. A bare curl from the same host
 * passes the socket/Host checks; a cross-site browser request is refused.
 */
export function isLoopbackRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Browser-signal tripwire, NOT an authority check: a bare curl sends neither
 * header and is refused, but a curl with a forged Origin passes this too.
 * The real boundary is the loopback socket + Host + origin-equality checks
 * in isLoopbackRequest; do not rely on this marker alone.
 */
export function browserSameOriginMarker(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site === 'same-origin' || typeof req.headers.origin === 'string'
}
