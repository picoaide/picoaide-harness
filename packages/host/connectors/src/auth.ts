import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ConnectorAuthRequest, ConnectorDef, DeviceAuthConfig, OAuthAuthConfig } from './types.ts'
import type { ConnectorCredential } from './store.ts'
import { assertOutboundUrlAllowed, OutboundTimeoutError, OutboundUrlBlockedError, outboundFetch } from './outbound.ts'
import { expiryFromResponse } from './token-lifetime.ts'
import { DEFAULT_HOST_LOCALE, hostT, type HostLocale } from './host-copy.ts'
import { ConnectorError } from './connector-error.ts'

/**
 * Stable code of an interactive-flow failure that means "the user has to
 * (re)authorize".
 *
 * 2026-09-16 i18n: `src/index.ts` used to decide the row's `unauthorized` state
 * (and the client its friendly copy) by looking for `授权` / `token` / `登录`
 * inside the message. Those substrings vanish in English, so the classification
 * now rides the error object. The set below is exactly the flow failures that
 * meant "authorize again" in the Chinese source text; a definition/policy
 * problem (bad URL, unsupported registration, malformed callback) stays an
 * ordinary error, as it did before.
 */
function authRequired(message: string): ConnectorError {
  return new ConnectorError('auth-required', message)
}

/**
 * Flow steps whose refusal was reported as "authorization required".
 *
 * Before 2026-09-16 that classification came from the Chinese step label
 * appearing in the error text: `OAuth 授权端点`, `OAuth token 端点` and
 * `设备授权验证地址` contain `授权`/`token`, while `MCP 端点` and the client
 * registration endpoint do not. The list below is the explicit,
 * locale-independent form of the same rule, and the message text is no longer a
 * contract.
 *
 * Two deliberate exceptions to the old rule (both yield an `error` row instead
 * of `unauthorized`) — 2026-09-16 R3 audit, pinned by
 * `tests/audit-r9-classification.spec.ts`:
 *  - a network failure at the token exchange (`fetch failed`): the old rule never
 *    matched the failure itself, only the step label;
 *  - a malformed/null upstream body, whose V8 message ("Unexpected token '<'",
 *    "…reading 'access_token'") happens to contain the letters `token`. A broken
 *    upstream response is not "authorize again".
 */
const AUTHORIZING_STEPS = new Set(['OAuth 授权端点', 'OAuth token 端点', '设备授权验证地址'])

/**
 * Failures the pre-2026-09-16 substring rule classified as "authorize again".
 *
 * The old rule matched the STEP LABEL the policy errors interpolate (`OAuth token
 * 端点 指向内网…`, `… 请求超时`). A network failure or a caller abort carries no
 * label (`fetch failed`), so it stayed an ordinary error — re-classifying every
 * throw here moved a flaky network to `unauthorized`, telling the user to
 * re-authorize something that will never succeed (2026-09-16 R2 audit).
 */
function isClassifiedStepFailure(error: unknown): boolean {
  return error instanceof OutboundUrlBlockedError || error instanceof OutboundTimeoutError
}

/** Re-classify a policy/timeout step failure, or rethrow everything else untouched. */
function markAuthorizingStep(error: unknown, what: string): never {
  if (!AUTHORIZING_STEPS.has(what) || error instanceof ConnectorError || !isClassifiedStepFailure(error)) throw error
  throw new ConnectorError('auth-required', error instanceof Error ? error.message : String(error), { cause: error })
}

/** `assertOutboundUrlAllowed` for one authorization-server flow step. */
function flowUrl(rawUrl: string, what: string, locale: HostLocale): URL {
  try {
    return assertOutboundUrlAllowed(rawUrl, what, locale)
  } catch (error) {
    markAuthorizingStep(error, what)
  }
}

