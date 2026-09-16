import type { Context } from '@deepseek-ai/cordis'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { browserSameOriginMarker, isLoopbackRequest } from './loopback.ts'
import { ConnectorStore, sameCredential } from './store.ts'
import { ConnectorError, connectorErrorCodeOf } from './connector-error.ts'
import { hostLocaleOf, hostT, type HostCopyKey, type HostLocale } from './host-copy.ts'
import { runAuth } from './auth.ts'
import { createOAuthProvider, resolveAuthorizationServer, TokenRefresher, tokenNeedsRefresh, type RefreshedTokens } from './mcp-oauth-provider.ts'
import type { OAuthTarget } from './mcp-oauth-provider.ts'
import { REFRESH_LEAD_MS, REFRESH_SWEEP_INTERVAL_MS } from './token-lifetime.ts'
import { userScopePath } from './user-scope.ts'
import { ConnectorApprovalStore } from './approvals.ts'
import {
  CONNECTOR_AUTH_MODES,
  CONNECTOR_ID_PATTERN,
  credentialFieldProblem,
  declaredCredentialKeys,
  isDeniedEnvKey,
  mcpDefinitionProblem,
  mcpServerProblem,
  sanitizeMcpEnv,
  stdioApprovalFingerprint,
  streamableHttpUrl,
} from './policy.ts'
import {
  claimMcpTransportFenceTargetWarning,
  ensureMcpTransportRedirectFence,
  McpTransportFenceUnavailableError,
  mcpTransportFenceTargetWarning,
} from './mcp-transport-fence.ts'
import type {
  ConnectorAuthRequest,
  ConnectorDef,
  ConnectorMcp,
  ConnectorMcpApproval,
  ConnectorState,
} from './types.ts'
import type { ConnectorCredential } from './store.ts'

// Type-only: declare the enterprise session event so `ctx.on` resolves it.
// The enterprise package owns the runtime event (SessionService emits it);
// this declaration lets plugins type-check without a runtime dependency.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'pico/session-changed'(session: { username?: string; token?: string; serverURL?: string } | null): void
    /**
     * A connector credential moved (refreshed token, rotated refresh token).
     * HTTP MCP servers pick it up on the next request through their auth
     * provider; stdio servers receive the token in the child environment and
     * are re-registered by this plugin in response.
     */
    'pico/connector-credentials-changed'(payload: { id: string }): void
  }
}

/**
 * Connector framework (mirrors WorkBuddy's connector service):
 * a registry of connector definitions, per-connector auth orchestration
 * (oauth redirect / device-code poll / token form / cli / server-side),
 * local token persistence, and dynamic MCP registration through
 * `ctx.plugin` once a connector connects.
 *
 * Exposes a loopback HTTP API consumed by the client settings UI:
 *   GET  /api/pico/connectors                -> list with states
 *   POST /api/pico/connectors/:id/connect    -> start auth flow
 *   POST /api/pico/connectors/:id/auth-submit-> token form values
 *   GET  /api/pico/connectors/:id/state      -> poll status + pending request
 *   POST /api/pico/connectors/:id/disconnect -> stop and forget
 */

export const name = 'pico-connectors'
export const inject = ['webServer']

/**
 * 上游 `connection` 服务（BrowserAuth 持有性检查）在本包内需要的**最小结构**。
 *
 * 与 `packages/host/enterprise/src/auth-gate.ts` 的 `ConnectionTrustFence` 同形：
 * 只用到 `requestRejection`（Host/Origin 围栏 + `dsh-auth-*` cookie 验签），
 * 结构类型 + 运行时存在性判断已足够，服务缺席时明确 fail-closed。
 */
