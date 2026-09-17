/**
 * MCP OAuth for connectors — built on the official protocol implementation.
 *
 * The spec (MCP 2025-06-18 authorization, RFC 9728 protected-resource
 * metadata, RFC 8414 authorization-server metadata, RFC 7591 dynamic client
 * registration, RFC 6749 §6 refresh, RFC 8707 resource indicators) is
 * implemented ONCE, by `@modelcontextprotocol/sdk`'s `auth()` orchestrator.
 * This module only supplies the storage side of the official
 * `OAuthClientProvider` interface and classifies the outcome:
 *
 *  - the access token stays fresh without anyone hand-rolling a refresh POST:
 *    the SDK reads `tokens()`, refreshes through the metadata-named token
 *    endpoint, calls `saveTokens()` and retries the failed request;
 *  - `expires_in` from the exchange/refresh is persisted as an absolute
 *    `expiresAt`, which is what the panel shows and what the background sweep
 *    uses to refresh *before* a call fails;
 *  - a dead grant (`invalid_grant` / `invalid_client`) is reported as
 *    `reauthorize`; a network failure stays `transient` and the stored
 *    credential is left untouched.
 *
 * Both connector shapes are covered without a second discovery path:
 * `discoverMcpOAuth` (our SSRF-policy-checked RFC 9728/RFC 8414 discovery)
 * resolves the authorization server + token endpoint, and the result is fed to
 * the SDK as saved discovery state so it does not re-discover a second time.
 *
 * @module
 */

import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { discoverMcpOAuth } from './auth.ts'
import { assertOutboundUrlAllowed, OutboundUrlBlockedError } from './outbound.ts'
import { DEFAULT_TOKEN_LIFETIME_MS, REFRESH_LEAD_MS } from './token-lifetime.ts'
import { DEFAULT_HOST_LOCALE, hostT, type HostLocale } from './host-copy.ts'
import type { ConnectorCredential } from './store.ts'

/** Persist helper shape (the real one is `ConnectorStore.updateCredential`). */
export type CredentialWriter = (id: string, patch: Partial<ConnectorCredential>) => Promise<ConnectorCredential>

/** Inputs a refresh needs from the connector definition. */
export interface OAuthTarget {
  /** RFC 9728 MCP endpoint (discovery shape). */
  discoveryUrl?: string | undefined
  /**
   * The MCP resource URL this credential authorizes. Used as the SDK `auth()`
   * server URL for definitions that publish no discovery endpoint: RFC 8707
   * resource validation then sees the resource it expects.
   */
  resourceUrl?: string | undefined
  /** Static token endpoint (definitions without published metadata). */
  tokenUrl?: string | undefined
  /** Static authorize endpoint; used only to derive the authorization server URL. */
  authorizeUrl?: string | undefined
  clientId?: string | undefined
  clientSecret?: string | undefined
  scope?: string | undefined
  redirectUri?: string | undefined
}

/** Successful refresh: the authoritative token facts to persist. */
export interface RefreshedTokens {
  accessToken: string
  refreshToken?: string
  /** Absolute epoch milliseconds. */
  expiresAt: number
}

type RefreshFailureReason =
  /** The authorization server rejected the grant: only a new authorization helps. */
  | 'reauthorize'
  /** Network / 5xx / malformed response: retry later with the same credential. */
  | 'transient'
  /** Nothing to refresh (no refresh token, no endpoint, or a public endpoint). */
  | 'not-applicable'

export interface RefreshFailure {
  ok: false
  reason: RefreshFailureReason
  message: string
}

export type RefreshOutcome = { ok: true; tokens: RefreshedTokens } | RefreshFailure

/** Thrown internally when the SDK would redirect a background refresh to a browser. */
const REAUTHORIZE_REQUIRED = 'PICO_CONNECTOR_REAUTHORIZE_REQUIRED'

/** OAuth error codes that mean "this grant is dead" (SDK `errorCode` values). */
const DEAD_GRANT_CODES = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client'])