/** `outboundFetch` for one authorization-server flow step. */
async function flowFetch(
  rawUrl: string,
  what: string,
  init: RequestInit,
  options: { timeoutMs?: number; locale?: HostLocale },
): Promise<Response> {
  try {
    return await outboundFetch(rawUrl, what, init, options)
  } catch (error) {
    markAuthorizingStep(error, what)
  }
}

/**
 * Auth orchestration, mirroring WorkBuddy's connector flow:
 * authStart → (open authorize URL | show verification URL + code | show token
 * form) → poll status (1.5s interval, 300s timeout) → done.
 *
 * UI interaction is pushed through `onRequest`; the flow resolves with the
 * credential patch to persist (or rejects on timeout/cancel).
 */
export interface AuthRunOptions {
  onRequest: (request: ConnectorAuthRequest) => void
  /** Abort the flow (user cancelled). */
  signal: AbortSignal
  /** Override token URL/redirect host for tests. */
  tokenUrlOverride?: string
  /** Loopback host for the OAuth callback. */
  callbackHost?: string
  /** Pre-connect settings already collected from the user. */
  fields?: Record<string, string>
  /**
   * OAuth 客户端名（客户 IdP 的授权同意页上显示的名字）。
   * 渠道化时由渠道包注入（profile.ts → ConnectorsOptions.clientName）；
   * 缺省是中性名 —— 仓库里不留厂商品牌描述。
   */
  clientName?: string
  /**
   * Deadline for the outbound requests this flow performs (conn-1). Defaults
   * to {@link OUTBOUND_REQUEST_TIMEOUT_MS}; the plugin passes its own option
   * through, tests pass a short one.
   */
  outboundTimeoutMs?: number
  /**
   * Locale for every user-visible string this flow builds (thrown errors and
   * the loopback callback page). The caller resolves it per connect request
   * from the probed `desktopRuntime`; omitting it keeps the product default,
   * which is what the pre-i18n behaviour was.
   */
  locale?: HostLocale
}

/**
 * Everything an outbound call inside this module needs besides its own
 * arguments (conn-1): the flow's cancel signal and the deadline override.
 *
 * Both are passed EXPLICITLY to every call site so discovery and dynamic client
 * registration are cancelable and bounded like the token exchange already was —
 * a user who cancels a connect, or a logout that supersedes a restore, must not
 * be parked on a socket that never answers. `locale` rides along for the same
 * reason: the error text belongs to the request that failed, not to the module.
 */
interface OutboundCallOptions {
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
  locale?: HostLocale | undefined
}

/** Build `outboundFetch`'s init + options from one flow's outbound knobs. */
function outboundCall(
  init: RequestInit,
  outbound: OutboundCallOptions,
): { init: RequestInit; options: { timeoutMs?: number; locale?: HostLocale } } {
  return {
    init: outbound.signal === undefined ? init : { ...init, signal: outbound.signal },
    // `exactOptionalPropertyTypes`: only attach the overrides when they are set.
    options: {
      ...(outbound.timeoutMs === undefined ? {} : { timeoutMs: outbound.timeoutMs }),
      ...(outbound.locale === undefined ? {} : { locale: outbound.locale }),
    },
  }
}

/**
 * The outbound knobs of one authorization flow (conn-1): its cancel signal and
 * the caller's deadline override.
 */
function flowOutboundOptions(options: AuthRunOptions): OutboundCallOptions {
  return {
    signal: options.signal,
    ...(options.outboundTimeoutMs === undefined ? {} : { timeoutMs: options.outboundTimeoutMs }),
    // Resolved by the caller per connect request; never cached in this module.
    ...(options.locale === undefined ? {} : { locale: options.locale }),
  }
}

/**
 * Locale of one outbound call's error text.
 *
 * A test or embedder that omits it gets the product default, exactly like the
 * pre-i18n build; the plugin always passes the locale it resolved for the
 * request.
 */
function outboundLocale(outbound: OutboundCallOptions): HostLocale {
  return outbound.locale ?? DEFAULT_HOST_LOCALE
}