interface ConnectionTrustFence {
  /**
   * Connection 的 Host/Origin 围栏 + BrowserAuth cookie 校验。
   * @param request - 只用到 headers(Host / Cookie)。
   * @returns 401/403 表示拒绝；undefined 表示通过。
   */
  requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

export interface ConnectorsOptions {
  /** Extra connector definitions to register. */
  connectors?: ConnectorDef[]
  /** Override the token store directory (tests). */
  storeBaseDir?: string
  /**
   * OAuth 客户端名（客户 IdP 授权同意页上显示的名字）。
   * 渠道化时由 profile.ts 从渠道包注入；缺省为中性名。
   */
  clientName?: string
  /**
   * Headless confirmation hook for server-issued stdio commands (FIX-02).
   * An interactive deployment leaves this undefined: the request then surfaces
   * through the connector panel (`request.approval`) and is answered through
   * the local `approve`/`deny` routes. Embedders and tests may answer
   * programmatically — returning false denies the spawn.
   */
  requestApproval?: (request: ConnectorMcpApproval) => boolean | Promise<boolean>
  /**
   * Deadline for one connector outbound request (conn-1). Defaults to
   * `OUTBOUND_REQUEST_TIMEOUT_MS` (30 s); tests inject a short value. Never
   * fed from a connector definition.
   */
  outboundTimeoutMs?: number
  /**
   * Interval of the background token sweep (stdio MCP servers receive their
   * token in the child environment at spawn time and cannot recover from a 401
   * by themselves, so they must be re-registered before the token lapses).
   * Defaults to `REFRESH_SWEEP_INTERVAL_MS`; 0 disables the sweep (tests).
   */
  refreshSweepIntervalMs?: number
  /**
   * 一次扫掠的**可注入钩子**（2026-09-16，测试专用）。
   *
   * 为什么需要：扫掠是"后台定时器 + 真实 HTTP 往返 + 事件扇出"的组合，
   * `audit-connectors.spec.ts` 的 PROBE A 此前靠"等下一次定时扫描"来观察
   * 恢复，在 CI（4 vCPU、多包并发）上曾多次因调度抖动在预算内等不到
   * （本地 12 进程压测亦复现 2/12）。把扫掠体抽成可注入的函数后，测试可以
   * **自己驱动扫掠**，断言的是"扫掠逻辑会恢复"这个不变量，而不是调度运气。
   * 注入的是**观察者**（拿到的是真实的扫掠函数）而不是替代实现——测试仍然
   * 跑生产代码，只是可以主动调用它，而不必等定时器。未注入时行为与原来逐字相同。
   */
  onRefreshSweepReady?: (sweep: () => Promise<void>) => void
}

type JsonHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

/** Server connector catalog item (bootstrap `connectors[]`). */
export interface ServerConnectorItem {
  id: string
  name: string
  description: string
  auth_mode: string
  definition: string
}

/**
 * Parse the server-issued connector catalog into ConnectorDef[]: the catalog
 * row wins for id/name/description/authMode; the definition JSON contributes
 * the auth/tokenFields/examples/mcp payload. Invalid entries are dropped so a
 * single bad row never blanks the whole catalog.
 *
 * FIX-02: this is a TRUST BOUNDARY, not a convenience mapper. The row's id
 * shape, the `mcp[]` entries (serverName/transport/command/args/env/url) and
 * the credential-field declarations (`tokenFields`/`settings`, whose keys end
 * up in the child environment) are all validated here, so a definition that
 * would hand `spawn` an unchecked executable, a protected env key, or a
 * non-public URL never enters the catalog at all.
 */
export function parseServerConnectors(items: ServerConnectorItem[]): ConnectorDef[] {
  const out: ConnectorDef[] = []
  for (const item of items) {
    if (!item?.id || !item.definition) continue
    if (!CONNECTOR_ID_PATTERN.test(item.id)) {
      console.warn(`[dsh-connectors] dropped connector with invalid id: ${JSON.stringify(item.id)}`)
      continue
    }
    try {
      const raw = JSON.parse(item.definition) as ConnectorDef
      if (!raw?.mcp?.length) continue
      const problem = mcpDefinitionProblem(raw.mcp) ?? credentialFieldProblem(raw)
      if (problem !== null) {
        console.warn(`[dsh-connectors] dropped connector ${item.id}: ${problem}`)
        continue
      }
      let authMode = (item.auth_mode || raw.authMode || '') as string
      if (!authMode) {
        // 回退推断:定义 JSON 的结构决定模式(tokenFields → token,
        // auth 配置 → oauth;其余按 device 保守处理)。
        if (raw.tokenFields?.length) authMode = 'token'
        else if (raw.auth) authMode = 'oauth'
        else authMode = 'device'
      }
      if (!CONNECTOR_AUTH_MODES.includes(authMode)) {
        console.warn(`[dsh-connectors] dropped connector ${item.id}: unsupported auth_mode ${JSON.stringify(authMode)}`)
        continue
      }
      // Preserve the historical empty-string fallback, but never emit
      // undefined: the settings list calls `name.toLowerCase()` while
      // searching, so a catalog row without a name used to crash the panel.
      const itemName = typeof item.name === 'string' ? item.name : ''
      const rawName = typeof raw.name === 'string' ? raw.name : ''
      const itemDescription = typeof item.description === 'string' ? item.description : ''
      const rawDescription = typeof raw.description === 'string' ? raw.description : ''
      out.push({
        ...raw,
        id: item.id,
        name: itemName !== '' ? itemName : rawName,
        description: itemDescription !== '' ? itemDescription : rawDescription,
        authMode: authMode as ConnectorDef['authMode'],
      })
    } catch {
      // 单条定义非法:跳过,不影响其他连接器。
    }
  }
  return out
}

/** Cap on connector API request bodies (settings forms are small). */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > MAX_REQUEST_BODY_BYTES) return null
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/** Decode one path segment, rejecting malformed escapes instead of throwing. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

function exact(handler: JsonHandler): (req: IncomingMessage, res: ServerResponse) => void {
  // 审计 2026-08-25 P2-3:此前 `void handler(req, res)` 丢弃 promise,disconnect
  // 等 async handler 抛错会成为 unhandledRejection——Node≥15 默认直接退出
  // 整个 Electron 主进程(browser 的 action handler 有 .catch,这里缺失)。
  // 修复:统一捕获并回 500(同步 handler 的返回值是 void,Promise.resolve 归一)。
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      console.error('[dsh-connectors] handler failed', error)
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
    }
  }
}

export function apply(ctx: Context, options: ConnectorsOptions = {}): void {
  /**
   * Host locale of THIS message.
   *
   * Resolved from the probed `desktopRuntime` on every call — never captured in
   * a constant (a module-level or apply-time capture is the bug class documented
   * in `src/client/status-label.ts`; the user can switch language while the app
   * runs). Deep modules (auth/outbound/policy/fence/refresh) receive the value
   * as an explicit argument, so their copy is resolved per request too.
   */
  const locale = (): HostLocale => hostLocaleOf(ctx)
  /**
   * Translate one host copy key in the current host locale.
   *
   * Deliberately NOT named like the client translator: the desktop i18n
   * dead-key guard (`packages/host/desktop/tests/i18n-keys.spec.ts`) treats every
   * client-translator call with a literal key in a package's sources as a CLIENT
   * dictionary key, and these keys live in the host dictionary.
   */
  const copy = (key: HostCopyKey, params?: Record<string, string>): string => hostT(locale(), key, params)
  /** State patch carrying the stable code of a caught error (see connector-error.ts). */
  const withCode = (error: unknown): { errorCode?: ReturnType<typeof connectorErrorCodeOf> } => {
    const code = connectorErrorCodeOf(error)
    return code === undefined ? {} : { errorCode: code }
  }

  // N3: the MCP streamable-http transport is constructed inside
  // `dsh-mcp-client` with its own `fetch`, so the redirect fence must be on the
  // SDK class before the first instance exists. Installing it here keeps the
  // window closed for every path (restore, panel approve, headless hook);
  // `registerMcp` re-checks and refuses a streamable-http server when the fence
  // is unavailable, so a failure here is loud, not silent.
  void ensureMcpTransportRedirectFence().catch((error: unknown) => {
    ctx.logger?.error('pico-connectors: MCP streamable-http 重定向栅栏安装失败，将拒绝注册此类连接器', error)
  })

  // 连接器目录(0042):服务端为准——bootstrap 下发 connectors[](定义 JSON),
  // 客户端无内置定义,仅保留 options.connectors 作为开发/测试注入。
  let defs: ConnectorDef[] = [...(options.connectors ?? [])]

  // 从 bootstrap 同步连接器目录:每次 session 建立/变化时拉取,用服务端
  // 下发定义整体替换(凭证按 id 匹配,定义变更不丢用户已连接的凭证)。
  // 服务端不返回/请求失败时保留当前 defs(不影响已连接的 MCP 工具)。
  const syncServerDefs = async (): Promise<void> => {
    try {
      const pico = ctx.get('picoSession') as { getSession?: () => { serverURL?: string; token?: string } | null } | undefined
      const session = pico?.getSession?.()
      if (!session?.serverURL || !session?.token) return
      // This runs inside the serial lifecycle queue: a black-holed gateway
      // must not park a logout/user switch for undici's default header
      // timeout (minutes). The bootstrap catalogue is optional; 30s is ample.
      const res = await fetch(`${session.serverURL.replace(/\/+$/, '')}/api/client/v2/config/bootstrap`, {
        headers: { Authorization: `Bearer ${session.token}` },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return
      const cfg = (await res.json()) as { connectors?: ServerConnectorItem[] }
      const items = cfg.connectors ?? []
      if (items.length === 0) {
        // 服务端未配置连接器:清空目录(连接器中心显示空;不与 options 冲突)。
        defs = [...(options.connectors ?? [])]
        return
      }
      defs = parseServerConnectors(items)
    } catch {
      /* 服务端配置获取失败不影响连接器基本功能(保留当前 defs) */
    }
  }
  void syncServerDefs()
  // Current user scope: resolved from the enterprise session when present.
  // `getSession()` is a service read guarded by type-only import, so this
  // plugin also loads in compositions without the enterprise plugin.
  const currentUser = (): string | null => {
    try {
      const pico = ctx.get('picoSession') as { getSession?: () => { username?: string } | null } | undefined
      return pico?.getSession?.()?.username ?? null
    } catch {
      return null
    }
  }

  // Per-user store. Rebuilt when the session changes; the old user's MCP
  // registrations are disconnected first (server-side tokens stay on disk
  // per user, never shared across accounts).
  let store = new ConnectorStore(options.storeBaseDir ? { baseDir: options.storeBaseDir } : { username: currentUser() })
  // Per-user local-approval ledger for server-issued stdio commands (FIX-02).
  let approvals = new ConnectorApprovalStore(options.storeBaseDir ? { baseDir: options.storeBaseDir } : { username: currentUser() })
  const states = new Map<string, ConnectorState>()
  /** Ids whose STORED credential currently carries a refresh token. */
  const refreshable = new Set<string>()

  /**
   * The refresh target of one connector: only the OAuth facts a refresh needs.
   * Kept in one place so a future MCP credential source can supply the same
   * shape without touching the engine.
   */
  const oauthTargetOf = (def: ConnectorDef): OAuthTarget | null => {
    if (def.authMode !== 'oauth') return null
    // The MCP endpoint doubles as the RFC 8707 resource the SDK validates
    // against; prefer a streamable-http URL when the definition has one.
    // Prefer the streamable-http endpoint; a stdio-only connector still has an
    // MCP identity, and its bearer token belongs to the same resource.
    const resourceUrl = (def.mcp.find(server => server.transport === 'streamable-http' && typeof server.url === 'string')
      ?? def.mcp.find(server => typeof server.url === 'string'))?.url
    const auth = def.auth as {
      discoveryUrl?: string
      tokenUrl?: string
      authorizeUrl?: string
      clientId?: string
      publicClient?: boolean
      scopes?: string
      redirectUri?: string
    } | undefined
    if (!auth) return null
    return {
      ...(resourceUrl === undefined ? {} : { resourceUrl }),
      ...(auth.discoveryUrl === undefined ? {} : { discoveryUrl: auth.discoveryUrl }),
      ...(auth.tokenUrl === undefined ? {} : { tokenUrl: auth.tokenUrl }),
      ...(auth.authorizeUrl === undefined ? {} : { authorizeUrl: auth.authorizeUrl }),
      ...(auth.clientId === undefined ? {} : { clientId: auth.clientId }),
      ...(auth.scopes === undefined ? {} : { scope: auth.scopes }),
      ...(auth.redirectUri === undefined ? {} : { redirectUri: auth.redirectUri }),
    }
  }

  /**
   * The official `OAuthClientProvider` for one streamable-http registration.
   *
   * Discovery is resolved here (through the same policy-checked routine the
   * refresh engine uses) and handed to the SDK as saved discovery state, so
   * the SDK's 401 path refreshes through the metadata-named token endpoint
   * without a second, unfenced discovery round trip.
   */
  const mcpAuthProvider = async (
    def: ConnectorDef,
    credential: ConnectorCredential | null,
  ): Promise<{ authProvider?: OAuthClientProvider; handle?: LiveProviderHandle }> => {
    const target = oauthTargetOf(def)
    if (target === null || credential?.accessToken === undefined) return {}
    // The provider (and any SDK 401 self-heal it drives) belongs to the ACCOUNT
    // that was current when this registration was built. A user switch replaces
    // `store` with a store rooted in another directory; persisting through it
    // would write this account's tokens into the next user's directory. Compare
    // the resolved directory, not the instance: a same-account session
    // re-establishment swaps the instance but keeps the directory, and that
    // write (e.g. a rotated refresh token) must not be dropped.
    const registrationScope = store.dir
    // The credential snapshot this provider was built from; every SDK
    // `saveTokens` write is compare-and-updated against it (advanced after each
    // successful write, and by syncBaseline when tokens are adopted). Without
    // this, a 401 refresh already on the wire when the user disconnects (or
    // re-authorizes) writes its stale result after the fact: it resurrects a
    // deleted credential file or overwrites the newer grant (R3-A).
    // Registration must not depend on a discovery round trip: when the token is
    // still valid and the definition already names its token endpoint, the
    // provider can refresh on 401 through that endpoint alone (the SDK calls
    // the grant; the URL is ours, not discovered).
    if (
      credential.expiresAt !== undefined
      && credential.expiresAt - Date.now() > REFRESH_LEAD_MS
      && target.tokenUrl !== undefined
    ) {
      const baseline: { current: ConnectorCredential } = { current: credential }
      const created = createOAuthProvider({
        credential,
        target,
        onPersist: (patch: Partial<ConnectorCredential>) => {
          if (registrationScope !== store.dir) return
          void persistAndMaybeAnnounce(def.id, patch, baseline.current)
            .then((saved) => { if (saved !== null) baseline.current = saved })
            .catch((cause: unknown) => {
              ctx.logger?.warn(`pico-connectors: ${def.id} 令牌持久化失败`, cause)
            })
        },
      })
      const handle: LiveProviderHandle = {
        adopt: (tokens) => created.adopt(tokens),
        syncBaseline: (next) => { baseline.current = next },
      }
      return { authProvider: created.provider, handle }
    }
    try {
      const resolved = await resolveAuthorizationServer(
        target,
        options.outboundTimeoutMs === undefined ? {} : { timeoutMs: options.outboundTimeoutMs },
      )
      if (resolved.failure) {
        // No refresh material: keep the token we have. A 401 then surfaces as
        // an ordinary tool error instead of a silent dead grant.
        ctx.logger?.warn(`pico-connectors: ${def.id} 无法解析令牌端点（${resolved.failure.message}）`)
        return {}
      }
      const baseline: { current: ConnectorCredential } = { current: credential }
      const created = createOAuthProvider({
        credential,
        target,
        discovery: resolved.discovery,
        ...(resolved.resource === undefined ? {} : { resource: resolved.resource }),
        onPersist: (patch: Partial<ConnectorCredential>) => {
          // The SDK's persistence point: a rotated refresh token or a new
          // access token must reach the store, or the next process (or the
          // next registration) would refresh with a dead grant. Never through
          // a store that a user switch has replaced in the meantime.
          if (registrationScope !== store.dir) return
          void store.updateCredentialIfUnchanged(def.id, baseline.current, patch)
            .then((saved) => {
              if (saved === null) return
              baseline.current = saved
              ctx.emit('pico/connector-credentials-changed', { id: def.id })
            })
            .catch((cause: unknown) => {
              ctx.logger?.warn(`pico-connectors: ${def.id} 令牌持久化失败`, cause)
            })
        },
      })
      const handle: LiveProviderHandle = {
        adopt: (tokens) => created.adopt(tokens),
        syncBaseline: (next) => { baseline.current = next },
      }
      return { authProvider: created.provider, handle }
    } catch (error) {
      // A policy-blocked URL is an active redirection attempt: register
      // without the provider (the SDK will report 401 plainly) and log loudly.
      ctx.logger?.error(`pico-connectors: ${def.id} 令牌端点解析被拒绝`, error)
      return {}
    }
  }

  /**
   * One live OAuth provider handle, as handed to a registered transport.
   *
   * `adopt` is the SDK-facing in-memory token mirror (`createOAuthProvider`).
   */
  interface LiveProviderHandle {
    adopt: (tokens: RefreshedTokens) => void
    /**
     * Advance the provider's CAS baseline after tokens are adopted from a
     * write that bypassed it (our own refresher / another registration). The
     * SDK's next `saveTokens` must compare against the credential currently in
     * memory, otherwise its rotation is rejected as "stale" and the consumed
     * token is left on disk (2026-09-16 audit R4).
     */
    syncBaseline: (credential: ConnectorCredential) => void
  }

  /**
   * Live OAuth providers keyed by connector id, then by MCP `serverName`.
   *
   * A connector can register several streamable-http servers; each owns its own
   * transport and its own provider, so a per-connector single slot would leave
   * every server but the last one holding a consumed refresh token (the exact
   * `invalid_grant` reuse this map exists to prevent). Handles are installed
   * only AFTER their transport actually loaded, so a registration that was
   * superseded — or whose plugin failed to load — can never displace the handle
   * of the transport that is really in use.
   */
  const liveProviders = new Map<string, Map<string, LiveProviderHandle>>()

  /** Install (or replace) the live handle of one registered server. */
  function installLiveProvider(id: string, serverName: string, handle: LiveProviderHandle): void {
    const byServer = liveProviders.get(id) ?? new Map<string, LiveProviderHandle>()
    byServer.set(serverName, handle)
    liveProviders.set(id, byServer)
  }

  /** Drop one server's handle (its transport is gone or about to be replaced). */
  function dropLiveProvider(id: string, serverName: string): void {
    const byServer = liveProviders.get(id)
    if (byServer === undefined) return
    byServer.delete(serverName)
    if (byServer.size === 0) liveProviders.delete(id)
  }

  /** Every live handle of one connector (an out-of-band refresh fans out to all). */
  function liveHandlesOf(id: string): Iterable<LiveProviderHandle> {
    return liveProviders.get(id)?.values() ?? []
  }

  /**
   * The most recent credential **our own** refresher produced, per connector.
   *
   * `registerMcp` reads the credential once and builds the provider from that
   * snapshot only later (after discovery / the outbound fence), so a refresh
   * landing in between left the new transport holding the consumed token —
   * `onRefreshed` had no handle yet to feed, and the provider was born stale.
   * Keeping the last result lets a registration that started too early catch up
   * before it goes live. The catch-up compares the persisted write's
   * `updatedAt` against the snapshot's: a later interactive re-authorization
   * (or manual credential replacement) has a larger `updatedAt` and is never
   * overwritten, while a refresh that landed mid-registration is adopted.
   */
  const latestRefresh = new Map<string, { tokens: RefreshedTokens; updatedAt: number; credential: ConnectorCredential }>()

  /**
   * Bring a freshly built provider up to the newest credential we know of.
   *
   * The ordering predicate is the **store write** (`updatedAt`), never
   * `expiresAt`: a server picks the lifetime, and an interactive
   * re-authorization can legitimately produce a shorter one. An earlier
   * background refresh must not overwrite that fresh grant; a refresh that
   * landed while this registration was still building the provider must be
   * adopted. `updatedAt` orders both correctly because every credential write
   * goes through the store's exclusive read-modify-write (see ConnectorStore).
   * @param id - connector id the provider belongs to.
   * @param handle - the provider created for the current registration.
   * @param snapshot - the credential the provider was built from.
   */
  function adoptLatestRefresh(
    id: string,
    handle: LiveProviderHandle,
    snapshot: ConnectorCredential | null | undefined,
  ): void {
    const latest = latestRefresh.get(id)
    if (latest === undefined) return
    if (latest.updatedAt <= (snapshot?.updatedAt ?? 0)) return
    handle.adopt(latest.tokens)
    // The provider in memory now holds the newer credential: its CAS baseline
    // must move with it, or the SDK's own next rotation compares against the
    // stale registration snapshot and is dropped (2026-09-16 audit R4).
    handle.syncBaseline(latest.credential)
  }

  /**
   * One refresh engine for every connector. `pico/connector-credentials-changed`
   * is how the rest of the host learns that a token moved: HTTP MCP servers
   * pick the new token up on the next request (their auth provider reads the
   * store), while stdio servers must be re-registered to receive it.
   */
  const tokenRefresher = new TokenRefresher({
    read: (id) => store.readCredential(id),
    write: (id, patch) => store.updateCredential(id, patch),
    // Refresh writes are compare-and-update against the credential the refresh
    // read: a disconnect, a newer interactive re-authorization, or a user
    // switch must make the stale result a no-op (2026-09-16 audit E5/E6).
    writeIfUnchanged: (id, expected, patch) => store.updateCredentialIfUnchanged(id, expected, patch),
    scope: () => store.dir,
    target: (id) => {
      const def = defs.find(entry => entry.id === id)
      return def ? oauthTargetOf(def) : null
    },
    // Resolved per refresh call (a language switch must not need a restart) and
    // used for the failure text of the sweep's own refreshes.
    locale: () => locale(),
    onRefreshed: (id, tokens, persisted) => {
      // The engine just wrote the credential; mirror it so the panel shows the
      // new expiry without a disk read, then tell the rest of the host.
      setState(id, { expiresAt: tokens.expiresAt, refreshedAt: Date.now(), refreshToken: true })
      // The in-memory mirror is NOT the store: a transport that outlives this
      // refresh keeps the **consumed** refresh token and would present it on its
      // next 401 self-heal. A rotation-aware server answers
      // `invalid_grant: refresh token already used` and (RFC 6749 §10.4) revokes
      // the grant, so the connector silently needs re-authorization. Feed the
      // live provider the credential we just persisted. Regression:
      // tests/token-refresh-live-provider.spec.ts.
      // The persisted write's `updatedAt` is what makes the catch-up in
      // adoptLatestRefresh decide correctly against a later re-authorization.
      latestRefresh.set(id, { tokens, updatedAt: persisted.updatedAt, credential: persisted })
      for (const handle of liveHandlesOf(id)) {
        handle.adopt(tokens)
        handle.syncBaseline(persisted)
      }
      ctx.emit('pico/connector-credentials-changed', { id })
    },
    ...(options.outboundTimeoutMs === undefined ? {} : { timeoutMs: options.outboundTimeoutMs }),
  })
  const pendingRequests = new Map<string, ConnectorAuthRequest>()
  /** Server-issued stdio commands waiting for a local decision, keyed by connector id. */
  const pendingApprovals = new Map<string, PendingApproval>()
  const mcpDisposers = new Map<string, () => void>()
  /** In-flight auth flows keyed by connector id: disconnect/cancel aborts them. */
  const pendingFlows = new Map<string, AbortController>()
  /**
   * Which form produced the current `pendingRequests` entry: pre-connect
   * `settings` or post-connect `tokenFields`. submitAuth must know this to
   * continue the OAuth/device flow instead of short-circuiting into an
   * unauthenticated MCP registration (2026-09-15 audit).
   */
  const pendingFieldRequestKind = new Map<string, 'settings' | 'tokenFields'>()
  /**
   * Per-connector intent generation. `disconnect()` bumps it; any
   * `registerMcp`/`submitAuth` that started before the bump observes the
   * mismatch after its next await and aborts instead of resurrecting a
   * disconnected connector.
   */
  /**
   * Per-connector registration sequence. Bumped by EVERY `registerMcp` entry so
   * an older registration that is still parked in discovery (e.g. one triggered
   * by a credentials-changed announce) cannot finish after a newer one (a user
   * re-authorization) and retire/replace its transport. `beginIntent` alone did
   * not cover this: it does not bump the generation, and announce-triggered
   * registrations carry the teardown signal rather than an intent.
   */
  const registrationSeqs = new Map<string, number>()
  const currentRegistrationSeq = (id: string): number => registrationSeqs.get(id) ?? 0
  const bumpRegistrationSeq = (id: string): number => {
    const next = currentRegistrationSeq(id) + 1
    registrationSeqs.set(id, next)
    return next
  }
  const connectorGenerations = new Map<string, number>()
  const currentGeneration = (id: string): number => connectorGenerations.get(id) ?? 0
  const bumpGeneration = (id: string): number => {
    const next = currentGeneration(id) + 1
    connectorGenerations.set(id, next)
    return next
  }

  /**
   * Per-connect intent token (2026-09-15 audit, BUG-02). Connecting is a
   * multi-await operation whose side effects — publishing a form, flipping the
   * row to 'connecting', writing a credential, spawning MCP servers — must not
   * survive a user cancel, a disconnect, a newer connect, or a user switch. The
   * token carries every fact needed to answer "is this work still wanted?": the
   * generation at entry, its own abort signal, the store instance it may write
   * to, and the teardown controller it started under.
   */
  interface ConnectIntent {
    generation: number
    controller: AbortController
    store: ConnectorStore
    teardown: AbortController
  }
  const connectIntents = new Map<string, ConnectIntent>()

  /** Register a new intent, superseding (and aborting) whatever was in flight. */
  const beginIntent = (id: string): ConnectIntent => {
    connectIntents.get(id)?.controller.abort(new Error(copy('flow.superseded')))
    const intent: ConnectIntent = {
      generation: currentGeneration(id),
      controller: new AbortController(),
      store,
      teardown: teardownController,
    }
    connectIntents.set(id, intent)
    return intent
  }

  /** True while this exact intent is still the live, unaborted work of the connector. */
  const intentLive = (id: string, intent: ConnectIntent): boolean =>
    connectIntents.get(id) === intent
    && intent.generation === currentGeneration(id)
    && !intent.controller.signal.aborted
    && intent.teardown === teardownController
    && !intent.teardown.signal.aborted

  /** True once a NEWER connect/submit took the connector over. */
  const supersededByNewerIntent = (id: string, intent: ConnectIntent): boolean => {
    const newer = connectIntents.get(id)
    return newer !== undefined && newer !== intent
  }

  const endIntent = (id: string, intent: ConnectIntent): void => {
    if (connectIntents.get(id) === intent) connectIntents.delete(id)
  }

  /**
   * Invalidate every in-flight connect/submit for a connector: bump the
   * generation (registerMcp re-checks it) and abort the intent signal so work
   * parked on an await unwinds instead of finishing.
   */
  const invalidateIntent = (id: string, reason: Error): void => {
    bumpGeneration(id)
    const intent = connectIntents.get(id)
    if (intent === undefined) return
    intent.controller.abort(reason)
    connectIntents.delete(id)
  }

  /**
   * Aborted by EITHER a lifecycle teardown or this intent dying, so a
   * registration parked inside registerMcp stops spawning at its next await.
   */
  const intentSignal = (intent: ConnectIntent): AbortSignal => {
    const combine = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
    return typeof combine === 'function'
      ? combine.call(AbortSignal, [intent.teardown.signal, intent.controller.signal])
      : intent.teardown.signal
  }

  /**
   * Compensate a credential write that lost its race with a cancel/disconnect
   * (the check before the write passed, the invalidation landed while the write
   * was in flight, and the bytes reached the disk afterwards).
   *
   * 2026-09-15 复核修正：**不能**以"存在更新的意图"为免做条件 —— 断开之后紧接一次
   * 新提交/新连接（哪怕只是建了意图、还没写盘）就会让补偿直接放弃，迟到的旧凭据留在
   * 磁盘上，下次启动 `restoreAll` 又把它复活（复核探针实测：断开后文件里重新出现
   * `{"apiKey":"STALE-A"}`）。现在的判据是**内容比对**：磁盘上仍是我们这次写下的
   * 那一份时才回滚；更新的意图若已经写过自己的凭据，比对必然不等，自然放手。
   *
   * 用户切换（store 实例已更换）时不动：那份字节落在上一个用户的目录里，无法在不
   * 破坏他人数据的前提下判断归属。
   */
  const undoStaleCredentialWrite = async (
    id: string,
    intent: ConnectIntent,
    written: ConnectorCredential,
  ): Promise<void> => {
    if (intent.store !== store) return
    try {
      // 原子 compare-and-delete（2026-09-15 第二轮复核）：比较与删除必须在 store
      // 的同一段独占区里 —— 在插件侧"先读后删"时，更新的写入若落在读与清之间会被
      // 旧补偿删掉（复核用强制交错探针实测到）。
      await intent.store.clearCredentialIfUnchanged(id, written)
    } catch (cause) {
      ctx.logger?.warn(`pico-connectors: ${id} 竞态凭据写入回滚失败`, cause)
    }
  }


  /**
   * Register one connector's MCP servers. `pendingApproval` means nothing was
   * spawned because a server-issued stdio command still needs local
   * confirmation; `rejected` lists definitions/urls this plugin refuses;
   * `superseded` means a teardown (logout / user switch) landed while the
   * registration was awaiting and NOTHING else may be spawned for it.
   */
  interface McpRegistrationOutcome {
    pendingApproval?: ConnectorMcpApproval
    rejected: string[]
    superseded?: boolean
  }

  /**
   * Pending local confirmation: the prompt plus the exact ledger record of
   * every command one answer approves (audit R3 N1 — a union of key sets would
   * misattribute one server's keys to another server's record).
   */
  interface PendingApproval extends ConnectorMcpApproval {
    entries: Array<{
      fingerprint: string
      command: string
      args: string[]
      envKeys: string[]
      envValues: Record<string, string>
    }>
  }

  /**
   * Aborted by `teardownAll` and replaced immediately after (conn-1): a
   * registration that is already awaiting must stop spawning rather than
   * resurrect the previous user's MCP servers after the teardown ran.
   */
  let teardownController = new AbortController()

  /** Drop all MCP registrations and reset in-memory state (user switch). */
  const teardownAll = async (): Promise<void> => {
    teardownController.abort(new Error(copy('flow.userSwitchedRegistration')))
    liveProviders.clear()
    latestRefresh.clear()
    for (const dispose of mcpDisposers.values()) {
      try { dispose() } catch { /* teardown never throws */ }
    }
    mcpDisposers.clear()
    for (const flow of pendingFlows.values()) flow.abort(new Error(copy('flow.userSwitchedConnect')))
    pendingFlows.clear()
    // BUG-02: connect/submit intents started under the previous session must
    // not publish a form, flip a row or write a credential for the new one.
    for (const intent of connectIntents.values()) intent.controller.abort(new Error(copy('flow.userSwitchedConnect')))
    connectIntents.clear()
    pendingRequests.clear()
    pendingApprovals.clear()
    pendingFieldRequestKind.clear()
    states.clear()
    // A NEW controller for the tasks the new session enqueues: the signal above
    // must stay aborted for everything that captured it.
    teardownController = new AbortController()
  }

  /**
   * Serialize the two lifecycle entry points (P2-23): the boot restore and
   * every session change used to run concurrently, so an in-flight restore for
   * the previous user could register MCP servers AFTER the new user's
   * teardown — leaking connections and duplicating tools. Tasks run strictly
   * in order and only the NEWEST enqueued task survives: an older queued task
   * is superseded (its epoch no longer matches) because the newest transition
   * already carries the full desired state.
   */
  let lifecycleEpoch = 0
  let lifecycleQueue: Promise<void> = Promise.resolve()
  const runLifecycle = (task: () => Promise<void>): Promise<void> => {
    const epoch = ++lifecycleEpoch
    const run = lifecycleQueue.then(async () => {
      if (epoch !== lifecycleEpoch) return
      await task()
    })
    // Keep the chain alive after a failure; the caller still sees the error.
    lifecycleQueue = run.then(() => {}, () => {})
    return run
  }

  /** Rebuild per-user store/runtime after a login/logout/switch. */
  const reconfigureUser = (): void => {
    const username = currentUser()
    // Migrate legacy `~/.picoaide/connectors` once (first login after
    // upgrade): A's pre-upgrade credentials must not be lost silently.
    migrateLegacyStore(username)
    if (!options.storeBaseDir) {
      store = new ConnectorStore({ username })
      approvals = new ConnectorApprovalStore({ username })
    }
  }

  // Session lifecycle: disconnect registrations for the previous user, then
  // re-read credentials for the new one (restore fresh MCP servers). The def
  // catalog is synced from bootstrap FIRST so the restore registers the
  // current server directory (defs are server-issued now).
  ctx.on('pico/session-changed', (next: unknown) => {
    void runLifecycle(async () => {
      const epoch = lifecycleEpoch
      await teardownAll()
      await syncServerDefs()
      reconfigureUser()
      if (next !== null) await restoreAll(epoch)
    }).catch((cause: unknown) => {
      ctx.logger?.error('pico-connectors: session change handling failed', cause)
    })
  })

  const setState = (id: string, patch: Partial<ConnectorState>): void => {
    const current = states.get(id) ?? { status: 'disconnected', everConnected: false }
    states.set(id, { ...current, ...patch })
  }

  /**
   * Mirror a credential's token facts onto the row state. Called wherever a
   * credential is read or written, so the panel's poll never touches the disk
   * and still shows "valid until …" / the manual-refresh affordance.
   */
  /**
   * Persist a credential patch written by an SDK provider, and announce it ONCE
   * PER NEW ACCESS TOKEN.
   *
   * The announcement is what re-registers a server so it stops using a stale
   * token, but a re-registration builds a new provider whose `saveTokens` fires
   * again — announcing every save would loop forever. Comparing the token makes
   * the announcement idempotent: the second save changes nothing and stays quiet.
   */
  const lastAnnouncedToken = new Map<string, string>()
  const persistAndMaybeAnnounce = async (
    id: string,
    patch: Partial<ConnectorCredential>,
    expected: ConnectorCredential,
  ): Promise<ConnectorCredential | null> => {
    // Capture the store this save belongs to before the first await: a user
    // switch while the write is in flight must not redirect it into the next
    // user's directory (2026-09-16 audit E5).
    const target = store
    const current = await target.readCredential(id)
    // Compare-and-update against the provider's snapshot: a disconnect (file
    // gone) or a newer interactive re-authorization must make this stale SDK
    // save a no-op instead of recreating/overwriting the credential.
    if (current === null || !sameCredential(current, expected)) return null
    // A save that changes no credential material is a NO-OP. The SDK re-saves
    // tokens on every 401 handshake, and a blind write would bump `updatedAt`,
    // re-announce the connector and restart its MCP transport each time — a
    // reconnect storm that looks like "the connector keeps flashing".
    const tokenChanged = patch.accessToken !== undefined && patch.accessToken !== current?.accessToken
    const refreshChanged = patch.refreshToken !== undefined && patch.refreshToken !== current?.refreshToken
    const clientChanged = patch.clientId !== undefined && patch.clientId !== current?.clientId
    if (!tokenChanged && !refreshChanged && !clientChanged) {
      noteCredential(id, current)
      return current
    }
    const saved = await target.updateCredentialIfUnchanged(id, expected, patch)
    if (saved === null) return null
    noteCredential(id, saved)
    const token = saved.accessToken ?? ''
    if (token === '' || lastAnnouncedToken.get(id) === token) return saved
    lastAnnouncedToken.set(id, token)
    ctx.emit('pico/connector-credentials-changed', { id })
    return saved
  }

  const noteCredential = (id: string, credential: ConnectorCredential | null): void => {
    // Live set, so the list route can still report the manual-refresh
    // affordance while the row is idle (state is only written on transitions).
    if (credential?.refreshToken === undefined) refreshable.delete(id)
    else refreshable.add(id)
    setState(id, {
      expiresAt: credential?.expiresAt,
      refreshedAt: credential?.refreshedAt,
      refreshToken: credential?.refreshToken !== undefined,
    })
  }

  const getDef = (id: string): ConnectorDef | undefined => defs.find((def) => def.id === id)

  const emitRequest = (request: ConnectorAuthRequest): void => {
    pendingRequests.set(request.connectorId, request)
  }

  /** Render request headers: static `${FIELD}` templates from credential fields, empty Authorization -> Bearer token, and the default Bearer injection for OAuth/token credentials. */
  const renderHeaders = (server: ConnectorMcp, credential: ConnectorCredential | null): Record<string, string> => {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(server.headers ?? {})) {
      if (value === '') {
        if (credential?.accessToken) headers[name] = `Bearer ${credential.accessToken}`
        continue
      }
      headers[name] = value.replace(/\$\{([^}]+)\}/g, (_, key: string) => credential?.fields?.[key] ?? '')
    }
    // OAuth/token connectors without static headers still authenticate with
    // the stored access token.
    if (Object.keys(headers).length === 0 && credential?.accessToken) {
      headers.Authorization = `Bearer ${credential.accessToken}`
    }
    return headers
  }

  /**
   * Child env for one stdio MCP server (FIX-19, residual A). Two whitelists
   * apply: the definition's own env (protected bootstrap keys are dropped) and
   * the credential fields (only the keys the connector declared in
   * `tokenFields`/`settings` are injected — and only those whose name survives
   * the same denylist, so a declared `NODE_OPTIONS`/`PATH` can never set a
   * loader hook). The framework's own keys are written last so a definition can
   * never shadow them.
   *
   * `declared` (the sanitized `mcp[].env`) and `credentialKeys` (the injectable
   * field names) are the definition-controlled part of the approval
   * fingerprint; `env` is the complete key set the child will receive, which is
   * exactly what the local confirmation discloses.
   */
  const buildStdioEnv = (
    def: ConnectorDef,
    server: ConnectorMcp,
    credential: ConnectorCredential | null,
  ): { declared: Record<string, string>; credentialKeys: string[]; env: Record<string, string> } => {
    const { env: declared } = sanitizeMcpEnv(server.env)
    const env: Record<string, string> = { ...declared }
    const declaredKeys = declaredCredentialKeys(def)
    for (const [key, value] of Object.entries(credential?.fields ?? {})) {
      if (!declaredKeys.has(key) || typeof value !== 'string') continue
      // INJECTION side of the same denylist: the declaration side already
      // filtered, this re-check keeps a future caller from re-opening the hole.
      if (isDeniedEnvKey(key)) continue
      env[key] = value
    }
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    if (credential?.accessToken) env.PICOAIDE_CONNECTOR_ACCESS_TOKEN = credential.accessToken
    if (credential?.refreshToken) env.PICOAIDE_CONNECTOR_REFRESH_TOKEN = credential.refreshToken
    return { declared, credentialKeys: [...declaredKeys].sort(), env }
  }

  /**
   * Framework-owned env names a stdio child can receive no matter what the
   * definition declares. Listed in every disclosure so a token that only
   * appears later (the auth flow may store one after approval) was still shown
   * to the user before it could ever be injected (audit R3 N2).
   */
  const FRAMEWORK_STDIO_ENV_KEYS = ['PICOAIDE_CONNECTOR_ACCESS_TOKEN', 'PICOAIDE_CONNECTOR_REFRESH_TOKEN'] as const

  /**
   * The names a child of this server may EVER receive: what is injected now,
   * the declared credential field names (a value may be stored later — the
   * fingerprint pins the NAME set, not the values) and the framework's own keys.
   */
  const stdioDisclosureKeys = (env: Record<string, string>, credentialKeys: readonly string[]): string[] => {
    const keys = new Set<string>(Object.keys(env))
    for (const key of credentialKeys) keys.add(key)
    for (const key of FRAMEWORK_STDIO_ENV_KEYS) keys.add(key)
    if (process.versions.electron) keys.add('ELECTRON_RUN_AS_NODE')
    return [...keys].sort()
  }

  /**
   * The definition-supplied VALUE of every env pair a child will receive
   * (conn-5, audit R7).
   *
   * The prompt used to disclose key NAMES only, and a name is not a decision:
   * approving "run `git diff`" approved an opaque `GIT_EXTERNAL_DIFF` whose
   * value shelled out (measured: the payload ran while the user only ever saw a
   * harmless-looking command line). Showing the pair makes an unknown hook name
   * judgeable.
   *
   * Scope is the definition's own `mcp[].env` (already sanitized) — that is the
   * only channel where the SERVER picks both the name and the value. Values that
   * come from the user's own credentials are deliberately not redisplayed (the
   * framework's token keys are excluded for the same reason), and their NAMES
   * stay in `envKeys`, which is what the fingerprint pins (audit R3 N2).
   */
  const stdioDisclosureValues = (declared: Record<string, string>): Record<string, string> => {
    const values: Record<string, string> = {}
    for (const [key, value] of Object.entries(declared)) {
      if ((FRAMEWORK_STDIO_ENV_KEYS as readonly string[]).includes(key)) continue
      if (key === 'ELECTRON_RUN_AS_NODE') continue
      values[key] = value
    }
    return values
  }

  /**
   * Local-confirmation prompt for every stdio server of one connector.
   *
   * ONE answer approves every pending stdio server, so the prompt discloses
   * every one of them (audit R3 N1): `commands` carries each server's own
   * command/args/envKeys, `envKeys` is their UNION (an older single-answer UI
   * that only renders the flat fields still sees every name), and `servers`
   * lists them all.
   *
   * `envKeys` is the set of names the child may receive, not only the ones with
   * a value right now (audit R3 N2): a declared-but-empty credential field can
   * be filled in later, and that value is injected under the same fingerprint
   * (the fingerprint pins the declared key NAMES, which is what a definition
   * change moves). Disclosing the potential set is what keeps "shown at
   * approval" = "ever injected" true.
   */
  const checkStdioApproval = async (
    def: ConnectorDef,
    servers: ConnectorMcp[],
    credential: ConnectorCredential | null,
  ): Promise<{ pending: ConnectorMcpApproval } | { denied: true } | null> => {
    const unapproved: Array<{
      server: ConnectorMcp
      fingerprint: string
      command: string
      args: string[]
      envKeys: string[]
      envValues: Record<string, string>
    }> = []
    for (const server of servers) {
      // Shape problems are reported by the registration loop itself; the
      // approval gate only covers structurally usable entries.
      if (mcpServerProblem(server) !== null) continue
      const { declared, credentialKeys, env } = buildStdioEnv(def, server, credential)
      const fingerprint = stdioApprovalFingerprint(server.command ?? '', server.args ?? [], declared, credentialKeys)
      if (!(await approvals.isApproved(fingerprint))) {
        unapproved.push({
          server,
          fingerprint,
          command: server.command ?? '',
          args: server.args ?? [],
          envKeys: stdioDisclosureKeys(env, credentialKeys),
          envValues: stdioDisclosureValues(declared),
        })
      }
    }
    if (unapproved.length === 0) return null
    const first = unapproved[0]!
    const unionKeys = [...new Set(unapproved.flatMap(item => item.envKeys))].sort()
    const unionValues = Object.assign({}, ...unapproved.map(item => item.envValues)) as Record<string, string>
    const prompt: ConnectorMcpApproval = {
      fingerprint: first.fingerprint,
      command: first.command,
      args: first.args,
      envKeys: unionKeys,
      envValues: unionValues,
      servers: unapproved.map(item => item.server.serverName),
      commands: unapproved.map(item => ({
        serverName: item.server.serverName,
        command: item.command,
        args: item.args,
        envKeys: item.envKeys,
        envValues: item.envValues,
      })),
    }
    if (options.requestApproval !== undefined) {
      const granted = await options.requestApproval(prompt)
      if (!granted) return { denied: true }
      for (const item of unapproved) {
        await approvals.approve({
          fingerprint: item.fingerprint,
          command: item.command,
          args: item.args,
          envKeys: item.envKeys,
        })
      }
      return null
    }
    // No headless hook: the request is answered through the local panel.
    const pending: PendingApproval = {
      ...prompt,
      entries: unapproved.map(item => ({
        fingerprint: item.fingerprint,
        command: item.command,
        args: item.args,
        envKeys: item.envKeys,
        envValues: item.envValues,
      })),
    }
    pendingApprovals.set(def.id, pending)
    emitRequest({ connectorId: def.id, approval: prompt })
    return { pending: prompt }
  }

  /** Register the connector's MCP servers through the mcp-client plugin. */
  const registerMcp = async (
    def: ConnectorDef,
    outbound: { signal?: AbortSignal } = {},
  ): Promise<McpRegistrationOutcome> => {
    // Capture the intent generation up-front: a disconnect (or a newer
    // registration request) bumps it, and every await below re-checks this
    // closure so the old registration cannot spawn after the bump.
    const generation = currentGeneration(def.id)
    const registrationSeq = bumpRegistrationSeq(def.id)
    /** A teardown/disconnect or a NEWER registration landed: spawn nothing more. */
    const superseded = (): boolean =>
      outbound.signal?.aborted === true
      || generation !== currentGeneration(def.id)
      || registrationSeq !== currentRegistrationSeq(def.id)
    // conn-1: a logout/user switch that lands while this registration is
    // awaiting must not resurrect the previous user's MCP servers.
    if (superseded()) return { rejected: [], superseded: true }
    const credential = await store.readCredential(def.id)
    // Mirror the token facts onto the row (the panel's poll reads state only).
    noteCredential(def.id, credential)
    if (superseded()) return { rejected: [], superseded: true }
    const rejected: string[] = []
    const stdioServers = def.mcp.filter(server => (server.transport ?? 'stdio') === 'stdio')
    const gate = await checkStdioApproval(def, stdioServers, credential)
    if (superseded()) return { rejected: [], superseded: true }
    if (gate !== null) {
      if ('denied' in gate) return { rejected: [copy('flow.approvalDenied')] }
      // Nothing is spawned while ANY stdio server of this connector is
      // unapproved: a partially registered connector is harder to reason about
      // than a row that simply waits for the user's decision.
      return { pendingApproval: gate.pending, rejected }
    }
    // N3: the streamable-http transport builds its own fetch inside
    // `dsh-mcp-client`, so the redirect fence has to be in place on the SDK
    // class BEFORE any such server is registered. Fail closed: when the seam
    // cannot be fenced (or verified), these servers are refused instead of
    // connecting with a transport that follows redirects.
    const httpServers = def.mcp.filter(server =>
      server.transport === 'streamable-http' && mcpServerProblem(server) === null)
    let httpFenceError: string | null = null
    if (httpServers.length > 0) {
      try {
        await ensureMcpTransportRedirectFence(locale())
        // The seam is fenced and behaviourally verified; the identity of the
        // two resolutions could not be settled (see the fence module). The
        // connection proceeds — the path pair goes to the log once, so a field
        // report carries the spellings instead of only the refusal text.
        if (claimMcpTransportFenceTargetWarning()) {
          ctx.logger?.warn(`pico-connectors: ${def.id} streamable-http 传输身份校验未定论，仍按加固后的传输连接（${mcpTransportFenceTargetWarning() ?? ''}）`)
        }
      } catch (error) {
        httpFenceError = error instanceof McpTransportFenceUnavailableError
          ? error.message
          : String(error)
        ctx.logger?.error(`pico-connectors: ${def.id} streamable-http 传输未加固，已拒绝注册`, error)
      }
    }
    const { apply: applyMcpClient } = await import('@deepseek-ai/dsh-mcp-client')
    if (superseded()) return { rejected: [], superseded: true }
    for (const server of def.mcp) {
      if (superseded()) return { rejected: [], superseded: true }
      // The rejection text is shown on the connector row, so it is rendered in
      // the locale resolved for THIS registration.
      const problem = mcpServerProblem(server, { locale: locale() })
      if (problem !== null) {
        rejected.push(`${server?.serverName ?? '?'}: ${problem}`)
        continue
      }
      if (server.transport === 'streamable-http' && httpFenceError !== null) {
        rejected.push(copy('flow.fenceUnavailable', { serverName: server.serverName, error: httpFenceError }))
        continue
      }
      // Resolve the provider BEFORE the superseded check below (the discovery
      // round trip is one of the awaited windows that check exists for), but do
      // NOT install its handle yet: installation waits until the transport has
      // actually loaded, so a superseded registration — or one whose plugin
      // fails to load — cannot clobber the handle that is really in use.
      const auth = server.transport === 'streamable-http'
        ? await mcpAuthProvider(def, credential)
        : {}
      const config = server.transport === 'streamable-http'
        ? {
            transport: 'streamable-http' as const,
            serverName: server.serverName,
            url: streamableHttpUrl(server, locale()).toString(),
            headers: renderHeaders(server, credential),
            // MCP authorization spec: the transport is handed the official
            // `OAuthClientProvider`, so the SDK injects the bearer token,
            // refreshes it when the server answers 401, persists the rotation
            // and retries the call. No hand-rolled fetch and no header rewriting.
            ...(auth.authProvider === undefined ? {} : { authProvider: auth.authProvider }),
            toolCallTimeoutMs: 120_000,
            failOnStartupError: false,
          }
        : {
            transport: 'stdio' as const,
            serverName: server.serverName,
            command: server.command ?? '',
            args: server.args ?? [],
            env: buildStdioEnv(def, server, credential).env,
            cwd: process.cwd(),
            toolCallTimeoutMs: 120_000,
            failOnStartupError: false,
          }
      // A disconnect/user-switch may have landed while mcpAuthProvider was
      // awaiting discovery; do not retire the old transport or spawn the new
      // one after that intent was invalidated.
      if (superseded()) return { rejected: [], superseded: true }
      // The serverName is a per-scope reservation owned by the LIVE fibre: the
      // upstream plugin throws "serverName \"...\" is already in use" when a
      // second instance loads while the first is still alive. A re-registration
      // (credential refresh, token changed) therefore has to retire the old
      // fibre BEFORE loading the new one — doing it after (the old order) made
      // every re-registration fail, and the row showed "连接失败".
      const retire = (): void => {
        // The old transport is gone (or about to be): its handle must not keep
        // receiving adopted tokens.
        dropLiveProvider(def.id, server.serverName)
        const disposer = mcpDisposers.get(server.serverName)
        if (disposer === undefined) return
        try { disposer() } catch { /* teardown never throws */ }
        mcpDisposers.delete(server.serverName)
      }
      retire()
      // `ctx.plugin` returns `Fiber & PromiseLike<Fiber>` (not a real Promise),
      // so it is wrapped before the failure hook is attached.
      const load = (): Promise<Awaited<ReturnType<typeof ctx.plugin>>> => Promise.resolve(
        ctx.plugin({ inject: ['tools'], apply: applyMcpClient, name: 'mcp-client' }, config),
      )
      let fiber = await load().catch(async (cause: unknown) => {
        const message = String(cause instanceof Error ? cause.message : cause)
        // An authorization rejection during registration is not a crash: the
        // connector simply has no usable credential yet (first connect, or a
        // revoked grant). Say what the user has to do instead of leaking the
        // transport's raw "Error POSTing to endpoint: {\"error\":\"invalid_token\"}".
        if (/401|invalid_token|Unauthorized/iu.test(message)) {
          // A stable code travels with this failure: it is what the host uses to
          // pick the `unauthorized` row state and what the client maps to its
          // friendly copy. Matching the TEXT here is what broke under i18n.
          throw new ConnectorError('auth-required', copy('flow.authRequired'), { cause })
        }
        // Defensive: a name held by an instance we do not own (HMR leftovers, a
        // previous generation). Retire whatever this plugin knows about and try
        // exactly once more; a second failure is the caller's to report.
        if (!message.includes('already in use')) throw cause
        ctx.logger?.warn(`pico-connectors: ${def.id} 的 MCP 名被占用，先注销旧实例再重试一次`)
        await unregisterMcp(def)
        return await load()
      })
      // conn-1: a teardown may have landed WHILE this registration was
      // starting. Retire the fiber it just created instead of recording it —
      // otherwise the disposer would outlive the teardown that cleared the map
      // (and nothing would ever dispose this one).
      if (superseded()) {
        try { void fiber?.dispose?.() } catch { /* teardown never throws */ }
        return { rejected: [], superseded: true }
      }
      // The transport loaded: THIS handle is the one an out-of-band refresh
      // must feed now. Installing after the last superseded check closes both
      // the "superseded registration clobbers the live handle" race and the
      // "failed plugin leaves a dead handle" hole. The catch-up adopt follows
      // in the same synchronous block, so a refresh that landed while the
      // plugin was loading cannot slip between install and adopt.
      if (auth.handle !== undefined) {
        installLiveProvider(def.id, server.serverName, auth.handle)
        adoptLatestRefresh(def.id, auth.handle, credential)
      }
      // P2-23 kept: the map holds at most one disposer per server key, so the
      // fiber recorded here is the only live instance for that name.
      mcpDisposers.set(server.serverName, () => { void fiber?.dispose?.() })
    }
    return { rejected }
  }

  const unregisterMcp = async (def: ConnectorDef): Promise<void> => {
    for (const server of def.mcp) {
      dropLiveProvider(def.id, server.serverName)
      const dispose = mcpDisposers.get(server.serverName)
      if (dispose) {
        dispose()
        mcpDisposers.delete(server.serverName)
      }
    }
  }

  /**
   * Fields the definition declares as required that the credential does not yet
   * carry. Used by BOTH the pre-connect settings gate and the post-flow check:
   * a flow that finishes without the credential its tools need must not report
   * "connected" — that state guarantees every tool call fails silently.
   */
  const missingDeclaredFields = (
    def: ConnectorDef,
    credential: ConnectorCredential | null | undefined,
  ): NonNullable<ConnectorDef['tokenFields']> =>
    (def.tokenFields ?? []).filter((field) => {
      const value = credential?.fields?.[field.key]
      return field.required === true && (typeof value !== 'string' || value.trim() === '')
    })

  /**
   * Whether a stored credential can be registered on startup.
   *
   * OAuth/server-side credentials authenticate with `accessToken`; token and
   * device connectors store only declared fields (an API key/token in
   * `fields`). The old `if (effective.accessToken)` check therefore dropped
   * every fields-only connector on restart (2026-09-15 audit).
   * @param def - connector definition.
   * @param credential - stored credential.
   * @returns true when the credential is sufficient to register the MCP servers.
   */
  const credentialUsable = (
    def: ConnectorDef,
    credential: ConnectorCredential | null | undefined,
  ): boolean => {
    if (credential === null || credential === undefined) return false
    if (missingDeclaredFields(def, credential).length > 0) return false
    if (def.authMode === 'token' || def.authMode === 'device') return true
    // A public MCP endpoint answers without an authorization challenge, so the
    // discovery result is the whole credential: requiring an accessToken here
    // dropped its tools on every restart (2026-09-15 audit, BUG-06).
    if (credential.publicMcp === true) return true
    return typeof credential.accessToken === 'string' && credential.accessToken !== ''
  }

  /** Publish a field form for the panel and leave the row waiting for it. */
  const requestDeclaredFields = (id: string, def: ConnectorDef): void => {
    pendingFieldRequestKind.set(id, 'tokenFields')
    emitRequest({ connectorId: id, fields: def.tokenFields ?? [] })
    setState(id, { status: 'connecting', error: undefined })
  }

  /** Start the auth flow for a connector (background for poll-based modes). */
  const startConnect = async (id: string): Promise<void> => {
    const def = getDef(id)
    if (!def) throw new Error(`unknown connector: ${id}`)
    // P0-1: re-entrancy guard — a second connect on the same connector while
    // a flow is in flight must not start a duplicate authorization flow
    // (two callback ports, two browser windows, credential writeback race).
    if (pendingFlows.has(id)) return
    // BUG-02: the intent is registered BEFORE the first await, so a cancel or
    // disconnect that lands while this call is parked in the credential read
    // invalidates it instead of letting it publish a form for a dead request.
    const intent = beginIntent(id)
    try {
      const existing = await store.readCredential(id)
      if (!intentLive(id, intent)) return
      setState(id, { status: 'connecting', everConnected: Boolean(existing) || Boolean(states.get(id)?.everConnected) })

      // Pre-connect settings: if required fields are missing, emit the form and
      // wait for auth-submit before starting the actual auth flow.
      if (def.settings?.length) {
        const missing = def.settings.filter((field) => {
          const value = existing?.fields?.[field.key]
          return field.required === true && (typeof value !== 'string' || value.trim() === '')
        })
        if (missing.length > 0) {
          if (!intentLive(id, intent)) return
          pendingFieldRequestKind.set(id, 'settings')
          emitRequest({ connectorId: id, fields: def.settings })
          return
        }
      }
      // Token connectors never run an authorization flow: once the declared
      // fields are present they register directly (settings above are only a
      // pre-connect gate). This also guarantees the token form is shown when a
      // required field is missing, even when settings and tokenFields coexist.
      if (def.authMode === 'token') {
        if (missingDeclaredFields(def, existing).length > 0) {
          if (!intentLive(id, intent)) return
          requestDeclaredFields(id, def)
          return
        }
        if (!intentLive(id, intent)) return
        const outcome = await registerMcp(def, { signal: intentSignal(intent) })
        if (outcome.superseded === true) return
        if (outcome.pendingApproval !== undefined) {
          setState(id, { status: 'unauthorized', everConnected: true, error: undefined })
          return
        }
        if (outcome.rejected.length > 0) {
          pendingRequests.delete(id)
          setState(id, { status: 'error', everConnected: true, error: outcome.rejected.join('; ') })
          return
        }
        pendingRequests.delete(id)
        pendingFieldRequestKind.delete(id)
        setState(id, { status: 'connected', everConnected: true, connectedAt: Date.now(), error: undefined })
        return
      }
      // The auth flow reuses the intent's controller: /cancel, disconnect and a
      // newer connect all have exactly one signal to abort (BUG-02).
      pendingFieldRequestKind.delete(id)
      pendingRequests.delete(id)
      if (!intentLive(id, intent)) return
      const controller = intent.controller
      pendingFlows.set(id, controller)
      try {
      const patch = await runAuth(def, {
        onRequest: emitRequest,
        signal: controller.signal,
        ...(existing?.fields ? { fields: existing.fields } : {}),
        ...(options.clientName === undefined ? {} : { clientName: options.clientName }),
        ...(options.outboundTimeoutMs === undefined ? {} : { outboundTimeoutMs: options.outboundTimeoutMs }),
        // The locale of the user who clicked connect: the callback page, the
        // thrown errors and the refresh text below all follow it.
        locale: locale(),
      })
      // Token mode returned above; only OAuth/device/server-side reach this.
      // BUG-02: the credential write is the point of no return for a cancelled
      // flow, so the intent is re-checked immediately before it (and compensated
      // after it) — a disconnect that landed during the token round-trip must
      // not leave a fresh credential behind for the next restore to resurrect.
      const current = await store.readCredential(id)
      if (!intentLive(id, intent) || intent.store !== store) return
      const merged = await store.updateCredential(id, { ...current, ...patch })
      if (!intentLive(id, intent)) {
        await undoStaleCredentialWrite(id, intent, merged)
        return
      }
      // A stateless flow (device / server-side) can finish without the
      // credential the definition requires: surface the field form and stay in
      // 'connecting' rather than registering MCP servers that cannot work.
      if (missingDeclaredFields(def, merged).length > 0) {
        requestDeclaredFields(id, def)
        return
      }
      // conn-1: the flow may have been overtaken (logout / user switch) while
      // the token round-trip was in flight — never register for a session that
      // is already gone.
      if (!intentLive(id, intent)) return
      // Retire the PREVIOUS registration only now that the new authorization
      // succeeded: doing it before the flow meant a failed re-authorization
      // (server unreachable, user cancelled the browser step) silently removed
      // a working connector's tools. registerMcp also retires it internally, so
      // this only covers the case where the new credential cannot register
      // (e.g. stdio approval pending) and keeps the old one from lingering
      // across users.
      const outcome = await registerMcp(def, { signal: intentSignal(intent) })
      if (outcome.superseded === true || !intentLive(id, intent)) return
      if (outcome.pendingApproval !== undefined) {
        // FIX-02: the credential is stored, but the server-issued stdio
        // command still needs a local decision — nothing was spawned and the
        // confirmation request stays in `pendingRequests` for the panel.
        setState(id, { status: 'unauthorized', everConnected: true, error: undefined })
        return
      }
      if (outcome.rejected.length > 0) {
        pendingRequests.delete(id)
        setState(id, { status: 'error', everConnected: true, error: outcome.rejected.join('; ') })
        return
      }
      setState(id, { status: "connected", everConnected: true, connectedAt: Date.now(), error: undefined })
      // The flow reached a terminal success: the authorize URL in
      // pendingRequests is stale (the auth page was already opened and the
      // code exchanged). Leaving it behind makes every later panel open
      // re-trigger `window.open(authorizeUrl)` in the client (the card's
      // auto-open guard is per-mount; a reopened panel remounts the card and
      // sees the stale URL as "new"). Drop it so terminal states stay clean.
      pendingRequests.delete(id)
    } catch (error) {
      // A newer connect took over: it owns the row now, so this unwinding flow
      // must not stamp 'disconnected' or an error over its 'connecting' state.
      if (supersededByNewerIntent(id, intent)) return
      const message = error instanceof Error ? error.message : String(error)
      // Classification is by the stable, locale-independent code the producer
      // attached — never by substrings of a (now translatable) message.
      const unauthorized = connectorErrorCodeOf(error) === 'auth-required'
      // A user-initiated abort maps to the neutral 'disconnected' state, not
      // an error (the cancel button must not leave a scary red row behind).
      if (controller.signal.aborted) {
        setState(id, { status: 'disconnected', everConnected: Boolean(states.get(id)?.everConnected), error: undefined })
      } else {
        setState(id, { status: unauthorized ? 'unauthorized' : 'error', error: message, ...withCode(error) })
      }
      // Terminal failure likewise invalidates the pending authorize URL.
      pendingRequests.delete(id)
    } finally {
      // 按身份删除:connect 路由发现旧流程会 stale.abort() 后启动新流程,
      // 旧流程异步 unwind 可能晚于新流程 set——无条件 delete 会抹掉新流程
      // 的 controller,使 /cancel、disconnect 找不到活流程(2026-09-01 深挖)。
      if (pendingFlows.get(id) === controller) pendingFlows.delete(id)
    }
    } finally {
      // Every exit path (settings form, token form, success, failure) drops the
      // intent: after this call returns there is nothing left to invalidate, and
      // a later submit/cancel starts from a fresh generation.
      endIntent(id, intent)
    }
  }

  const submitAuth = async (id: string, fields: Record<string, string>): Promise<void> => {
    const def = getDef(id)
    if (!def) throw new Error(`unknown connector: ${id}`)
    // BUG-02: submitting a form is its own intent, registered before the first
    // await. The credential write below is the operation a late submit used to
    // sneak past a disconnect: the old code checked the generation only AFTER
    // updateCredential, so the file was already back on disk ("disconnect
    // silently undone" on the next restore).
    const intent = beginIntent(id)
    try {
      const kind = pendingFieldRequestKind.get(id)
      pendingFieldRequestKind.delete(id)
      const current = await store.readCredential(id)
      if (!intentLive(id, intent) || intent.store !== store) return
      const written = await store.updateCredential(id, { fields: { ...(current?.fields ?? {}), ...fields } })
      if (!intentLive(id, intent)) {
        await undoStaleCredentialWrite(id, intent, written)
        return
      }
      const merged = await store.readCredential(id)
      if (!intentLive(id, intent)) return
      // A pre-connect settings form was just completed on an OAuth/device
      // connector: continue the REAL authorization flow first. Registering MCP
      // here would mark the row connected without ever starting OAuth; asking
      // for tokenFields before OAuth would dead-end the authorization too.
      if (kind === 'settings' && def.authMode !== 'token') {
        await startConnect(id)
        return
      }
      // A required declared field is still missing (user submitted a partial
      // token form): show it again instead of registering an MCP server that
      // cannot authenticate (token mode used to skip this check).
      if (missingDeclaredFields(def, merged).length > 0) {
        requestDeclaredFields(id, def)
        return
      }
      const outcome = await registerMcp(def, { signal: intentSignal(intent) })
      if (outcome.superseded === true || !intentLive(id, intent)) return
      if (outcome.pendingApproval !== undefined) {
        setState(id, { status: 'unauthorized', everConnected: true, error: undefined })
        return
      }
      if (outcome.rejected.length > 0) {
        pendingRequests.delete(id)
        setState(id, { status: 'error', everConnected: true, error: outcome.rejected.join('; ') })
        return
      }
      setState(id, { status: 'connected', everConnected: true, connectedAt: Date.now(), error: undefined })
      pendingRequests.delete(id)
    } finally {
      endIntent(id, intent)
    }
  }

  const disconnect = async (id: string): Promise<void> => {
    // Invalidate every in-flight registration/submission intent BEFORE
    // clearing the credential: their next await observes the bump and stops
    // instead of spawning MCP servers for a disconnected connector. The abort
    // also cancels a flow that has not reached its first await yet (BUG-02).
    invalidateIntent(id, new Error(copy('flow.userDisconnected')))
    const def = getDef(id)
    if (def) await unregisterMcp(def)
    // P0-1: a disconnect must also abort any in-flight authorization flow —
    // otherwise the completed OAuth/device flow would "resurrect" the
    // connector and write back credentials after the user disconnected.
    const flow = pendingFlows.get(id)
    if (flow) flow.abort(
      new Error(copy('flow.userDisconnected')),
    )
    await store.clearCredential(id)
    // The card renders "有效期至 …" from these facts: a disconnected connector
    // must not keep advertising the token it no longer has.
    refreshable.delete(id)
    lastAnnouncedToken.delete(id)
    // No credential and no live transports remain (unregisterMcp dropped their
    // handles): the cached refresh result must not be adopted by a later
    // re-registration under a NEW authorization.
    latestRefresh.delete(id)
    liveProviders.delete(id)
    setState(id, {
      status: 'disconnected', everConnected: false, error: undefined, connectedAt: undefined,
      expiresAt: undefined, refreshedAt: undefined, refreshToken: undefined,
    })
    pendingRequests.delete(id)
    pendingApprovals.delete(id)
    pendingFieldRequestKind.delete(id)
  }

  /**
   * Restore all connector MCP registrations for the CURRENT user.
   *
   * conn-1: every await in here can be overtaken by a logout/user switch, so
   * the task's epoch is re-checked after every one of them — a restore that is
   * no longer the newest transition must stop instead of registering (or
   * reporting) anything for the previous user.
   */
  const restoreAll = async (epoch: number): Promise<void> => {
    /** True once a NEWER lifecycle transition superseded this task. */
    const stale = (): boolean => epoch !== lifecycleEpoch
    for (const def of defs) {
      try {
        if (stale()) return
        const credential = await store.readCredential(def.id)
        if (stale()) return
        noteCredential(def.id, credential)
        if (!credential) {
          // No credential for THIS user: clear the token facts the previous user
          // left on the row (states survive a session change; the store does
          // not). The STATUS is deliberately not forced to 'disconnected' —
          // 'unauthorized' is how a failed authorization reports itself and must
          // survive the restore pass.
          setState(def.id, { expiresAt: undefined, refreshedAt: undefined, refreshToken: undefined })
          continue
        }
        // Refresh OAuth tokens before restoring (official SDK refresh flow),
        // then register the MCP servers.
        const effective = credential.refreshToken === undefined
          ? credential
          : await (async () => {
              const outcome = await tokenRefresher.refresh(def.id)
              if (stale()) return credential
              if (!outcome.ok && outcome.reason === 'reauthorize') {
                // The grant is gone: say so on the row instead of registering
                // MCP servers that are guaranteed to 401.
                setState(def.id, { status: 'unauthorized', everConnected: true, error: outcome.message, errorCode: 'auth-required' })
                return null
              }
              return await store.readCredential(def.id) ?? credential
            })()
        if (stale() || effective === null) continue
        if (stale()) return
        if (credentialUsable(def, effective)) {
          const outcome = await registerMcp(def, { signal: teardownController.signal })
          // A newer registration for THIS connector (user pressed connect on it)
          // only supersedes this def — the rest of the restore pass must still
          // run. Only a real teardown/stale epoch aborts the whole loop.
          if (stale()) return
          if (outcome.superseded === true) continue
          if (outcome.pendingApproval !== undefined) {
            // FIX-02: an unapproved server-issued command never reaches spawn;
            // the row waits for the user's local decision.
            setState(def.id, { status: 'unauthorized', everConnected: true, error: undefined })
            continue
          }
          if (outcome.rejected.length > 0) {
            setState(def.id, { status: 'error', everConnected: true, error: outcome.rejected.join('; ') })
            continue
          }
          setState(def.id, { status: 'connected', everConnected: true })
        } else if (def.authMode === 'token' || def.authMode === 'device') {
          // Fields-only connector whose required fields were removed/truncated:
          // ask for them again instead of silently staying disconnected.
          requestDeclaredFields(def.id, def)
        }
      } catch (error) {
        if (stale()) return
        // A restore failure (network, missing dependency, MCP connect) must
        // not become an unhandled rejection: the host treats those as fatal
        // and exits the whole app. Surface it on the connector row instead.
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.error(`pico-connectors: failed to restore ${def.id}: ${message}`)
        setState(def.id, { status: 'error', error: message, ...withCode(error) })
      }
    }
  }

  ctx.effect(() => {
    return () => {
      // Supersede any queued/running lifecycle task: a restore that resolves
      // after teardown must not re-register MCP servers (P2-23).
      lifecycleEpoch++
      // conn-1: …and a registration already awaiting must stop spawning.
      teardownController.abort(new Error(copy('flow.pluginUnloadRegistration')))
      liveProviders.clear()
      latestRefresh.clear()
      for (const dispose of mcpDisposers.values()) dispose()
      mcpDisposers.clear()
      // P0-1: teardown must abort any in-flight authorization flow — a
      // lingering OAuth/device flow would keep the callback server up and
      // (on a later disconnect) could write back credentials after teardown.
      for (const flow of pendingFlows.values()) flow.abort(new Error(copy('flow.pluginUnloadConnect')))
      pendingFlows.clear()
      for (const intent of connectIntents.values()) intent.controller.abort(new Error(copy('flow.pluginUnloadConnect')))
      connectIntents.clear()
    }
  }, 'pico connectors: restore + cleanup')

  /**
   * Background token sweep.
   *
   * The 401 path (SDK auth provider) is the safety net; this is what keeps a
   * token from ever reaching that point — and it is the ONLY recovery for
   * stdio MCP servers, whose token is placed in the child environment at spawn
   * time and cannot be re-read later. A refreshed credential re-registers the
   * connector's stdio servers (`registerMcp` retires the previous fibers).
   */
  ctx.effect(() => {
    const intervalMs = options.refreshSweepIntervalMs ?? REFRESH_SWEEP_INTERVAL_MS
    if (intervalMs <= 0) return () => {}
    const timer = setInterval(() => {
      void runRefreshSweep().catch((cause: unknown) => {
        ctx.logger?.warn('pico-connectors: token sweep failed', cause)
      })
    }, intervalMs)
    return () => { clearInterval(timer) }
  }, 'pico connectors: token sweep')

  /**
   * 一次扫掠：把"该刷新的连接器刷一遍"串在生命周期队列里（与连接/断开互斥），
   * 刷新失败的 `reauthorize` 落 `unauthorized`。定时器与测试注入共用这一份。
   * @returns 扫掠完成的 Promise。
   */
  async function runRefreshSweep(): Promise<void> {
    return runLifecycle(async () => {
      for (const def of defs) {
        const state = states.get(def.id)
        if (state?.status !== 'connected' && state?.status !== 'unauthorized') continue
        const credential = await store.readCredential(def.id)
        if (!credential || !tokenNeedsRefresh(credential)) continue
        const outcome = await tokenRefresher.refresh(def.id, { locale: locale() })
        if (!outcome.ok && outcome.reason === 'reauthorize') {
          setState(def.id, { status: 'unauthorized', everConnected: true, error: outcome.message, errorCode: 'auth-required' })
        }
      }
    })
  }
  options.onRefreshSweepReady?.(runRefreshSweep)

  /**
   * A refreshed (or re-rotated) credential must reach the running MCP servers
   * that cannot read it lazily: stdio children get their token in `env` at
   * spawn. `registerMcp` is idempotent per server key, so re-registering is
   * the supported way to hand a child the new value.
   */
  ctx.on('pico/connector-credentials-changed', (payload: { id: string }) => {
    void runLifecycle(async () => {
      const def = defs.find(entry => entry.id === payload.id)
      if (!def) return
      // stdio children got the token in `env` at spawn time; an http transport
      // baked it into its request headers. Both only see a refreshed token after
      // a re-registration (the provider reads the store on the NEXT request, but
      // the header it was constructed with is what gets sent first).
      if (def.mcp.length === 0) return
      if (states.get(def.id)?.status !== 'connected') return
      const outcome = await registerMcp(def, { signal: teardownController.signal })
      if (outcome.superseded === true) return
      if (outcome.pendingApproval !== undefined) {
        setState(def.id, { status: 'unauthorized', everConnected: true, error: undefined })
        return
      }
      if (outcome.rejected.length > 0) {
        setState(def.id, { status: 'error', everConnected: true, error: outcome.rejected.join('; ') })
      }
    }).catch((cause: unknown) => {
      ctx.logger?.warn(`pico-connectors: ${payload.id} 令牌更新后重注册失败`, cause)
    })
  })

  ctx.effect(() => {
    const list: JsonHandler = (_req, res) => {
      const body = defs.map((def) => {
        const state = states.get(def.id) ?? { status: 'disconnected' as const, everConnected: false }
        return {
          id: def.id,
          name: def.name,
          description: def.description,
          icon: def.icon ?? null,
          authMode: def.authMode,
          examples: def.examples ?? [],
          request: pendingRequests.get(def.id) ?? null,
          // Token lifetime is carried on the state (written whenever a
          // credential is read or refreshed): the list route stays synchronous,
          // so a slow disk never delays the panel's 2s poll.
          expiresAt: state.expiresAt ?? null,
          refreshedAt: state.refreshedAt ?? null,
          canRefresh: (refreshable.has(def.id) || state.refreshToken === true) && oauthTargetOf(def) !== null,
          refreshing: tokenRefresher.isRefreshing(def.id),
          ...state,
        }
      })
      json(res, 200, { connectors: body })
    }

    /**
     * Manual refresh (panel button). Runs the official SDK refresh flow and
     * reports the new expiry; a dead grant flips the row to `unauthorized` so
     * the user is told to authorize again instead of silently staying
     * "connected" with a token that no longer works.
     */
    const refreshTokens: JsonHandler = async (req, res) => {
      const rawId = decodeSegment(req.url?.split('/')[4] ?? '')
      if (rawId === null) return json(res, 400, { error: 'malformed connector id' })
      const id = rawId
      const def = getDef(id)
      if (!def) return json(res, 404, { error: `unknown connector: ${id}` })
      if (oauthTargetOf(def) === null) return json(res, 400, { error: copy('flow.refreshUnsupported') })
      const outcome = await tokenRefresher.refresh(id, { force: true, locale: locale() })
      if (!outcome.ok) {
        // The refresh engine reports WHY the refresh failed; a dead grant is the
        // one outcome that means "authorize again", and that is the stable code
        // the client maps (the message itself is translatable).
        const errorCode = outcome.reason === 'reauthorize' ? 'auth-required' : undefined
        if (outcome.reason === 'reauthorize') {
          setState(id, { status: 'unauthorized', everConnected: true, error: outcome.message, errorCode })
        } else if (outcome.reason === 'transient') {
          setState(id, { status: 'error', everConnected: Boolean(states.get(id)?.everConnected), error: outcome.message })
        }
        return json(res, outcome.reason === 'not-applicable' ? 400 : 409, {
          error: outcome.message,
          reason: outcome.reason,
          ...(errorCode === undefined ? {} : { errorCode }),
        })
      }
      noteCredential(id, await store.readCredential(id))
      setState(id, { status: 'connected', everConnected: true, error: undefined })
      json(res, 200, { ok: true, expiresAt: outcome.tokens.expiresAt })
    }

    const connect: JsonHandler = (req, res) => {
      const rawId = decodeSegment(req.url?.split('/')[4] ?? '')
      if (rawId === null) return json(res, 400, { error: 'malformed connector id' })
      const id = rawId
      const def = getDef(id)
      if (!def) return json(res, 404, { error: `unknown connector: ${id}` })
      // P0-1: a re-connect while a flow is in flight means the user closed
      // the authorization popup (or abandoned it) and wants a fresh flow —
      // abort the stale one first so the new connect is never swallowed and
      // old authorize URL is never re-opened. A fast double-click still
      // races: the second connect sees the first flow (just started) and
      // aborts it — the client's own busy guard prevents that on the happy
      // path; the abort here is the safety net for an abandoned flow.
      const stale = pendingFlows.get(id)
      if (stale) {
        stale.abort(new Error(copy('flow.reconnectCancelled')))
        pendingFlows.delete(id)
        pendingRequests.delete(id)
      }
      // A stale pre-connect form belongs to the superseded attempt: clear the
      // marker so a late submit of the old form cannot skip the new flow.
      pendingFieldRequestKind.delete(id)
      const request: ConnectorAuthRequest = { connectorId: id }
      emitRequest(request)
      void startConnect(id).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        setState(id, { status: 'error', error: message, ...withCode(error) })
      })
      // The pending request may gain fields once the flow starts; poll the
      // state endpoint for the final shape.
      json(res, 200, { ok: true, request })
    }

    const cancel: JsonHandler = (req, res) => {
      const rawId = decodeSegment(req.url?.split('/')[4] ?? '')
      if (rawId === null) return json(res, 400, { error: 'malformed connector id' })
      const id = rawId
      if (!getDef(id)) return json(res, 404, { error: `unknown connector: ${id}` })
      // P0-1: explicit user cancel of an in-flight authorization flow. The
      // flow's abort listener closes the callback server and rejects the
      // code promise; startConnect's catch maps the abort to 'disconnected'.
      // BUG-02: cancelling must invalidate the WHOLE connect intent, not only a
      // flow that already registered itself in pendingFlows — a connect parked
      // in its first credential read (or waiting for the settings form) used to
      // keep going and put the row back to "connecting" after the cancel.
      invalidateIntent(id, new Error(copy('flow.userCancelled')))
      setState(id, { status: 'disconnected', everConnected: Boolean(states.get(id)?.everConnected), error: undefined })
      pendingRequests.delete(id)
      pendingFieldRequestKind.delete(id)
      json(res, 200, { ok: true })
    }

    const authSubmit: JsonHandler = async (req, res) => {
      const rawId = decodeSegment(req.url?.split('/')[4] ?? '')
      if (rawId === null) return json(res, 400, { error: 'malformed connector id' })
      const id = rawId
      const raw = await readJson(req)
      const candidateFields = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { fields?: unknown }).fields
        : undefined
      if (candidateFields === null || typeof candidateFields !== 'object' || Array.isArray(candidateFields)) {
        return json(res, 400, { error: 'missing fields' })
      }
      // P0-1/P2-17: only string values are meaningful for auth headers; a
      // number/object/array would crash renderHeaders on the MCP registration
      // path with an obscure TypeError.
      const fields = candidateFields as Record<string, unknown>
      for (const [key, value] of Object.entries(fields)) {
        if (typeof value !== 'string') return json(res, 400, { error: `field '${key}' must be a string` })
      }
      try {
        void submitAuth(id, fields as Record<string, string>).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          setState(id, { status: 'error', error: message, ...withCode(error) })
        })
        // Return immediately: token form flows complete fast, but OAuth/device
        // flows can run for minutes — the fetch must not hang the panel's
        // busy state on "提交中…" for the whole authorization.
        json(res, 200, { ok: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { error: message })
      }
    }

    const state: JsonHandler = (req, res) => {
      const rawId = decodeSegment(req.url?.split('/')[4] ?? '')
      if (rawId === null) return json(res, 400, { error: 'malformed connector id' })
      const id = rawId
      const def = getDef(id)
      if (!def) return json(res, 404, { error: `unknown connector: ${id}` })
      const current = states.get(id) ?? { status: 'disconnected' as const, everConnected: false }
      json(res, 200, { ...current, request: pendingRequests.get(id) ?? null })
    }

    const disconnectHandler: JsonHandler = async (req, res) => {
      const rawId = decodeSegment(req.url?.split('/')[4] ?? '')
      if (rawId === null) return json(res, 400, { error: 'malformed connector id' })
      const id = rawId
      if (!getDef(id)) return json(res, 404, { error: `unknown connector: ${id}` })
      await disconnect(id)
      json(res, 200, { ok: true })
    }

    /**
     * FIX-02 local confirmation: remember the pending command fingerprint(s)
     * for this user and continue the registration. Nothing is spawned before
     * this answer arrives.
     */
    const approve: JsonHandler = async (req, res) => {
      const rawId = decodeSegment(req.url?.split('/')[4] ?? '')
      if (rawId === null) return json(res, 400, { error: 'malformed connector id' })
      const id = rawId
      const def = getDef(id)
      if (!def) return json(res, 404, { error: `unknown connector: ${id}` })
      const pending = pendingApprovals.get(id)
      if (pending === undefined) return json(res, 409, { error: 'no pending local approval' })
      for (const entry of pending.entries) {
        await approvals.approve({
          fingerprint: entry.fingerprint,
          command: entry.command,
          args: entry.args,
          envKeys: entry.envKeys,
        })
      }
      pendingApprovals.delete(id)
      pendingRequests.delete(id)
      // conn-1: a teardown may have landed while the user was deciding — the
      // captured signal stops the spawn instead of resurrecting the row.
      const outcome = await registerMcp(def, { signal: teardownController.signal })
      if (outcome.superseded === true) return json(res, 200, { ok: true })
      if (outcome.pendingApproval !== undefined) {
        setState(id, { status: 'unauthorized', everConnected: true, error: undefined })
        return json(res, 409, { error: 'approval did not settle every pending command' })
      }
      if (outcome.rejected.length > 0) {
        setState(id, { status: 'error', everConnected: true, error: outcome.rejected.join('; ') })
        return json(res, 400, { error: outcome.rejected.join('; ') })
      }
      setState(id, { status: 'connected', everConnected: true, connectedAt: Date.now(), error: undefined })
      json(res, 200, { ok: true })
    }

    /** FIX-02 local confirmation: refuse the pending command (nothing spawned). */
    const deny: JsonHandler = (req, res) => {
      const rawId = decodeSegment(req.url?.split('/')[4] ?? '')
      if (rawId === null) return json(res, 400, { error: 'malformed connector id' })
      const id = rawId
      if (!getDef(id)) return json(res, 404, { error: `unknown connector: ${id}` })
      pendingApprovals.delete(id)
      pendingRequests.delete(id)
      setState(id, { status: 'error', everConnected: Boolean(states.get(id)?.everConnected), error: copy('flow.approvalDeniedRow') })
      json(res, 200, { ok: true })
    }

    // Trust fence for every connector route: loopback socket + Host +
    // same-origin markers. State-changing endpoints below also enforce POST.
    const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
      if (browserSameOriginMarker(req) && isLoopbackRequest(req)) return true
      json(res, 403, { error: 'forbidden' })
      return false
    }

    /**
     * R7-RV-3（第三轮）：`guard()` 之上再要一份持有性证明——口径与
     * `packages/host/enterprise/src/auth-gate.ts` 的 r7c-6 逐条一致。
     *
     * `loopback.ts` 自述的边界就是"伪造 Origin 的 curl 也能过"：本机任意进程
     * 伪造 `Origin`/`Host`/`Sec-Fetch-Site` 即可 `POST /api/pico/connectors/
     * <id>/auth-submit` 把攻击者 token 写进**本地连接器凭据库**（实测落盘
     * glitchtip.json，后续连接器出站就带攻击者凭据），或 `POST …/approve` 往
     * `.mcp-approvals.json` 写入持久化的「允许在本机执行 <command> <args>」审批
     * （跨重启生效，绕过本地命令必须用户确认的闸门）。
     *
     * 证明 = 上游 `connection` 服务的 BrowserAuth cookie（`dsh-auth-<authority>`：
     * HttpOnly + SameSite=Strict + HMAC，只能由本进程服务、经 launch token 换票
     * 的页面持有），直接复用 `connection.requestRejection()`，不新造机制。
     * fence 缺席 ⇒ fail-closed 503（退回 `guard()` 等于把伪造 Origin 重新放进来）；
     * 读面（GET，如 `/…/state` 状态轮询）维持 `guard()`。
     */
    const proofOfPossession = (req: IncomingMessage, res: ServerResponse): boolean => {
      const fence = (ctx as unknown as { get?: (name: string) => unknown }).get?.('connection') as ConnectionTrustFence | undefined
      if (fence === undefined || typeof fence.requestRejection !== 'function') {
        ctx.logger?.warn?.('pico-connectors: connection service unavailable; refusing a local write (fail-closed)')
        json(res, 503, {
          error: 'browser session proof unavailable',
          hint: 'reopen the application window from its launch URL',
        })
        return false
      }
      let rejection: 401 | 403 | undefined
      try {
        rejection = fence.requestRejection({ headers: req.headers })
      } catch (err) {
        // 校验器自身抛错 = 无法证明 ⇒ 按拒绝处理（不把异常泄漏成 500）。
        ctx.logger?.warn?.(`pico-connectors: browser proof check failed (${err instanceof Error ? err.message : String(err)})`)
        rejection = 403
      }
      if (rejection === undefined) return true
      ctx.logger?.warn?.(`pico-connectors: refused a local write without browser proof (${String(rejection)})`)
      json(res, 403, {
        error: 'browser session proof required',
        hint: 'reopen the application window from its launch URL',
      })
      return false
    }
    const requireWriteProof = (req: IncomingMessage, res: ServerResponse): boolean =>
      req.method === 'GET' || proofOfPossession(req, res)

    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: '/api/pico/connectors', handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        if (!guard(req, res)) return
        list(req, res)
      } }),
      ctx.webServer.register({ kind: 'prefix', path: '/api/pico/connectors', handler: async (req, res) => {
        const segments = req.url?.split('/') ?? []
        const action = segments[5]?.split('?')[0]
        const handlers: Record<string, JsonHandler> = {
          connect: exact(connect),
          cancel: exact(cancel),
          'auth-submit': exact(authSubmit),
          state: exact(state),
          disconnect: exact(disconnectHandler),
          approve: exact(approve),
          deny: exact(deny),
          refresh: exact(refreshTokens),
        }
        if (!guard(req, res)) return
        // R7-RV-3：拿不到持有性证明就不进任何 handler（凭据/审批/handler 都不会
        // 被执行）。GET 只服务 `state` 轮询，维持 guard()。
        if (!requireWriteProof(req, res)) return
        const method = req.method ?? 'GET'
        const allowedMethods: Record<string, string> = {
          connect: 'POST',
          cancel: 'POST',
          'auth-submit': 'POST',
          state: 'GET',
          disconnect: 'POST',
          approve: 'POST',
          deny: 'POST',
          refresh: 'POST',
        }
        const expected = action ? allowedMethods[action] : undefined
        if (expected !== undefined && method !== expected) {
          return json(res, 405, { error: 'method not allowed' })
        }
        const handler = action ? handlers[action] : undefined
        // AWAIT the handler: the async ones (connect / refresh / approve) write
        // their response after a network round trip, and an unawaited promise
        // would both return an empty body to a caller that awaits this handler
        // and surface as an unhandled rejection when it throws.
        if (handler) return await handler(req, res)
        json(res, 404, { error: 'not found' })
      } }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'pico connectors: http routes')

  // Initial restore: wait for the bootstrap def sync (the directory is the
  // source now), then restore — startup with an empty defs list would skip
  // every registered credential. The session listener above handles later
  // changes; this covers the startup path. P2-23: it goes through the same
  // serialized lifecycle queue so a login that lands during boot supersedes
  // this restore instead of racing it.
  void runLifecycle(async () => {
    const epoch = lifecycleEpoch
    await syncServerDefs()
    await restoreAll(epoch)
  }).catch((cause: unknown) => {
    ctx.logger?.error('pico-connectors: initial restore failed', cause)
  })
}

