/**
 * Outbound redirect fence for the MCP **streamable-http** transport (audit R3,
 * residual N3 / high; audit R5: the GET(SSE) channel was still unfenced).
 *
 * `outbound.ts` fences every URL *this* package fetches, but the MCP channel is
 * not fetched here: the connector hands `{ url, headers }` to
 * `@deepseek-ai/dsh-mcp-client`, which builds its own
 * `StreamableHTTPClientTransport` and therefore uses the SDK's own `fetch`.
 * `requestInit` from that construction carries no `redirect`, so `fetch`
 * followed a 3xx by default and the whole MCP channel — the `initialize`
 * request, every rendered credential header (`X-Api-Key: ${API_KEY}`, the
 * framework's `Authorization: Bearer …`) and the tool list — moved to whatever
 * host the first answer named, including hosts `isOutboundUrlAllowed()` refuses
 * as an initial URL.
 *
 * The SDK gives no configuration seam for this (`createTransport` in the
 * installed `dsh-mcp-client` build passes only `requestInit: { headers }` and —
 * since 0.1.6 — an optional `authProvider`), so the fence is installed on the
 * transport CLASS before any instance exists.
 *
 * ## The second half: the outbound URL policy (audit 2026-09-23, CN-1)
 *
 * A redirect fence alone left the seam half hard-wired: the wrapper received
 * the URL and threw it away, so any request the SDK decided to make — including
 * the one a 401 names in `WWW-Authenticate: Bearer resource_metadata="…"` — was
 * really performed, carrying the transport's `requestInit` headers (the
 * connector's `Authorization: Bearer <access_token>` or its static API key), no
 * matter what `outbound.ts` thought of that URL. Measured, not inferred: a
 * resource metadata URL the policy REFUSED (`0.0.0.0/8`) received a real GET
 * with the connector's headers on it.
 *
 * Every request through {@link createMcpOutboundFetch} now passes four gates:
 * the outbound URL policy (`assertOutboundUrlAllowed`, the same function
 * `auth.ts` uses for our own discovery chain), the DNS resolution gate
 * (`CN-9`), an origin scope registered by the connector's OAuth provider (so
 * the resource server cannot steer the flow to a host the definition never
 * named), and header hygiene (the connector's baked credential headers stay on
 * the transport's own origin). A refusal throws
 * {@link OutboundUrlBlockedError} — fail-loud, never a silent downgrade — and
 * the behavioural verification below proves each gate is live before the fence
 * reports itself installed.
 *
 * ## How the fence is installed, and why it changed in SDK v2
 *
 * Until upstream 0.1.5 the SDK's transport kept `_requestInit` / `_fetch` /
 * `_fetchWithInit` as plain constructor assignments, so three prototype
 * ACCESSORS intercepted every write and could force `redirect: 'manual'` on
 * every instance. `@modelcontextprotocol/client@2.0.0` declares them as class
 * fields (`dist/index.mjs:4947-4952`), i.e. every instance gets OWN data
 * properties that shadow a prototype accessor — measured, not inferred:
 *
 * ```text
 * node -e "…new StreamableHTTPClientTransport(u,o)…"
 * _requestInit own? true proto get? false
 * _fetch       own? true proto get? false
 * _fetchWithInit own? true proto get? false
 * ```
 *
 * An accessor fence on that shape patches nothing while still reporting
 * "installed" — precisely the silent failure this module exists to prevent. The
 * v2 fence therefore hardens the INSTANCE, the one place v2 still lets us
 * write: the outbound entry points (`start`, `send`, `terminateSession`,
 * `resumeStream`, `finishAuth`) are wrapped so that, before delegating, they
 * rewrite that instance's own fields —
 *
 *  - `_requestInit` ← `{…init, redirect: 'manual'}` (every POST/DELETE spread),
 *  - `_fetch`        ← forced-manual wrapper (POST/DELETE and the `GET`/SSE path),
 *  - `_fetchWithInit`← forced-manual wrapper (the OAuth/auth-provider calls).
 *
 * The rewrite is durable (a symbol marks a hardened instance) and happens before
 * the SDK reads anything, so the fire-and-forget SSE open, the reconnection
 * timer and the 401/auth retries all use the hardened fields as well. The
 * `_fetch` fallback matters for the production construction, which passes NO
 * `fetch`: `(this._fetch ?? fetch)` must resolve to OUR wrapper, never to the
 * global fetch's follow default.
 *
 * With `redirect: 'manual'` the SDK sees the real 3xx response and turns it
 * into an `SdkHttpError`/protocol error from its own `!response.ok` branch (the
 * GET path included), so a redirect is a failed connection, never a followed
 * one.
 *
 * Fail-loud: {@link ensureMcpTransportRedirectFence} verifies the seam
 * behaviourally and throws {@link McpTransportFenceUnavailableError} when it
 * cannot — `registerMcp` then refuses to register any streamable-http server
 * instead of connecting unfenced. The field and method names are SDK internals;
 * the behavioural verification, not the name list, is what keeps a future SDK
 * build from silently disabling the fence.
 *
 * The identity check that guards the build coupling is deliberately NOT
 * fail-closed on a path-spelling difference: it refuses when both resolutions
 * are readable and name different files (the measured R5 failure), and only
 * warns when one of them cannot be read at all — see
 * {@link verifyTargetsTheMcpClientSdk} for the field report that produced that
 * split.
 *
 * Build coupling: `@modelcontextprotocol/client` must stay EXTERNAL in this
 * package's bundle (it is a declared dependency, and `tsdown.config.ts` lists
 * it explicitly). An inlined copy is a different class object from the one
 * `dsh-mcp-client` constructs, which would leave the packaged app unfenced
 * while every test that runs from `src/` still passed — measured, not
 * theoretical: the built bundle leaked `x-api-key` to a 307 target 3 times with
 * the SDK inlined. `assertTargetsTheMcpClientSdk()` below is the runtime
 * half of that guard.
 *
 * @module
 */
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_HOST_LOCALE, hostT, stepLabel, type HostLocale } from './host-copy.ts'
import {
  allowedOutboundOriginsOf,
  assertOutboundUrlAllowed,
  assertResolvedOutboundAddressAllowed,
  originOfUrl,
  OutboundUrlBlockedError,
} from './outbound.ts'
import type { FetchLike } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'


/** Thrown when the streamable-http transport seam could not be fenced. */
export class McpTransportFenceUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpTransportFenceUnavailableError'
  }
}

/**
 * Marks a `fetch` this module already wraps.
 *
 * Two jobs: a re-install never double-wraps, and the behavioural probe can tell
 * a fenced fetch from a caller's raw one without calling it.
 */
const FENCED_FETCH = Symbol('picoaide.mcp.transport-fence.fenced-fetch')

/**
 * Marks a transport instance whose own request fields were already rewritten.
 *
 * The rewrite is idempotent and durable because the entry wrappers mutate the
 * instance: once any fenced method ran, the SDK's own later reads (the
 * fire-and-forget SSE open, the reconnection timer, the auth retries) see the
 * hardened `_fetch` / `_fetchWithInit` / `_requestInit` without calling us
 * again.
 */
const HARDENED = Symbol('picoaide.mcp.transport-fence.hardened')

/**
 * The owner token of one transport instance's outbound bookkeeping.
 *
 * Every ticket a transport's requests create is filed under this object, so the
 * accounting is per INSTANCE rather than per endpoint (R10 N2). The waiter in
 * `index.ts` cannot name the instance (the bridge owns it), which is why the
 * endpoint-wide give-up release is gated on `soleLiveTransport` instead of
 * assuming the endpoint has one user.
 */
const ACTIVITY_OWNER = Symbol('picoaide.mcp.transport-fence.activity-owner')

/**
 * Carries a transport's **live** request-header record on the one object
 * `hardenTransport` already reaches: the `authProvider` the bridge handed the
 * SDK.
 *
 * Why it exists (audit R9-D-1): the credential-change rebuild set covers stdio
 * and provider-less http, so a provider-backed http transport was left with
 * every OTHER registration-time baked value frozen — a definition declaring
 * `X-Probe-Key: ''` ("leave empty to auto-fill the bearer") kept the FIRST
 * access token forever and 401ed on every later call while the row still said
 * `connected`. `Config.headers` cannot be the seam: Schemastery resolves
 * `z.dict(String)` into a NEW object (`resolved.headers === passed` is false),
 * so mutating the config the connector built reaches nothing.
 *
 * The SDK reads `this._requestInit?.headers` on every request
 * (`_commonHeaders()`, pinned `@modelcontextprotocol/client@2.0.0`), and
 * `hardenTransport` is the one place that can replace that object on the live
 * instance. It therefore installs THIS record when the connector attached one,
 * and the connector mutates that very object when a credential changes.
 */
const LIVE_HEADERS = Symbol('picoaide.mcp.transport-fence.live-headers')

/**
 * Attach the record a provider-backed transport must read its headers from.
 *
 * Non-enumerable: the provider object is also inspected by the SDK
 * (`isOAuthClientProvider`-style classification) and by
 * {@link allowedOutboundOriginsOf}, and neither may start seeing a new own key.
 * @param provider - the object handed to the SDK as `authProvider` (the fence
 *   reads it off `_authProvider` / `_oauthProvider`).
 * @param headers - the mutable record the connector will keep updating.
 */