/**
 * Device-flow probes: connectors whose poll is provider-specific (e.g. the
 * sales-easy clawId poll) register a probe under their connector id; the
 * framework surfaces the authorize URL through onRequest and awaits the probe.
 * (2026-09 清理:无任何连接器注册 probe——CLI 连接器已移除,device 默认
 * 无状态探测,注册表为空,扩展点随注册 API 一并删除。)
 */

const DEFAULT_POLL_INTERVAL_MS = 1500
const DEFAULT_POLL_TIMEOUT_MS = 300_000
const TOKEN_REQUEST_TIMEOUT_MS = 60_000

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Aborted')
}

/** RFC 7636 PKCE S256. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * OAuth 客户端名的中性缺省值。
 *
 * 刻意不含厂商品牌：仓库里不留任何品牌描述，渠道化时由渠道包注入自己的名字
 * （客户在自家 IdP 的授权同意页上应该看到自己公司的产品名）。
 */
const DEFAULT_OAUTH_CLIENT_NAME = 'Enterprise AI Connector'

/** RFC 7591 dynamic client registration; returns the issued client id. */
async function registerClient(
  auth: OAuthAuthConfig,
  redirectUri: string,
  registrationEndpoint: string,
  clientName: string,
  outbound: OutboundCallOptions = {},
): Promise<string> {
  // FIX-20: the registration endpoint may come from a remote discovery
  // document — never POST client metadata to a host outside the policy, and
  // never follow a redirect out of it (residual C).
  const call = outboundCall({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: auth.publicClient ? 'none' : 'client_secret_basic',
    }),
  }, outbound)
  const response = await outboundFetch(registrationEndpoint, 'OAuth 客户端注册端点', call.init, call.options)
  if (!response.ok) throw new Error(hostT(outboundLocale(outbound), 'auth.registrationFailed', { status: String(response.status) }))
  const data = (await response.json()) as { client_id?: string }
  if (!data.client_id) throw new Error(hostT(outboundLocale(outbound), 'auth.registrationMissingClientId'))
  return data.client_id
}

/** RFC 8414 authorization-server metadata. */
interface OAuthServerMetadata {
  authorization_endpoint?: string
  token_endpoint?: string
  registration_endpoint?: string
  scopes_supported?: string[]
}

/** MCP OAuth discovery result (spec 2025-06-18): public endpoint or the resolved OAuth endpoints. */
export interface McpOAuthDiscovery {
  publicMcp?: boolean
  /** RFC 8414 issuer / authorization server identifier (metadata `issuer`, else the discovered origin). */
  authorizationServerUrl?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  registrationEndpoint?: string
  scopes?: string
  /** RFC 8707 resource indicator: the MCP server canonical URI. */
  resource?: string
}

/**
 * MCP OAuth discovery (spec 2025-06-18): probe the MCP endpoint; a 2xx means
 * public. On 401, resolve the authorization server through RFC 9728
 * protected-resource metadata (URL from the WWW-Authenticate header, fallback
 * `/.well-known/oauth-protected-resource`), then RFC 8414 metadata at the
 * authorization server.
 */