/** Structural read of the SDK's OAuthError (`errorCode` is a public getter). */
function oauthErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { errorCode?: unknown }).errorCode
  return typeof code === 'string' ? code : undefined
}

/** Whether a credential is worth refreshing right now (sweep + panel hint). */
export function tokenNeedsRefresh(credential: ConnectorCredential, now = Date.now()): boolean {
  if (credential.refreshToken === undefined) return false
  // A credential with no recorded expiry (written before this feature, or by a
  // server that omits `expires_in`) reads as possibly stale: asking is cheap
  // and a dead grant surfaces as `reauthorize` instead of on the first tool call.
  if (credential.expiresAt === undefined) return true
  return credential.expiresAt - REFRESH_LEAD_MS <= now
}

/** The authorization server URL a target implies (metadata is resolved from it). */
function authorizationServerUrl(target: OAuthTarget): string | undefined {
  const source = target.discoveryUrl ?? target.tokenUrl ?? target.authorizeUrl
  if (!source) return undefined
  try {
    return new URL(source).origin
  } catch {
    return undefined
  }
}

/**
 * Build the official `OAuthClientProvider` over one credential.
 *
 * `discovery` is the already-policy-checked endpoint information; passing it
 * as saved discovery state is the SDK's documented way to avoid a second
 * discovery round trip (`OAuthClientProvider.discoveryState`).
 */
