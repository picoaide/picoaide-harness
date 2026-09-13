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
 * installed `dsh-mcp-client` build passes only `requestInit: { headers }`), so
 * the fence is installed on the transport CLASS before any instance exists:
 * THREE prototype accessors make every instance's `_requestInit` carry
 * `redirect: 'manual'`, wrap its `_fetchWithInit` (the auth-provider path) and —
 * R5 — wrap its `_fetch`. `_fetch` is the one that closed the SSE hole:
 * `_startOrAuthSse()` calls `(this._fetch ?? fetch)(url, { method: 'GET',
 * headers, signal })` and does **not** spread `_requestInit`, so fencing the
 * init alone left the server-initiated SSE channel (opened automatically once
 * `initialize` answers 200 and `notifications/initialized` answers 202, and
 * again on every reconnect / `resumeStream`) following redirects with the full
 * header set. When `_fetch` is empty the accessor stores a wrapper over the
 * global `fetch`, so `(this._fetch ?? fetch)` can never fall back to it.
 *
 * With `redirect: 'manual'` the SDK sees the real 3xx response and turns it
 * into a `StreamableHTTPError` from its own `!response.ok` branch (the GET path
 * included), so a redirect is a failed connection, never a followed one.
 *
 * Every other outbound channel of this transport is covered by the same three
 * accessors, because the SDK funnels all of them through `this._fetch` or
 * `this._fetchWithInit`: `send()` POST (`...this._requestInit` + `_fetch`),
 * `terminateSession()` DELETE (same), `resumeStream()`/reconnect (`_fetch` via
 * `_startOrAuthSse`), and the auth-provider calls (`_fetchWithInit`, plus one
 * `fetchFn: this._fetch` in the 403 upscoping branch — unreachable in this
 * product because `createTransport` never passes an `authProvider`). The SSE
 * `retry:` field only feeds a reconnection DELAY and the `endpoint` event
 * belongs to the deprecated HTTP+SSE transport this one does not parse, so
 * neither can name a new URL; `_url` is assigned once, in the constructor.
 *
 * Fail-loud: {@link ensureMcpTransportRedirectFence} verifies the seam
 * behaviourally and throws {@link McpTransportFenceUnavailableError} when it
 * cannot — `registerMcp` then refuses to register any streamable-http server
 * instead of connecting unfenced. The field names are SDK internals; the
 * verification is what keeps a future SDK build from silently disabling the
 * fence.
 *
 * The identity check that guards the build coupling is deliberately NOT
 * fail-closed on a path-spelling difference: it refuses when both resolutions
 * are readable and name different files (the measured R5 failure), and only
 * warns when one of them cannot be read at all — see
 * {@link verifyTargetsTheMcpClientSdk} for the field report that produced that
 * split.
 *
 * Build coupling: `@modelcontextprotocol/sdk` must stay EXTERNAL in this
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
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/** Thrown when the streamable-http transport seam could not be fenced. */
export class McpTransportFenceUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpTransportFenceUnavailableError'
  }
}

/** Per-instance storage behind the patched accessors (never a prototype field). */
const rawRequestInit = new WeakMap<object, RequestInit | undefined>()
const rawFetchWithInit = new WeakMap<object, unknown>()
const rawFetch = new WeakMap<object, unknown>()

/**
 * Marks a `fetch` this module already wraps.
 *
 * Two jobs: a re-install never double-wraps, and the behavioural probe can tell
 * a fenced fetch from a caller's raw one without calling it.
 */
const FENCED_FETCH = Symbol('picoaide.mcp.transport-fence.fenced-fetch')

/** The SDK module `dsh-mcp-client` constructs its streamable-http transport from. */
const SDK_TRANSPORT_SUBPATH = '@modelcontextprotocol/sdk/client/streamableHttp.js'
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'
const SDK_PACKAGE_MARKER = 'node_modules/@modelcontextprotocol/sdk'