export async function discoverMcpOAuth(mcpUrl: string, outbound: OutboundCallOptions = {}): Promise<McpOAuthDiscovery> {
  // FIX-20: the MCP endpoint itself is definition-supplied; every URL this
  // function learns from the remote side is checked before it is fetched.
  // Locale is resolved per call for the same reason as the URL check: a
  // discovery failure is reported in the language of THIS request.
  const locale = outboundLocale(outbound)
  const mcp = assertOutboundUrlAllowed(mcpUrl, 'MCP 端点', locale)
  const resource = mcp.origin + mcp.pathname.replace(/\/+$/, '')

  const probeCall = outboundCall({ headers: { Accept: 'text/event-stream', 'MCP-Protocol-Version': '2025-06-18' } }, outbound)
  const probe = await outboundFetch(mcpUrl, 'MCP 端点', probeCall.init, probeCall.options)
  if (probe.status >= 200 && probe.status < 300) return { publicMcp: true, resource }
  if (probe.status !== 401 && probe.status !== 403) {
    throw new Error(hostT(locale, 'auth.mcpProbeFailed', { status: String(probe.status) }))
  }

  const authHeader = probe.headers.get('www-authenticate') ?? ''
  const metadataMatch = /resource_metadata="([^"]+)"/.exec(authHeader)
  const resourceMetadataCandidates = [
    metadataMatch?.[1],
    `${mcp.origin}/.well-known/oauth-protected-resource`,
  ].filter((url): url is string => Boolean(url))

  for (const metadataUrl of [...new Set(resourceMetadataCandidates)]) {
    // A blocked URL here is an active redirection attempt, not a typo to skip:
    // fail the flow instead of quietly trying the next candidate.
    assertOutboundUrlAllowed(metadataUrl, 'OAuth resource metadata', locale)
    const metadataCall = outboundCall({ headers: { Accept: 'application/json' } }, outbound)
    const metadataResponse = await outboundFetch(metadataUrl, 'OAuth resource metadata', metadataCall.init, metadataCall.options)
    if (!metadataResponse.ok) continue
    const resourceMetadata = (await metadataResponse.json()) as { authorization_servers?: string[] }
    const authorizationServer = resourceMetadata.authorization_servers?.[0]
    if (!authorizationServer) continue

    const asUrl = assertOutboundUrlAllowed(authorizationServer, 'OAuth authorization server', locale)
    // RFC 8414 §3: the well-known segment is inserted BETWEEN the host and the
    // issuer path (`https://host/.well-known/oauth-authorization-server/path`),
    // not appended after the path. Keeping the issuer path matters for
    // multi-tenant authorization servers; the previous spelling only worked
    // for root issuers.
    const issuerPath = asUrl.pathname.replace(/\/+$/, '')
    const wellKnownUrl = new URL(asUrl.origin)
    wellKnownUrl.pathname = `/.well-known/oauth-authorization-server${issuerPath}`
    const asCall = outboundCall({ headers: { Accept: 'application/json' } }, outbound)
    const metadataResponse2 = await outboundFetch(wellKnownUrl.toString(), 'OAuth authorization server metadata', asCall.init, asCall.options)
    if (!metadataResponse2.ok) continue
    const meta = (await metadataResponse2.json()) as OAuthServerMetadata
    if (!meta.authorization_endpoint || !meta.token_endpoint) continue
    // The RFC 8414 document names the endpoints that will receive the
    // authorization code and the PKCE verifier: check all three before use.
    // The authorize/token steps go through {@link flowUrl}: a policy-blocked
    // endpoint here is the same "authorization is impossible" failure the flow
    // steps report, and the connect flow classifies rows by the stable code
    // (the pre-2026-09-16 substring rule matched 授权/token in these messages;
    // a bare throw lost that classification — 2026-09-16 R9 audit).
    const authorizationEndpoint = flowUrl(meta.authorization_endpoint, 'OAuth 授权端点', locale).toString()
    const tokenEndpoint = flowUrl(meta.token_endpoint, 'OAuth token 端点', locale).toString()
    const registrationEndpoint = meta.registration_endpoint === undefined
      ? undefined
      : assertOutboundUrlAllowed(meta.registration_endpoint, 'OAuth 客户端注册端点', locale).toString()
    const scopes = meta.scopes_supported?.includes('offline_access')
      ? 'offline_access'
      : meta.scopes_supported?.[0]
    return {
      // The issuer identifier includes its path; returning only the origin
      // would make the SDK treat a path-based issuer as a different server.
      authorizationServerUrl: `${asUrl.origin}${issuerPath}`,
      authorizationEndpoint,
      tokenEndpoint,
      ...(registrationEndpoint ? { registrationEndpoint } : {}),
      ...(scopes ? { scopes } : {}),
      resource,
    }
  }
  // The Chinese source text ("服务器要求授权…") contained `授权`, which is what
  // classified this as `unauthorized` before; the code carries it now.
  throw authRequired(hostT(locale, 'auth.discoveryFailed'))
}