export function createOAuthProvider(
  options: {
    credential: ConnectorCredential
    target: OAuthTarget
    discovery?: { authorizationServerUrl: string; tokenEndpoint: string } | undefined
    /** RFC 8707 resource indicator the grant stays bound to. */
    resource?: string | undefined
    /** Redirect URL for an interactive flow; `undefined` keeps it non-interactive. */
    redirectUrl?: string | undefined
    onPersist?: ((patch: Partial<ConnectorCredential>) => Promise<void> | void) | undefined
    /**
     * Ensure the credential is fresh through the caller's per-connector
     * single-flight; resolves with the refreshed tokens (or `null` when nothing
     * was refreshed). Injected by `registerMcp` so the SDK's `tokens()` and our
     * own refresh paths share ONE owner (2026-09-17).
     */
    ensureFresh?: (() => Promise<RefreshedTokens | null>) | undefined
  },
): {
  provider: OAuthClientProvider
  /** The provider's live view of the tokens (updated by `saveTokens` and `adopt`). */
  readonly tokens: OAuthTokens | undefined
  /**
   * Adopt tokens obtained by a refresh **we** ran, so the SDK's next 401
   * self-heal presents the rotated credential instead of the consumed one.
   */
  adopt: (next: RefreshedTokens) => void
} {
  const { credential, target } = options
  const ensureFresh = options.ensureFresh
  /** 绝对过期时刻（ms）；`adopt` / SDK 的 `saveTokens` 都会更新它。 */
  let expiresAt: number | undefined = credential.expiresAt
  const adoptTokens = (next: RefreshedTokens): void => {
    // A rotation MAY omit a new refresh token; keep the one we hold rather
    // than dropping the only material a later refresh needs.
    const refreshToken = next.refreshToken ?? tokens?.refresh_token
    expiresAt = next.expiresAt
    tokens = {
      access_token: next.accessToken,
      token_type: 'Bearer',
      ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
      expires_in: Math.max(0, Math.round((next.expiresAt - Date.now()) / 1000)),
    }
  }
  let tokens: OAuthTokens | undefined = credential.accessToken === undefined
    ? undefined
    : {
        access_token: credential.accessToken,
        token_type: 'Bearer',
        ...(credential.refreshToken === undefined ? {} : { refresh_token: credential.refreshToken }),
        ...(credential.expiresAt === undefined ? {} : { expires_in: Math.max(0, Math.round((credential.expiresAt - Date.now()) / 1000)) }),
      }
  let clientInformation: OAuthClientInformationMixed | undefined = credential.clientId === undefined
    ? undefined
    : {
        client_id: credential.clientId,
        ...(credential.clientSecret === undefined ? {} : { client_secret: credential.clientSecret }),
      }
  const redirectUri = options.redirectUrl ?? target.redirectUri
  const clientMetadata: OAuthClientMetadata = {
    client_name: 'MCP Connector',
    redirect_uris: [...(redirectUri === undefined || redirectUri === '' ? [] : [redirectUri])],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: credential.clientSecret === undefined ? 'none' : 'client_secret_post',
    ...(target.scope === undefined ? {} : { scope: target.scope }),
  }
  const serverUrl = target.discoveryUrl

  const provider = {
    // No redirect URL: the refresh path must never fall through to opening a
    // browser (there is no user gesture and no callback server here).
    redirectUrl: undefined,
    clientMetadata,
    clientInformation: () => clientInformation,
    saveClientInformation: async (information: OAuthClientInformationMixed) => {
      clientInformation = information
      await options.onPersist?.({ clientId: information.client_id })
    },
    /**
     * Refresh through **our** single-flight, then hand the SDK fresh tokens.
     *
     * 只有一个刷新主人的收口（2026-09-17）：SDK 的 401 自愈会读出 refresh token
     * 自己换一次（`authInternal` → `tokens()` → `refreshAuthorization`），而这条
     * 路径**不在** `TokenRefresher.inflight` 里。它一旦和我们的刷新（心跳/面板/
     * 重开恢复）并发，同一个单次 refresh token 会被出示两次，启用轮换复用检测的
     * 授权服务器（RFC 6749 §10.4）会吊销整个授权 —— CI 里表现为
     * `InvalidGrantError: refresh token already used`。
     *
     * SDK 的四个 `tokens()` 调用点全部是 `await provider.tokens()`，所以这里可以
     * 在交出令牌前先确保新鲜：快过期/已过期时走同一个 per-id 单飞，SDK 拿到的
     * 永远是当前世代，于是它不会再发起自己的刷新 —— 刷新的主人只剩我们一个。
     *
     * 未注入 `ensureFresh`（没有 OAuth target / 无刷新材料）时保持原语义。
     * @returns 该 provider 当前持有的令牌（刷新失败时仍是旧的，交给 SDK 走原来的
     *   escalate 路径）。
     */
    tokens: async (): Promise<OAuthTokens | undefined> => {
      // 与 `tokenNeedsRefresh` 同判据，但用**活的** `expiresAt`（`adopt` /
      // `saveTokens` 都会前移它）：没有 refresh token 的连接器永不在这里刷新；
      // 未记录过期时间视为可能过期（问一次很便宜）。
      const needsFresh = credential.refreshToken !== undefined
        && (expiresAt === undefined || expiresAt - REFRESH_LEAD_MS <= Date.now())
      if (ensureFresh !== undefined && needsFresh) {
        try {
          const fresh = await ensureFresh()
          if (fresh !== null) adoptTokens(fresh)
        } catch {
          // 刷新失败不改写这里的行为：交回旧令牌，SDK 随后按原路径处理
          // （transient 由上层退避，dead grant 由 saveTokens/401 链路升级为
          // 「需要重新授权」）。
        }
      }
      return tokens
    },
    saveTokens: async (next: OAuthTokens) => {
      tokens = next
      expiresAt = Date.now() + (next.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_MS / 1000 : next.expires_in) * 1000
      await options.onPersist?.({
        accessToken: next.access_token,
        ...(next.refresh_token === undefined ? {} : { refreshToken: next.refresh_token }),
        // `expires_in` is seconds-from-now; store the absolute instant once.
        expiresAt: Date.now() + (next.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_MS / 1000 : next.expires_in) * 1000,
        refreshedAt: Date.now(),
      })
    },
    // RFC 6749 §6 refresh grant in the SDK's own parameter object — the
    // endpoint comes from the discovered metadata, not from a URL we build.
    prepareTokenRequest: () => {
      if (tokens?.refresh_token === undefined) throw new Error(REAUTHORIZE_REQUIRED)
      // RFC 6749 §6: a refresh request MAY carry `scope`, but omitting it means
      // "keep the originally granted scope" — and only that form is
      // interoperable. Measured against a real authorization server
      // (2026-09-14): echoing the configured scope back (the SDK passes the
      // client-metadata scope into this hook) got the refresh rejected with
      // `invalid_scope` — "refresh scope 超出原授权范围" — which turned into an
      // endless 401 → refresh-fails → backoff loop on the MCP transport.
      return new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        ...(options.resource === undefined ? {} : { resource: options.resource }),
      })
    },
    // The SDK's default validation rejects a server-published resource that is
    // not the origin/path of our server URL. For a static-endpoint definition we
    // hand `auth()` the MCP URL, and the authorization server may publish a
    // sibling resource (or none); the definition's own MCP URL stays
    // authoritative for the bearer token, so accept either value.
    validateResourceURL: async (serverUrl: string | URL, resource?: string) => {
      const requested = typeof serverUrl === 'string' ? serverUrl : serverUrl.toString()
      const origin = new URL(requested).origin
      if (resource === undefined) return undefined
      if (resource === requested || resource === origin || resource.startsWith(`${origin}/`)) {
        return new URL(resource)
      }
      return undefined
    },
    redirectToAuthorization: () => {
      // Reached only when the grant is dead; the panel must drive a new
      // authorization, never this background call.
      throw new Error(REAUTHORIZE_REQUIRED)
    },
    saveCodeVerifier: () => {},
    codeVerifier: () => '',
    ...(options.discovery === undefined || serverUrl === undefined
      ? {}
      : {
          discoveryState: (): OAuthDiscoveryState => ({
            authorizationServerUrl: options.discovery!.authorizationServerUrl,
            authorizationServerMetadata: {
              issuer: options.discovery!.authorizationServerUrl,
              authorization_endpoint: target.authorizeUrl ?? options.discovery!.authorizationServerUrl,
              token_endpoint: options.discovery!.tokenEndpoint,
              response_types_supported: ['code'],
              grant_types_supported: ['authorization_code', 'refresh_token'],
              token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
            },
          }),
        }),
  }

  return {
    provider: provider as unknown as OAuthClientProvider,
    get tokens() { return tokens },
    /**
     * Adopt tokens **our own** refresher obtained out of band.
     *
     * The SDK's `saveTokens` is the only other writer, and it only runs when the
     * SDK itself refreshed. A refresh we performed (background sweep, the
     * panel's refresh button, or the restore path) rotates the refresh token in
     * the store while this provider keeps the **consumed** one in memory — so
     * the SDK's next 401 self-heal presents a dead grant and a rotation-aware
     * server answers `invalid_grant: refresh token already used`, which per
     * RFC 6749 §10.4 revokes the whole grant. Measured 2026-09-16 in CI as
     * `InvalidGrantError: refresh token already used` from
     * `StreamableHTTPClientTransport.send` → `auth()` → `executeTokenRequest`.
     * @param next - the credential our refresher just persisted.
     */
    adopt(next: RefreshedTokens): void {
      adoptTokens(next)
    },
  }
}