export type { ConnectorDef, ConnectorState, ConnectorAuthRequest } from './types.ts'

/**
 * One-time migration of the pre-2026-08 legacy store dir `~/.picoaide/connectors`
 * into the per-user scope. Runs on every session change but only acts when a
 * real user is logged in, the legacy dir exists, and the target dir does not.
 * Best-effort: a failure leaves the legacy dir in place (the next login
 * retries) and never blocks the app. Anonymous (logged-out) sessions never
 * absorb the legacy data — it is claimed by the first account that logs in.
 *
 * TOCTOU hardening (2026-08-22): outside the `existsSync(target)` check the
 * claim is serialized through an atomic marker file created with `wx`
 * (O_EXCL). Whichever session/process creates the marker first wins the
 * legacy data; a loser finds the marker already present and returns quietly:
 * no double-rename, no lost update. The marker is removed after the rename so
 * a later real user can retry if the first claim found an empty store.
 */
function migrateLegacyStore(username: string | null): void {
  if (username === null || username.length === 0) return
  try {
    const legacy = join(homedir(), '.picoaide', 'connectors')
    if (!existsSync(legacy)) return
    const target = join(userScopePath(username), 'connectors')
    if (existsSync(target)) return
    mkdirSync(join(userScopePath(username)), { recursive: true, mode: 0o700 })
    // Atomic claim: only the first O_EXCL winner proceeds to the rename.
    const claim = join(userScopePath(username), '.legacy-claim')
    try {
      writeFileSync(claim, `${username}\n`, { mode: 0o600, flag: 'wx' })
    } catch {
      return // another session/process claimed first
    }
    try {
      renameSync(legacy, target)
    } finally {
      rmSync(claim, { force: true })
    }
  } catch {
    // Best effort: never let a migration failure break connector startup.
  }
}