/** Run an oauth2 authorization-code flow with PKCE and a loopback callback. */
async function runOAuth(def: ConnectorDef, options: AuthRunOptions): Promise<Partial<ConnectorCredential>> {
  const auth = def.auth as OAuthAuthConfig
  // Locale of every string this flow builds: resolved ONCE per connect request
  // (from the runtime the plugin probed), then threaded into each message.
  const locale = options.locale ?? DEFAULT_HOST_LOCALE
  // conn-1: discovery is the FIRST outbound hop of this flow and used to
  // ignore the flow's cancel signal (and any deadline) entirely — a user who
  // clicked cancel stayed parked on the socket.
  const flowOutbound = flowOutboundOptions(options)
  const discovered = auth.discoveryUrl ? await discoverMcpOAuth(auth.discoveryUrl, flowOutbound) : undefined
  // The endpoint is public: no token is issued, but the successful discovery is
  // itself the result and must be persisted. Without the `publicMcp` marker a
  // restart could not tell this credential apart from a half-finished one
  // (credentialUsable demands an accessToken for oauth connectors) and every
  // tool vanished until the user manually reconnected (2026-09-15 audit).
  if (discovered?.publicMcp) return { updatedAt: Date.now(), publicMcp: true } satisfies Partial<ConnectorCredential>
  const callbackHost = options.callbackHost ?? '127.0.0.1'
  const { verifier, challenge } = pkce()
  // RFC 6749 §10.12: bind the loopback callback to this flow. A callback
  // without the matching state is rejected (and the flow keeps waiting for
  // the genuine redirect) instead of being accepted as a login.
  const state = randomBytes(24).toString('base64url')
  // P3-4: the probe listen IS the callback listen — a single listen(0) with
  // the real handler avoids the probe-close-relisten TOCTOU window in which
  // a local process could seize the port and capture the authorization code.
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  let callbackServer: ReturnType<typeof createServer> | null = null
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  // P0-1: the whole authorization flow must have a deadline and must be
  // cancelable. Without it, a user who clicked "connect" can never abort:
  // the callback server stays up and the panel hangs on "连接中…" until the
  // browser is closed. Abort (user cancel / disconnect / overall timeout)
  // closes the callback server and rejects the code promise so runAuth
  // unwinds in bounded time.
  const OAuthFlowTimeoutMs = 300_000 // 5 minutes
  const abortFlow = (reason: string): void => {
    // Guard against double-settlement: rejectCode fires only once, but the
    // callback path may race an abort — an already-settled promise is a
    // no-op, so just close the server and reject idempotently.
    callbackServer?.close()
    callbackServer?.closeIdleConnections?.()
    callbackServer = null
    rejectCode(authRequired(hostT(locale, 'auth.flowCancelled', { reason })))
  }
  const onAbort = (): void => abortFlow(options.signal.reason instanceof Error ? options.signal.reason.message : String(options.signal.reason ?? hostT(locale, 'auth.userCancelled')))
  options.signal.addEventListener('abort', onAbort, { once: true })
  const flowTimer = setTimeout(() => abortFlow(hostT(locale, 'auth.flowTimeout')), OAuthFlowTimeoutMs)
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer((req, res) => {
      // The loopback port is fixed before any request can arrive (the listen
      // callback resolves `port` first), so the captured value is used
      // instead of server.address(): after server.close() that call returns
      // null and `address.port` throws inside this request handler — an
      // uncaught exception that kills the whole host when a late keep-alive
      // request lands (e.g. the browser's /favicon.ico right after the
      // callback page). Connection: close + closeIdleConnections additionally
      // prevent the browser from reusing the callback socket.
      const url = new URL(req.url ?? '/', `http://${callbackHost}:${port}`)
      if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const codeParam = url.searchParams.get('code')
      const errorParam = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' })
      // The ONE page this package serves to the user's own browser: it must
      // follow the same locale as the panel that opened the flow.
      res.end(hostT(locale, 'auth.callbackPage'))
      server.close()
      server.closeIdleConnections()
      callbackServer = null
      if (errorParam) {
        rejectCode(authRequired(hostT(locale, 'auth.callbackFailed', { error: errorParam })))
        return
      }
      if (codeParam) resolveCode(codeParam)
      else rejectCode(new Error(hostT(locale, 'auth.callbackMissingCode')))
    })
    server.listen(0, callbackHost, () => {
      const address = server.address() as AddressInfo
      resolve(address.port)
    })
    server.on('error', reject)
    callbackServer = server
  })
  const redirectUri = `http://${callbackHost}:${port}/callback`
  const registrationEndpoint = discovered?.registrationEndpoint ?? auth.registrationEndpoint
  const clientId = registrationEndpoint
    ? await registerClient(
      auth,
      redirectUri,
      registrationEndpoint,
      options.clientName ?? DEFAULT_OAUTH_CLIENT_NAME,
      flowOutbound,
    )
    : auth.clientId || ''
  if (!clientId) throw new Error(hostT(locale, 'auth.noClientId'))
  const codeChallengeMethod = auth.pkce ? 'S256' : undefined
  const authorizeUrl = flowUrl(
    discovered?.authorizationEndpoint ?? auth.authorizeUrl,
    'OAuth 授权端点',
    locale,
  )
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('state', state)
  const scopes = discovered?.scopes ?? auth.scopes
  if (scopes) authorizeUrl.searchParams.set('scope', scopes)
  if (auth.pkce) {
    authorizeUrl.searchParams.set('code_challenge', challenge)
    authorizeUrl.searchParams.set('code_challenge_method', codeChallengeMethod ?? 'S256')
  }
  // RFC 8707: the token must be bound to the MCP server resource.
  if (discovered?.resource) authorizeUrl.searchParams.set('resource', discovered.resource)
  options.onRequest({ connectorId: def.id, authorizeUrl: authorizeUrl.toString() })
  // 无论 codePromise 成功/失败/中止都先清理:失败路径(用户拒绝/OAuth 错误/
  // abort)此前会绕过清理,残留 5 分钟 flowTimer 与 signal 上的 abort 监听
  // (2026-09-01 审计修复)。
  let code: string
  try {
    code = await codePromise
  } finally {
    // The flow settled (code received, error, or abort): stop watching for
    // further aborts and stop the timeout so the token exchange below is not
    // racing a cancelled flow.
    options.signal.removeEventListener('abort', onAbort)
    clearTimeout(flowTimer)
    callbackServer = null
  }

  throwIfAborted(options.signal)
  // FIX-20: the token exchange carries the authorization code AND the PKCE
  // verifier — the last place the outbound policy must hold.
  const tokenUrl = flowUrl(
    options.tokenUrlOverride ?? discovered?.tokenEndpoint ?? auth.tokenUrl,
    'OAuth token 端点',
    locale,
  ).toString()
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  })
  if (discovered?.resource) body.set('resource', discovered.resource)
  if (auth.pkce) body.set('code_verifier', verifier)
  // The exchange keeps its own (longer) 60 s budget: `outboundFetch` composes
  // the deadline with the flow signal, so a caller can still only shorten it.
  const tokenCall = outboundCall(
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    { ...flowOutbound, timeoutMs: TOKEN_REQUEST_TIMEOUT_MS },
  )
  const response = await flowFetch(tokenUrl, 'OAuth token 端点', tokenCall.init, tokenCall.options)
  if (!response.ok) throw authRequired(hostT(locale, 'auth.tokenExchangeFailed', { status: String(response.status) }))
  const data = (await response.json()) as Record<string, unknown>
  const accessToken = String(data.access_token ?? '')
  if (!accessToken) throw authRequired(hostT(locale, 'auth.tokenMissingAccessToken'))
  return {
    accessToken,
    clientId,
    // The panel shows this and the sweep refreshes before it lapses; without
    // it the token is treated as "possibly stale" on the next restore.
    expiresAt: expiryFromResponse(data),
    ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : {}),
  }
}