/**
 * Resolve the authorization-server facts a refresh will use, through our
 * policy-checked discovery. Returns `null` for a public MCP endpoint (nothing
 * to authorize) and reports "no endpoint" when neither shape is available.
 */
export async function resolveAuthorizationServer(
  target: OAuthTarget,
  options: { timeoutMs?: number | undefined; locale?: HostLocale | undefined } = {},
): Promise<{ discovery?: { authorizationServerUrl: string; tokenEndpoint: string }; resource?: string; failure?: RefreshFailure }> {
  // Every failure message below is built for THIS call's locale; nothing is
  // cached at module scope (the caller resolves it per refresh request).
  const locale = options.locale ?? DEFAULT_HOST_LOCALE
  if (target.discoveryUrl) {
    const discovered = await discoverMcpOAuth(
      target.discoveryUrl,
      {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        locale,
      },
    )
    if (discovered.publicMcp) {
      return { failure: { ok: false, reason: 'not-applicable', message: hostT(locale, 'refresh.publicMcp') } }
    }
    const asUrl = discovered.authorizationServerUrl
    if (discovered.tokenEndpoint && asUrl) {
      return {
        discovery: { authorizationServerUrl: asUrl, tokenEndpoint: discovered.tokenEndpoint },
        ...(discovered.resource === undefined ? {} : { resource: discovered.resource }),
      }
    }
  }
  if (target.tokenUrl) {
    const tokenEndpoint = assertOutboundUrlAllowed(target.tokenUrl, 'OAuth token 端点', locale).toString()
    const asUrl = authorizationServerUrl(target)
    return asUrl === undefined
      ? { failure: { ok: false, reason: 'transient', message: hostT(locale, 'refresh.invalidTokenUrl') } }
      : { discovery: { authorizationServerUrl: asUrl, tokenEndpoint } }
  }
  return {
    failure: {
      ok: false,
      reason: 'not-applicable',
      message: hostT(locale, target.discoveryUrl === undefined ? 'refresh.noTokenEndpoint' : 'refresh.discoveryNoTokenEndpoint'),
    },
  }
}