export function attachMcpLiveHeaders(provider: object, headers: Record<string, string>): void {
  Object.defineProperty(provider, LIVE_HEADERS, {
    value: headers,
    enumerable: false,
    configurable: true,
    writable: true,
  })
}

/**
 * Read the live header record off a provider, when it has one.
 * @param provider - the object in the transport's provider slot.
 * @returns the record, or undefined for a provider without one.
 */
function liveHeadersOf(provider: unknown): Record<string, string> | undefined {
  if (typeof provider !== 'object' || provider === null) return undefined
  const value = (provider as Record<symbol, unknown>)[LIVE_HEADERS]
  return typeof value === 'object' && value !== null ? value as Record<string, string> : undefined
}

/**
 * The tool budget of ONE MCP call, in milliseconds.
 *
 * Sole authority for both sides of the same budget (R10 N6): the registration in
 * `index.ts` hands this value to the bridge as `toolCallTimeoutMs` (stdio AND
 * streamable-http), and this module uses it as the ceiling after which a counted
 * request stops charging future rebuilds. Two literals of the same number is how
 * a budget silently drifts from the bookkeeping that is supposed to describe it.
 */
export const MCP_TOOL_CALL_TIMEOUT_MS = 120_000

/**
 * Which requests to one MCP endpoint are awaiting an answer right now, **per
 * transport instance**.
 *
 * The ticket set belongs to the transport that made the request (the owner token
 * {@link createMcpOutboundFetch} is constructed with), not to the endpoint. The
 * endpoint-only version of this map is what turned R10-B-06's give-up release
 * into cross-transport damage (R10 N2): with two transports on one URL, the one
 * being rebuilt gave up, released the endpoint's tickets — including the ticket
 * of a transport that was NOT being retired — and that transport's own later
 * rebuild then read `idle` and cut a call which could still have settled inside
 * its grace window. Releasing is therefore only ever done for a named owner, or
 * for a caller that has proven it is the endpoint's only live transport
 * ({@link whenMcpOutboundIdle}'s `soleLiveTransport`).
 *
 * Only non-GET requests count: the SDK's GET is the long-lived SSE stream, so
 * counting it would mark every connected transport permanently busy.
 *
 * A ticket set is a map of ticket id -> start time, never a bare counter
 * (R10-B-06). The counter this replaced was decremented in the `finally` of
 * `await options.base(...)`, so a `base` that NEVER settles (a fetch that
 * ignores its signal, or a socket that hangs) left the endpoint permanently
 * busy: every later rebuild walked the full grace and logged the misleading
 * `重建等待在途调用超时` line while nothing was on the wire. Tickets make both
 * repairs possible — the age bound can drop the ones older than a budget, and a
 * late `finally` from a request whose ticket was already dropped is a no-op
 * instead of decrementing somebody else's count.
 */
const outboundActivity = new Map<string, Map<object, Map<number, number>>>()

/** Ticket ids: unique per counted request, so a stale release cannot subtract. */
let outboundTicketSeq = 0

/**
 * The longest a counted request can legitimately still be on the wire.
 *
 * {@link MCP_TOOL_CALL_TIMEOUT_MS} is the ceiling: a request older than that is
 * beyond the budget that protects it, so it stops charging future rebuilds even
 * if its `base` never settles. With the endpoint-wide give-up release now gated
 * on being the endpoint's only live transport, this age bound is the ONLY valve
 * that always applies — hence the sharing rather than a second literal.
 */
const OUTBOUND_ACTIVITY_MAX_MS = MCP_TOOL_CALL_TIMEOUT_MS

/**
 * The activity bucket of one request URL — **the single normalization** every
 * "same endpoint" decision is made under, or null for a URL that cannot be
 * parsed.
 *
 * Bookkeeping and proof must agree (R10 N2, the repo's long-standing
 * "judge/record/clear under one key" rule). Tickets are filed by
 * {@link beginOutboundActivity} under this key, so the exclusive-transport proof
 * in `index.ts` has to compare endpoints under THIS key too. It used to compare
 * `.toString()` values instead, and the second defect of the R10-B-06 release
 * valve followed: `/mcp?a=1` and `/mcp?a=2` share one ticket bucket (the query
 * string is dropped here) while the string comparison called them different
 * endpoints, so the rebuild of the first "proved" it was alone, gave up, and
 * cleared the second's in-flight ticket — the exact cross-transport damage the
 * proof was added to prevent (W2 remeasured `busyAfterGiveUp=false` for that
 * pair, `true` for the same-URL pair).
 *
 * The query string is dropped on purpose: an MCP endpoint reached with two query
 * spellings is still one endpoint as far as "is somebody else on the wire" goes,
 * and `#`-fragments never reach a server at all. Dropping them is also the
 * conservative direction — two URLs that normalize together can only make the
 * caller LESS likely to be proven alone, so a give-up releases nothing.
 * @param url - the MCP endpoint URL (string or `URL`).
 * @returns `origin + pathname`, or null when the URL cannot be parsed.
 */
export function mcpActivityKey(url: string | URL): string | null {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return null
  }
}

/**
 * Every ticket set of one endpoint, after dropping the tickets older than
 * `maxAgeMs`.
 * @param key - the endpoint's activity key.
 * @param maxAgeMs - age at which a ticket stops counting.
 * @returns the surviving buckets (owner -> tickets), or undefined when idle.
 */
function liveOwnersOf(key: string, maxAgeMs: number): Map<object, Map<number, number>> | undefined {
  const owners = outboundActivity.get(key)
  if (owners === undefined) return undefined
  const now = Date.now()
  for (const [owner, tickets] of owners) {
    for (const [id, startedAt] of tickets) if (now - startedAt >= maxAgeMs) tickets.delete(id)
    if (tickets.size === 0) owners.delete(owner)
  }
  if (owners.size === 0) {
    outboundActivity.delete(key)
    return undefined
  }
  return owners
}

/** How many counted requests this endpoint has, for one owner or for all of them. */
function ticketsOf(key: string, owner: object | undefined): number {
  const owners = liveOwnersOf(key, OUTBOUND_ACTIVITY_MAX_MS)
  if (owners === undefined) return 0
  if (owner === undefined) {
    let total = 0
    for (const tickets of owners.values()) total += tickets.size
    return total
  }
  return owners.get(owner)?.size ?? 0
}

/**
 * Release the tickets of `owner` (or of every owner, for an endpoint-wide
 * release) that are older than `maxAgeMs`.
 * @param key - the endpoint's activity key.
 * @param maxAgeMs - age at which a ticket is released.
 * @param owner - the transport whose tickets are released; undefined = all owners.
 */
function releaseOutboundActivity(key: string, maxAgeMs: number, owner?: object): void {
  const owners = outboundActivity.get(key)
  if (owners === undefined) return
  const now = Date.now()
  for (const [candidate, tickets] of owners) {
    if (owner !== undefined && candidate !== owner) continue
    for (const [id, startedAt] of tickets) if (now - startedAt >= maxAgeMs) tickets.delete(id)
    if (tickets.size === 0) owners.delete(candidate)
  }
  if (owners.size === 0) outboundActivity.delete(key)
}

/** Register one counted request; the id is what {@link endOutboundActivity} releases. */
function beginOutboundActivity(key: string, owner: object): number {
  const id = ++outboundTicketSeq
  const owners = outboundActivity.get(key)
  if (owners === undefined) {
    outboundActivity.set(key, new Map([[owner, new Map([[id, Date.now()]])]]))
    return id
  }
  const tickets = owners.get(owner)
  if (tickets === undefined) owners.set(owner, new Map([[id, Date.now()]]))
  else tickets.set(id, Date.now())
  return id
}

/**
 * Release one counted request.
 *
 * Looked up by ticket id inside the OWNER's set: a ticket whose bucket was
 * pruned (or given up on) must not decrement a LATER request's count, and one
 * transport must never touch another transport's tickets.
 * @param key - the endpoint's activity key.
 * @param owner - the transport that made the request.
 * @param id - the ticket returned by {@link beginOutboundActivity}.
 */
function endOutboundActivity(key: string, owner: object, id: number): void {
  const owners = outboundActivity.get(key)
  if (owners === undefined) return
  const tickets = owners.get(owner)
  if (tickets === undefined) return
  tickets.delete(id)
  if (tickets.size === 0) owners.delete(owner)
  if (owners.size === 0) outboundActivity.delete(key)
}

/** The transport's own URL as a full href, read live (see {@link URL_FIELD}). */
function ownHrefOf(read: (() => unknown) | undefined): string | null {
  const value = read?.()
  if (value instanceof URL) return value.href
  if (typeof value === 'string') return value
  return null
}

/**
 * Whether an MCP call is on the wire for this endpoint right now.
 * @param target - the MCP endpoint URL of the definition.
 * @param owner - optional transport whose tickets are read; omitted = every
 *   transport on the endpoint (the conservative reading).
 * @returns true while at least one non-GET request is unanswered.
 */
export function isMcpOutboundBusy(target: string, owner?: object): boolean {
  const key = mcpActivityKey(target)
  return key !== null && ticketsOf(key, owner) > 0
}