/** Refresh an access token through the connector's token endpoint. */
export async function refreshOAuthToken(
  def: ConnectorDef,
  credential: ConnectorCredential,
  options: { tokenUrlOverride?: string; signal?: AbortSignal; outboundTimeoutMs?: number; locale?: HostLocale } = {},
): Promise<Partial<ConnectorCredential> | null> {
  if (def.authMode !== 'oauth' || !credential.refreshToken) return null
  const auth = def.auth as OAuthAuthConfig
  const outbound: OutboundCallOptions = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.outboundTimeoutMs === undefined ? {} : { timeoutMs: options.outboundTimeoutMs }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credential.refreshToken,
    client_id: credential.clientId ?? auth.clientId,
  })
  // RFC 8707: refresh tokens are bound to the MCP resource too.
  if (auth.discoveryUrl) {
    const mcp = new URL(auth.discoveryUrl)
    body.set('resource', mcp.origin + mcp.pathname.replace(/\/+$/, ''))
  }
  let tokenUrl = options.tokenUrlOverride ?? auth.tokenUrl
  if (!tokenUrl && auth.discoveryUrl) {
    // conn-1: this is the hop that used to park a logout/switch behind the
    // restore (no deadline, no signal, `tokenUrl` absent).
    const discovered = await discoverMcpOAuth(auth.discoveryUrl, outbound)
    tokenUrl = discovered.tokenEndpoint ?? ''
  }
  if (!tokenUrl) return null
  // FIX-20 / residual C: a refresh POSTs the refresh token — same policy as the
  // exchange, including the redirect fence. A refused redirect is reported like
  // any other failed refresh (null): the stored credential stays untouched and
  // the connector keeps working with it.
  tokenUrl = assertOutboundUrlAllowed(tokenUrl, 'OAuth token 端点', outboundLocale(outbound)).toString()
  let response: Response
  try {
    response = await outboundFetch(tokenUrl, 'OAuth token 端点', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      ...(outbound.signal === undefined ? {} : { signal: outbound.signal }),
    }, { timeoutMs: outbound.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS })
  } catch (error) {
    if (error instanceof OutboundUrlBlockedError) return null
    throw error
  }
  if (!response.ok) return null
  const data = (await response.json()) as Record<string, unknown>
  const accessToken = String(data.access_token ?? '')
  if (!accessToken) return null
  return {
    accessToken,
    expiresAt: expiryFromResponse(data),
    ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : {}),
  }
}