/**
 * Refresh one credential through the official SDK flow. Storage is the
 * caller's business: this returns the token facts to persist.
 */
export async function refreshCredentialTokens(
  credential: ConnectorCredential,
  target: OAuthTarget,
  options: { timeoutMs?: number; locale?: HostLocale } = {},
): Promise<RefreshOutcome> {
  const locale = options.locale ?? DEFAULT_HOST_LOCALE
  if (credential.refreshToken === undefined) {
    return {
      ok: false,
      reason: 'not-applicable',
      message: hostT(locale, credential.accessToken === undefined ? 'refresh.noCredential' : 'refresh.noRefreshToken'),
    }
  }
  let resolved: Awaited<ReturnType<typeof resolveAuthorizationServer>>
  try {
    resolved = await resolveAuthorizationServer(target, options)
  } catch (error) {
    // A blocked URL must stay visible as a policy refusal, never be retried
    // against the throwaway endpoint. Discovery re-classifies the authorize /
    // token step as `auth-required`, so the original refusal rides along as the
    // `cause` (2026-09-16 R9 audit).
    if (error instanceof OutboundUrlBlockedError || (error as { cause?: unknown } | null)?.cause instanceof OutboundUrlBlockedError) throw error
    return { ok: false, reason: 'transient', message: hostT(locale, 'refresh.authorizationServerResolveFailed', { message: error instanceof Error ? error.message : String(error) }) }
  }
  if (resolved.failure) return resolved.failure

  // The provider persists through this patch buffer so a failed `auth()` never
  // half-writes a credential.
  let patch: Partial<ConnectorCredential> | undefined
  const { provider } = createOAuthProvider({
    credential,
    target,
    discovery: resolved.discovery,
    ...(resolved.resource === undefined ? {} : { resource: resolved.resource }),
    onPersist: (next) => { patch = { ...patch, ...next } },
  })
  // The SDK validates that the protected resource it derives matches this URL.
  // Prefer the RFC 8707 resource discovery published (it is exactly the value
  // that goes into the grant); without one (definitions that publish no
  // metadata) use the MCP endpoint, then the authorization server.
  // `auth()` requires a server URL: with saved discovery state it still derives
  // the RFC 8707 resource from it and rejects a mismatch. The MCP endpoint is
  // the right value in both shapes — for a discoveryUrl definition it IS the
  // discovered resource, and for a static-endpoint definition the resource the
  // SDK derives from it is deliberately allowed to differ from the authorization
  // server (the connector's MCP URL is authoritative for bearer tokens).
  const serverUrl = target.discoveryUrl ?? target.resourceUrl ?? resolved.resource ?? resolved.discovery?.authorizationServerUrl
  if (serverUrl === undefined) {
    return { ok: false, reason: 'not-applicable', message: hostT(locale, 'refresh.missingMcpEndpoint') }
  }
  try {
    const result = await auth(provider, { serverUrl })
    if (result !== 'AUTHORIZED') {
      return { ok: false, reason: 'reauthorize', message: hostT(locale, 'refresh.notCompleted') }
    }
  } catch (error) {
    const code = oauthErrorCode(error)
    const message = error instanceof Error ? error.message : String(error)
    if (message === REAUTHORIZE_REQUIRED) {
      return { ok: false, reason: 'reauthorize', message: hostT(locale, 'refresh.tokenExpired') }
    }
    if (code !== undefined && DEAD_GRANT_CODES.has(code)) {
      return { ok: false, reason: 'reauthorize', message: hostT(locale, 'refresh.grantRejected', { code }) }
    }
    return { ok: false, reason: 'transient', message: hostT(locale, 'refresh.failed', { message }) }
  }
  const saved = patch as Partial<ConnectorCredential> | undefined
  if (saved?.accessToken === undefined) {
    return { ok: false, reason: 'transient', message: hostT(locale, 'refresh.missingAccessToken') }
  }
  return {
    ok: true,
    tokens: {
      accessToken: saved.accessToken,
      // RFC 6749 §6: the server may omit a new refresh token, in which case
      // the existing one stays valid. Preserve it explicitly — the caller
      // replaces the stored credential with this patch.
      refreshToken: saved.refreshToken ?? credential.refreshToken,
      expiresAt: saved.expiresAt ?? Date.now() + DEFAULT_TOKEN_LIFETIME_MS,
    },
  }
}