/** Options of {@link whenMcpOutboundIdle}. */
export interface McpOutboundWaitOptions {
  /**
   * The transport whose tickets this wait concerns. When given, the wait reads
   * and (on give-up) releases only that transport's tickets.
   */
  owner?: object
  /**
   * The caller has proven that no OTHER live transport talks to this endpoint,
   * so every ticket here belongs to the transport this rebuild retires and the
   * give-up may release them. Default false: an unproven give-up releases
   * nothing (R10 N2). "This endpoint" is the {@link mcpActivityKey} bucket — the
   * same key the tickets are filed under, so the proof and the bookkeeping
   * cannot disagree about what "the same endpoint" means.
   */
  soleLiveTransport?: boolean
}

/**
 * Wait until no MCP call is on the wire for this endpoint, bounded.
 *
 * Used by the provider-less rebuild, whose `retire()` closes the transport the
 * SDK may still be answering a tool call on (`Connection closed` mid-call,
 * audit R9A-3). The wait ends as soon as the tickets reach zero, so the common
 * case costs one poll; the bound exists so a stalled call cannot starve the
 * credential update forever.
 *
 * **Whose tickets, and whose release** (R10 N2): the waiter in `index.ts` cannot
 * name the transport instance — the bridge owns it — so it reads the endpoint
 * union and passes `soleLiveTransport: true` only when it has proven that no
 * other live registration talks to this endpoint. "Same endpoint" there is the
 * same {@link mcpActivityKey} bucket these tickets live in, which is what makes
 * the proof and the bookkeeping one decision instead of two spellings. In that
 * case every ticket on the endpoint belongs to the transport this rebuild is
 * about to retire, and the give-up may release them (that is R10-B-06's valve: a
 * call that outlived the grace is one this rebuild cuts anyway). With another
 * live transport on the endpoint the give-up **releases nothing**: under-waiting
 * one rebuild is cheap, cutting a call another transport could still have
 * settled is not. Ticket age ({@link OUTBOUND_ACTIVITY_MAX_MS}) remains the
 * unconditional release valve.
 * @param target - the MCP endpoint URL of the definition.
 * @param timeoutMs - upper bound on the wait.
 * @param options - optional owner scope and the sole-live-transport assertion.
 * @returns `'idle'` when the endpoint drained (or already was idle), `'busy'`
 *   when the bound expired with a call still on the wire.
 */
export async function whenMcpOutboundIdle(
  target: string,
  timeoutMs: number,
  options: McpOutboundWaitOptions = {},
): Promise<'idle' | 'busy'> {
  const key = mcpActivityKey(target)
  if (key === null || ticketsOf(key, options.owner) === 0) return 'idle'
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, ACTIVITY_POLL_MS))
    if (ticketsOf(key, options.owner) === 0) return 'idle'
  }
  if (ticketsOf(key, options.owner) === 0) return 'idle'
  // Gave up. Release ONLY what this call is entitled to release: its own
  // transport's tickets when the owner is known, or the whole endpoint when the
  // caller proved it is the endpoint's only live transport. Then still report
  // `busy` — the bound really did expire with a call on the wire, which is what
  // the caller's warn line says.
  if (options.owner !== undefined) releaseOutboundActivity(key, Math.max(0, timeoutMs), options.owner)
  else if (options.soleLiveTransport === true) releaseOutboundActivity(key, Math.max(0, timeoutMs))
  return 'busy'
}

/** Poll interval of {@link whenMcpOutboundIdle}: far below any tool budget. */
const ACTIVITY_POLL_MS = 25

/**
 * The module `dsh-mcp-client` constructs its streamable-http transport from.
 *
 * Upstream 0.1.6-alpha.2 replaced `@modelcontextprotocol/sdk@1.x` with
 * `@modelcontextprotocol/client@2.0.0`; the old package still exists in this
 * tree (the desktop package declares it, and `dsh-subagent-claude-code` uses
 * it) — which is exactly why the identity check below has to name the package
 * mcp-client ACTUALLY imports instead of one this module happens to resolve.
 *
 * Exported for the regression: the guard that reads the installed mcp-client
 * build asserts this constant against the artifact, so a future SDK swap that
 * leaves the constant behind goes red instead of silently hardening a package
 * nobody loads.
 */
export const MCP_SDK_PACKAGE_SPECIFIER = '@modelcontextprotocol/client'
const SDK_PACKAGE_SPECIFIER = MCP_SDK_PACKAGE_SPECIFIER
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'
const SDK_PACKAGE_MARKER = 'node_modules/@modelcontextprotocol/client'

const REQUEST_INIT_FIELD = '_requestInit'
const FETCH_WITH_INIT_FIELD = '_fetchWithInit'
const FETCH_FIELD = '_fetch'
/**
 * The transport's own URL (an own class field in v2). The fence needs it to
 * tell "a request to MY MCP server" from "a request to a host the resource
 * server named"; a build that renames it fails the installation probe instead
 * of silently losing the same-origin rule.
 */
const URL_FIELD = '_url'
/**
 * The OAuth provider the transport was constructed with. It carries the
 * allowed-origin scope (`outbound.ts`), which is the only trusted answer to
 * "which hosts may this connector's credential reach".
 *
 * Only set when the SDK's `isOAuthClientProvider` predicate classified the
 * argument as an OAuth provider. Our production construction passes the
 * `AuthProvider` face instead (see `createOAuthProvider`: an OAuth-classified
 * provider loses our 401 hook to `adaptOAuthProvider`), and in that shape the
 * SAME provider object — scope attached — sits in this field:
 */
const OAUTH_PROVIDER_FIELD = '_oauthProvider'
/**
 * The provider slot the transport uses when it was handed an `AuthProvider`
 * rather than an `OAuthClientProvider` (the production shape since
 * 2026-09-24). Both slots hold our provider object with the origins attached,
 * so the scope lookup must read whichever one this build filled in; reading
 * only the OAuth slot would silently drop the connector's origin allow-list
 * (the CN-2 control: a refresh may only reach the DEFINITION's authorization
 * server) for every production transport.
 */
const AUTH_PROVIDER_FIELD = '_authProvider'
/**
 * Outbound entry points of the v2 streamable-http transport.
 *
 * Every request the SDK can make starts in one of these (`Client.connect()`
 * calls `start()`; every protocol message goes through `send()`; `close()` on
 * the client side reaches `terminateSession()`; `resumeStream()` and the
 * reconnection timer re-open the GET/SSE channel; `finishAuth()` redeems the
 * authorization code). Hardening must happen before the SDK reads the fields,
 * and these are the last points this module can still intercept — the fields
 * themselves are own data properties in v2.
 */
const FENCED_METHODS = ['start', 'send', 'terminateSession', 'resumeStream', 'finishAuth'] as const
/** Header the probe instance carries, so a leaked probe is recognizable. */
const PROBE_HEADER = 'x-picoaide-transport-fence'
/** Never contacted: the probe always supplies its own recording `fetch`. */
const PROBE_URL = 'http://127.0.0.1:1/mcp'
/**
 * A URL the SYNTAX policy refuses (`0.0.0.0/8`), used by the installation probe
 * to prove the policy half of the fence is live. Never contacted either: the
 * probe passes only when the recorder was NOT reached.
 */
const POLICY_REFUSED_PROBE_URL = 'http://0.0.0.0:1/mcp'
/**
 * A DIFFERENT origin from {@link PROBE_URL} (different port) that the policy
 * allows, used to prove the connector's baked credential headers do not travel
 * cross-origin. The recorder answers; no socket exists.
 */
const CROSS_ORIGIN_PROBE_URL = 'http://127.0.0.1:2/rm'

type Proto = Record<string, unknown>

/**
 * Whether the marker is present in ANY spelling of `path`.
 *
 * Windows answers `fileURLToPath` with backslashes, and an extended-length or
 * UNC install adds a `\\?\` prefix, so a marker search on the raw string alone
 * can report "unknown package" for the very file it is looking at. The
 * canonical form (below) is the one all comparisons use.
 */
function hasSdkMarker(path: string, foldCase = process.platform === 'win32'): boolean {
  return path.includes(SDK_PACKAGE_MARKER) || canonicalMcpTargetPath(path, foldCase).includes(SDK_PACKAGE_MARKER)
}

/**
 * Whether this spelling is a Windows path, i.e. one where `\` really is a
 * separator rather than an ordinary filename byte.
 *
 * Only these may be folded (conn-3, audit R7). On POSIX `\` is a legal
 * filename character: folding it unconditionally let ONE real file whose name
 * contains the SDK tail canonicalise onto a DIFFERENT real file's path, so
 * `sameFile` answered true for two readable, different files and the fence
 * installed silently.
 *
 * The shapes accepted are the ones the packaged/Windows product produces:
 * a drive-letter path (`C:\…` / `C:/…`), a UNC or extended-length prefix
 * (`\\?\`, `\\server\share`, `//?/`, `//server/share`), a rooted backslash path
 * (`\tmp\x`, i.e. "the current drive"), or — only when `foldCase` says this
 * really is Windows — any relative path containing `\`.
 *
 * All of those start with something a RESOLVED POSIX path never starts with:
 * `resolveTarget` only ever sees `fileURLToPath` output, which is absolute and
 * therefore begins with `/`. A POSIX path whose FILE NAME merely contains
 * backslashes (`/opt/app/node_modules\@modelcontextprotocol\sdk`) is not a
 * Windows shape and is left alone — that is the conn-3 distinction.
 */