/** Device-code flow: surface verification URL + user code, poll until connected. */
async function runDevice(def: ConnectorDef, options: AuthRunOptions): Promise<Partial<ConnectorCredential>> {
  const auth = def.auth as DeviceAuthConfig
  // conn-4: `verificationUrl` is definition-supplied (the server-issued
  // catalog carries it) and the client renders it as a clickable `<a href>`.
  // It was the ONLY definition-controlled URL in this package that skipped the
  // outbound policy — `javascript:alert(document.domain)//` reached the panel
  // verbatim. Check it exactly like its sibling `authorizeUrl`, and fail the
  // connect loudly (a device row whose verification page is unusable must not
  // silently report "connected").
  const locale = options.locale ?? DEFAULT_HOST_LOCALE
  const verificationUrl = flowUrl(auth.verificationUrl, '设备授权验证地址', locale).toString()
  options.onRequest({
    connectorId: def.id,
    verificationUrl,
  })
  return pollUntilConnected(createProbe(def, options), auth.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, auth.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS, options.signal, locale)
}

interface AuthProbe {
  /** Optional: obtain the user code to display. */
  issueUserCode?: () => Promise<string>
  /** Resolve true once the user finished authorizing. */
  isConnected: () => Promise<boolean>
}

/**
 * Device-flow probe: the flow is stateless (2026-08-25 decision — the CLI
 * connector was removed and no device-token endpoint is polled), so "the flow
 * finished" is all this can observe.
 *
 * 2026-09-23 审计 CN-3 was about the ROW claiming `connected` without any
 * authorization artifact — the probe was never the right place to fix that:
 * the URL policy of `verificationUrl` is enforced HERE (before the poll) and
 * `tests/device-verification-url-policy.spec.ts` pins that a well-formed
 * verification address resolves, while the artifact question is answered where
 * the credential is judged (`index.ts`: `credentialUsable` + the post-flow
 * gate, which leaves the row `unauthorized` and registers nothing when a
 * device connector holds neither a declared field value, an access token nor
 * the public-endpoint marker). Keeping the two apart is what makes both
 * invariants testable: a bad URL fails HERE, a missing artifact fails THERE.
 * @param def - connector definition.
 * @param options - the connect request.
 * @returns the probe the poll loop asks.
 */
