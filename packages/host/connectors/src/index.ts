import type { Context } from '@deepseek-ai/cordis'
import type { OAuthClientProvider } from '@modelcontextprotocol/client'
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
import { createOAuthProvider, isTerminalRefreshReason, resolveAuthorizationServer, resolveStaticAuthorizationServer, TokenRefresher, tokenNeedsRefresh, type RefreshedTokens, type RefreshFailure, type RefreshOutcome } from './mcp-oauth-provider.ts'
import type { McpTransportAuthProvider, OAuthTarget } from './mcp-oauth-provider.ts'
import { REFRESH_LEAD_MS, REFRESH_SWEEP_INTERVAL_MS } from './token-lifetime.ts'
import { userScopePath, unscopedConnectorPath } from './user-scope.ts'
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
  attachMcpLiveHeaders,
  claimMcpTransportFenceTargetWarning,
  ensureMcpTransportRedirectFence,
  isMcpOutboundBusy,
  MCP_TOOL_CALL_TIMEOUT_MS,
  McpTransportFenceUnavailableError,
  mcpActivityKey,
  mcpTransportFenceTargetWarning,
  whenMcpOutboundIdle,
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
 * How long a credential-change rebuild waits for the endpoint's in-flight MCP
 * calls before retiring the old transport (audit R9A-3).
 *
 * The rebuild is unavoidable for a provider-less http transport — the bearer is
 * baked into `requestInit.headers` and nothing re-reads it (V3A-N6) — and
 * `retire()` closes the client the SDK may still be answering a tool call on:
 * measured `ERR@616ms:Connection closed` with the call disposed mid-flight. The
 * wait is bounded because a stalled call (tool budget is 120 s) must not starve
 * the credential update; the grace covers the observed rebuild latency
 * (600–800 ms) with room to spare, and every expiry is logged.
 */