function isWindowsPathShape(value: string, foldCase: boolean): boolean {
  // `\\?\C:…`, `\\?\UNC\…`, both slash spellings.
  if (/^[\\/]{2}[.?][\\/]/u.test(value)) return true
  // `C:\…` / `C:/…`
  if (/^[A-Za-z]:[\\/]/u.test(value)) return true
  // `\\server\share` / `//server/share` (UNC without the `?\` prefix).
  if (/^[\\/]{2}[^\\/]/u.test(value)) return true
  // A rooted backslash path names the current drive on Windows; POSIX has no
  // such spelling (an absolute POSIX path starts with `/`).
  if (value.startsWith('\\')) return true
  // A relative Windows spelling only exists on Windows, where `foldCase` is on.
  return foldCase && value.includes('\\')
}

/**
 * Make two spellings of one file compare equal — and only those.
 *
 * The identity check compares a path this module resolved with one mcp-client
 * resolved. Both go through the SAME Node ESM resolver and the same
 * `fileURLToPath`, so on a normal install they are already byte-identical; but
 * the packaged product (Electron + `app.asar`) and Windows add spellings that
 * differ while naming one file: `/` vs `\`, `\\?\C:` vs `C:`, 8.3 short names
 * (`PROGRA~1`) on one side only, and case. Comparing raw strings turned any of
 * those into a hard refusal — a customer's connector stopped registering for a
 * path-spelling difference (2026-09-13, a customer-channel `streamable-http`
 * connector), which is why the comparison is canonical: separators normalised,
 * extended-length prefix
 * stripped, and case folded where the platform folds it.
 *
 * Canonical is deliberately NOT aggressive: no symlink following is invented
 * here (`fs.realpathSync` is tried first and its answer is what gets
 * canonicalised), no short-name expansion (Windows only does that through
 * `fs.realpathSync.native`, whose case behaviour cannot be reasoned about
 * offline). A spelling the rules do not cover still counts as different —
 * {@link describeTargets} then says so, and the caller decides between refusing
 * (proven different file) and warning (unreadable path).
 *
 * Separator folding is applied only where the separator IS a separator
 * (conn-3): a Windows-shaped input, or any input at all when `foldCase` says
 * the platform folds path case (Windows). POSIX paths are therefore compared
 * byte for byte, which is what keeps two different files distinguishable.
 */
export function canonicalMcpTargetPath(path: string, foldCase = process.platform === 'win32'): string {
  let value = foldCase || isWindowsPathShape(path, foldCase) ? path.replace(/\\/g, '/') : path
  // `\\?\C:/x` and `//?/C:/x` both name `C:/x`
  if (value.startsWith('//?/')) value = value.slice(4)
  if (foldCase) value = value.toLowerCase()
  return value
}

/** A resolution attempt: the path, plus the form used for comparison. */
export interface TargetResolution {
  path: string
  canonical: string
  realpath: string | null
  error: string | null
}

function resolveTarget(path: string, foldCase = process.platform === 'win32'): TargetResolution {
  let realpath: string | null = null
  let error: string | null = null
  try {
    realpath = realpathSync(path)
  } catch (cause) {
    error = errorCodeOf(cause)
  }
  return { path, canonical: canonicalMcpTargetPath(realpath ?? path, foldCase), realpath, error }
}

/** Short, stable error code (`ENOENT`, `EPERM`, …) for diagnostics. */
function errorCodeOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && typeof (cause as { code?: unknown }).code === 'string') {
    return (cause as { code: string }).code
  }
  return String(cause)
}

/**
 * Whether both sides name the same file (conn-3).
 *
 * The resolved bytes decide first: when both sides could be read, an exact
 * `realpath` match is the same file, and two POSIX spellings that differ are two
 * different files — folding the canonical form first, as before, made a POSIX
 * filename containing backslashes compare equal to a different file.
 *
 * Two exceptions have to stay open, because both name ONE file while resolving
 * to different bytes:
 *
 * - a Windows-shaped spelling (drive letter, UNC / extended-length prefix,
 *   rooted backslash path — see {@link isWindowsPathShape});
 * - anything at all on a case-folding platform (`foldCase`).
 *
 * The canonical comparison is otherwise the fallback for a path this process
 * cannot stat (the `app.asar` / EPERM shape), exactly as before.
 */
function sameFile(a: TargetResolution, b: TargetResolution, foldCase: boolean): boolean {
  if (a.realpath !== null && b.realpath !== null) {
    if (a.realpath === b.realpath) return true
    const spellingOnly = foldCase
      || isWindowsPathShape(a.realpath, foldCase)
      || isWindowsPathShape(b.realpath, foldCase)
    if (!spellingOnly) return false
  }
  return a.canonical === b.canonical
}

/**
 * One log line with everything needed to tell the three failure shapes apart
 * without another round trip: the raw spellings, the canonical ones that were
 * compared, and whether each path was readable at all.
 */
function describeTargets(ours: TargetResolution | null, theirs: TargetResolution | null, locale: HostLocale = DEFAULT_HOST_LOCALE): string {
  const side = (label: string, value: TargetResolution | null): string =>
    value === null
      ? `${label}=<resolve failed>`
      : `${label}=${value.path} [canonical ${value.canonical}${value.error === null ? '' : ` unreadable:${value.error}`}]`
  // The whole report can end up in the connector row (a `proven-other` verdict
  // is thrown with it), so its own label follows the same locale.
  return `${side(hostT(locale, 'fence.oursLabel'), ours)} / ${side('mcp-client', theirs)}`
}

/** What the runtime identity check concluded. */
export type TargetVerdict =
  | { kind: 'ok'; ours: TargetResolution; theirs: TargetResolution }
  | { kind: 'unresolved'; detail: string }
  | { kind: 'proven-other'; ours: TargetResolution; theirs: TargetResolution }
  /**
   * The installed `dsh-mcp-client` build is readable and does NOT import the
   * package this fence hardens: nothing this module could patch would ever be
   * constructed. A readable witness, like `proven-other` — refuse loudly.
   */
  | { kind: 'proven-foreign'; detail: string }
  | { kind: 'inconclusive'; ours: TargetResolution | null; theirs: TargetResolution | null; note?: string }

/**
 * Check that the class this module patches is the class `dsh-mcp-client` will
 * use — without turning a path SPELLING into a refusal.
 *
 * The identity is what makes the fence real: `createTransport` in
 * `dsh-mcp-client` builds `StreamableHTTPClientTransport` from its OWN import
 * of the SDK, so patching any other copy (an inlined one, or a nested install
 * with a conflicting version range) would silently protect nothing.
 *
 * The comparison is the resolved FILE, not the package directory: v2 ships BOTH
 * `dist/index.mjs` and `dist/index.cjs` under one package root, and fencing the
 * ESM class while the host loads the CJS one (or the reverse) would leave every
 * channel unfenced while a directory comparison still said "same package" —
 * measured in R5 on the old SDK, whose CJS copy of this class follows a redirect
 * exactly like the unfenced ESM one. The parent URL is mcp-client's own entry,
 * so the second resolution runs the ESM resolver over mcp-client's import
 * conditions — the same answer its static `import` gets at runtime.
 *
 * Three outcomes, because "the two strings differ" is not the same statement as
 * "two different files":
 *
 * - `ok` — same file once both spellings are canonical;
 * - `proven-other` — BOTH paths are readable and they are different files
 *   (the CJS twin, a nested duplicate): refuse, loudly. This verdict has a
 *   witness that outlives path spelling, so `isMcpTransportFenceTargetMismatch`
 *   reports it as the remembered failure reason;
 * - `inconclusive` — one side could not be read (EPERM/ENOENT inside an
 *   `app.asar`, an install the runtime cannot stat). Proceeding is safe: the
 *   behavioural verification that follows patches and probes the real class, and
 *   a genuinely foreign target fails it. Refusing here is what took a
 *   customer's connector offline.
 *
 * Note what this check does NOT (only) do: it never looks at
 * `@modelcontextprotocol/sdk` (v1) any more. Upstream 0.1.6 moved
 * `dsh-mcp-client` to `@modelcontextprotocol/client@2.0.0`, and the v1 package is
 * still installed in this tree for other consumers — resolving the old specifier
 * succeeded, named OUR OWN copy, and reported `ok` while the real v2 transport
 * went unfenced (audit B §4.2, measured).
 *
 * Path identity alone is still not enough for that class of failure, because
 * Node resolves a package from the PARENT's directory upward: if a future
 * `dsh-mcp-client` imported yet another SDK package, the resolution of OUR
 * specifier from its entry would walk up and find the copy in this very package
 * — `ok` again, with the real transport unfenced. So the installed mcp-client
 * build is also READ, and the import has to name the package this fence hardens.
 * A readable build that imports something else is refused
 * ({@link verifyMcpClientImportsTheSdk}); an unreadable one stays a warning, per
 * the 2026-09-13 field lesson (an `app.asar` path this process cannot stat must
 * not take a customer's connector offline).
 */
