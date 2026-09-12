/**
 * Outbound redirect fence for the MCP **streamable-http** transport (audit R3,
 * residual N3 / high).
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
 * two prototype accessors make every instance's `_requestInit` carry
 * `redirect: 'manual'` and wrap its `_fetchWithInit` (the auth-provider path)
 * the same way. With `redirect: 'manual'` the SDK sees the real 3xx response
 * and turns it into a `StreamableHTTPError` from its own `!response.ok` branch,
 * so a redirect is a failed connection, never a followed one.
 *
 * Fail-loud: {@link ensureMcpTransportRedirectFence} verifies the seam
 * behaviourally (a probe instance must hand a `redirect: 'manual'` init to a
 * recording fetch) and throws
 * {@link McpTransportFenceUnavailableError} when it cannot — `registerMcp`
 * then refuses to register any streamable-http server instead of connecting
 * unfenced. The field names are SDK internals; the verification is what keeps a
 * future SDK build from silently disabling the fence.
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
import { createRequire } from 'node:module'
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

/** The SDK module `dsh-mcp-client` constructs its streamable-http transport from. */
const SDK_TRANSPORT_SUBPATH = '@modelcontextprotocol/sdk/client/streamableHttp.js'
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'
const SDK_PACKAGE_MARKER = 'node_modules/@modelcontextprotocol/sdk'

const REQUEST_INIT_FIELD = '_requestInit'
const FETCH_WITH_INIT_FIELD = '_fetchWithInit'
/** Header the probe instance carries, so a leaked probe is recognizable. */
const PROBE_HEADER = 'x-picoaide-transport-fence'
/** Never contacted: the probe always supplies its own recording `fetch`. */
const PROBE_URL = 'http://127.0.0.1:1/mcp'

type Proto = Record<string, unknown>

/** The installed package directory a resolved SDK file belongs to ('' when unknown). */
function sdkPackageRoot(path: string): string {
  const index = path.lastIndexOf(SDK_PACKAGE_MARKER)
  return index < 0 ? '' : path.slice(0, index + SDK_PACKAGE_MARKER.length)
}

/**
 * Refuse to patch unless the class in this module is the class
 * `dsh-mcp-client` will use.
 *
 * The identity is what makes the fence real: `createTransport` in
 * `dsh-mcp-client` builds `StreamableHTTPClientTransport` from its OWN import
 * of the SDK, so patching any other copy (an inlined one, or a nested install
 * with a conflicting version range) would silently protect nothing. Resolving
 * the subpath from the mcp-client package and comparing the package directory
 * turns that into a loud, fail-closed error.
 */
function assertTargetsTheMcpClientSdk(): void {
  let ours = ''
  let theirs = ''
  try {
    ours = fileURLToPath(import.meta.resolve(SDK_TRANSPORT_SUBPATH))
    theirs = createRequire(fileURLToPath(import.meta.resolve(MCP_CLIENT_PACKAGE))).resolve(SDK_TRANSPORT_SUBPATH)
  } catch (error) {
    throw new McpTransportFenceUnavailableError(`无法定位 MCP streamable-http 传输实现: ${String(error)}`)
  }
  if (sdkPackageRoot(ours) === '' || sdkPackageRoot(ours) !== sdkPackageRoot(theirs)) {
    throw new McpTransportFenceUnavailableError(
      `MCP streamable-http 传输加固目标与 mcp-client 不一致（本包 ${ours} / mcp-client ${theirs}），拒绝注册`,
    )
  }
}

let patched = false
let verified = false
let pendingVerification: Promise<void> | null = null
let failure: McpTransportFenceUnavailableError | null = null
let restorePatched: (() => void) | null = null

function protoOf(): Proto {
  return StreamableHTTPClientTransport.prototype as unknown as Proto
}

function patchField(field: string, wrap: (value: unknown) => unknown, store: WeakMap<object, unknown>): void {
  Object.defineProperty(protoOf(), field, {
    configurable: true,
    enumerable: false,
    get(this: object): unknown {
      return store.get(this)
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

function patchTransportClass(): () => void {
  const proto = protoOf()
  const previousRequestInit = Object.getOwnPropertyDescriptor(proto, REQUEST_INIT_FIELD)
  const previousFetchWithInit = Object.getOwnPropertyDescriptor(proto, FETCH_WITH_INIT_FIELD)
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
  return () => {
    restoreField(REQUEST_INIT_FIELD, previousRequestInit)
    restoreField(FETCH_WITH_INIT_FIELD, previousFetchWithInit)
  }
}

function restoreField(field: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) delete protoOf()[field]
  else Object.defineProperty(protoOf(), field, descriptor)
}

/**
 * Verify — behaviourally — that the patched class really hands
 * `redirect: 'manual'` to the fetch the SDK owns.
 *
 * The probe builds a real transport with a recording `fetch` (no socket is
 * opened) and drives the same `send()` path that carries `initialize` and the
 * credential headers. Every failure mode of the seam (field renamed, class
 * field bypassing the accessor, SDK no longer spreading `_requestInit`) lands
 * on one of the three checks below.
 */
async function verifyFenceSeam(): Promise<void> {
  const seen: Array<RequestInit | undefined> = []
  const probeFetch: FetchLike = async (_input, init) => {
    seen.push(init)
    return new Response('', { status: 500 })
  }
  const probe = new StreamableHTTPClientTransport(new URL(PROBE_URL), {
    requestInit: { headers: { [PROBE_HEADER]: '1' } },
    fetch: probeFetch,
  })
  const requestInit = (probe as unknown as Record<string, unknown>)[REQUEST_INIT_FIELD] as RequestInit | undefined
  if (requestInit?.redirect !== 'manual') {
    throw new McpTransportFenceUnavailableError(
      `MCP streamable-http 传输的 ${REQUEST_INIT_FIELD} 未被拦截（SDK 内部字段或构造方式已变更）`,
    )
  }
  const fetchWithInit = (probe as unknown as Record<string, unknown>)[FETCH_WITH_INIT_FIELD]
  if (typeof fetchWithInit !== 'function') {
    throw new McpTransportFenceUnavailableError(`MCP streamable-http 传输的 ${FETCH_WITH_INIT_FIELD} 不可拦截`)
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
  if (seen.length === 0) {
    throw new McpTransportFenceUnavailableError('MCP streamable-http 传输的 send() 未经过可拦截的 fetch')
  }
  if (seen[0]?.redirect !== 'manual') {
    throw new McpTransportFenceUnavailableError("MCP streamable-http 传输未强制 redirect:'manual'")
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
 * @returns a function restoring the SDK's original property descriptors.
 */
export function installMcpTransportRedirectFence(): () => void {
  if (patched) return () => {}
  assertTargetsTheMcpClientSdk()
  restorePatched = patchTransportClass()
  patched = true
  return uninstallMcpTransportRedirectFence
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