/**
 * Serialized refresh per connector id (single flight).
 *
 * Races are routine — the background sweep fires while a tool call hits 401,
 * or two MCP servers of one connector call at once. A second refresh would
 * waste a round trip or, with a rotating refresh token, invalidate the token
 * the first one just stored.
 */
export class TokenRefresher {
  private readonly inflight = new Map<string, Promise<RefreshOutcome>>()

  constructor(
    private readonly deps: {
      read: (id: string) => Promise<ConnectorCredential | null>
      write: CredentialWriter
      /**
       * Compare-and-update used for the refresh result when provided.
       *
       * Receives the credential this refresh read at the start and returns null
       * when the store no longer matches it (disconnect / interactive
       * re-authorization / another user's store). A null result means the
       * refresh MUST NOT publish its tokens: they are stale or belong to an
       * authorization that no longer exists.
       */
      writeIfUnchanged?: ((id: string, expected: ConnectorCredential, patch: Partial<ConnectorCredential>) => Promise<ConnectorCredential | null>) | undefined
      /**
       * Account scope the read/write pair currently points at (e.g. the store's
       * resolved directory). Captured when the refresh starts: a CAS miss on
       * another scope means a user switch, which must stay a silent no-op.
       */
      scope?: (() => string) | undefined
      target: (id: string) => OAuthTarget | null
      /**
       * Called after a refresh actually changed the stored credential.
       *
       * The third argument is the credential as **persisted** (with the store's
       * `updatedAt`), so callers that mirror the refresh into live providers can
       * tell "my refresh is newer than the snapshot this provider was built
       * from" apart from "an interactive re-authorization has since replaced
       * it" without guessing from `expiresAt`.
       */
      onRefreshed?: ((id: string, tokens: RefreshedTokens, persisted: ConnectorCredential) => void) | undefined
      timeoutMs?: number | undefined
      /**
       * Locale of the failure text, resolved by the caller for the request that
       * triggered the refresh (panel click / background sweep). A function, not
       * a value: the sweep and the panel can run under different settings, and
       * a refresh started before a language switch must still report in the
       * language the user sees now.
       */
      locale?: (() => HostLocale) | undefined
    },
  ) {}

  isRefreshing(id: string): boolean {
    return this.inflight.has(id)
  }