function verifyTargetsTheMcpClientSdk(): TargetVerdict {
  let oursPath = ''
  let theirsPath = ''
  try {
    oursPath = fileURLToPath(import.meta.resolve(SDK_PACKAGE_SPECIFIER))
    const mcpEntry = import.meta.resolve(MCP_CLIENT_PACKAGE)
    theirsPath = fileURLToPath(resolveFromParent(SDK_PACKAGE_SPECIFIER, mcpEntry))
  } catch (error) {
    return { kind: 'unresolved', detail: String(error) }
  }
  const coupling = verifyMcpClientImportsTheSdk()
  if (coupling.kind === 'foreign') return { kind: 'proven-foreign', detail: coupling.detail }
  const verdict = judgeTargets(oursPath, theirsPath)
  if (coupling.kind === 'unknown' && verdict.kind === 'ok') {
    // Same file, but the build that is supposed to import it could not be read:
    // keep the identity report and let the behavioural probe be the gate.
    return { kind: 'inconclusive', ours: verdict.ours, theirs: verdict.theirs, note: coupling.detail }
  }
  return verdict
}

/** Whether one installed bundle reaches `specifier` through a static import or `require`. */
export function mcpClientBundleImportsSdk(source: string, specifier: string = MCP_SDK_PACKAGE_SPECIFIER): boolean {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?:from|require\\()\\s*["']${escaped}["']`, 'u').test(source)
}

/** What reading the installed `dsh-mcp-client` build said about the SDK it imports. */
type McpClientSdkCoupling =
  | { kind: 'imports'; detail: string }
  | { kind: 'foreign'; detail: string }
  | { kind: 'unknown'; detail: string }

function verifyMcpClientImportsTheSdk(): McpClientSdkCoupling {
  let entry = ''
  try {
    entry = fileURLToPath(import.meta.resolve(MCP_CLIENT_PACKAGE))
  } catch (error) {
    return { kind: 'unknown', detail: `mcp-client entry unresolved: ${String(error)}` }
  }
  let source = ''
  try {
    source = readFileSync(entry, 'utf8')
  } catch (error) {
    return { kind: 'unknown', detail: `mcp-client entry ${entry} unreadable:${errorCodeOf(error)}` }
  }
  if (!mcpClientBundleImportsSdk(source)) {
    return { kind: 'foreign', detail: `the installed dsh-mcp-client build (${entry}) does not import ${SDK_PACKAGE_SPECIFIER}` }
  }
  return { kind: 'imports', detail: `${entry} imports ${SDK_PACKAGE_SPECIFIER}` }
}

/**
 * The verdict for two resolved spellings, with no resolution of its own.
 *
 * Split out because the interesting inputs cannot be produced on the machine
 * that runs the tests: a Windows spelling of an `app.asar` path, a nested
 * duplicate install, a path the process may not stat. The test seam below feeds
 * them in, so the policy (canonicalise, then demand readability before
 * refusing) is asserted instead of merely intended.
 */
function judgeTargets(oursPath: string, theirsPath: string): TargetVerdict {
  return decideTargets(
    resolveTarget(oursPath),
    resolveTarget(theirsPath),
    process.platform === 'win32',
  )
}

/**
 * The decision, with BOTH sides already resolved and the platform supplied.
 *
 * Pure on purpose: the interesting inputs are a Windows spelling of an
 * `app.asar` path and the 8.3/EPERM shapes, none of which can be produced on
 * the Linux runner that gates the change. The regression drives this function
 * with `win32` and with `linux` so the rule that broke in the field (a marker
 * written with `/`, a path spelled with `\`) is asserted on every platform
 * instead of only on the one that failed.
 * @param ours - the resolution this module performed.
 * @param theirs - the resolution taken from mcp-client's entry.
 * @param foldCase - whether the platform folds path case (Windows does).
 * @returns the verdict the install path acts on.
 */
export function decideMcpTargets(
  ours: TargetResolution,
  theirs: TargetResolution,
  foldCase: boolean,
): TargetVerdict {
  return decideTargets(ours, theirs, foldCase)
}

function decideTargets(ours: TargetResolution, theirs: TargetResolution, foldCase: boolean): TargetVerdict {
  if (!hasSdkMarker(ours.path, foldCase)) {
    // We are not even looking at an installed SDK copy (inlined build).
    return { kind: 'inconclusive', ours, theirs }
  }
  if (sameFile(ours, theirs, foldCase)) return { kind: 'ok', ours, theirs }
  return ours.realpath !== null && theirs.realpath !== null
    ? { kind: 'proven-other', ours, theirs }
    : { kind: 'inconclusive', ours, theirs }
}

/**
 * Resolve `specifier` the way a `parent` module's own `import` would.
 *
 * `import.meta.resolve` takes the parent URL at runtime (Node ≥ 20.6); the
 * TypeScript lib of this package only declares the one-argument form, hence the
 * narrow cast.
 */
function resolveFromParent(specifier: string, parent: string): string {
  const resolve = import.meta.resolve as unknown as (specifier: string, parent?: string) => string
  return resolve(specifier, parent)
}

let patched = false
let verified = false
let pendingVerification: Promise<void> | null = null
let failure: McpTransportFenceUnavailableError | null = null
let restorePatched: (() => void) | null = null
/** Set when the two resolutions disagreed in a way that could not be settled. */
let targetWarning: string | null = null
/** Set when the resolutions named two readable, different files. */
let targetMismatch = false
/** One warning per install: connectors re-register on every session change. */
let targetWarningLogged = false
/**
 * Locale of the last install request, read when a fenced request is refused.
 *
 * Deliberately mutable and read at REQUEST time: the connector plugin resolves
 * the desktop locale per registration, and a user who switches language must
 * see the next refusal in the new language (module-level frozen copy is the bug
 * class documented in `client/status-label.ts`).
 */
let fenceLocale: HostLocale = DEFAULT_HOST_LOCALE

function protoOf(): Proto {
  return StreamableHTTPClientTransport.prototype as unknown as Proto
}

/**
 * Rewrite one live transport's own request fields so no request it makes can
 * follow a redirect — and so no request it makes can leave the outbound policy
 * or hand this connector's credential headers to a host the connector never
 * registered (audit 2026-09-23, CN-1).
 *
 * This is the v2 seam. The SDK declares `_requestInit` / `_fetch` /
 * `_fetchWithInit` as class fields, so each instance carries them as OWN data
 * properties and a prototype accessor would be shadowed (measured — see the
 * module header). Writing the instance's own properties is therefore the only
 * interception point left, and it is durable: the fire-and-forget SSE open, the
 * reconnection timer and the 401/auth retries read the SAME fields later.
 *
 * Three fields, three jobs (see {@link createMcpOutboundFetch} for the wrapper):
 *
 *  - `_requestInit` ← `redirect: 'manual'` (every POST/DELETE spread);
 *  - `_fetch`       ← policy + scope + redirect (POST/DELETE and the SSE GET;
 *                      every request it carries targets the transport's own URL);
 *  - `_fetchWithInit` ← the same, PLUS the connector's baked headers merged back
 *                      in for same-origin requests only. The SDK's own
 *                      `createFetchWithInit` would bake `requestInit.headers`
 *                      (the connector's `Authorization: Bearer …` / static API
 *                      key) into EVERY request that closure makes — including
 *                      the RFC 9728 / RFC 8414 discovery requests the 401 path
 *                      aims at a URL the RESOURCE server supplied. Rebuilding
 *                      the closure here is what keeps those headers on the MCP
 *                      origin.
 *
 * Idempotent: {@link HARDENED} marks an instance that was already rewritten, so
 * concurrent `send()` calls cannot build a wrapper tower.
 *
 * @param transport - the live transport instance (its `this`).
 * @param locale - resolves the locale of the messages the wrapper may throw, at
 *   throw time (never frozen at install time).
 * @throws {TypeError} when a field exists but rejects the write (a getter-only
 *   accessor in a future SDK build) — the caller surfaces that as a failed
 *   verification, never as an unfenced connection.
 */
function hardenTransport(transport: object, locale: () => HostLocale = () => DEFAULT_HOST_LOCALE): void {
  const fields = transport as Record<string | symbol, unknown>
  if (fields[HARDENED] === true) return
  // The credential's allowed-origin scope: whichever provider slot this SDK
  // build filled in (OAuth-classified arguments land in the first, our own
  // `AuthProvider` face in the second — see the field docs above). Read BEFORE
  // the request fields are rewritten: the same object may carry the transport's
  // live header record (R9-D-1).
  const scope = fields[OAUTH_PROVIDER_FIELD] ?? fields[AUTH_PROVIDER_FIELD]
  const requestInit = forceManual(fields[REQUEST_INIT_FIELD] as RequestInit | undefined)
  // The connector attached this record when it registered the server: the SDK
  // re-reads `_requestInit.headers` on every request, so installing the record
  // itself (instead of the resolved copy Schemastery left in the config) is what
  // lets a rotated credential reach an already-live transport without the
  // rebuild that would cut the call in flight.
  const live = liveHeadersOf(scope)
  if (live !== undefined) requestInit.headers = live
  fields[REQUEST_INIT_FIELD] = requestInit
  const ownUrl = (): unknown => fields[URL_FIELD]
  // ONE owner token per transport instance, shared by both wrappers below: the
  // two entry points belong to the same transport, so their tickets must land in
  // the same set (and in no other transport's).
  const existingOwner = fields[ACTIVITY_OWNER]
  const owner: object = typeof existingOwner === 'object' && existingOwner !== null ? existingOwner : {}
  Object.defineProperty(fields, ACTIVITY_OWNER, { value: owner, enumerable: false, configurable: true })
  // Where the SDK's requests really go: the caller-supplied fetch when there is
  // one (tests inject a recorder; a foreign build may inject a proxy), else the
  // global fetch read lazily at request time. The SDK's own `_fetchWithInit`
  // closure is deliberately NOT reused: it bakes the credential headers in, and
  // a wrapper cannot take them back out again.
  const provided = fields[FETCH_FIELD]
  const base: FetchLike = typeof provided === 'function' ? provided as FetchLike : globalFetch
  fields[FETCH_WITH_INIT_FIELD] = createMcpOutboundFetch({
    base,
    ownUrl,
    scope,
    bakedHeaders: requestInit.headers,
    locale,
    owner,
  })
  // `_startOrAuthSse()` builds its GET with `...this._requestInit` (v2) but the
  // POST/DELETE path and the 401 retries all read `_fetch`; the production
  // construction passes NO `fetch`, so `(this._fetch ?? fetch)` must resolve to
  // OUR wrapper rather than to the global follow-by-default fetch.
  fields[FETCH_FIELD] = createMcpOutboundFetch({ base, ownUrl, scope, locale, owner })
  Object.defineProperty(fields, HARDENED, { value: true, enumerable: false })
}

/** Whether one transport instance was already hardened by {@link hardenTransport}. */
export function isMcpTransportFenceHardened(transport: object): boolean {
  return (transport as Record<string | symbol, unknown>)[HARDENED] === true
}

/**
 * The outbound-bookkeeping owner token of one hardened transport instance.
 *
 * This is the handle {@link whenMcpOutboundIdle} and {@link isMcpOutboundBusy}
 * take when the caller really holds the instance (a probe, or a future bridge
 * that hands the transport back): with it, a wait reads and releases only that
 * transport's tickets, which is the precise form of R10 N2. The rebuild path
 * cannot use it — the bridge owns the instance and never hands it out — so that
 * path goes through the endpoint union plus the `soleLiveTransport` proof.
 * @param transport - the transport instance (hardened or not).
 * @returns the owner token, or undefined for an instance the fence never saw.
 */
export function mcpOutboundOwnerOf(transport: object): object | undefined {
  const owner = (transport as Record<string | symbol, unknown>)[ACTIVITY_OWNER]
  return typeof owner === 'object' && owner !== null ? owner : undefined
}

function forceManual(init: RequestInit | undefined): RequestInit {
  // Ours wins over whatever the caller passed: a definition (or a future
  // mcp-client build) cannot ask for redirects to be followed.
  return { ...(init ?? {}), redirect: 'manual' }
}

/** The global fetch, behind one indirection so the wrapper never relies on `this`. */
const globalFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

/** Step label the wrapper names in its policy errors (translated by `stepLabel`). */
function transportStep(locale: HostLocale): string {
  return hostT(locale, 'step.mcpTransportRequest')
}

/** The URL of one `fetch` input, whatever shape the SDK passed. */
function requestUrlOf(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url
  if (typeof input === 'object' && input !== null) {
    const candidate = (input as { url?: unknown }).url
    if (typeof candidate === 'string') return candidate
  }
  return String(input)
}

/** The transport's own origin, read live (a late `_url` write still counts). */
function ownOriginOf(read: (() => unknown) | undefined): string | null {
  const value = read?.()
  if (value instanceof URL) return value.origin
  if (typeof value === 'string') return originOfUrl(value)
  return null
}

/** One header list as a plain lower-cased record (Headers/array/record). */
function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {}
  if (headers === undefined) return record
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, name) => { record[name.toLowerCase()] = value })
    return record
  }
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) record[String(name).toLowerCase()] = String(value)
    return record
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) record[name.toLowerCase()] = String(value)
  }
  return record
}