const REQUEST_INIT_FIELD = '_requestInit'
const FETCH_WITH_INIT_FIELD = '_fetchWithInit'
const FETCH_FIELD = '_fetch'
/** Header the probe instance carries, so a leaked probe is recognizable. */
const PROBE_HEADER = 'x-picoaide-transport-fence'
/** Never contacted: the probe always supplies its own recording `fetch`. */
const PROBE_URL = 'http://127.0.0.1:1/mcp'

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
 * Make two spellings of one file compare equal — and only those.
 *
 * The identity check compares a path this module resolved with one mcp-client
 * resolved. Both go through the SAME Node ESM resolver and the same
 * `fileURLToPath`, so on a normal install they are already byte-identical; but
 * the packaged product (Electron + `app.asar`) and Windows add spellings that
 * differ while naming one file: `/` vs `\`, `\\?\C:` vs `C:`, 8.3 short names
 * (`PROGRA~1`) on one side only, and case. Comparing raw strings turned any of
 * those into a hard refusal — a customer's connector stopped registering for a
 * path-spelling difference (2026-09-13, Moka `streamable-http`), which is why
 * the comparison is canonical: separators normalised, extended-length prefix
 * stripped, and case folded where the platform folds it.
 *
 * Canonical is deliberately NOT aggressive: no symlink following is invented
 * here (`fs.realpathSync` is tried first and its answer is what gets
 * canonicalised), no short-name expansion (Windows only does that through
 * `fs.realpathSync.native`, whose case behaviour cannot be reasoned about
 * offline). A spelling the rules do not cover still counts as different —
 * {@link describeTargets} then says so, and the caller decides between refusing
 * (proven different file) and warning (unreadable path).
 */
export function canonicalMcpTargetPath(path: string, foldCase = process.platform === 'win32'): string {
  let value = path.replace(/\\/g, '/')
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

/** Whether both sides name the same file — string compare of canonical forms. */
function sameFile(a: TargetResolution, b: TargetResolution): boolean {
  return a.canonical === b.canonical
}

/**
 * One log line with everything needed to tell the three failure shapes apart
 * without another round trip: the raw spellings, the canonical ones that were
 * compared, and whether each path was readable at all.
 */
function describeTargets(ours: TargetResolution | null, theirs: TargetResolution | null): string {
  const side = (label: string, value: TargetResolution | null): string =>
    value === null
      ? `${label}=<resolve failed>`
      : `${label}=${value.path} [canonical ${value.canonical}${value.error === null ? '' : ` unreadable:${value.error}`}]`
  return `${side('本包', ours)} / ${side('mcp-client', theirs)}`
}

/** What the runtime identity check concluded. */
export type TargetVerdict =
  | { kind: 'ok'; ours: TargetResolution; theirs: TargetResolution }
  | { kind: 'unresolved'; detail: string }
  | { kind: 'proven-other'; ours: TargetResolution; theirs: TargetResolution }
  | { kind: 'inconclusive'; ours: TargetResolution | null; theirs: TargetResolution | null }

/**
 * Check that the class this module patches is the class `dsh-mcp-client` will
 * use — without turning a path SPELLING into a refusal.
 *
 * The identity is what makes the fence real: `createTransport` in
 * `dsh-mcp-client` builds `StreamableHTTPClientTransport` from its OWN import
 * of the SDK, so patching any other copy (an inlined one, or a nested install
 * with a conflicting version range) would silently protect nothing.
 *
 * The comparison is the resolved FILE, not the package directory: the SDK ships
 * BOTH `dist/esm` and `dist/cjs` under one package root, and patching the ESM
 * class while the host loads the CJS one (or the reverse) would leave every
 * channel unfenced while a directory comparison still said "same package" —
 * measured in R5: the CJS copy of this class follows a redirect exactly like
 * the unfenced ESM one. The parent URL is mcp-client's own entry, so the second
 * resolution runs the ESM resolver over mcp-client's import conditions — the
 * same answer its static `import` gets at runtime.
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
 */
function verifyTargetsTheMcpClientSdk(): TargetVerdict {
  let oursPath = ''
  let theirsPath = ''
  try {
    oursPath = fileURLToPath(import.meta.resolve(SDK_TRANSPORT_SUBPATH))
    const mcpEntry = import.meta.resolve(MCP_CLIENT_PACKAGE)
    theirsPath = fileURLToPath(resolveFromParent(SDK_TRANSPORT_SUBPATH, mcpEntry))
  } catch (error) {
    return { kind: 'unresolved', detail: String(error) }
  }
  return judgeTargets(oursPath, theirsPath)
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
  if (sameFile(ours, theirs)) return { kind: 'ok', ours, theirs }
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

function protoOf(): Proto {
  return StreamableHTTPClientTransport.prototype as unknown as Proto
}

function patchField(
  field: string,
  wrap: (value: unknown) => unknown,
  store: WeakMap<object, unknown>,
  fallback?: () => unknown,
): void {
  Object.defineProperty(protoOf(), field, {
    configurable: true,
    enumerable: false,
    get(this: object): unknown {
      // The fallback only exists for `_fetch`: the SDK calls
      // `(this._fetch ?? fetch)`, so a missing instance value must resolve to
      // OUR wrapper (never to the global fetch). `_requestInit` deliberately
      // has none — an SDK build that stops assigning it must fail the
      // behavioural verification below, not be papered over.
      return store.get(this) ?? fallback?.()
    },
    set(this: object, value: unknown): void {
      store.set(this, wrap(value))
    },
  })
}

function forceManual(init: RequestInit | undefined): RequestInit {
  // Ours wins over whatever the caller passed: a definition (or a future
  // mcp-client build) cannot ask for redirects to be followed.
  return { ...(init ?? {}), redirect: 'manual' }
}

/** The global fetch, behind one indirection so the wrapper never relies on `this`. */
const globalFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

/**
 * Wrap a fetch so `redirect: 'manual'` is forced onto EVERY request it makes,
 * whatever init the SDK passes (`_startOrAuthSse` passes none).
 *
 * An already-fenced fetch is returned untouched, so installing the fence twice
 * cannot build a wrapper tower.
 * @param base - the fetch to force, or undefined for the global one.
 * @returns a marked, redirect-refusing fetch.
 */
function forcedRedirectFetch(base: FetchLike | undefined): FetchLike {
  const target = base ?? globalFetch
  if ((target as { [FENCED_FETCH]?: unknown })[FENCED_FETCH] === true) return target
  const wrapped: FetchLike = (input, init) => target(input, forceManual(init))
  Object.defineProperty(wrapped, FENCED_FETCH, { value: true, enumerable: false })
  return wrapped
}

/** Whether one value is a fetch this module already fenced. */
function isFencedFetch(value: unknown): boolean {
  return typeof value === 'function' && (value as { [FENCED_FETCH]?: unknown })[FENCED_FETCH] === true
}

/**
 * The one wrapper used when a transport was built without a `fetch` option —
 * the production shape. Cached so every instance (and the getter fallback)
 * shares one identity instead of minting a wrapper per read.
 */
let defaultFencedFetch: FetchLike | null = null

function defaultFetchFence(): FetchLike {
  defaultFencedFetch ??= forcedRedirectFetch(undefined)
  return defaultFencedFetch
}

function patchTransportClass(): () => void {
  const proto = protoOf()
  const previousRequestInit = Object.getOwnPropertyDescriptor(proto, REQUEST_INIT_FIELD)
  const previousFetchWithInit = Object.getOwnPropertyDescriptor(proto, FETCH_WITH_INIT_FIELD)
  const previousFetch = Object.getOwnPropertyDescriptor(proto, FETCH_FIELD)
  patchField(REQUEST_INIT_FIELD, value => forceManual(value as RequestInit | undefined), rawRequestInit as WeakMap<object, unknown>)
  patchField(
    FETCH_WITH_INIT_FIELD,
    (value) => {
      if (typeof value !== 'function') return value
      const original = value as FetchLike
      const wrapped: FetchLike = (input, init) => original(input, forceManual(init))
      return wrapped
    },
    rawFetchWithInit,
  )
  // R5: `_startOrAuthSse()` builds its GET without `...this._requestInit`, so
  // the init accessor cannot reach it. `_fetch` is the only fetch that path
  // uses — fence it, and supply our own when the caller passed none (the
  // production case: `createTransport` passes `requestInit` only).
  patchField(
    FETCH_FIELD,
    value => (typeof value === 'function' ? forcedRedirectFetch(value as FetchLike) : defaultFetchFence()),
    rawFetch as WeakMap<object, unknown>,
    defaultFetchFence,
  )
  return () => {
    restoreField(REQUEST_INIT_FIELD, previousRequestInit)
    restoreField(FETCH_WITH_INIT_FIELD, previousFetchWithInit)
    restoreField(FETCH_FIELD, previousFetch)
  }
}

function restoreField(field: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) delete protoOf()[field]
  else Object.defineProperty(protoOf(), field, descriptor)
}

/**
 * Verify — behaviourally — that the patched class really hands
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
 * (2) and (3) exist because R5 proved the hole: `_startOrAuthSse()` calls
 * `(this._fetch ?? fetch)(url, { method: 'GET', … })` with NO `_requestInit`,
 * so a version of this check that only drove `send()` reported `verified=true`
 * while the SSE channel — the one that leaks as soon as a server answers
 * `initialize` 200 + `initialized` 202 — was still unfenced. Both the
 * "did the GET go through the fenced fetch" and the "was `redirect` forced on
 * it" halves are asserted: a future SDK that calls the global `fetch` directly
 * (or a subclass that re-points `_fetch`) fails here.
 *
 * Any failure lands on {@link McpTransportFenceUnavailableError}, which
 * `registerMcp` turns into a refusal to register the server.
 */
async function verifyFenceSeam(): Promise<void> {
  const seen: Array<{ method: string; redirect: unknown }> = []
  const probeFetch: FetchLike = async (_input, init) => {
    const method = init?.method ?? 'GET'
    seen.push({ method, redirect: init?.redirect })
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
  // A future SDK that switches these to class fields (`_fetch = …`) would
  // create own data properties and silently bypass every accessor below.
  for (const field of [REQUEST_INIT_FIELD, FETCH_WITH_INIT_FIELD, FETCH_FIELD]) {
    if (Object.getOwnPropertyDescriptor(probe, field) !== undefined) {
      throw new McpTransportFenceUnavailableError(
        `MCP streamable-http 传输的 ${field} 已是实例自有属性（SDK 改用类字段，原型访问器被绕开）`,
      )
    }
  }
  const requestInit = internals[REQUEST_INIT_FIELD] as RequestInit | undefined
  if (requestInit?.redirect !== 'manual') {
    throw new McpTransportFenceUnavailableError(
      `MCP streamable-http 传输的 ${REQUEST_INIT_FIELD} 未被拦截（SDK 内部字段或构造方式已变更）`,
    )
  }
  const fetchWithInit = internals[FETCH_WITH_INIT_FIELD]
  if (typeof fetchWithInit !== 'function') {
    throw new McpTransportFenceUnavailableError(`MCP streamable-http 传输的 ${FETCH_WITH_INIT_FIELD} 不可拦截`)
  }
  const fetchField = internals[FETCH_FIELD]
  if (!isFencedFetch(fetchField)) {
    throw new McpTransportFenceUnavailableError(
      `MCP streamable-http 传输的 ${FETCH_FIELD} 未被拦截（GET/SSE 通道会回落到默认 fetch 并跟随重定向）`,
    )
  }
  // The production construction passes NO `fetch`: `(this._fetch ?? fetch)` must
  // still resolve to our wrapper, never to the global fetch's follow default.
  const bareFetch = (new StreamableHTTPClientTransport(new URL(PROBE_URL), {
    requestInit: { headers: { [PROBE_HEADER]: '1' } },
  }) as unknown as Record<string, unknown>)[FETCH_FIELD]
  if (!isFencedFetch(bareFetch) || bareFetch === globalThis.fetch) {
    throw new McpTransportFenceUnavailableError(`MCP streamable-http 传输未提供 ${FETCH_FIELD} 的加固包装（默认 fetch 会跟随重定向）`)
  }
  // The auth-provider path builds its own fetch: prove it is fenced too.
  seen.length = 0
  await (fetchWithInit as FetchLike)(PROBE_URL, { method: 'POST' }).catch(() => undefined)
  if (seen[0]?.redirect !== 'manual') {
    throw new McpTransportFenceUnavailableError(`MCP streamable-http 传输的 ${FETCH_WITH_INIT_FIELD} 未强制 redirect:'manual'`)
  }
  // The request path that actually carries the credentials and the body.
  seen.length = 0
  await probe.send({ jsonrpc: '2.0', method: 'ping', id: 1 } as never).catch(() => undefined)
  if (!seen.some(call => call.method === 'POST' && call.redirect === 'manual')) {
    throw new McpTransportFenceUnavailableError("MCP streamable-http 传输未强制 redirect:'manual'")
  }
  // THE SPEC CHAIN: `initialize` 200 → `notifications/initialized` 202 → the
  // SDK opens the GET(SSE) stream by itself (R5 hole).
  seen.length = 0
  await probe.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never).catch(() => undefined)
  await settleProbe(() => seen.some(call => call.method === 'GET'))
  const sse = seen.find(call => call.method === 'GET')
  if (sse === undefined) {
    throw new McpTransportFenceUnavailableError('MCP streamable-http 传输的 GET(SSE) 流未经过可拦截的 fetch（重定向栅栏对 SSE 通道无效）')
  }
  if (sse.redirect !== 'manual') {
    throw new McpTransportFenceUnavailableError("MCP streamable-http 传输的 GET(SSE) 流未强制 redirect:'manual'")
  }
  // Reconnect/resume uses the same GET path, but is awaited — drive it too.
  seen.length = 0
  await probe.resumeStream('probe-event-id').catch(() => undefined)
  const resumed = seen.find(call => call.method === 'GET')
  if (resumed === undefined || resumed.redirect !== 'manual') {
    throw new McpTransportFenceUnavailableError("MCP streamable-http 传输的 resumeStream() 未强制 redirect:'manual'")
  }
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
 * @returns a function restoring the SDK's original property descriptors.
 */
export function installMcpTransportRedirectFence(targets?: { ours: string; theirs: string }): () => void {
  if (patched) return () => {}
  const verdict = targets === undefined
    ? verifyTargetsTheMcpClientSdk()
    : judgeTargets(targets.ours, targets.theirs)
  if (verdict.kind === 'unresolved') {
    throw new McpTransportFenceUnavailableError(`无法定位 MCP streamable-http 传输实现: ${verdict.detail}`)
  }
  if (verdict.kind === 'proven-other') {
    targetMismatch = true
    throw new McpTransportFenceUnavailableError(
      `MCP streamable-http 传输加固目标与 mcp-client 不一致（${describeTargets(verdict.ours, verdict.theirs)}），拒绝注册`,
    )
  }
  if (verdict.kind === 'inconclusive') {
    // One side could not be read, so "different strings" is not evidence: the
    // behavioural verification below is the real gate. Keep the report — a
    // connector that later fails to fence must not look like a clean install.
    targetWarning = describeTargets(verdict.ours, verdict.theirs)
  }
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
export async function ensureMcpTransportRedirectFence(): Promise<void> {
  if (failure !== null) throw failure
  if (verified) return
  // Concurrent registrations share one verification: a second caller must not
  // observe "patched" before the seam was proven, or it could register a
  // transport during the window the fence is still unproven.
  if (pendingVerification !== null) return pendingVerification
  const attempt = (async (): Promise<void> => {
    if (!patched) {
      try {
        installMcpTransportRedirectFence()
      } catch (error) {
        failure = new McpTransportFenceUnavailableError(`MCP streamable-http 传输不可加固: ${String(error)}`)
        throw failure
      }
    }
    try {
      await verifyFenceSeam()
    } catch (error) {
      uninstallMcpTransportRedirectFence()
      failure = error instanceof McpTransportFenceUnavailableError
        ? error
        : new McpTransportFenceUnavailableError(`MCP streamable-http 重定向栅栏校验失败: ${String(error)}`)
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
