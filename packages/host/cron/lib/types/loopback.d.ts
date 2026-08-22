/**
 * Loopback trust fence for the cron API routes: socket address, Host header,
 * and browser same-origin markers. Ported from dsh-web-ui shared/host
 * (Apache-2.0); the socket address is authoritative and X-Forwarded-For is
 * never trusted.
 */
import type { IncomingMessage } from 'node:http';
/** IPv4 127/8 predicate (four decimal octets, first == 127). */
export declare function isIPv4Loopback(v4: string): boolean;
/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
export declare function isLoopbackAddress(address: string | undefined): boolean;
/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
export declare function isLoopbackHostname(hostname: string): boolean;
/**
 * Request-level trust fence: a loopback socket address AND a loopback Host
 * header, plus browser same-origin markers.
 */
export declare function isLoopbackRequest(request: IncomingMessage): boolean;
/**
 * Browser-signal tripwire, NOT an authority check: a bare curl sends neither
 * header and is refused, but a curl with a forged Origin passes this too.
 * The real boundary is the loopback socket + Host + origin-equality checks
 * in isLoopbackRequest; do not rely on this marker alone.
 */
export declare function browserSameOriginMarker(req: IncomingMessage): boolean;