function createProbe(def: ConnectorDef, options: AuthRunOptions): AuthProbe {
  void def
  void options
  return { isConnected: async () => true }
}

async function pollUntilConnected(
  probe: AuthProbe,
  pollIntervalMs: number,
  pollTimeoutMs: number,
  signal: AbortSignal,
  locale: HostLocale,
): Promise<Partial<ConnectorCredential>> {
  const deadline = Date.now() + pollTimeoutMs
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    await sleep(pollIntervalMs, signal)
    if (await probe.isConnected()) return { updatedAt: Date.now() } as Partial<ConnectorCredential>
  }
  throw authRequired(hostT(locale, 'auth.pollTimeout'))
}

/** Token form flow: emit the field list; the UI answers with the values. */
async function runToken(def: ConnectorDef, options: AuthRunOptions): Promise<Partial<ConnectorCredential>> {
  const fields = def.tokenFields ?? []
  options.onRequest({ connectorId: def.id, fields })
  // The UI writes fields through the service (connect -> requestFields ->
  // submitToken), so this flow only validates the shape.
  return { updatedAt: Date.now() } as Partial<ConnectorCredential>
}

/** Server-side flow: fetch the managed token through the injected callback. */
async function runServerSide(def: ConnectorDef, options: AuthRunOptions): Promise<Partial<ConnectorCredential>> {
  void def
  const locale = options.locale ?? DEFAULT_HOST_LOCALE
  const auth = def.auth as { fetchToken?: unknown }
  options.onRequest({ connectorId: def.id })
  if (typeof auth.fetchToken !== 'function') {
    // A definition that cannot carry the callback is a CONFIGURATION problem,
    // not "authorize again": the pre-2026-09-16 substring rule did not match
    // this message either (`fetchToken` has a capital T), so it stays an
    // ordinary error (2026-09-16 R9 audit).
    throw new Error(hostT(locale, 'auth.serverMissingFetchToken'))
  }
  const accessToken = await (auth.fetchToken as () => Promise<string>)()
  if (!accessToken) throw authRequired(hostT(locale, 'auth.serverNoToken'))
  return { accessToken }
}

/** Run the auth flow for a connector; returns the credential patch to persist. */
export async function runAuth(def: ConnectorDef, options: AuthRunOptions): Promise<Partial<ConnectorCredential>> {
  switch (def.authMode) {
    case 'oauth':
      return runOAuth(def, options)
    case 'device':
      return runDevice(def, options)
    case 'token':
      return runToken(def, options)
    case 'server-side':
      return runServerSide(def, options)
  }
}