/**
 * Merge the transport's baked headers under one request's own headers, the way
 * the SDK's `createFetchWithInit` does (per-request wins).
 * @param baked - headers the transport carries by construction.
 * @param given - headers of this request.
 * @returns the merged record, or undefined when neither side has any.
 */
function mergeHeaders(baked: HeadersInit | undefined, given: HeadersInit | undefined): Record<string, string> | undefined {
  const merged = { ...headerRecord(baked), ...headerRecord(given) }
  return Object.keys(merged).length === 0 ? undefined : merged
}

/** Options of {@link createMcpOutboundFetch}. */
export interface McpOutboundFetchOptions {
  /** The fetch to delegate to once the request passed the fence. */
  base: FetchLike
  /** Live read of the transport's own URL (`_url`), for the same-origin rule. */
  ownUrl?: (() => unknown) | undefined
  /** Object carrying the attached allowed origins (the OAuth provider). */
  scope?: unknown
  /** Headers the SDK bakes into this transport (`requestInit.headers`). */
  bakedHeaders?: HeadersInit | undefined
  /** Locale of the messages this wrapper may throw, resolved per request. */
  locale?: (() => HostLocale) | undefined
  /**
   * The transport instance this wrapper belongs to, as an opaque token: every
   * ticket it creates is filed under this object, so one transport's rebuild can
   * never release another transport's tickets (R10 N2). Omitted (a bare wrapper
   * built outside {@link hardenTransport}) = this wrapper is its own owner.
   */
  owner?: object | undefined
}

/**
 * Build the ONE fenced fetch every MCP transport request goes through.
 *
 * Four rules, each of which the 2026-09-23 audit found missing from the
 * redirect-only wrapper this replaces (`CN-1`):
 *
 * 1. **Outbound URL policy** — the same `assertOutboundUrlAllowed` the OAuth
 *    discovery chain uses (`auth.ts`), applied to the URL the SDK is about to
 *    fetch. Without it, a 401 carrying
 *    `WWW-Authenticate: Bearer resource_metadata="<any URL>"` made the SDK
 *    really GET that URL — while `outbound.ts` refused the very same URL when
 *    we resolved it ourselves. A refusal throws
 *    {@link OutboundUrlBlockedError}; nothing is fetched, so nothing leaks.
 * 2. **Resolution gate** — {@link assertResolvedOutboundAddressAllowed}, so a
 *    NAME that resolves into a private / link-local / loopback range is refused
 *    like its literal spelling (`CN-9`).
 * 3. **Registered-origin scope** — a request to an origin other than the
 *    transport's own is allowed only when the connector registered that origin
 *    (`createOAuthProvider` attaches the policy-checked authorization-server
 *    facts to itself, and the fence reads them off `_oauthProvider`). The
 *    resource server decides nothing about where credentials go; the connector
 *    definition does. An unknown provider (no attached scope) keeps the general
 *    policy — the header rule below still protects it.
 * 4. **Header hygiene** — the connector's baked headers (`Authorization: Bearer
 *    …`, the definition's static API keys) are merged back in for SAME-ORIGIN
 *    requests only. A cross-origin hop (token endpoint, discovery document, the
 *    URL a hostile resource server named) receives only what that request
 *    itself asked for, so the SDK's own OAuth protocol headers still work while
 *    the connector credential cannot travel.
 *
 * `redirect: 'manual'` is still forced on every request (residual C), and an
 * already-fenced fetch is returned untouched so a re-install cannot build a
 * wrapper tower.
 * @param options - base fetch, own-URL reader, scope, baked headers, locale.
 * @returns a marked fetch that only performs policy-approved, scoped requests.
 */
export function createMcpOutboundFetch(options: McpOutboundFetchOptions): FetchLike {
  const owner = options.owner ?? {}
  const wrapped: FetchLike = async (input, init) => {
    const locale = options.locale?.() ?? DEFAULT_HOST_LOCALE
    const step = transportStep(locale)
    const raw = requestUrlOf(input)
    const target = assertOutboundUrlAllowed(raw, step, locale)
    const ownOrigin = ownOriginOf(options.ownUrl)
    const allowed = allowedOutboundOriginsOf(options.scope)
    const crossOrigin = ownOrigin === null || target.origin !== ownOrigin
    if (crossOrigin && allowed !== null && !allowed.has(target.origin)) {
      throw new OutboundUrlBlockedError(hostT(locale, 'outbound.mcpFenceOrigin', {
        what: stepLabel(locale, step),
        target: target.href,
        allowed: [...allowed].join(', ') || hostT(locale, 'outbound.mcpFenceOriginNone'),
      }))
    }
    await assertResolvedOutboundAddressAllowed(target, step, locale)
    const headers = crossOrigin
      ? (init?.headers === undefined ? undefined : headerRecord(init.headers))
      : mergeHeaders(options.bakedHeaders, init?.headers)
    const next: RequestInit = { ...(init ?? {}), redirect: 'manual' }
    if (headers === undefined || Object.keys(headers).length === 0) delete next.headers
    else next.headers = headers
    // R9A-3 bookkeeping: the provider-less rebuild retires (and closes) this
    // transport, which killed a tool call that was still on the wire. The
    // tickets are what let that rebuild wait for the call instead of cutting it.
    // The ticket (not a bare increment) is what makes the set recoverable when
    // `base` never settles (R10-B-06): the age bound releases it, and this
    // `finally` — should it ever run, possibly much later — releases only THIS
    // request, inside THIS transport's own set (R10 N2).
    const ownHref = ownHrefOf(options.ownUrl)
    const activityKey = ownHref === null ? null : mcpActivityKey(ownHref)
    const counted = activityKey !== null
      && activityKey === mcpActivityKey(target)
      && (init?.method ?? 'GET').toUpperCase() !== 'GET'
    const ticket = counted && activityKey !== null ? beginOutboundActivity(activityKey, owner) : null
    try {
      return await options.base(input, next)
    } finally {
      if (ticket !== null && activityKey !== null) endOutboundActivity(activityKey, owner, ticket)
    }
  }
  Object.defineProperty(wrapped, FENCED_FETCH, { value: true, enumerable: false })
  return wrapped
}