  /** Refresh `id` unless it is already fresh; `force` skips the freshness check. */
  async refresh(id: string, options: { force?: boolean; locale?: HostLocale } = {}): Promise<RefreshOutcome> {
    const existing = this.inflight.get(id)
    if (existing) return await existing
    const run = this.perform(id, options.force === true, options.locale ?? this.deps.locale?.() ?? DEFAULT_HOST_LOCALE)
    this.inflight.set(id, run)
    try {
      return await run
    } finally {
      this.inflight.delete(id)
    }
  }

  private async perform(id: string, force: boolean, locale: HostLocale): Promise<RefreshOutcome> {
    const credential = await this.deps.read(id)
    if (!credential) return { ok: false, reason: 'not-applicable', message: hostT(locale, 'refresh.notConnected', { id }) }
    // Snapshot the account scope at the SAME point as the credential read; the
    // CAS below must compare against the scope this refresh started on, not the
    // one current at write time (capturing it next to the CAS made the
    // cross-account branch unreachable — 2026-09-16 audit R3-B).
    const scopeAtStart = this.deps.scope?.()
    if (!force && !tokenNeedsRefresh(credential)) {
      return {
        ok: true,
        tokens: {
          accessToken: credential.accessToken ?? '',
          ...(credential.refreshToken === undefined ? {} : { refreshToken: credential.refreshToken }),
          expiresAt: credential.expiresAt ?? Date.now() + DEFAULT_TOKEN_LIFETIME_MS,
        },
      }
    }
    const target = this.deps.target(id)
    if (!target) return { ok: false, reason: 'not-applicable', message: hostT(locale, 'refresh.unsupported', { id }) }
    let outcome: RefreshOutcome
    try {
      outcome = await refreshCredentialTokens(
        credential,
        target,
        {
          ...(this.deps.timeoutMs === undefined ? {} : { timeoutMs: this.deps.timeoutMs }),
          locale,
        },
      )
    } catch (error) {
      // A blocked URL is an active redirection attempt: surface it, never
      // silently retry against a throwaway endpoint.
      return { ok: false, reason: 'transient', message: hostT(locale, 'refresh.outboundBlocked', { message: error instanceof Error ? error.message : String(error) }) }
    }
    if (!outcome.ok) return outcome
    const patch = {
      accessToken: outcome.tokens.accessToken,
      ...(outcome.tokens.refreshToken === undefined ? {} : { refreshToken: outcome.tokens.refreshToken }),
      expiresAt: outcome.tokens.expiresAt,
      refreshedAt: Date.now(),
    }
    let persisted: ConnectorCredential
    if (this.deps.writeIfUnchanged !== undefined) {
      const cas = await this.deps.writeIfUnchanged(id, credential, patch)
      if (cas === null) {
        // The credential moved underfoot while the refresh was on the wire.
        // Never publish the stale result; but distinguish the benign cases so
        // the panel does not turn a successful outcome into a red error row:
        //  - another account's store: silent no-op;
        //  - no credential anymore (disconnect): not-applicable;
        //  - a NEWER credential on the same account (interactive re-auth or an
        //    SDK self-heal won the write order): mirror THAT credential into the
        //    live providers instead of the one this refresh obtained.
        if (this.deps.scope !== undefined && scopeAtStart !== this.deps.scope()) {
          return { ok: false, reason: 'not-applicable', message: hostT(locale, 'refresh.notConnected', { id }) }
        }
        const current = await this.deps.read(id)
        if (current === null) {
          return { ok: false, reason: 'not-applicable', message: hostT(locale, 'refresh.notConnected', { id }) }
        }
        const tokens: RefreshedTokens = {
          accessToken: current.accessToken ?? outcome.tokens.accessToken,
          ...(current.refreshToken === undefined ? {} : { refreshToken: current.refreshToken }),
          expiresAt: current.expiresAt ?? Date.now() + DEFAULT_TOKEN_LIFETIME_MS,
        }
        this.deps.onRefreshed?.(id, tokens, current)
        return { ok: true, tokens }
      }
      persisted = cas
    } else {
      persisted = await this.deps.write(id, patch)
    }
    this.deps.onRefreshed?.(id, outcome.tokens, persisted)
    return outcome
  }
}