export const MCP_REBUILD_IDLE_GRACE_MS = 5_000

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
   * How long a credential-change rebuild waits for the endpoint's in-flight
   * MCP calls before retiring the old transport (audit R9A-3). The rebuild is
   * unavoidable for a provider-less http transport (V3A-N6), and retiring it
   * closes the client the SDK may still be answering a tool call on, so the
   * wait is what turns "call cut mid-flight" into "call finishes, then the new
   * transport takes over". Bounded: a stalled call must not starve the
   * credential update.
   *
   * Defaults to {@link MCP_REBUILD_IDLE_GRACE_MS}; tests inject a short value.
   */
  rebuildIdleGraceMs?: number
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
  /**
   * State patch carrying the stable code of a caught error (see connector-error.ts).
   *
   * 无 code 时也必须**带上这个键**（2026-09-17 S04-3 审计）：setState 是合并写，
   * 早先只在有 code 时才写字段，于是一条 `errorCode:'auth-required'` 会粘到
   * 之后任何一条未分类的失败上（客户端按 code 优先渲染 ⇒ 跳过本地化兜底、
   * 把原始错误文本直出），把分类契约反过来用。
   *
   * 同一条审计的反向规则：**凡是写 `error` 的 setState 都要同时交代 `errorCode`**
   * —— 拿不到分类就显式写 `errorCode: undefined`（下面所有清空错误、或换成未
   * 分类消息的路径），否则同一个字段会以另一种方式粘住。
   */
  const withCode = (error: unknown): { errorCode?: ReturnType<typeof connectorErrorCodeOf> } =>
    ({ errorCode: connectorErrorCodeOf(error) })

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

  // R6-B-2: the SECOND half of the credential scope. Same source and same
  // read-per-call shape as `@picoaide/dsh-browser`'s `currentServerHash()` —
  // one machine can be logged into two deployments, and the credential of the
  // first must never be handed to the second (see `./user-scope.ts`).
  const currentServerURL = (): string | null => {
    try {
      const pico = ctx.get('picoSession') as { getSession?: () => { serverURL?: string } | null } | undefined
      const serverURL = pico?.getSession?.()?.serverURL
      return typeof serverURL === 'string' ? serverURL : null
    } catch {
      return null
    }
  }

  // Per-(account, server) store. Rebuilt when the session changes; the old
  // user's MCP registrations are disconnected first (server-side tokens stay on
  // disk per account AND per server, never shared across either).
  let store = new ConnectorStore(
    options.storeBaseDir
      ? { baseDir: options.storeBaseDir }
      : { username: currentUser(), serverURL: currentServerURL() },
  )
  // Local-approval ledger for server-issued stdio commands (FIX-02), scoped the
  // same way: the commands it vouches for come from ONE tenant's catalog.
  let approvals = new ConnectorApprovalStore(
    options.storeBaseDir
      ? { baseDir: options.storeBaseDir }
      : { username: currentUser(), serverURL: currentServerURL() },
  )
  const states = new Map<string, ConnectorState>()
  /**
   * Ids whose STORED credential currently carries a refresh token — i.e. exactly
   * the fact behind the panel's "refresh now" affordance.
   *
   * Keyed by **(credential scope, connector id)**, the same account dimension
   * `deadGrants` / `warnedDeclaredAuthorization` carry (2026-09-23 rule: a fact
   * about "this account's credential file at this generation" must not be keyed
   * by the connector alone). A credential read from account A's directory must
   * never make account B's row look refreshable.
   *
   * Unlike those two terminal markers this one is a **pure projection of disk**
   * (`noteCredential` is the only writer and `restoreAll` re-derives it from the
   * new account's credentials), so it is ALSO cleared on every session switch —
   * see {@link teardownAll}. Without that clear, a `noteCredential` from a write
   * that was already in flight when the session moved on would leave the
   * previous account's id behind for the whole of the next account's restore
   * pass, and `canRefresh` would offer a refresh that reads an empty credential
   * and answers `not-applicable` (R13-B-P2-4).
   */
  const refreshable = new Set<string>()
  /**
   * ONE key constructor for the write and the read of {@link refreshable}.
   *
   * Split ownership is this repository's recurring defect shape (the judgement,
   * the bookkeeping and the cleanup must agree on the key): `\u0000` cannot occur
   * in a directory path, so scope and id can never be re-split ambiguously.
   * @param scope - credential scope (`ConnectorStore.dir`) the credential came from.
   * @param id - connector id.
   * @returns the set key.
   */
  const refreshableKey = (scope: string, id: string): string => `${scope}\u0000${id}`

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
   * The OAuth-backed `authProvider` for one streamable-http registration.
   *
   * Discovery is resolved here (through the same policy-checked routine the
   * refresh engine uses) and handed to the SDK as saved discovery state, so the
   * SDK's refresh goes to the definition's authorization server and never to
   * one the resource server named — without a second, unfenced discovery round
   * trip.
   *
   * The returned `authProvider` is our `AuthProvider` face, NOT the full
   * `OAuthClientProvider` (see `createOAuthProvider`): an OAuth-classified
   * provider is replaced by the SDK's `adaptOAuthProvider`, whose hard-coded
   * `onUnauthorized` bypasses the per-id single flight on a 401.
   */
  const mcpAuthProvider = async (
    def: ConnectorDef,
    credential: ConnectorCredential | null,
  ): Promise<{ authProvider?: McpTransportAuthProvider; handle?: LiveProviderHandle }> => {
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
      // CN-2 (audit 2026-09-23): this branch used to build the provider with NO
      // discovery state, and the SDK then re-discovered the authorization server
      // from the MCP URL — `WWW-Authenticate: resource_metadata` of the RESOURCE
      // server's choosing, then its `authorization_servers[0]` — and POSTed the
      // stored refresh token to whatever token endpoint came back. The
      // definition's own `tokenUrl` is the authority instead, and resolving it
      // is pure policy checking: no round trip, so the fast path this branch
      // exists for is preserved.
      const staticResolved = resolveStaticAuthorizationServer(target, locale())
      if (staticResolved.discovery === undefined) {
        ctx.logger?.warn(`pico-connectors: ${def.id} 静态端点不可用（${staticResolved.failure?.message ?? 'unknown'}）`)
        return {}
      }
      const baseline: { current: ConnectorCredential } = { current: credential }
      const created = createOAuthProvider({
        credential,
        target,
        discovery: staticResolved.discovery,
        ensureFresh: async () => await ensureCredentialFresh(def.id, baseline),
        // 401 的强制刷新（2026-09-24）：服务器说这枚访问令牌已死时，看时钟的
        // `ensureFresh` 会直接跳过（服务器侧失效而本地 `expiresAt` 还在未来），
        // 于是 SDK 只能自己再刷一次 —— 那条路径不在 per-id 单飞里，并发 401
        // 会把同一个单次 refresh token 出示两次（轮换复用检测吊销整个授权）。
        refreshOnUnauthorized: async () => await refreshForUnauthorized(def.id, baseline),
        log: (message) => ctx.logger?.warn(`pico-connectors: ${def.id} ${message}`),
        // **必须 await 落盘**（2026-09-17 flake 定案）：`saveTokens` 是 SDK 自己
        // 续期后唯一的持久化点，而 provider 的 `tokens()` 又会把内存里的新令牌
        // 交给下一次请求。写盘一旦 fire-and-forget，SDK 的续期就已经"完成"了而
        // 磁盘还是旧的 —— 随后任何读者（registerMcp 的建 provider、restoreAll）
        // 都可能拿着一枚**已被消费**的 refresh token 去续期，轮换复用检测随即
        // 吊销整个授权（实测窗口 4–29ms，CI 里就是那条
        // `InvalidGrantError: refresh token already used`）。
        onPersist: async (patch: Partial<ConnectorCredential>) => {
          if (registrationScope !== store.dir) return
          await persistAndMaybeAnnounce(def.id, patch, baseline.current)
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
      // The TRANSPORT face, never `created.provider`: an OAuth-classified
      // provider is replaced by the SDK's `adaptOAuthProvider`, which would
      // hard-code `onUnauthorized` and bypass our per-id single flight.
      return { authProvider: created.transportProvider, handle }
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
        ensureFresh: async () => await ensureCredentialFresh(def.id, baseline),
        // 与静态端点分支同一条 401 收口（见上）。
        refreshOnUnauthorized: async () => await refreshForUnauthorized(def.id, baseline),
        log: (message) => ctx.logger?.warn(`pico-connectors: ${def.id} ${message}`),
        // The SDK's persistence point: a rotated refresh token or a new
        // access token must reach the store, or the next process (or the
        // next registration) would refresh with a dead grant. Never through
        // a store that a user switch has replaced in the meantime.
        // **必须 await 落盘**（2026-09-17 flake 定案）：返回 undefined 会让
        // `saveTokens` 在持久化之前就 resolve，随后任何读者都可能拿到已被消费的
        // refresh token（见上面静态端点分支的同一段说明）。
        onPersist: async (patch: Partial<ConnectorCredential>) => {
          if (registrationScope !== store.dir) return
          await store.updateCredentialIfUnchanged(def.id, baseline.current, patch)
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
      // The TRANSPORT face, never `created.provider`: an OAuth-classified
      // provider is replaced by the SDK's `adaptOAuthProvider`, which would
      // hard-code `onUnauthorized` and bypass our per-id single flight.
      return { authProvider: created.transportProvider, handle }
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
    byServer.set(mcpServerKey(id, serverName), handle)
    liveProviders.set(id, byServer)
  }

  /** Drop one server's handle (its transport is gone or about to be replaced). */
  function dropLiveProvider(id: string, serverName: string): void {
    const byServer = liveProviders.get(id)
    if (byServer === undefined) return
    byServer.delete(mcpServerKey(id, serverName))
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
      // R9-D-1's deadline is the SDK's 401 retry, which reads
      // `_requestInit.headers` the moment its refresh resolves — i.e. as soon as
      // the promise this callback is running inside settles. The event listener
      // below reaches the same record, but only through an `await
      // store.readCredential()`, so the retry used to race that disk read
      // (measured: the retry's header snapshot lands 3–4 ms after the refresh
      // resolves, and a ≥1 ms stall in the read is enough to replay the stale
      // declared header and 401 a second time — audit G4 2026-09-24). Apply the
      // record here, synchronously and from the credential the refresh JUST
      // persisted: no await between the write and the in-memory update, so the
      // retry cannot read a generation the store has already left behind. The
      // listener still runs (it also decides rebuilds, and re-applying the same
      // render is idempotent).
      const announced = defs.find(entry => entry.id === id)
      if (announced !== undefined) {
        // The synchronous refresh is an OPTIMIZATION of the hand-off the emit
        // below drives, not a second truth path: that listener re-reads the same
        // credential and re-applies the same render (`handOffLiveHeaders`, which
        // has its own catch), and a rebuild re-reads the store again. What must
        // NOT happen is this call taking the emit down with it — the emit is what
        // re-registers stdio children (their token lives in the child
        // environment), and before this guard a throwing render sat in FRONT of
        // it: one cosmetic defect in a credential file (`"fields": null`, R10 N1)
        // became a rejected refresh, an HTTP 500 on the panel route and a lost
        // stdio re-registration. Catch-and-log hides nothing: the same defect
        // still produces the listener's own `令牌移交给活传输失败` line, and this
        // one names the connector, so the failure stays searchable in the host
        // log while the refresh chain keeps working.
        try {
          refreshLiveHeaders(announced, persisted)
        } catch (cause: unknown) {
          ctx.logger?.warn(`pico-connectors: ${id} 同步刷活头失败（已跳过；事件与重注册继续）`, cause)
        }
      }
      ctx.emit('pico/connector-credentials-changed', { id })
    },
    ...(options.outboundTimeoutMs === undefined ? {} : { timeoutMs: options.outboundTimeoutMs }),
  })

  /**
   * 走**同一个** per-id 单飞刷新一个凭据；`force` 跳过"是否临期"的时钟判断。
   *
   * `force=false`（`ensureFresh`，看时钟的保鲜路径）与 `force=true`
   * （`refreshForUnauthorized`，401 的强制路径）**共用这一处**：判定、记账、CAS
   * 基准前移只有一份实现，两条路径不可能对"刷新有没有发生"给出不同答案。
   * @param id - 连接器 id。
   * @param baseline - 该 provider 的 CAS 基准快照（刷新落盘后同步前移）。
   * @param force - true 时即使 `expiresAt` 还在未来也真的去刷新。
   * @returns 刷新引擎的分类结果（`not-applicable` = 这个连接器没有可续期的材料）。
   */
  const refreshThroughEngine = async (
    id: string,
    baseline: { current: ConnectorCredential },
    force: boolean,
  ): Promise<RefreshOutcome> => {
    const outcome = await tokenRefresher.refresh(id, {
      ...(force ? { force: true } : {}),
      locale: locale(),
    })
    if (!outcome.ok) return outcome
    // 刷新引擎的 onRefreshed 已经把新凭据喂给活着的 provider（adopt +
    // syncBaseline）；这里再把这个 provider 自己的 CAS 基准前移，避免 SDK 之后
    // 的持久化拿着被取代的快照做比较而静默丢弃。
    const persisted = await store.readCredential(id)
    if (persisted !== null) baseline.current = persisted
    return outcome
  }

  /**
   * 让 SDK provider 交出令牌前先确保新鲜 —— 走**同一个** per-id 单飞。
   *
   * 2026-09-17：SDK 的 401 自愈（`authInternal` → `tokens()` →
   * `refreshAuthorization`）不在 `TokenRefresher.inflight` 里。它和我们的刷新
   * （心跳 / 面板 / 重开恢复）并发时，同一个单次 refresh token 会被出示两次，
   * 启用轮换复用检测的授权服务器（RFC 6749 §10.4）会吊销整个授权 —— CI 里的
   * `InvalidGrantError: refresh token already used` 就是这条。
   *
   * SDK 的四个 `tokens()` 调用点全部 `await provider.tokens()`，所以收口放在
   * provider 的 `tokens()` 里：快过期时先经这里刷一次，SDK 拿到的是当前世代，
   * 于是它不会再发起自己的刷新 —— 刷新的主人只剩一个（`TokenRefresher`）。
   *
   * **这条路看时钟**：服务器侧把访问令牌作废（本地 `expiresAt` 仍在未来）时它会
   * 直接跳过，那种情况由 {@link refreshForUnauthorized} 处理。
   * @param id - 连接器 id。
   * @param baseline - 该 provider 的 CAS 基准快照（刷新落盘后同步前移）。
   * @returns 刷新后的令牌；未刷新或失败时返回 null（provider 交回旧令牌，SDK 按原
   *   路径升级为 transient / 需要重新授权）。
   */
  const ensureCredentialFresh = async (
    id: string,
    baseline: { current: ConnectorCredential },
  ): Promise<RefreshedTokens | null> => {
    const outcome = await refreshThroughEngine(id, baseline, false)
    return outcome.ok ? outcome.tokens : null
  }

  /**
   * 401 的刷新入口（`createOAuthProvider` 的 `refreshOnUnauthorized`）。
   *
   * 强制语义是这条的全部意义：401 是**服务器侧**的失效事实，本地 `expiresAt`
   * 常常还在未来（CI 回归正是服务端 `expireAccessTokens()` + 本地一小时后到期），
   * 所以不允许再问一次时钟。并发 401 由 `TokenRefresher.inflight` 合并成一次刷新
   * —— 这正是"一个凭据一个刷新主人"在 401 路径上的落地（2026-09-24）。
   * @param id - 连接器 id。
   * @param baseline - 该 provider 的 CAS 基准快照。
   * @returns 分类后的结果；provider 只在 `ok` 时 adopt，其余情况记日志后正常返回。
   */
  const refreshForUnauthorized = async (
    id: string,
    baseline: { current: ConnectorCredential },
  ): Promise<RefreshOutcome> => await refreshThroughEngine(id, baseline, true)
  const pendingRequests = new Map<string, ConnectorAuthRequest>()
  /** Server-issued stdio commands waiting for a local decision, keyed by connector id. */
  const pendingApprovals = new Map<string, PendingApproval>()
  /** Composite key of one MCP server inside ONE connector (live providers). */
  const mcpServerKey = (id: string, serverName: string): string => JSON.stringify([id, serverName])
  /**
   * Dead-grant terminal state: **(account scope, connector id) → the credential
   * generation (`updatedAt`) that was rejected with
   * `invalid_grant`/`invalid_client`**.
   *
   * The fact belongs to ONE ACCOUNT's credential file, so the account is part of
   * the key — not a separate cleanup path (R3-B2 audit 2026-09-23, R3B2-2).
   * Keyed by connector id alone, account A's revocation was inherited by account
   * B whenever B's stored credential carried the same generation, which is what
   * a provisioned/copied credential file looks like: B was told to authorize
   * again, with zero network round trips, although its token was usable. The
   * scope is the resolved store directory — the same identity `TokenRefresher`
   * snapshots as `scopeAtStart` — so two accounts can never share an entry, and
   * another account's entry is unreachable rather than merely cleared (a user
   * switch keeps THIS account's terminal state, exactly like the durable row
   * state, and re-arms nothing).
   *
   * In memory on purpose: the marker is an optimization of the AUTOMATIC sweep
   * (one probe per account and process is acceptable, a probe per minute forever
   * is not), while the durable facts (row `unauthorized` + the stored credential)
   * already survive a restart. A successful re-authorization writes a new
   * generation, so the entry stops matching and automatic recovery is re-armed
   * without any explicit clearing.
   */
  const deadGrants = new Map<string, number>()
  /**
   * Key of one dead-grant marker: account scope + connector id, built in ONE
   * place so every read, write and delete agrees on it (a marker judged under a
   * different key than it was recorded under would silently re-arm, or never
   * arm, the automatic recovery).
   *
   * NUL separates the halves: no filesystem path can contain it, and connector
   * ids are already validated to `[A-Za-z0-9._-]`, so no two scope/id pairs can
   * collide by concatenation.
   */
  const deadGrantKey = (scope: string, id: string): string => `${scope}\u0000${id}`
  /** Is the credential just read from THIS account's store the generation already proven dead? */
  const isDeadGrant = (scope: string, id: string, credential: ConnectorCredential): boolean =>
    deadGrants.get(deadGrantKey(scope, id)) === credential.updatedAt
  /** Record the generation whose grant the authorization server revoked, under ITS OWN account. */
  const markDeadGrant = (scope: string, id: string, credential: ConnectorCredential): void => {
    deadGrants.set(deadGrantKey(scope, id), credential.updatedAt)
  }
  /** Re-arm automatic recovery for one account's connector (fresh generation / disconnect). */
  const clearDeadGrant = (scope: string, id: string): void => {
    deadGrants.delete(deadGrantKey(scope, id))
  }
  /**
   * 一次刷新失败 ⇒ 行状态 + 终态标记。**唯一实现**：恢复、后台扫掠、面板按钮三条
   * 路径共用，它们不能对"哪些失败是终态"给出不同答案。
   *
   * R4-B-10（审计 2026-09-23）就是这条唯一性缺失的后果：面板「刷新」按钮遇到
   * `invalid_grant` 时只 `setState`、不 `markDeadGrant`，于是下一次后台扫掠又把
   * **已被消费掉**的 refresh token 出示给 IdP（探针实测 reuse 0→1→2；由扫掠检出的
   * 对照组停在 1）。R4-B-8 的另一半同理：`invalid_scope` 一类**请求级**永久拒绝
   * （{@link isTerminalRefreshReason} 的 `terminal`）也必须走这里，否则 60s 扫掠
   * 永远重发同一条注定失败的请求。
   *
   * 5xx/网络（`transient`）语义**不变**：不是终态、不装标记，行状态留给调用点
   * （扫掠保持原状以便下一轮继续试探，面板按钮显示错误文案）。
   * @param scope - account scope the credential was read from (`store.dir`).
   * @param id - connector id.
   * @param credential - the credential generation the failing attempt used, or
   * `null` when the attempt had none (then no marker can be keyed to a generation).
   * @param outcome - the classified failure.
   * @returns true when the failure was terminal (marker armed + row flipped).
   */
  const applyRefreshFailure = (
    scope: string,
    id: string,
    credential: ConnectorCredential | null,
    outcome: RefreshFailure,
  ): boolean => {
    if (!isTerminalRefreshReason(outcome.reason)) return false
    if (credential !== null) markDeadGrant(scope, id, credential)
    setState(id, { status: 'unauthorized', everConnected: true, error: outcome.message, errorCode: 'auth-required' })
    return true
  }
  /**
   * Live MCP registrations, keyed by **serverName** — the namespace upstream
   * `mcp-client` reserves for exactly ONE live instance.
   *
   * The key stays the bare name on purpose: `tests/lifecycle.spec.ts > disposes
   * the previous registration when the same server key is registered again`
   * (P2-23) pins that a later registration of the same key retires the previous
   * one before it loads — upstream's plugin throws "serverName is already in
   * use" otherwise, and a credential refresh re-registers through exactly this
   * path.
   *
   * CN-4 (audit 2026-09-23) is the other half of that event: the row whose
   * transport was taken over kept claiming `connected` while its tools were
   * gone. The VALUE therefore carries the owning connector id, so
   * {@link retireServerName} can tell the vacated row the truth instead of
   * leaving it lying.
   */
  interface McpRegistration {
    /** Connector that owns the live registration. */
    id: string
    /**
     * The MCP endpoint this registration's transport talks to, for
     * streamable-http registrations only (stdio has no URL).
     *
     * It exists for ONE decision: whether the rebuild that is about to retire
     * this transport is the endpoint's only live user. Only then may its
     * give-up release the endpoint's outbound tickets (R10 N2 — the fence keeps
     * the tickets per transport instance but the waiter cannot name the
     * instance, so it needs this proof instead of assuming). "Same endpoint" is
     * compared under the fence's own {@link mcpActivityKey}, never as a raw
     * string: the tickets of `/mcp?a=1` and `/mcp?a=2` live in one bucket, so
     * they must count as the same endpoint here too.
     */
    endpoint?: string
    dispose: () => void
    /**
     * The mutable header record the fence installed as this transport's
     * `_requestInit.headers`, when there is one. Present only for a
     * provider-backed streamable-http transport (the fence finds the record on
     * the provider object it already reads); its presence is the criterion for
     * "a credential change can be applied to this transport in place", which is
     * the R9-D-1 fix. {@link refreshLiveHeaders} is the only writer.
     */
    liveHeaders?: Record<string, string>
  }
  const mcpRegistrations = new Map<string, McpRegistration>()

  /**
   * Header records that are **attached to a transport but not registered yet**:
   * the record source that closes the registration window (R11-B-01).
   *
   * `registerMcp` renders the record from its credential snapshot and hands it to
   * the fence (`attachMcpLiveHeaders` — which is what makes it
   * `_requestInit.headers`) BEFORE `ctx.plugin` runs, and only publishes it to
   * {@link mcpRegistrations} AFTER `ctx.plugin` resolved — i.e. after the real MCP
   * handshake (`client.connect` = initialize + `listTools`). A refresh landing
   * anywhere in that window used to reach neither source: the registration map had
   * no entry yet, and the sibling catch-up `adoptLatestRefresh` feeds only the
   * provider. So the declared "leave empty to auto-fill the bearer" header
   * (`X-Probe-Key: ''`, the R9-D-1 shape) kept the REPLACED token, the JSON-RPC
   * body frames carried a dead bearer, the endpoint answered 401 twice and the
   * whole registration failed with `Server returned 401 after re-authentication` —
   * while `restoreAll` still wrote `status: 'connected'`. The window is not a few
   * milliseconds: it is the entire handshake.
   *
   * This is the SAME record, found through a second source — not a second
   * judgement: {@link refreshLiveHeaders} renders and sweeps both sources with one
   * body of code (the render is `renderTransportHeaders`, the criterion is
   * `def.id`), so "should this be refreshed" cannot drift between the registration
   * path and the refresh path.
   *
   * Keyed by `serverName` exactly like {@link mcpRegistrations} (that map holds at
   * most one registration per name — upstream reserves the name per live
   * instance), and the owner id travels with the record so a refresh of one
   * connector can never write into another's record. The record is handed over
   * (removed here) when its registration publishes, and dropped when that
   * registration is superseded, fails to load, or is retired.
   */
  const pendingLiveHeaders = new Map<string, { id: string, headers: Record<string, string> }>()

  /** Forget an attached-but-unpublished record, unless it belongs to another owner. */
  const dropPendingLiveHeaders = (serverName: string, ownerId?: string): void => {
    const pending = pendingLiveHeaders.get(serverName)
    if (pending === undefined) return
    if (ownerId !== undefined && pending.id !== ownerId) return
    pendingLiveHeaders.delete(serverName)
  }

  /**
   * Retire whatever live registration owns `serverName`, and — when it belonged
   * to ANOTHER connector — stop that connector's row from claiming `connected`.
   *
   * Called before every load (`registerMcp`), so the name is always free for the
   * new instance.
   * @param serverName - the upstream-reserved name being (re)registered.
   * @param ownerId - the connector performing the registration.
   * @param ownerName - its display name (named in the vacated row's message).
   */
  const retireServerName = (serverName: string, ownerId: string, ownerName: string): void => {
    const previous = mcpRegistrations.get(serverName)
    if (previous === undefined) return
    dropLiveProvider(previous.id, serverName)
    // The retired registration's own attached record must not outlive it — but
    // only when the name is changing hands: a re-registration by the SAME
    // connector has already attached its new record under this name, and that is
    // the one a refresh landing during the handshake must reach (R11-B-01).
    if (previous.id !== ownerId) dropPendingLiveHeaders(serverName, previous.id)
    try { previous.dispose() } catch { /* teardown never throws */ }
    mcpRegistrations.delete(serverName)
    if (previous.id === ownerId) return
    // Upstream allows one live instance per name, so taking the name over
    // disposes the other connector's transport — and with it every tool of that
    // row. Reporting `connected` from here on would be a lie.
    setState(previous.id, {
      status: 'error',
      everConnected: true,
      error: copy('flow.serverNameTaken', { serverName, by: ownerName }),
      errorCode: undefined,
    })
  }
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
    for (const registration of mcpRegistrations.values()) {
      try { registration.dispose() } catch { /* teardown never throws */ }
    }
    mcpRegistrations.clear()
    // Records whose transports are still loading die with the scope that started
    // them: nothing may write one account's token into a record the next account's
    // registration could pick up (R11-B-01; same reason as `liveProviders.clear()`).
    pendingLiveHeaders.clear()
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
    // ...and the row projection that makes the panel offer "refresh now"
    // (R13-B-P2-4). `restoreAll` re-derives it from the NEW account's
    // credentials, so the next account starts from its own facts and never from
    // the previous account's — a connector B never authorized must not look
    // refreshable in the window before that restore pass finishes (and would
    // only earn a `not-applicable` error when clicked).
    //
    // `deadGrants` and `warnedDeclaredAuthorization` deliberately survive this
    // teardown: they are terminal facts about a scope-keyed credential file and
    // are already keyed by `store.dir`, whereas this set is a pure projection of
    // whatever is on disk right now (see `refreshable`'s own comment).
    refreshable.clear()
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
  const reconfigureUser = (eventServerURL?: string | null): void => {
    const username = currentUser()
    // Migrate legacy `~/.picoaide/connectors` once (first login after
    // upgrade): A's pre-upgrade credentials must not be lost silently.
    migrateLegacyStore(username)
    if (!options.storeBaseDir) {
      // Scope (account, server). The service read is authoritative; the event
      // payload is the fallback, exactly like the browser plugin resolves its
      // partition hash (`currentServerHash() ?? serverPartitionHash(event…)`).
      // A session event can arrive before/while the service is updated, and
      // "no evidence of the new server yet" must not silently keep the old
      // server's directory.
      const serverURL = currentServerURL() ?? eventServerURL ?? null
      store = new ConnectorStore({ username, serverURL })
      approvals = new ConnectorApprovalStore({ username, serverURL })
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
      reconfigureUser((next as { serverURL?: string } | null)?.serverURL ?? null)
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
      noteCredential(target.dir, id, current)
      return current
    }
    const saved = await target.updateCredentialIfUnchanged(id, expected, patch)
    if (saved === null) return null
    noteCredential(target.dir, id, saved)
    const token = saved.accessToken ?? ''
    if (token === '' || lastAnnouncedToken.get(id) === token) return saved
    lastAnnouncedToken.set(id, token)
    ctx.emit('pico/connector-credentials-changed', { id })
    return saved
  }

  /**
   * Mirror a credential's token facts onto {@link refreshable} and the row state.
   *
   * The **scope travels with the credential** (the caller passes the directory of
   * the very store instance it read from): taking it from the module-level
   * `store` here would key a credential read under account A against whichever
   * account happens to be current by the time the await resolved.
   * @param scope - credential scope (`ConnectorStore.dir`) of the credential.
   * @param id - connector id.
   * @param credential - the credential that was read, or null when there is none.
   */
  const noteCredential = (scope: string, id: string, credential: ConnectorCredential | null): void => {
    // Live set, so the list route can still report the manual-refresh
    // affordance while the row is idle (state is only written on transitions).
    const key = refreshableKey(scope, id)
    if (credential?.refreshToken === undefined) refreshable.delete(key)
    else refreshable.add(key)
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

  /** Header names are case-insensitive; the SDK and `fetch` normalize them too. */
  const AUTHORIZATION_HEADER = 'authorization'

  /**
   * The one spelling every authorization-slot header is rendered under.
   *
   * `_commonHeaders()` (pinned SDK) builds its headers as
   * `new Headers({ ...(token ? { Authorization: `Bearer ${token}` } : {}), ...normalizeHeaders(requestInit.headers) })`.
   * An object literal keyed EXACTLY `Authorization` therefore OVERWRITES the
   * provider's copy, while a lower-case `authorization` survives as a second
   * key and `new Headers()` — which appends — sends one comma-joined value
   * (`Bearer <token>, ApiKey <field>`), which no server accepts. Rendering every
   * authorization-slot header under this spelling makes "the declared value
   * wins" true for every spelling the admin console accepts (R8-B-1 / V3A-N2).
   */
  const AUTHORIZATION_KEY = 'Authorization'

  /**
   * The authorization schemes this product REGISTERS as "a scheme word and
   * nothing else" — a WHITELIST, deliberately.
   *
   * This is what makes "does the declaration carry a credential?" a question
   * about the DECLARATION rather than about emptiness (R10-B-01). `'Bearer '` —
   * the canonical `Authorization: 'Bearer ${API_KEY}'` with the field unset or
   * misnamed — is not the empty string, yet it carries nothing: keeping it as
   * the administrator's own credential shadowed and blanked the provider's live
   * token, so the handshake 401ed, every retry 401ed, and the row still said
   * `connected` (the very fault R9A-1 removed for the empty spelling).
   *
   * Only the words below (trimmed, case-insensitive) count as that scheme form.
   * Every OTHER single token is a definition's own OPAQUE credential and must be
   * sent exactly as written: `Authorization: 'abc123'` / `'sk-live-1234'` /
   * `'mytoken'` are how several MCP endpoints authenticate, and a shape test
   * ("one RFC 7230 token") would have silently replaced them with the framework
   * bearer — or DELETED the header when there is no stored token — which is the
   * R10-B-01 fault one spelling over, in the opposite direction (R10-F5 review).
   * So: whitelist in, never a shape rule.
   */
  const AUTHORIZATION_SCHEME_WORDS: ReadonlySet<string> = new Set([
    'bearer', // RFC 6750 — the provider token and `Bearer ${FIELD}` shape this product uses
    'basic', // RFC 7617 — `Basic ${FIELD}` (base64 user:password)
    'digest', // RFC 7616 — `Digest ${FIELD}`
    'negotiate', // RFC 4559 — `Negotiate ${FIELD}` (SPNEGO/Kerberos)
    'ntlm', // the Windows sibling of Negotiate, same "scheme + credential" shape
    'apikey', // `ApiKey ${FIELD}` — this repo's own API-key connector fixtures
    'api-key', // the same scheme, hyphenated spelling seen in the field
    'token', // `Token ${FIELD}` — opaque-token scheme several MCP endpoints document
    'jwt', // `JWT ${FIELD}` — opaque-JWT scheme used by several gateways
    'ssws', // Okta's `SSWS ${FIELD}`
    'aws4-hmac-sha256', // AWS SigV4 `AWS4-HMAC-SHA256 Credential=…`
  ])

  /**
   * Header names the renderer REFUSES explicitly instead of letting JavaScript
   * semantics decide (R10-B-05).
   *
   * `headers['__proto__'] = 'x'` is a no-op on an ordinary object literal (the
   * inherited setter ignores non-object values), so such a declaration used to
   * vanish with no trace at all. It cannot be honored either: the pinned SDK
   * builds `new Headers({ ...record })`, and the `Headers` record branch DROPS
   * an own `__proto__` key (measured: `new Headers(spreadWithOwnProtoKey)`
   * enumerates nothing, while the sequence form keeps it). The only honest
   * disposition is to refuse it out loud — never emitted, never silently lost —
   * which is what {@link RenderedHeaders.refusedHeaderNames} carries to the
   * one-time warn.
   */
  const UNREPRESENTABLE_HEADER_NAMES = new Set(['__proto__'])

  /**
   * `renderHeaders` output plus the provenance of the framework's OWN credential
   * header: {@link RenderedHeaders.baked} names the authorization-slot entries
   * this function filled in from the stored access token.
   */
  interface RenderedHeaders {
    /**
     * The record the transport sends (and, for a provider-backed http
     * transport, the record the fence keeps refreshing in place).
     *
     * A NULL-PROTOTYPE record: `Object.keys` / `Object.hasOwn` are then exact
     * for every declaration an admin console can produce — a header named
     * `constructor` is an own key rather than an inherited one, and no
     * declaration can reach a prototype (R10-B-05).
     */
    headers: Record<string, string>
    /**
     * Key spellings the framework filled in ITSELF from the stored access
     * token — the authorization slot, and any declared header whose value the
     * definition left empty ("leave empty to auto-fill the bearer", literal or
     * template). A value under any OTHER name is still the definition's own
     * header (V3A-N1: it is sent, never deleted), but the framework owns its
     * CONTENT, which is what makes it refreshable in place (R9-D-1).
     */
    frameworkFilled: string[]
    /**
     * The declared spelling that owns the authorization slot, or null when the
     * framework fills that slot. Only a non-null value is a credential the
     * definition declared — a resolution that carries no credential is not one
     * (R9A-1, R10-B-01).
     */
    declaredAuthorization: string | null
    /**
     * The declared authorization spelling that LOOKED like it meant to carry a
     * credential (a non-blank literal, or a template) yet resolved to a value
     * with no credential in it, or null. Reported once so a misnamed
     * `${FIELD}` is searchable instead of silent (R10-B-01).
     */
    ignoredAuthorization: string | null
    /**
     * Declared header names refused by {@link UNREPRESENTABLE_HEADER_NAMES},
     * in declaration order. Reported once (R10-B-05).
     */
    refusedHeaderNames: string[]
  }

  /**
   * Render request headers: static `${FIELD}` templates from credential fields,
   * an empty declared value -> `Bearer <stored token>`, and the default Bearer
   * injection for OAuth/token credentials.
   *
   * Five rules the transport shape depends on:
   *
   *  - **A declaration that carries no credential is not a credential.** Every
   *    spelling of "left empty" renders the same way: the framework fills the
   *    bearer. Both halves of that sentence are load-bearing. The empty ones — a
   *    literal `''` and a template whose fields resolve to `''`
   *    (`Authorization: '${MISSING_FIELD}'`, which the webadmin free-form KV can
   *    produce) — shadowed and blanked the provider's live token, so every call
   *    (handshake included) went out with an EMPTY `Authorization` while the row
   *    said `connected` (R9A-1). The ones that resolve to a scheme word with
   *    nothing after it (`'Bearer ${API_KEY}'` with the field unset or MISNAMED,
   *    a literal `'Bearer '`, `'Bearer   '`) are the same fault one spelling
   *    over: `'Bearer '` is not `''`, yet it carries no credential, so keeping it
   *    sent `Bearer` as the credential, 401ed the handshake, 401ed every retry
   *    and burned one refresh grant per attempt (R10-B-01). Only the schemes in
   *    {@link AUTHORIZATION_SCHEME_WORDS} count as that form: a single token
   *    that is not on the list (`'abc123'`, `'sk-live-1234'`) IS a credential.
   *  - **One decision point.** {@link carriesCredential} is the ONLY place that
   *    answers "is this declaration a credential?", and the auto-fill path is
   *    the other side of the same answer: a declaration it rejects is treated
   *    exactly like a missing one. Two predicates would drift.
   *  - **A non-empty declaration wins over an empty one for the same slot.**
   *    `{Authorization: 'ApiKey ${API_KEY}', authorization: ''}` used to let the
   *    empty spelling overwrite the configured scheme before the provenance rule
   *    deleted the result (R9A-4).
   *  - **Provenance, not emptiness.** {@link RenderedHeaders.frameworkFilled}
   *    names every entry whose value the framework synthesized, so "ours to
   *    refresh / ours to drop" is decided by origin. A definition that declares
   *    `X-Probe-Key: ''` keeps that header: deleting it turned a working
   *    connector into a broken one (V3A-N1).
   *  - **One spelling per HTTP header.** Header names are case-insensitive, so
   *    every slot is keyed by its lower-case name and the record carries ONE
   *    entry per slot: the authorization slot under {@link AUTHORIZATION_KEY}
   *    (so the SDK's object spread collides key-for-key with the provider's copy
   *    instead of appending a second header, V3A-N2), every other slot under the
   *    spelling that currently owns it. `{'x-probe-key': 'A', 'X-Probe-Key': ''}`
   *    used to render TWO keys, which `new Headers()` — appending — sent as one
   *    comma-joined value nobody can parse (R10-B-02). When the winning
   *    declaration's spelling differs from the one already written, the old
   *    spelling is removed in the same step, so "one entry per slot" holds after
   *    a credential change too.
   * @param server - the MCP server definition being registered.
   * @param credential - the credential snapshot this registration was built from.
   * @returns the rendered headers plus the provenance of what the framework
   *   filled in itself.
   */
  const renderHeaders = (server: ConnectorMcp, credential: ConnectorCredential | null): RenderedHeaders => {
    // Null prototype: see `RenderedHeaders.headers` (R10-B-05).
    const headers: Record<string, string> = Object.create(null) as Record<string, string>
    const frameworkFilled: string[] = []
    const refusedHeaderNames: string[] = []
    /** The declared spelling that owns the authorization slot, if any (see above). */
    let declaredAuthorization: string | null = null
    /** The last authorization spelling rejected for carrying no credential. */
    let rejectedAuthorization: string | null = null
    /**
     * Does this declaration carry a credential? THE one predicate.
     *
     * A value with no non-whitespace character in it does not — `trim()` also
     * covers the Unicode spaces (`'\u00a0'`, `'\u3000'`, …) that reach here as
     * "something was typed in the box". On the authorization slot, a value that
     * is exactly one of the REGISTERED scheme words does not either
     * ({@link AUTHORIZATION_SCHEME_WORDS}) — the whitelist is what keeps an
     * opaque single-token credential (`'abc123'`) on the wire. Every other slot
     * keeps the literal reading: only blankness means absent (V3A-N1 — a
     * definition's own `X-Probe-Key` value is a credential even when it looks
     * like a scheme).
     * @param slot - lower-case header slot name.
     * @param resolved - the declaration's value after `${FIELD}` substitution.
     * @returns true when the declaration is the connector's own credential.
     */
    const carriesCredential = (slot: string, resolved: string): boolean => {
      const text = resolved.trim()
      if (text === '') return false
      return !(slot === AUTHORIZATION_HEADER && AUTHORIZATION_SCHEME_WORDS.has(text.toLowerCase()))
    }
    /** Which spelling each slot currently goes out under (one entry per slot). */
    const spelling = new Map<string, string>()
    /** Which side owns one slot; a declaration beats a synthesis. */
    const owner = new Map<string, 'declared' | 'framework'>()
    const disown = (key: string): void => {
      const index = frameworkFilled.indexOf(key)
      if (index >= 0) frameworkFilled.splice(index, 1)
    }
    /**
     * Write one slot, dropping the spelling it was previously rendered under.
     *
     * The drop is what keeps "one entry per HTTP header" true across a spelling
     * change: without it the record would carry both spellings and the SDK's
     * `new Headers()` would comma-join them (R10-B-02).
     */
    const setSlot = (slot: string, key: string, value: string, provenance: 'declared' | 'framework'): void => {
      const previous = spelling.get(slot)
      if (previous !== undefined && previous !== key) {
        delete headers[previous]
        disown(previous)
      }
      spelling.set(slot, key)
      headers[key] = value
      if (provenance === 'framework') {
        if (!frameworkFilled.includes(key)) frameworkFilled.push(key)
      } else {
        disown(key)
      }
      owner.set(slot, provenance)
    }
    /** Drop one slot entirely (no declaration carried a credential and no token). */
    const clearSlot = (slot: string): void => {
      const key = spelling.get(slot)
      if (key === undefined) return
      delete headers[key]
      disown(key)
      spelling.delete(slot)
      owner.delete(slot)
    }
    /**
     * "Leave empty to auto-fill the bearer", for one slot. A slot a declaration
     * already owns is left alone — the administrator's value is the credential,
     * and a declaration that carries none must not overwrite it.
     * @param slot - lower-case header slot name.
     * @param key - the spelling this slot is written under.
     */
    const fillFromToken = (slot: string, key: string): void => {
      if (owner.get(slot) === 'declared') return
      const token = credential?.accessToken
      if (token === undefined || token === '') {
        clearSlot(slot)
        return
      }
      setSlot(slot, key, `Bearer ${token}`, 'framework')
    }
    for (const [name, value] of Object.entries(server.headers ?? {})) {
      // Header names are case-insensitive: the SLOT is the lower-case name, and
      // every decision below (owner, spelling, deletion) is made on that slot.
      const slot = name.toLowerCase()
      if (UNREPRESENTABLE_HEADER_NAMES.has(slot)) {
        refusedHeaderNames.push(name)
        continue
      }
      const key = slot === AUTHORIZATION_HEADER ? AUTHORIZATION_KEY : name
      // `${FIELD}` resolves against the credential's OWN fields, never through
      // the prototype chain (R10 N3, the same closure as R10-B-05): a definition
      // that spells `${constructor}` / `${toString}` / `${valueOf}` (a mistyped
      // field name, the most common source of these) used to resolve to a
      // JavaScript function's SOURCE TEXT — non-empty, so it counted as a
      // credential, replaced the provider's live bearer, and shipped
      // `function toString() { [native code] }` to the MCP endpoint. With
      // `Object.hasOwn` an unknown name is '' : the slot carries no credential
      // and the framework fills it (or drops it) instead.
      //
      // `fields` comes off a FILE a user can hand-edit (the store sanitizes
      // hand-edited timestamps for exactly that reason), so it is not always the
      // record the type promises: `"fields": null` is a legal file. Looking a
      // field up in it must mean "this credential carries no such field" — that
      // is what `Object.hasOwn(null, …)` threw a TypeError over (R10 N1) and it
      // cost the WHOLE registration (`status="error"` with the raw TypeError, a
      // later panel refresh answering HTTP 500, and the live-header update plus
      // the stdio re-registration that follows it never running). Any
      // non-record takes the same branch: a string would otherwise resolve
      // `${0}` to a character, which is the same accident class R10 N3 removed.
      //
      // A value that is not a string is the same reading one level down
      // (R11-D-07): `{API_KEY: 42}` in a declared `Authorization: 'Bearer
      // ${API_KEY}'` used to render `Bearer 42`, which is non-empty, so
      // `carriesCredential` classified it as the administrator's own credential
      // and the provider's live token was displaced — a 401 loop over a value
      // nobody ever entered. `readCredential` already drops such values at the
      // single read boundary; this `typeof` keeps the render honest for any
      // credential that reaches here by another route (a snapshot, a fixture, a
      // future caller), so the two enforce ONE rule rather than two.
      const ownFields = credential?.fields
      const fields = typeof ownFields === 'object' && ownFields !== null && !Array.isArray(ownFields)
        ? ownFields
        : undefined
      const resolved = value === ''
        ? ''
        : value.replace(/\$\{([^}]+)\}/g, (_, field: string) => {
          if (fields === undefined || !Object.hasOwn(fields, field)) return ''
          const found: unknown = fields[field]
          return typeof found === 'string' ? found : ''
        })
      if (!carriesCredential(slot, resolved)) {
        // Same rule as a missing declaration: the framework fills this slot.
        if (slot === AUTHORIZATION_HEADER && value.trim() !== '') rejectedAuthorization = name
        fillFromToken(slot, key)
        continue
      }
      setSlot(slot, key, resolved, 'declared')
      if (slot === AUTHORIZATION_HEADER) declaredAuthorization = name
    }
    // The default bearer injection is keyed on the AUTHORIZATION SLOT, not on
    // the record being empty: a definition that declares any other header used
    // to lose its `Authorization` entirely, so a provider-less transport went
    // to the wire unauthenticated no matter how often it was rebuilt (R9A-2).
    fillFromToken(AUTHORIZATION_HEADER, AUTHORIZATION_KEY)
    return {
      headers,
      frameworkFilled,
      declaredAuthorization,
      // Only a slot no declaration ended up owning has a declaration to report
      // as "looked like a credential, carried none" (a later non-empty sibling
      // spelling wins the slot, which makes the earlier one moot).
      ignoredAuthorization: declaredAuthorization === null ? rejectedAuthorization : null,
      refusedHeaderNames,
    }
  }


  /**
   * The request headers a **streamable-http** transport is constructed with.
   *
   * `renderHeaders` bakes the stored access token into `Authorization`. That is
   * right for the static shapes (a token/CLI connector has no other way to
   * authenticate) and **wrong whenever the transport is also handed an
   * `authProvider`**: the pinned SDK writes the provider's LIVE token first and
   * then spreads `requestInit.headers` over it (`_commonHeaders()`,
   * `@modelcontextprotocol/client@2.0.0` `dist/index.mjs`), so a baked header
   * wins over every token a 401 refresh just obtained. The refresh succeeds,
   * the retry replays the DEAD token, and the first tool call fails with
   * `SdkHttpError: Server returned 401 after re-authentication` (R7-B P1-1,
   * measured against the real OAuth fixture). Dropping our own copy here is
   * what lets the provider's value through.
   *
   * The drop is keyed on **provenance, never on the header name** (R8-B-1):
   * only the entries `renderHeaders` filled in from the stored token are
   * removed, and only in the AUTHORIZATION slot. A definition that declares its
   * own `Authorization` scheme (`ApiKey ${FIELD}`, or a bearer of its own) keeps
   * it — that value IS the connector's credential, it is what the administrator
   * configured, and deleting it left the connector silently unauthenticated
   * (first call 401, while the panel blamed the authorization). Registration
   * reports that coexistence once, with a searchable warn, so "which one wins"
   * is observable instead of implicit. A framework-filled value under any OTHER
   * name is the definition's own header (V3A-N1) and stays: it is refreshed in
   * place instead ({@link refreshLiveHeaders}), which is what the R9-D-1
   * regression was about. The static-token class (no provider ⇒
   * `providerSuppliesAuthorization === false`) keeps every baked bearer.
   * @param server - the MCP server definition being registered.
   * @param credential - the credential snapshot this registration was built from.
   * @param providerSuppliesAuthorization - true when the transport also receives
   *   an `authProvider` that has a token of its own to send. This is the same
   *   predicate `mcpAuthProvider` used to BUILD that provider, so "provider
   *   present" and "our baked copy dropped" cannot drift apart again (R8-D-4).
   * @returns the headers for `requestInit`, plus the provenance the live-view
   *   refresh needs.
   */
  const renderTransportHeaders = (
    server: ConnectorMcp,
    credential: ConnectorCredential | null,
    providerSuppliesAuthorization: boolean,
  ): RenderedHeaders => {
    const rendered = renderHeaders(server, credential)
    if (!providerSuppliesAuthorization) return rendered
    if (rendered.frameworkFilled.includes(AUTHORIZATION_KEY)) delete rendered.headers[AUTHORIZATION_KEY]
    return rendered
  }

  /**
   * Hand the credential on disk to every live transport that reads its headers
   * per request (R9-D-1), right now.
   *
   * Not queued on purpose: the hand-off must not wait behind a lifecycle
   * operation, because the SDK's 401 retry reads the record the moment its own
   * refresh resolves. Scope-checked like every other store read — an account
   * switch replaces `store`, and this account's credential must not be rendered
   * onto the next account's transport.
   * @param def - the connector whose credential changed.
   */
  const handOffLiveHeaders = async (def: ConnectorDef): Promise<void> => {
    const target = store
    try {
      const credential = await target.readCredential(def.id)
      if (target.dir !== store.dir) return
      refreshLiveHeaders(def, credential)
    } catch (cause: unknown) {
      // The serialized rebuild below re-reads the credential and reports its own
      // failures; a failed hand-off must not take the event listener down.
      ctx.logger?.warn(`pico-connectors: ${def.id} 令牌移交给活传输失败`, cause)
    }
  }

  /**
   * Re-render one live transport's request headers from `credential`, in place.
   *
   * This is the R9-D-1 fix. The credential-change rebuild set deliberately
   * leaves provider-backed http transports alone (R8-B-2: re-registering one
   * disposes the very transport the SDK is retrying on), so every OTHER value
   * the registration baked — `X-Probe-Key: ''` → `Bearer <first token>`, the
   * documented "leave empty to auto-fill the bearer" shape — stayed frozen
   * forever: the 401 self-heal obtained a fresh token, the retry carried the
   * stale header, and EVERY later call 401ed while the row said `connected`.
   *
   * The fix is not a rebuild but a live view: the record installed here is the
   * object `hardenTransport` swaps into the instance's `_requestInit.headers`
   * (`attachMcpLiveHeaders`), and the pinned SDK re-reads that object on every
   * request (`_commonHeaders()`). Mutating it therefore reaches the next
   * request with no dispose, no re-registration and no window in which a call
   * can be cut — which is also why the 401 retry, whose header read happens
   * after `saveTokens` resolves, is fed synchronously from
   * `mcpAuthProvider`'s `onPersist`.
   *
   * Only registrations that carry a live view are touched; a provider-less
   * transport reads nothing lazily and is still rebuilt (V3A-N6).
   *
   * The record has TWO sources, and both are swept by the same code below: a
   * published registration ({@link mcpRegistrations}) and one whose transport is
   * still loading ({@link pendingLiveHeaders}, R11-B-01). The window between
   * attaching the record and publishing it contains the whole MCP handshake, so a
   * refresh landing there (the handshake's own `ensureFresh` retry, the panel
   * button, the 60 s sweep) has to reach the record the transport is about to
   * read — otherwise the declared auto-filled bearer goes to the wire on the
   * replaced token and the registration fails with 401s while the row claims
   * `connected`.
   * @param def - the connector whose credential changed.
   * @param credential - the credential as it is on disk now.
   * @returns how many live transports were refreshed.
   */
  const refreshLiveHeaders = (def: ConnectorDef, credential: ConnectorCredential | null): number => {
    let refreshed = 0
    /** Apply one rendered credential to one live record. THE one sweep. */
    const applyTo = (server: ConnectorMcp, live: Record<string, string>): void => {
      const next = renderTransportHeaders(server, credential, true).headers
      // `Object.hasOwn`, never `name in next` (R10-B-05): `in` also sees the
      // prototype chain, so a header the definition happens to name
      // `constructor` / `toString` / `valueOf` / `hasOwnProperty` was reported
      // as still-declared by every render and therefore NEVER removed — the
      // transport kept sending a value the definition no longer had. The
      // rendered records are null-prototype (see `RenderedHeaders.headers`), so
      // an own-property test is exact in both directions; today that prototype
      // would make `in` agree by accident, and this sweep deliberately does not
      // depend on the accident.
      for (const name of Object.keys(live)) if (!Object.hasOwn(next, name)) delete live[name]
      for (const [name, value] of Object.entries(next)) live[name] = value
      refreshed += 1
    }
    for (const server of def.mcp) {
      // BOTH sources are swept, and **both are swept when they coexist**: a
      // re-registration publishes its new record (above) while the previous
      // same-owner registration is still in `mcpRegistrations` — the handshake's
      // await points (`waitForRebuildClearance`) sit between the two — so for a
      // moment "the record this transport will read" names two objects: the
      // doomed one and the one about to be read. Stopping at the first match
      // fed the doomed record and left the new one on the replaced token, so the
      // registration the refresh was supposed to protect still went to the wire
      // with a dead bearer and failed with `Server returned 401 after
      // re-authentication` (round-11 review J2-N2). Ownership is still the only
      // criterion (`def.id`): another connector's record is never written, in
      // either source.
      const registration = mcpRegistrations.get(server.serverName)
      if (registration !== undefined && registration.id === def.id && registration.liveHeaders !== undefined) {
        // A published registration is the record source for this name; when it
        // belongs to another connector the name was taken over and this refresh is
        // not about that transport (CN-4).
        applyTo(server, registration.liveHeaders)
      }
      const pending = pendingLiveHeaders.get(server.serverName)
      // The pending record is the one this connector's in-flight registration
      // will read; it exists only between attach and publication, so an owner
      // match here is always the NEWER of the two.
      if (pending !== undefined && pending.id === def.id) applyTo(server, pending.headers)
    }
    return refreshed
  }

  /**
   * Connectors whose declared `Authorization` was already reported.
   *
   * The key carries the ACCOUNT/DEPLOYMENT scope (`store.dir` — the resolved
   * credential directory, the same first segment `deadGrants` uses) plus the
   * connector, the server and the declared name: `defs` is replaced wholesale on
   * a session change, so without the scope a shape first reported for one
   * account (or for one deployment sharing this plugin instance's lifetime)
   * would silence the line for the next one — the "memory-state keys must carry
   * the account scope" rule of 2026-09-23 (V3A-N3). The line describes a
   * DEFINITION shape, so it is reported once per scope rather than on every
   * re-registration; the set lives with the plugin instance.
   */
  const warnedDeclaredAuthorization = new Set<string>()

  /**
   * Report the declaration shapes a user cannot see any other way, once per
   * scope.
   *
   * Three lines, all ASCII-marked so a field log stays greppable whatever the
   * host locale is:
   *
   *  - `[declared-authorization]` — an oauth-classified connector's own
   *    `Authorization` value. `renderTransportHeaders` keeps it and the SDK
   *    spreads it over the token the provider wrote, so the declared value wins
   *    for EVERY spelling (the slot is normalized to {@link AUTHORIZATION_KEY},
   *    which is what makes the spread collide key-for-key instead of appending,
   *    V3A-N2). That is the administrator's own scheme (an `ApiKey ${FIELD}`
   *    endpoint, for instance) and it must not be deleted — but it also means a
   *    401 refresh obtains a token this header shadows, so the fact has to be
   *    searchable (R8-B-1).
   *  - `[declared-authorization-ignored]` — a declaration that LOOKED like a
   *    credential (non-blank literal, or a template) but resolved to a value
   *    carrying none: the shape `'Bearer ${API_KEY}'` with the field unset or
   *    MISNAMED produces, which is otherwise completely silent while the
   *    connector runs on the framework's bearer (R10-B-01).
   *  - `[unsupported-header]` — a declared header name the record cannot
   *    represent (`__proto__`), refused explicitly instead of vanishing into a
   *    JavaScript assignment no-op (R10-B-05).
   * @param def - the connector being registered.
   * @param server - the MCP server whose headers are being rendered.
   * @param rendered - the rendered record this registration was built from
   *   (`renderTransportHeaders` output: its `headers` may have lost the
   *   framework's authorization copy, the provenance fields are intact).
   * @param providerSuppliesAuthorization - whether the transport also receives
   *   an `authProvider` whose live token a declared value would shadow; the
   *   first line is only meaningful then.
   */
  const warnOnHeaderDeclarations = (
    def: ConnectorDef,
    server: ConnectorMcp,
    rendered: RenderedHeaders,
    providerSuppliesAuthorization: boolean,
  ): void => {
    const scope = `${store.dir}\u0000${def.id}\u0000${server.serverName}\u0000`
    const once = (kind: string, subject: string, line: string): void => {
      const key = `${scope}${kind}\u0000${subject}`
      if (warnedDeclaredAuthorization.has(key)) return
      warnedDeclaredAuthorization.add(key)
      ctx.logger?.warn(line)
    }
    if (providerSuppliesAuthorization && rendered.declaredAuthorization !== null) {
      once('declared', rendered.declaredAuthorization, `pico-connectors: [declared-authorization] ${def.id}/${server.serverName} 声明了 ${rendered.declaredAuthorization} 头：按 ${AUTHORIZATION_KEY} 发送并覆盖 OAuth 提供者的活令牌（声明值优先）`)
    }
    if (rendered.ignoredAuthorization !== null) {
      once('ignored', rendered.ignoredAuthorization, `pico-connectors: [declared-authorization-ignored] ${def.id}/${server.serverName} 声明的 ${rendered.ignoredAuthorization} 未解析出凭据（字段缺值/只有方案名）：按未声明处理，由框架填 ${AUTHORIZATION_KEY}`)
    }
    for (const name of rendered.refusedHeaderNames) {
      once('refused', name, `pico-connectors: [unsupported-header] ${def.id}/${server.serverName} 声明的头 ${name} 无法表示，已拒绝发送`)
    }
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

  /**
   * How many OTHER live registrations talk to this endpoint.
   *
   * Read off the registration records (not off `defs` + URL recomputation): the
   * record set IS the live set, so a connector dropped from the catalogue while
   * its transport is still alive keeps counting — the direction that must not
   * be missed.
   *
   * "This endpoint" is decided by {@link mcpActivityKey} — the SAME normalization
   * the fence files outbound tickets under, imported rather than re-spelled
   * (R10 N2). Comparing the raw URLs instead made the proof disagree with the
   * bookkeeping: `/mcp?a=1` and `/mcp?a=2` share one ticket bucket but are two
   * different strings, so a rebuild proved itself alone and its give-up cleared
   * the other transport's in-flight ticket.
   * @param endpoint - the streamable-http URL of the registration being rebuilt.
   * @param serverName - the server being rebuilt (excluded from the count).
   * @returns the number of live registrations whose endpoint is the same.
   */
  const otherLiveTransportsAt = (endpoint: string, serverName: string): number => {
    const key = mcpActivityKey(endpoint)
    // An unparseable URL matches nothing, so nothing can be proven: report the
    // whole live set so the caller is never "alone". (`whenMcpOutboundIdle`
    // reads the same unparseable URL as idle, so this only decides the release
    // — and there the answer must be "release nothing".)
    if (key === null) return mcpRegistrations.size
    let count = 0
    for (const [name, registration] of mcpRegistrations) {
      if (name === serverName) continue
      const other = registration.endpoint
      if (other === undefined) continue
      if (mcpActivityKey(other) === key) count += 1
    }
    return count
  }

  /**
   * Wait for one server's in-flight MCP calls before its transport is retired.
   *
   * Audit R9A-3: the provider-less rebuild (V3A-N6) has to dispose the live
   * transport, and the shipped bridge's disposer closes the client — including
   * a tool call the SDK is still waiting on (`Connection closed` mid-call; the
   * 600–800 ms discovery round trip of the rebuild is exactly the window). The
   * fence counts non-GET requests per transport, so the rebuild can wait for the
   * call to finish instead of cutting it.
   *
   * **Scope of the give-up release** (R10 N2): the fence files tickets per
   * transport instance, and this waiter can only name the ENDPOINT — so it
   * asserts `soleLiveTransport` only when no other live registration talks to
   * the same endpoint ({@link otherLiveTransportsAt}, which compares under the
   * fence's own {@link mcpActivityKey}). Then every ticket here belongs to the
   * transport this rebuild is about to cut, and a timeout may stop charging them
   * (R10-B-06). With another live transport on the endpoint the waiter still
   * waits, but a give-up releases nothing: under-waiting this rebuild costs one
   * grace, while clearing the other transport's ticket made its own rebuild read
   * `idle` and cut a call that could still have settled.
   *
   * Not a full guarantee, and the residue is stated rather than implied: a call
   * that starts between the tickets reaching zero and `retire()` (a few
   * microseconds) and a call that outlives the bound are still cut. Both are
   * logged, and the bound is the documented trade-off against starving the
   * credential update.
   * @param def - the connector being registered.
   * @param server - the server whose transport is about to be retired.
   */
  const waitForRebuildClearance = async (def: ConnectorDef, server: ConnectorMcp): Promise<void> => {
    if (server.transport !== 'streamable-http') return
    // A first registration has no transport to cut.
    const live = mcpRegistrations.get(server.serverName)
    if (live === undefined || live.id !== def.id) return
    const url = streamableHttpUrl(server, locale()).toString()
    if (!isMcpOutboundBusy(url)) return
    const graceMs = options.rebuildIdleGraceMs ?? MCP_REBUILD_IDLE_GRACE_MS
    const soleLiveTransport = otherLiveTransportsAt(url, server.serverName) === 0
    const outcome = await whenMcpOutboundIdle(url, graceMs, { soleLiveTransport })
    if (outcome === 'busy') {
      ctx.logger?.warn(`pico-connectors: ${def.id}/${server.serverName} 重建等待在途调用超时（${graceMs}ms），仍按新凭据重建`)
      return
    }
    ctx.logger?.warn(`pico-connectors: ${def.id}/${server.serverName} 重建前等在途调用结束，避免掐断正在返回的调用`)
  }

  /**
   * Register the connector's MCP servers through the mcp-client plugin.
   * @param def - the connector definition to register.
   * @param outbound - abort signal for this registration attempt.
   * @param select - optional subset of `def.mcp` to (re)register. Only the
   *   credential-change path uses it, and it exists for one reason: a refreshed
   *   token must reach the stdio children (it is baked into their `env` at
   *   spawn) WITHOUT retiring the live streamable-http transports, whose auth
   *   provider reads the token per request. Re-registering those disposed the
   *   very transport the SDK was retrying on (R8-B-2).
   */
  const registerMcp = async (
    def: ConnectorDef,
    outbound: { signal?: AbortSignal } = {},
    select?: (server: ConnectorMcp) => boolean,
  ): Promise<McpRegistrationOutcome> => {
    /** The servers this attempt owns: everything, unless a caller narrowed it. */
    const targets = select === undefined ? def.mcp : def.mcp.filter(server => select(server))
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
    // Scope and credential are read in the SAME synchronous step (no await
    // between): the row projection below is keyed by the directory the
    // credential came from, and taking the scope after the awaits of this entry
    // window would key account A's credential against whichever account is
    // current by then (2026-09-23 credential-scope rule).
    const credentialScope = store.dir
    const credential = await store.readCredential(def.id)
    // The generation this registration's snapshots belong to: the store's own
    // write ordering (`updatedAt`), which is what `adoptLatestRefresh` compares
    // too. `catchUpEntryCredential` below re-checks it before the snapshot is
    // turned into a provider and a live-header record — a refresh landing in
    // this entry window must not go on the wire as the replaced token.
    let credentialGeneration = credential?.updatedAt ?? 0
    /** The newest credential this registration knows of (entry snapshot first). */
    let effectiveCredential = credential
    /**
     * Catch this registration up to a credential that landed AFTER its entry read.
     *
     * The entry snapshot is consumed much later: the stdio approval gate, the
     * transport fence and the dynamic import of the MCP bridge are all awaited
     * before the provider and the live-header record are built from it. A refresh
     * landing anywhere in that window left both of them holding the **replaced**
     * token; the record reached the wire on the handshake and cost an extra 401
     * plus an extra refresh exchange, while the row stayed `connected` only
     * because the SDK's 401 self-heal eventually adopted the new token (R13 V2
     * item 7 CASE A — red on the unfixed tree).
     *
     * Deliberately synchronous: this closes the window rather than moving it, and
     * `latestRefresh` is the same source `adoptLatestRefresh` uses, so "which
     * generation is newest" has one answer on both paths.
     */
    const catchUpEntryCredential = (): void => {
      const latest = latestRefresh.get(def.id)
      if (latest === undefined || latest.updatedAt <= credentialGeneration) return
      effectiveCredential = latest.credential
      credentialGeneration = latest.updatedAt
    }
    // Mirror the token facts onto the row (the panel's poll reads state only).
    noteCredential(credentialScope, def.id, credential)
    if (superseded()) return { rejected: [], superseded: true }
    const rejected: string[] = []
    const stdioServers = targets.filter(server => (server.transport ?? 'stdio') === 'stdio')
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
    const httpServers = targets.filter(server =>
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
    for (const server of targets) {
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
      // ...but first catch up to a credential that landed during the entry
      // window above (R13 V2 item 7): everything below is built from the
      // snapshot, and the snapshot must be the newest one we know of.
      catchUpEntryCredential()
      // Resolve the provider BEFORE the superseded check below (the discovery
      // round trip is one of the awaited windows that check exists for), but do
      // NOT install its handle yet: installation waits until the transport has
      // actually loaded, so a superseded registration — or one whose plugin
      // fails to load — cannot clobber the handle that is really in use.
      const auth = server.transport === 'streamable-http'
        ? await mcpAuthProvider(def, effectiveCredential)
        : {}
      // A live OAuth provider owns the bearer IT writes: the SDK writes the
      // provider's token and then spreads these headers over it, so the copy we
      // baked from the stored token would win and the 401 retry would replay
      // the dead token (see `renderTransportHeaders`). Only that baked copy is
      // dropped — a declared `Authorization` is the definition's own credential
      // and is kept, with a one-time warn saying so. The predicate is the same
      // one `mcpAuthProvider` used to BUILD the provider (`authProvider !==
      // undefined`), so "provider present" and "our baked copy dropped" cannot
      // drift apart again (R8-D-4: the old second half — a non-empty
      // accessToken — disagreed with the construction condition and left a
      // baked header in place whenever the token was the empty string).
      const providerSuppliesAuthorization = auth.authProvider !== undefined
      // The record the transport will read its headers from. For a
      // provider-backed http transport it is handed to the fence
      // (`attachMcpLiveHeaders`) so `_requestInit.headers` IS this object and a
      // later credential change can be applied in place, with no rebuild
      // (R9-D-1). For every other shape it is the registration-time snapshot it
      // has always been.
      const renderedHeaders = renderTransportHeaders(server, effectiveCredential, providerSuppliesAuthorization)
      warnOnHeaderDeclarations(def, server, renderedHeaders, providerSuppliesAuthorization)
      // Publish this registration's live record to the "attached but not yet
      // registered" source (R11-B-01). Called twice: at attach below, and again
      // before the `already in use` retry — that retry goes through
      // `unregisterMcp`, which drops the records of the servers it retires, and the
      // retry is the SAME registration whose record object the transport will read.
      const publishPendingLiveHeaders = (): void => {
        pendingLiveHeaders.set(server.serverName, { id: def.id, headers: renderedHeaders.headers })
      }
      if (providerSuppliesAuthorization && auth.authProvider !== undefined) {
        attachMcpLiveHeaders(auth.authProvider, renderedHeaders.headers)
        // The transport is about to be able to read this record, but the
        // registration that would publish it is still a handshake away: publish
        // it to the second record source NOW so a refresh landing anywhere before
        // `mcpRegistrations.set` below still reaches it (R11-B-01). Handed over /
        // dropped at every exit of this registration — see `dropPendingLiveHeaders`.
        publishPendingLiveHeaders()
      }
      const config = server.transport === 'streamable-http'
        ? {
            transport: 'streamable-http' as const,
            serverName: server.serverName,
            url: streamableHttpUrl(server, locale()).toString(),
            headers: renderedHeaders.headers,
            // MCP authorization spec: the transport is handed the credential
            // provider, so the SDK injects the bearer token and the 401 hook
            // refreshes it through our per-id single flight before the SDK
            // retries the call. No hand-rolled fetch and no header rewriting.
            // The cast is the shape boundary described on `mcpAuthProvider`:
            // the config field is declared as `OAuthClientProvider` (upstream
            // `dsh-mcp-client`), while the object is deliberately the
            // `AuthProvider` face so the SDK keeps OUR 401 hook.
            ...(auth.authProvider === undefined ? {} : { authProvider: auth.authProvider as unknown as OAuthClientProvider }),
            // The budget this call gets is the SAME number the fence bounds its
            // outbound bookkeeping with (R10 N6): one exported constant, never a
            // second literal that can drift away from the accounting.
            toolCallTimeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
            failOnStartupError: false,
          }
        : {
            transport: 'stdio' as const,
            serverName: server.serverName,
            command: server.command ?? '',
            args: server.args ?? [],
            env: buildStdioEnv(def, server, effectiveCredential).env,
            cwd: process.cwd(),
            toolCallTimeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
            failOnStartupError: false,
          }
      // A disconnect/user-switch may have landed while mcpAuthProvider was
      // awaiting discovery; do not retire the old transport or spawn the new
      // one after that intent was invalidated.
      if (superseded()) {
        dropPendingLiveHeaders(server.serverName, def.id)
        return { rejected: [], superseded: true }
      }
      // R9A-3: `retire()` disposes the live transport, and the shipped bridge's
      // disposer closes the client — including a tool call still on the wire
      // (`Connection closed` mid-call). A provider-less transport has to be
      // rebuilt to see a new token (V3A-N6), so wait for that endpoint's
      // outbound calls to drain first. Bounded, so a stalled call cannot starve
      // the credential update.
      await waitForRebuildClearance(def, server)
      if (superseded()) {
        dropPendingLiveHeaders(server.serverName, def.id)
        return { rejected: [], superseded: true }
      }
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
        retireServerName(server.serverName, def.id, def.name)
      }
      retire()
      // `ctx.plugin` returns `Fiber & PromiseLike<Fiber>` (not a real Promise),
      // so it is wrapped before the failure hook is attached.
      const load = (): Promise<Awaited<ReturnType<typeof ctx.plugin>>> => Promise.resolve(
        ctx.plugin({ inject: ['tools'], apply: applyMcpClient, name: 'mcp-client' }, config),
      )
      let fiber: Awaited<ReturnType<typeof ctx.plugin>>
      try {
        fiber = await load().catch(async (cause: unknown) => {
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
          // Only the servers THIS registration owns: a credential-change rebuild
          // selects one subset, and retiring the rest here would dispose the very
          // transports the selection exists to leave alone (V3A-N4).
          await unregisterMcp(def, select)
          // `unregisterMcp` drops the record of every server it retires — but this
          // retry is the same registration, and the transport it is about to load
          // still reads the SAME record object, so re-publish it first.
          if (providerSuppliesAuthorization && auth.authProvider !== undefined) publishPendingLiveHeaders()
          return await load()
        })
      } catch (cause: unknown) {
        // The transport never loaded: nothing reads this record any more, so it
        // must not stay behind as a source a later refresh could write into. The
        // retry above keeps it for its own duration on purpose — the retry IS the
        // same registration and still wants a refresh to reach it.
        dropPendingLiveHeaders(server.serverName, def.id)
        throw cause
      }
      // conn-1: a teardown may have landed WHILE this registration was
      // starting. Retire the fiber it just created instead of recording it —
      // otherwise the disposer would outlive the teardown that cleared the map
      // (and nothing would ever dispose this one).
      if (superseded()) {
        try { void fiber?.dispose?.() } catch { /* teardown never throws */ }
        dropPendingLiveHeaders(server.serverName, def.id)
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
        adoptLatestRefresh(def.id, auth.handle, effectiveCredential)
      }
      // P2-23 kept: the map holds at most one registration per server key, so
      // the fiber recorded here is the only live instance for that name — and
      // the owner id is what lets the NEXT takeover stop the previous row from
      // claiming `connected` (CN-4). ONE criterion decides how a later
      // credential change reaches this transport: `liveHeaders` is present
      // exactly when the fence installed the mutable record this registration's
      // headers ARE, which is what lets the change be applied in place instead
      // of by another rebuild (R9-D-1). There is deliberately no second
      // "provider supplied?" flag: `needsRebuild` reads `liveHeaders`, and a
      // field nobody reads is how two truth sources start to drift (R10-B-04).
      // The record is published now: the pending source hands it over so the same
      // record is never reachable from two owners at once (R11-B-01).
      dropPendingLiveHeaders(server.serverName, def.id)
      mcpRegistrations.set(server.serverName, {
        id: def.id,
        // Only the http shape has an endpoint; stdio registrations leave it out,
        // so they can never make an http rebuild think it is not alone.
        ...(server.transport === 'streamable-http' ? { endpoint: streamableHttpUrl(server, locale()).toString() } : {}),
        ...(providerSuppliesAuthorization ? { liveHeaders: renderedHeaders.headers } : {}),
        dispose: () => { void fiber?.dispose?.() },
      })
    }
    return { rejected }
  }

  /**
   * Tear down this connector's live registrations.
   * @param def - the connector being retired.
   * @param select - optional subset of `def.mcp` to retire; omitted = all of
   *   them. The credential-change rebuild passes the same selection it
   *   registers, so it never disposes a transport it did not touch (V3A-N4).
   */
  const unregisterMcp = async (
    def: ConnectorDef,
    select?: (server: ConnectorMcp) => boolean,
  ): Promise<void> => {
    for (const server of select === undefined ? def.mcp : def.mcp.filter(server => select(server))) {
      dropLiveProvider(def.id, server.serverName)
      // A registration still loading has no entry in the map yet, and its record
      // must go with the intent that retired it (R11-B-01).
      dropPendingLiveHeaders(server.serverName, def.id)
      const registration = mcpRegistrations.get(server.serverName)
      // Only this connector's own registration: if another row has since taken
      // the name over, disconnecting here must not tear down ITS transport
      // (CN-4). That takeover already marked this row not-connected.
      if (registration === undefined || registration.id !== def.id) continue
      try { registration.dispose() } catch { /* teardown never throws */ }
      mcpRegistrations.delete(server.serverName)
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
   * Whether a `device` connector actually DECLARES a device-code authorization.
   *
   * `parseServerConnectors` labels a definition that has neither an `auth` block
   * nor `tokenFields` as `device` (the historical fallback). That label says
   * nothing about authorization: there is no verification URL to visit and no
   * token to obtain, so the CN-3 artifact gate must not apply — otherwise a
   * perfectly usable credential-less MCP connector becomes permanently
   * `unauthorized` with no user action able to fix it (V3 review, 2026-09-23).
   * The same predicate drives `runDevice`, which skips the flow entirely when no
   * verification URL is declared.
   * @param def - connector definition.
   * @returns true when the definition declares a device authorization step.
   */
  const declaresDeviceFlow = (def: ConnectorDef): boolean => {
    const auth = def.auth as { verificationUrl?: unknown } | undefined
    return auth !== undefined
      && typeof auth.verificationUrl === 'string'
      && auth.verificationUrl.trim() !== ''
  }

  /**
   * Whether a `device` credential carries an authorization artifact at all.
   *
   * The connect path may look at more than this (a declared-field form is
   * published separately), but "does the row have anything to authenticate
   * with" must have ONE answer: an access token, the public-endpoint marker, or
   * at least one declared field value. An empty credential (the stateless
   * device flow's `{updatedAt}`) is not an authorization — see CN-3.
   * @param credential - the stored credential.
   * @returns true when at least one artifact is present.
   */
  const hasDeviceAuthorization = (credential: ConnectorCredential): boolean =>
    (typeof credential.accessToken === 'string' && credential.accessToken !== '')
    || credential.publicMcp === true
    || Object.keys(credential.fields ?? {}).length > 0

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
    // Widened on purpose: a definition handed straight to `apply()` (a profile
    // row, a test fixture) may carry no mode at all — see the `undefined` arm.
    const mode: string | undefined = def.authMode
    if (mode === 'token') return true
    // CN-3 (audit 2026-09-23): `device` used to pass through unconditionally, so
    // a device flow that produced nothing but `{updatedAt}` registered its MCP
    // servers on every restart and the row read `connected` while every tool
    // call was guaranteed to fail. A device credential is usable only when it
    // carries something the tools can actually use — BUT the gate only applies
    // to connectors that DECLARE a device-code authorization (V3 review): the
    // catalog's fallback label is also `device` for a definition with neither
    // an `auth` block nor `tokenFields`, and such a credential-less connector
    // (a local MCP server that needs no credential) must stay usable exactly as
    // it was before CN-3. See `declaresDeviceFlow`.
    if (mode === 'device') return declaresDeviceFlow(def) ? hasDeviceAuthorization(credential) : true
    // A definition that declares no authorization mode at all is the
    // credential-less shape as well (V3 review): nothing was declared, so there
    // is nothing to authorize and nothing to gate.
    if (mode === undefined) return true
    // A public MCP endpoint answers without an authorization challenge, so the
    // discovery result is the whole credential: requiring an accessToken here
    // dropped its tools on every restart (2026-09-15 audit, BUG-06).
    if (credential.publicMcp === true) return true
    return typeof credential.accessToken === 'string' && credential.accessToken !== ''
  }

  /**
   * Does this definition need a STORED credential to be registered at all?
   *
   * The credential-less arms mirror {@link credentialUsable} exactly (no mode
   * declared, or a `device` definition that declares no device-code
   * authorization): for those, "there is a leftover credential file somewhere"
   * is not a reason to tell the user to authorize again — the connector has
   * nothing to authorize. Everywhere else a missing credential IS an
   * authorization gap, which is what the unscoped-credential branch in
   * {@link restoreAll} reports (R6-B-2).
   * @param def - the connector definition.
   * @returns true when the row is expected to hold a credential.
   */
  const requiresCredential = (def: ConnectorDef): boolean => {
    const mode: string | undefined = def.authMode
    if (mode === undefined) return false
    if (mode === 'device' && !declaresDeviceFlow(def)) return false
    return true
  }

  /** Publish a field form for the panel and leave the row waiting for it. */
  const requestDeclaredFields = (id: string, def: ConnectorDef): void => {
    pendingFieldRequestKind.set(id, 'tokenFields')
    emitRequest({ connectorId: id, fields: def.tokenFields ?? [] })
    setState(id, { status: 'connecting', error: undefined, errorCode: undefined })
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
      // 进入 connecting 必须把上一次的失败文案与分类一起清掉（2026-09-17 S04-3
      // 复核 P4：这是同一条规则漏掉的**唯一**一处状态写入点）。客户端
      // `client/ConnectorsSection.tsx` 对任何非 connected 状态都渲染 `error`
      // 段落，留着旧值会让"新一轮连接中"的行继续显示上一次的失败（errorCode 也
      // 跟着留下）；两者必须同时清，否则又回到"分类与文案各说各话"。
      setState(id, {
        status: 'connecting',
        everConnected: Boolean(existing) || Boolean(states.get(id)?.everConnected),
        error: undefined,
        errorCode: undefined,
      })

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
          setState(id, { status: 'unauthorized', everConnected: true, error: undefined, errorCode: undefined })
          return
        }
        if (outcome.rejected.length > 0) {
          pendingRequests.delete(id)
          setState(id, { status: 'error', everConnected: true, error: outcome.rejected.join('; '), errorCode: undefined })
          return
        }
        pendingRequests.delete(id)
        pendingFieldRequestKind.delete(id)
        setState(id, { status: 'connected', everConnected: true, connectedAt: Date.now(), error: undefined, errorCode: undefined })
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
      // CN-3: nothing declared to fill in AND nothing stored to authenticate
      // with (a `device` flow that only wrote `{updatedAt}`) — registering here
      // is what told the user "connected" while every tool call would fail.
      // Say what is wrong and stay unauthorized instead.
      if (!credentialUsable(def, merged)) {
        setState(id, {
          status: 'unauthorized',
          everConnected: true,
          error: copy('auth.deviceUnverifiable'),
          errorCode: 'auth-required',
        })
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
        setState(id, { status: 'unauthorized', everConnected: true, error: undefined, errorCode: undefined })
        return
      }
      if (outcome.rejected.length > 0) {
        pendingRequests.delete(id)
        setState(id, { status: 'error', everConnected: true, error: outcome.rejected.join('; '), errorCode: undefined })
        return
      }
      setState(id, { status: "connected", everConnected: true, connectedAt: Date.now(), error: undefined, errorCode: undefined })
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
        setState(id, { status: 'disconnected', everConnected: Boolean(states.get(id)?.everConnected), error: undefined, errorCode: undefined })
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
        setState(id, { status: 'unauthorized', everConnected: true, error: undefined, errorCode: undefined })
        return
      }
      if (outcome.rejected.length > 0) {
        pendingRequests.delete(id)
        setState(id, { status: 'error', everConnected: true, error: outcome.rejected.join('; '), errorCode: undefined })
        return
      }
      setState(id, { status: 'connected', everConnected: true, connectedAt: Date.now(), error: undefined, errorCode: undefined })
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
    // must not keep advertising the token it no longer has. Keyed the same way
    // the entry was written: the credential just removed came from THIS store.
    refreshable.delete(refreshableKey(store.dir, id))
    lastAnnouncedToken.delete(id)
    // No credential and no live transports remain (unregisterMcp dropped their
    // handles): the cached refresh result must not be adopted by a later
    // re-registration under a NEW authorization.
    latestRefresh.delete(id)
    // The marker belongs to the account whose credential was just removed.
    clearDeadGrant(store.dir, id)
    liveProviders.delete(id)
    // 断开必须连分类一起清（2026-09-17 S04-3 审计）：只清 error 会留下
    // `errorCode:'auth-required'`，下一次未分类失败就会被渲染成"需要重新授权"。
    setState(id, {
      status: 'disconnected', everConnected: false, error: undefined, errorCode: undefined, connectedAt: undefined,
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
    // R6-B-2: report the credentials this build REFUSES to adopt (they were
    // written before credentials carried a server dimension) ONCE per restore
    // pass, as one line with the ids and the directory. The files stay where
    // they are; the log is what makes the re-authorization wave diagnosable
    // instead of looking like "my connectors forgot everything".
    const unscoped = await store.unscopedCredentialIds()
    if (stale()) return
    // The `unscoped-credentials` tag is the stable, greppable half of the line
    // (host logs are zh-first, so the sentence alone is not searchable for a
    // non-Chinese reader); keep the tag ASCII and keep it in one place.
    if (unscoped.length > 0) {
      ctx.logger?.warn?.(
        `pico-connectors: unscoped-credentials count=${String(unscoped.length)} — `
        + `检测到 ${String(unscoped.length)} 个未标记服务端的连接器凭据（升级前保存），`
        + '按服务端隔离策略不沿用，对应连接器需要重新授权；原文件保留在 '
        + `${store.unscopedDir ?? ''}；ids=${unscoped.join(',')}`,
      )
    }
    for (const def of defs) {
      try {
        if (stale()) return
        // The account scope is captured TOGETHER with the credential (one store
        // instance for both): the dead-grant markers below are only meaningful
        // against the very store the credential came from.
        const target = store
        const scope = target.dir
        const credential = await target.readCredential(def.id)
        if (stale()) return
        noteCredential(scope, def.id, credential)
        if (!credential) {
          // No credential for THIS (account, server): clear the token facts the
          // previous scope left on the row (states survive a session change; the
          // store does not). The STATUS is deliberately not forced to
          // 'disconnected' — 'unauthorized' is how a failed authorization
          // reports itself and must survive the restore pass.
          setState(def.id, { expiresAt: undefined, refreshedAt: undefined, refreshToken: undefined })
          // ...but an UNSCOPED credential of the same id is evidence this
          // connector WAS authorized, just not for a server we can name. Say so
          // and demand a fresh authorization: adopting it would hand the
          // previous tenant's secret to whichever server is current, and
          // leaving the row silently disconnected would look like a bug.
          if (requiresCredential(def) && await target.hasUnscopedCredential(def.id)) {
            setState(def.id, {
              status: 'unauthorized',
              everConnected: true,
              error: copy('store.rescopeRequired'),
              errorCode: 'auth-required',
            })
          }
          continue
        }
        // Refresh OAuth tokens before restoring (official SDK refresh flow),
        // then register the MCP servers.
        const effective = credential.refreshToken === undefined
          || isDeadGrant(scope, def.id, credential)
          ? credential
          : await (async () => {
              const outcome = await tokenRefresher.refresh(def.id)
              if (stale()) return credential
              if (!outcome.ok && applyRefreshFailure(scope, def.id, credential, outcome)) {
                // CN-5 + R4-B-8/10: the terminal state is recorded in ONE place
                // (marker + row). The grant/request is refused, so registering
                // MCP servers that are guaranteed to fail is skipped.
                return null
              }
              return await target.readCredential(def.id) ?? credential
            })()
        if (stale() || effective === null) continue
        if (stale()) return
        // A credential whose grant is known dead must not be registered (every
        // tool call would 401); the row keeps demanding a fresh authorization.
        if (isDeadGrant(scope, def.id, effective)) {
          setState(def.id, { status: 'unauthorized', everConnected: true, errorCode: 'auth-required' })
          continue
        }
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
            setState(def.id, { status: 'unauthorized', everConnected: true, error: undefined, errorCode: undefined })
            continue
          }
          if (outcome.rejected.length > 0) {
            setState(def.id, { status: 'error', everConnected: true, error: outcome.rejected.join('; '), errorCode: undefined })
            continue
          }
          setState(def.id, { status: 'connected', everConnected: true, error: undefined, errorCode: undefined })
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
      for (const registration of mcpRegistrations.values()) {
        try { registration.dispose() } catch { /* teardown never throws */ }
      }
      mcpRegistrations.clear()
      // …and the records whose transports never got that far (R11-B-01).
      pendingLiveHeaders.clear()
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
   *
   * CN-5（2026-09-23 审计）：死 grant 必须进**终态**。此前 `unauthorized` 也在
   * 扫掠白名单里，于是被吊销的 refresh token 每 60s 再被出示一次（审计探针实测
   * 5 次扫掠 = 40 次打到 IdP），对那些做异常登录检测的 IdP 看起来就是持续攻击。
   * 现在：`invalid_grant`/`invalid_client` 记在 {@link deadGrants} 上（键是**账号
   * 作用域 + 连接器**，值是**凭据代次** `updatedAt`），只要该账号盘上还是同一份
   * 凭据就不再自动重试；用户重新授权会写入新凭据（新代次）⇒ 自动恢复尝试；面板的
   * 「刷新」按钮走 `force`，一直可用。
   *
   * R4-B-8/10（审计 2026-09-23）：终态判定与写状态收进 {@link applyRefreshFailure}
   * 一处（三条路径共用）；`error` 行只要还持 refresh token 也留在白名单里 —— 面板
   * 按钮遇到 5xx 会把行设成 `error`（可重试的失败），此前那一行从此**退出主动刷新
   * 集**，一次网络抖动就让连接器再也不会自愈。
   * @returns 扫掠完成的 Promise。
   */
  async function runRefreshSweep(): Promise<void> {
    return runLifecycle(async () => {
      for (const def of defs) {
        const state = states.get(def.id)
        if (state?.status !== 'connected' && state?.status !== 'unauthorized' && state?.status !== 'error') continue
        // 作用域与凭据取自同一个 store 实例（见 {@link deadGrantKey}）。
        const target = store
        const scope = target.dir
        const credential = await target.readCredential(def.id)
        if (!credential || !tokenNeedsRefresh(credential)) continue
        // 终态：同一账号同一代凭据已经证明授权被吊销/请求被永久拒绝 ⇒ 停止心跳
        // （不静默、行状态仍是「需要重新授权」，只是不再拿死 token 去打 IdP）。
        if (isDeadGrant(scope, def.id, credential)) continue
        const outcome = await tokenRefresher.refresh(def.id, { locale: locale() })
        if (outcome.ok) {
          clearDeadGrant(scope, def.id)
          continue
        }
        // transient 在这里刻意**不改行状态**：它的语义是"稍后用同一份凭据再试"，
        // 下一轮扫掠应当继续试探（终态的两类由唯一的 applyRefreshFailure 处理）。
        applyRefreshFailure(scope, def.id, credential, outcome)
      }
    })
  }
  options.onRefreshSweepReady?.(runRefreshSweep)

  /**
   * A refreshed (or re-rotated) credential must reach the running MCP servers
   * that cannot read it lazily. Exactly two classes cannot:
   *
   *  - **stdio children**, which get the token in `env` at spawn;
   *  - **streamable-http transports registered WITHOUT an `authProvider`** — the
   *    registration-time discovery round trip can fail (offline, a 5xx on the
   *    RFC 9728 metadata endpoint, an enterprise proxy) while the MCP endpoint
   *    itself keeps answering, and `mcpAuthProvider` then returns no provider at
   *    all. Such a transport authenticates with the bearer baked into its
   *    `requestInit.headers`, i.e. a snapshot nothing re-reads; without a
   *    rebuild the rows stay `connected` with a fresh `expiresAt` while every
   *    tool call 401s on the token that rotated away (V3A-N6).
   *
   * A streamable-http transport whose provider IS installed is deliberately left
   * alone (R8-B-2): it reads the live credential per request — exactly what the
   * round-7 fix stopped shadowing with a baked header — so rebuilding it bought
   * nothing and cost the call in flight: `registerMcp` retires the previous
   * fibre first, and the shipped bridge's disposer closes the client and its
   * transport, including the one the SDK is about to retry on. A 401 refresh
   * therefore killed its own retry with `Connection closed` (measured at
   * t+21…36 ms on both endpoint shapes; a multi-server connector disposed every
   * live transport at once). The rebuild below cannot hit that shape: a
   * provider-less transport has no 401 self-heal to interrupt.
   *
   * What the narrowed rebuild set left behind (audit R9-D-1) is the OTHER
   * registration-time bake of a provider-backed transport — a declared
   * `X-Probe-Key: ''` holds `Bearer <first token>` forever, so the 401 self-heal
   * succeeded, the retry 401ed on the stale header, and every later call did
   * too, while the row still said `connected`. Those transports are now
   * refreshed **in place** through the live header record the fence installed
   * ({@link refreshLiveHeaders}) — no rebuild, so there is nothing to cut.
   */
  ctx.on('pico/connector-credentials-changed', (payload: { id: string }) => {
    const announced = defs.find(entry => entry.id === payload.id)
    if (announced === undefined) return
    // R9-D-1 FIRST, and deliberately NOT through the lifecycle queue: the SDK's
    // 401 retry reads the transport's headers the moment its own refresh
    // resolves, so the in-memory record has to be current by then. Serializing
    // this behind a queued connect/refresh would put the retry back on the
    // stale declared header (the exact shape this fix removes), and the update
    // itself is a pure in-memory write that needs no serialization.
    void handOffLiveHeaders(announced)
    void runLifecycle(async () => {
      const def = announced
      /**
       * Does this server's live transport need a rebuild to see the new token?
       * @param server - one MCP server of the connector.
       * @returns true for stdio children and for provider-less http transports.
       */
      const needsRebuild = (server: ConnectorMcp): boolean => {
        if ((server.transport ?? 'stdio') !== 'streamable-http') return true
        const registration = mcpRegistrations.get(server.serverName)
        return registration?.id !== def.id || registration.liveHeaders === undefined
      }
      // Nothing to hand a new value to: every live transport reads the
      // credential per request, and a connector with no servers has none.
      if (!def.mcp.some(needsRebuild)) return
      if (states.get(def.id)?.status !== 'connected') return
      const outcome = await registerMcp(def, { signal: teardownController.signal }, needsRebuild)
      if (outcome.superseded === true) return
      if (outcome.pendingApproval !== undefined) {
        setState(def.id, { status: 'unauthorized', everConnected: true, error: undefined, errorCode: undefined })
        return
      }
      if (outcome.rejected.length > 0) {
        setState(def.id, { status: 'error', everConnected: true, error: outcome.rejected.join('; '), errorCode: undefined })
      }
    }).catch((cause: unknown) => {
      ctx.logger?.warn(`pico-connectors: ${payload.id} 令牌更新后重注册失败`, cause)
    })
  })

  ctx.effect(() => {
    const list: JsonHandler = (_req, res) => {
      // The scope this response speaks for: the store the credentials on disk
      // belong to. Read once so every row of one response is judged under the
      // same key (a session switch cannot land mid-render — this handler is
      // synchronous — but the key must not be re-derived per row either).
      const scope = store.dir
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
          canRefresh: (refreshable.has(refreshableKey(scope, def.id)) || state.refreshToken === true) && oauthTargetOf(def) !== null,
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
     *
     * R4-B-10 (audit 2026-09-23): this path used to flip the row WITHOUT arming
     * the terminal marker, so when the button was the first surface to meet a
     * revoked grant the next background sweep presented the already-consumed
     * refresh token to the IdP one more time (probe: reuse 0→1→2, versus 1 for
     * the sweep-detected control). It now goes through the same
     * {@link applyRefreshFailure} the other two paths use.
     */
    const refreshTokens: JsonHandler = async (req, res) => {
      const rawId = decodeSegment(req.url?.split('/')[4] ?? '')
      if (rawId === null) return json(res, 400, { error: 'malformed connector id' })
      const id = rawId
      const def = getDef(id)
      if (!def) return json(res, 404, { error: `unknown connector: ${id}` })
      if (oauthTargetOf(def) === null) return json(res, 400, { error: copy('flow.refreshUnsupported') })
      // The credential the failing attempt used: the terminal marker below is
      // keyed to its generation, so it must be READ — but the forced refresh is
      // registered FIRST. A route that awaits a read before calling `refresh()`
      // yields its single-flight slot to a concurrent automatic refresh, and
      // when that one takes the "token still fresh, nothing to do" fast path the
      // user's "refresh now" is silently swallowed (pinned by
      // `token-refresh.spec.ts > refreshes through the real route and exposes the
      // new expiry`, which requires exactly one grant from this route). A FAILED
      // attempt never writes a credential, so racing the read is safe.
      const scope = store.dir
      const pending = tokenRefresher.refresh(id, { force: true, locale: locale() })
      const credential = await store.readCredential(id)
      const outcome = await pending
      if (!outcome.ok) {
        // The refresh engine reports WHY the refresh failed; the terminal
        // reasons are the ones that mean "this credential will not be retried
        // automatically", and `auth-required` is the stable code the client maps
        // (the message itself is translatable).
        const terminal = applyRefreshFailure(scope, id, credential, outcome)
        if (!terminal && outcome.reason === 'transient') {
          setState(id, { status: 'error', everConnected: Boolean(states.get(id)?.everConnected), error: outcome.message, errorCode: undefined })
        }
        return json(res, outcome.reason === 'not-applicable' ? 400 : 409, {
          error: outcome.message,
          reason: outcome.reason,
          ...(terminal ? { errorCode: 'auth-required' as const } : {}),
        })
      }
      noteCredential(scope, id, await store.readCredential(id))
      setState(id, { status: 'connected', everConnected: true, error: undefined, errorCode: undefined })
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
      setState(id, { status: 'disconnected', everConnected: Boolean(states.get(id)?.everConnected), error: undefined, errorCode: undefined })
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
        setState(id, { status: 'unauthorized', everConnected: true, error: undefined, errorCode: undefined })
        return json(res, 409, { error: 'approval did not settle every pending command' })
      }
      if (outcome.rejected.length > 0) {
        setState(id, { status: 'error', everConnected: true, error: outcome.rejected.join('; '), errorCode: undefined })
        return json(res, 400, { error: outcome.rejected.join('; ') })
      }
      setState(id, { status: 'connected', everConnected: true, connectedAt: Date.now(), error: undefined, errorCode: undefined })
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
      setState(id, { status: 'error', everConnected: Boolean(states.get(id)?.everConnected), error: copy('flow.approvalDeniedRow'), errorCode: undefined })
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
 * The target is the **unscoped** directory ({@link unscopedConnectorPath},
 * `<dshHome>/users/<user>/connectors`) — the pre-2026-09-24 layout. That store
 * was shared by every server the account had ever pointed at, so since R6-B-2
 * its files are never adopted: `restoreAll` probes them for existence, reports
 * "needs a fresh authorization" and leaves the bytes alone. Migrating still
 * earns its keep — it moves the files under the account that can see them (and
 * into the log line that lists them) instead of stranding them in `~/.picoaide`.
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
    const target = unscopedConnectorPath(username)
    if (existsSync(target)) return
    mkdirSync(userScopePath(username), { recursive: true, mode: 0o700 })
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