/** Whether one value is a fetch this module already fenced. */
function isFencedFetch(value: unknown): boolean {
  return typeof value === 'function' && (value as { [FENCED_FETCH]?: unknown })[FENCED_FETCH] === true
}

/**
 * Wrap the transport's outbound entry points so each one hardens the instance
 * before delegating to the SDK.
 *
 * Every method whose absence would make the fence inert is REQUIRED: if the
 * class no longer exposes one of {@link FENCED_METHODS}, the seam cannot be
 * proven and {@link installMcpTransportRedirectFence} refuses rather than
 * reporting a hardened transport that never hardens anything.
 *
 * @returns a disposer restoring the original method descriptors.
 */
function patchTransportClass(): () => void {
  const proto = protoOf()
  const previous = new Map<string, PropertyDescriptor>()
  for (const name of FENCED_METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name)
    if (descriptor === undefined || typeof descriptor.value !== 'function') {
      for (const [restored, original] of previous) restoreField(restored, original)
      throw new Error(`StreamableHTTPClientTransport.prototype.${name} is not a function`)
    }
    previous.set(name, descriptor)
    const original = descriptor.value as (...args: unknown[]) => unknown
    Object.defineProperty(proto, name, {
      ...descriptor,
      value: function hardenedEntry(this: object, ...args: unknown[]): unknown {
        hardenTransport(this, () => fenceLocale)
        return original.apply(this, args)
      },
    })
  }
  return () => {
    for (const [name, descriptor] of previous) restoreField(name, descriptor)
  }
}

function restoreField(field: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) delete protoOf()[field]
  else Object.defineProperty(protoOf(), field, descriptor)
}

/**
 * Verify — behaviourally — that the fenced transport really hands
 * `redirect: 'manual'` to the fetch the SDK owns, on **every** channel it owns.
 *
 * The probe builds a real transport with a recording `fetch` (no socket is
 * opened: the recorder answers by method) and drives the channels that carry
 * credentials:
 *
 * 1. `send()` — the POST path that carries `initialize`, the rendered
 *    credential headers and the body (`...this._requestInit`);
 * 2. the SPEC CHAIN that opens the SSE stream — `notifications/initialized`
 *    answered with `202` makes the SDK fire `_startOrAuthSse()` on its own;
 * 3. `resumeStream()` — the reconnect/resume GET.
 *
 * (2) and (3) exist because R5 proved the hole: `_startOrAuthSse()` opens a
 * `(this._fetch ?? fetch)` GET, so a version of this check that only drove
 * `send()` reported `verified=true` while the SSE channel — the one that leaks
 * as soon as a server answers `initialize` 200 + `initialized` 202 — was still
 * unfenced. Both the "did the GET go through the fenced fetch" and the "was
 * `redirect` forced on it" halves are asserted: a future SDK that calls the
 * global `fetch` directly (or re-derives its fetch inside a method, bypassing
 * the instance fields this fence rewrites) fails here.
 *
 * The v2 probe also asserts the SHAPE it depends on — the three request fields
 * must be own data properties of the instance (class fields), because that is
 * what makes the method-level hardening the right seam and what made the old
 * prototype-accessor fence a no-op. A future build that moves them elsewhere,
 * or makes them read-only, fails here instead of silently unfencing.
 *
 * Any failure lands on {@link McpTransportFenceUnavailableError}, which
 * `registerMcp` turns into a refusal to register the server.
 */
async function verifyFenceSeam(locale: HostLocale): Promise<void> {
  const seen: Array<{ method: string; redirect: unknown; headers: unknown }> = []
  const probeFetch: FetchLike = async (_input, init) => {
    const method = init?.method ?? 'GET'
    seen.push({ method, redirect: init?.redirect, headers: init?.headers })
    // 405 is the spec's "this server offers no SSE stream" answer, so the SSE
    // path terminates without scheduling a reconnection; every redirect
    // decision has already been taken by the fence when the recorder runs.
    return new Response('', { status: method === 'GET' ? 405 : 202 })
  }
  const probe = new StreamableHTTPClientTransport(new URL(PROBE_URL), {
    requestInit: { headers: { [PROBE_HEADER]: '1' } },
    fetch: probeFetch,
  })
  const internals = probe as unknown as Record<string, unknown>
  // The v2 shape this fence rewrites: own data properties (class fields). If a
  // future build keeps them on the prototype as accessors, hardening still
  // writes through them — but a build that hides them entirely must be caught
  // here rather than reported as hardened. `_url` is in the list because the
  // same-origin rule (which host may receive the connector's baked headers)
  // reads it: a rename must fail the install, not silently widen the fence.
  for (const field of [REQUEST_INIT_FIELD, FETCH_WITH_INIT_FIELD, FETCH_FIELD, URL_FIELD]) {
    if (Object.getOwnPropertyDescriptor(probe, field) === undefined) {
      throw new McpTransportFenceUnavailableError(
        hostT(locale, 'fence.notInstanceField', { field }),
      )
    }
  }
  // The request path that actually carries the credentials and the body. Driven
  // FIRST: the hardening happens on this entry, and everything below reads the
  // fields it rewrote.
  seen.length = 0
  await probe.send({ jsonrpc: '2.0', method: 'ping', id: 1 } as never).catch(() => undefined)
  if (!seen.some(call => call.method === 'POST' && call.redirect === 'manual')) {
    throw new McpTransportFenceUnavailableError(hostT(locale, 'fence.sendNotManual'))
  }
  if (!isMcpTransportFenceHardened(probe)) {
    throw new McpTransportFenceUnavailableError(hostT(locale, 'fence.notInterceptable', { field: REQUEST_INIT_FIELD }))
  }
  const requestInit = internals[REQUEST_INIT_FIELD] as RequestInit | undefined
  if (requestInit?.redirect !== 'manual') {
    throw new McpTransportFenceUnavailableError(
      hostT(locale, 'fence.requestInitNotFenced', { field: REQUEST_INIT_FIELD }),
    )
  }
  const fetchWithInit = internals[FETCH_WITH_INIT_FIELD]
  if (typeof fetchWithInit !== 'function') {
    throw new McpTransportFenceUnavailableError(hostT(locale, 'fence.notInterceptable', { field: FETCH_WITH_INIT_FIELD }))
  }
  const fetchField = internals[FETCH_FIELD]
  if (!isFencedFetch(fetchField)) {
    throw new McpTransportFenceUnavailableError(
      hostT(locale, 'fence.fetchNotFenced', { field: FETCH_FIELD }),
    )
  }
  // The auth-provider path builds its own fetch: prove it is fenced too.
  seen.length = 0
  await (fetchWithInit as FetchLike)(PROBE_URL, { method: 'POST' }).catch(() => undefined)
  if (seen[0]?.redirect !== 'manual') {
    throw new McpTransportFenceUnavailableError(hostT(locale, 'fence.fetchWithInitNotManual', { field: FETCH_WITH_INIT_FIELD }))
  }
  // The production construction passes NO `fetch`: `(this._fetch ?? fetch)` must
  // resolve to our wrapper, never to the global fetch's follow default. Same
  // entry point as production (`send`), so the hardening is exercised too.
  const bare = new StreamableHTTPClientTransport(new URL(PROBE_URL), {
    requestInit: { headers: { [PROBE_HEADER]: '1' } },
  })
  await bare.send({ jsonrpc: '2.0', method: 'ping', id: 1 } as never).catch(() => undefined)
  const bareFetch = (bare as unknown as Record<string, unknown>)[FETCH_FIELD]
  if (!isFencedFetch(bareFetch) || bareFetch === globalThis.fetch) {
    throw new McpTransportFenceUnavailableError(hostT(locale, 'fence.noHardenedFetch', { field: FETCH_FIELD }))
  }
  // THE SPEC CHAIN: `initialize` 200 → `notifications/initialized` 202 → the
  // SDK opens the GET(SSE) stream by itself (R5 hole).
  seen.length = 0
  await probe.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never).catch(() => undefined)
  await settleProbe(() => seen.some(call => call.method === 'GET'))
  const sse = seen.find(call => call.method === 'GET')
  if (sse === undefined) {
    throw new McpTransportFenceUnavailableError(hostT(locale, 'fence.sseNotFenced'))
  }
  if (sse.redirect !== 'manual') {
    throw new McpTransportFenceUnavailableError(hostT(locale, 'fence.sseNotManual'))
  }
  // Reconnect/resume uses the same GET path, but is awaited — drive it too.
  seen.length = 0
  await probe.resumeStream('probe-event-id').catch(() => undefined)
  const resumed = seen.find(call => call.method === 'GET')
  if (resumed === undefined || resumed.redirect !== 'manual') {
    throw new McpTransportFenceUnavailableError(hostT(locale, 'fence.resumeNotManual'))
  }
  // CN-1 (audit 2026-09-23): the wrapper must ALSO apply the outbound URL
  // policy. A URL the policy refuses has to be refused here, before the base
  // fetch is reached — otherwise a 401 whose `WWW-Authenticate` names a
  // private/metadata URL makes the SDK really GET it. `0.0.0.0/8` is refused by
  // the SYNTAX rule, so this probe needs no resolver and no socket.
  seen.length = 0
  let policyRefusals = 0
  await (fetchWithInit as FetchLike)(POLICY_REFUSED_PROBE_URL, { method: 'GET' }).then(
    () => undefined,
    () => { policyRefusals += 1 },
  )
  if (policyRefusals !== 1 || seen.length !== 0) {
    throw new McpTransportFenceUnavailableError(hostT(locale, 'fence.policyNotApplied'))
  }
  // …and the credential headers the connector baked into `requestInit` must not
  // travel to a DIFFERENT origin (the token endpoint / a hostile
  // `resource_metadata` URL), while the SAME-origin request keeps them.
  seen.length = 0
  await (fetchWithInit as FetchLike)(PROBE_URL, { method: 'POST' }).catch(() => undefined)
  if (!headersOf(seen[0]?.headers).has(PROBE_HEADER)) {
    throw new McpTransportFenceUnavailableError(hostT(locale, 'fence.sameOriginHeadersDropped'))
  }
  seen.length = 0
  await (fetchWithInit as FetchLike)(CROSS_ORIGIN_PROBE_URL, { method: 'GET' }).catch(() => undefined)
  const crossOrigin = seen.find(call => call.method === 'GET')
  if (crossOrigin === undefined) {
    throw new McpTransportFenceUnavailableError(hostT(locale, 'fence.fetchWithInitNotManual', { field: FETCH_WITH_INIT_FIELD }))
  }
  if (headersOf(crossOrigin.headers).has(PROBE_HEADER)) {
    throw new McpTransportFenceUnavailableError(hostT(locale, 'fence.credentialHeaderCrossOrigin'))
  }
}

/** One recorded header set as a `Headers` (the probe compares with `has`). */
function headersOf(headers: unknown): Headers {
  if (headers instanceof Headers) return headers
  if (Array.isArray(headers)) return new Headers(headers as [string, string][])
  if (typeof headers === 'object' && headers !== null) return new Headers(headers as Record<string, string>)
  return new Headers()
}

/**
 * Give the SDK's fire-and-forget SSE open a few task turns to reach the
 * recording fetch, stopping as soon as `reached` says it arrived. Bounded, so an
 * SDK that never opens the stream cannot hang the registration path — it fails
 * the "GET was seen" assertion instead.
 * @param reached - predicate polled between turns.
 * @param turns - maximum task turns to wait.
 */
async function settleProbe(reached: () => boolean, turns = 20): Promise<void> {
  for (let index = 0; index < turns && !reached(); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

/**
 * Install the fence (idempotent). Returns a disposer that removes it again;
 * only the caller that performed the patch gets a working disposer.
 *
 * Production code calls {@link ensureMcpTransportRedirectFence} instead — the
 * disposer exists for the regression's negative control (it must be able to
 * show the unfenced construction still follows a redirect, so the test cannot
 * pass vacuously).
 * @param targets - test seam: the two paths the identity check should judge.
 *   Windows spellings, nested duplicate installs and unreadable paths cannot be
 *   produced on the Linux test runner, so the regression injects them here
 *   rather than mocking module resolution.
 * @returns a function restoring the SDK's original method descriptors (already
 *   hardened INSTANCES stay hardened — the hardening lives on the instance).
 */
export function installMcpTransportRedirectFence(targets?: { ours: string; theirs: string }, locale: HostLocale = DEFAULT_HOST_LOCALE): () => void {
  if (patched) return () => {}
  const verdict = targets === undefined
    ? verifyTargetsTheMcpClientSdk()
    : judgeTargets(targets.ours, targets.theirs)
  if (verdict.kind === 'unresolved') {
    throw new McpTransportFenceUnavailableError(hostT(locale, 'fence.targetUnresolved', { detail: verdict.detail }))
  }
  if (verdict.kind === 'proven-other') {
    targetMismatch = true
    throw new McpTransportFenceUnavailableError(
      hostT(locale, 'fence.targetMismatch', { detail: describeTargets(verdict.ours, verdict.theirs, locale) }),
    )
  }
  if (verdict.kind === 'proven-foreign') {
    targetMismatch = true
    throw new McpTransportFenceUnavailableError(
      hostT(locale, 'fence.foreignImport', { detail: verdict.detail }),
    )
  }
  if (verdict.kind === 'inconclusive') {
    // One side could not be read, so "different strings" is not evidence: the
    // behavioural verification below is the real gate. Keep the report — a
    // connector that later fails to fence must not look like a clean install.
    targetWarning = describeTargets(verdict.ours, verdict.theirs, locale)
      + (verdict.note === undefined ? '' : ` / ${verdict.note}`)
  }
  // Every install request re-states the locale, so a later language switch is
  // reflected by the next refusal this fence produces (see `fenceLocale`).
  fenceLocale = locale
  restorePatched = patchTransportClass()
  patched = true
  return uninstallMcpTransportRedirectFence
}

/**
 * The inconclusive-identity report, or null when the resolutions agreed.
 *
 * `registerMcp` logs it once per install: the connection is allowed to proceed,
 * so the operator has to be able to find out afterwards which spellings were
 * compared (and that is the difference between a diagnosable field report and
 * this one, where the refusal threw the paths away).
 */
export function mcpTransportFenceTargetWarning(): string | null {
  return targetWarning
}

/** Whether the two resolutions named two readable, different files (refusal). */
export function isMcpTransportFenceTargetMismatch(): boolean {
  return targetMismatch
}

/**
 * Claim the one-shot warning for the current install.
 * @returns true for the first caller, false afterwards.
 */
export function claimMcpTransportFenceTargetWarning(): boolean {
  if (targetWarning === null || targetWarningLogged) return false
  targetWarningLogged = true
  return true
}

/** Whether the seam has been behaviourally verified (not just patched). */
export function isMcpTransportRedirectFenceVerified(): boolean {
  return verified
}

/**
 * Remove the fence and forget the cached failure.
 *
 * Test-only: the production plugin never calls it. The regression needs it for
 * two things it cannot prove otherwise — that the unfenced construction really
 * does hand the MCP channel to the redirect target (the negative control, so
 * the attack assertion cannot pass vacuously), and that a broken seam makes
 * `registerMcp` refuse a streamable-http server instead of connecting without
 * the fence.
 */
export function uninstallMcpTransportRedirectFence(): void {
  restorePatched?.()
  restorePatched = null
  patched = false
  verified = false
  pendingVerification = null
  failure = null
  targetWarning = null
  targetMismatch = false
  targetWarningLogged = false
}

/**
 * Guarantee the fence is installed and verified, or throw.
 * @throws {McpTransportFenceUnavailableError} when the seam cannot be fenced.
 */
export async function ensureMcpTransportRedirectFence(locale: HostLocale = DEFAULT_HOST_LOCALE): Promise<void> {
  // The locale of THIS registration is what a later refusal must render in,
  // even while the seam itself is already installed and verified (the fence is
  // process-wide, the panel language is not).
  fenceLocale = locale
  // NOTE: `failure` is memoized on purpose (one seam verification per process),
  // so the FIRST caller's locale fixes the text of the cached error. That is a
  // property of the memoized failure, not a module-level locale capture: the
  // locale is still resolved per call and passed in.
  if (failure !== null) throw failure
  if (verified) return
  // Concurrent registrations share one verification: a second caller must not
  // observe "patched" before the seam was proven, or it could register a
  // transport during the window the fence is still unproven.
  if (pendingVerification !== null) return pendingVerification
  const attempt = (async (): Promise<void> => {
    if (!patched) {
      try {
        installMcpTransportRedirectFence(undefined, locale)
      } catch (error) {
        failure = new McpTransportFenceUnavailableError(hostT(locale, 'fence.notHardened', { error: String(error) }))
        throw failure
      }
    }
    try {
      await verifyFenceSeam(locale)
    } catch (error) {
      uninstallMcpTransportRedirectFence()
      failure = error instanceof McpTransportFenceUnavailableError
        ? error
        : new McpTransportFenceUnavailableError(hostT(locale, 'fence.verificationFailed', { error: String(error) }))
      throw failure
    }
    // A concurrent uninstall (test seam) must not leave a stale "verified".
    if (patched) verified = true
  })()
  pendingVerification = attempt
  try {
    await attempt
  } finally {
    if (pendingVerification === attempt) pendingVerification = null
  }
}

/** Whether the fence is currently installed (diagnostics and tests). */
export function isMcpTransportRedirectFenceInstalled(): boolean {
  return patched
}
