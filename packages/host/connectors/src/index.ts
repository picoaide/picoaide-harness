import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { browserSameOriginMarker, isLoopbackRequest } from './loopback.ts'
import { ConnectorStore } from './store.ts'
import { runAuth, refreshOAuthToken } from './auth.ts'
import { userScopePath } from './user-scope.ts'
import { ConnectorApprovalStore } from './approvals.ts'
import {
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
      let authMode = (item.auth_mode || raw.authMode || '') as ConnectorDef['authMode']
      if (!authMode) {
        // 回退推断:定义 JSON 的结构决定模式(tokenFields → token,
        // auth 配置 → oauth;其余按 device 保守处理)。
        if (raw.tokenFields?.length) authMode = 'token'
        else if (raw.auth) authMode = 'oauth'
        else authMode = 'device'
      }
      out.push({
        ...raw,
        id: item.id,
        name: item.name !== '' ? item.name : raw.name ?? '',
        description: item.description !== '' ? item.description : raw.description ?? '',
        authMode,
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
  return (req, res) => {
    void Promise.resolve(handler(req, res)).catch(error => {
      console.error('[dsh-connectors] handler failed', error)
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
    })
  }
}

export function apply(ctx: Context, options: ConnectorsOptions = {}): void {
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
      const res = await fetch(`${session.serverURL.replace(/\/+$/, '')}/api/client/v2/config/bootstrap`, {
        headers: { Authorization: `Bearer ${session.token}` },
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
  const pendingRequests = new Map<string, ConnectorAuthRequest>()
  /** Server-issued stdio commands waiting for a local decision, keyed by connector id. */
  const pendingApprovals = new Map<string, PendingApproval>()
  const mcpDisposers = new Map<string, () => void>()
  /** In-flight auth flows keyed by connector id: disconnect/cancel aborts them. */
  const pendingFlows = new Map<string, AbortController>()

  /**
   * Register one connector's MCP servers. `pendingApproval` means nothing was
   * spawned because a server-issued stdio command still needs local
   * confirmation; `rejected` lists definitions/urls this plugin refuses.
   */
  interface McpRegistrationOutcome {
    pendingApproval?: ConnectorMcpApproval
    rejected: string[]
  }

  /**
   * Pending local confirmation: the prompt plus the exact ledger record of
   * every command one answer approves (audit R3 N1 — a union of key sets would
   * misattribute one server's keys to another server's record).
   */
  interface PendingApproval extends ConnectorMcpApproval {
    entries: Array<{ fingerprint: string; command: string; args: string[]; envKeys: string[] }>
  }

  /** Drop all MCP registrations and reset in-memory state (user switch). */
  const teardownAll = async (): Promise<void> => {
    for (const dispose of mcpDisposers.values()) {
      try { dispose() } catch { /* teardown never throws */ }
    }
    mcpDisposers.clear()
    for (const flow of pendingFlows.values()) flow.abort(new Error('用户已切换，连接流程中止'))
    pendingFlows.clear()
    pendingRequests.clear()
    pendingApprovals.clear()
    states.clear()
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
      await teardownAll()
      await syncServerDefs()
      reconfigureUser()
      if (next !== null) await restoreAll()
    }).catch((cause: unknown) => {
      ctx.logger?.error('pico-connectors: session change handling failed', cause)
    })
  })

  const setState = (id: string, patch: Partial<ConnectorState>): void => {
    const current = states.get(id) ?? { status: 'disconnected', everConnected: false }
    states.set(id, { ...current, ...patch })
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
        })
      }
    }
    if (unapproved.length === 0) return null
    const first = unapproved[0]!
    const unionKeys = [...new Set(unapproved.flatMap(item => item.envKeys))].sort()
    const prompt: ConnectorMcpApproval = {
      fingerprint: first.fingerprint,
      command: first.command,
      args: first.args,
      envKeys: unionKeys,
      servers: unapproved.map(item => item.server.serverName),
      commands: unapproved.map(item => ({
        serverName: item.server.serverName,
        command: item.command,
        args: item.args,
        envKeys: item.envKeys,
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
      })),
    }
    pendingApprovals.set(def.id, pending)
    emitRequest({ connectorId: def.id, approval: prompt })
    return { pending: prompt }
  }

  /** Register the connector's MCP servers through the mcp-client plugin. */
  const registerMcp = async (def: ConnectorDef): Promise<McpRegistrationOutcome> => {
    const credential = await store.readCredential(def.id)
    const rejected: string[] = []
    const stdioServers = def.mcp.filter(server => (server.transport ?? 'stdio') === 'stdio')
    const gate = await checkStdioApproval(def, stdioServers, credential)
    if (gate !== null) {
      if ('denied' in gate) return { rejected: ['用户拒绝了本地执行确认，未启动本地命令'] }
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
        await ensureMcpTransportRedirectFence()
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
    for (const server of def.mcp) {
      const problem = mcpServerProblem(server)
      if (problem !== null) {
        rejected.push(`${server?.serverName ?? '?'}: ${problem}`)
        continue
      }
      if (server.transport === 'streamable-http' && httpFenceError !== null) {
        rejected.push(`${server.serverName}: streamable-http 出站重定向栅栏不可用，拒绝连接（${httpFenceError}）`)
        continue
      }
      const config = server.transport === 'streamable-http'
        ? {
            transport: 'streamable-http' as const,
            serverName: server.serverName,
            url: streamableHttpUrl(server).toString(),
            headers: renderHeaders(server, credential),
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
      const fiber = await ctx.plugin(
        { inject: ['tools'], apply: applyMcpClient, name: 'mcp-client' },
        config,
      )
      // P2-23: re-registering the same server key must retire the previous
      // registration first — the old `set()` overwrote the disposer, leaving
      // the first fiber (and its tools) alive forever.
      const previous = mcpDisposers.get(server.serverName)
      if (previous !== undefined) {
        try { previous() } catch { /* teardown never throws */ }
        mcpDisposers.delete(server.serverName)
      }
      mcpDisposers.set(server.serverName, () => { void fiber?.dispose?.() })
    }
    return { rejected }
  }

  const unregisterMcp = async (def: ConnectorDef): Promise<void> => {
    for (const server of def.mcp) {
      const dispose = mcpDisposers.get(server.serverName)
      if (dispose) {
        dispose()
        mcpDisposers.delete(server.serverName)
      }
    }
  }

  /** Start the auth flow for a connector (background for poll-based modes). */
  const startConnect = async (id: string): Promise<void> => {
    const def = getDef(id)
    if (!def) throw new Error(`unknown connector: ${id}`)
    // P0-1: re-entrancy guard — a second connect on the same connector while
    // a flow is in flight must not start a duplicate authorization flow
    // (two callback ports, two browser windows, credential writeback race).
    if (pendingFlows.has(id)) return
    const existing = await store.readCredential(id)
    setState(id, { status: 'connecting', everConnected: Boolean(existing) || Boolean(states.get(id)?.everConnected) })

    // Pre-connect settings: if required fields are missing, emit the form and
    // wait for auth-submit before starting the actual auth flow.
    if (def.settings?.length) {
      const missing = def.settings.filter((field) => field.required && !existing?.fields?.[field.key]?.trim())
      if (missing.length > 0) {
        emitRequest({ connectorId: id, fields: def.settings })
        return
      }
    }
    pendingRequests.delete(id)
    const controller = new AbortController()
    pendingFlows.set(id, controller)
    try {
      const patch = await runAuth(def, {
        onRequest: emitRequest,
        signal: controller.signal,
        ...(existing?.fields ? { fields: existing.fields } : {}),
        ...(options.clientName === undefined ? {} : { clientName: options.clientName }),
      })
      // Token-form flows finish on auth-submit; runAuth only emitted the fields.
      if (def.authMode === 'token') {
        setState(id, { status: 'connecting' })
        return
      }
      const current = await store.readCredential(id)
      await store.updateCredential(id, { ...current, ...patch })
      const outcome = await registerMcp(def)
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
      const message = error instanceof Error ? error.message : String(error)
      const unauthorized = message.includes('授权') || message.includes('token') || message.includes('登录')
      // A user-initiated abort maps to the neutral 'disconnected' state, not
      // an error (the cancel button must not leave a scary red row behind).
      if (controller.signal.aborted) {
        setState(id, { status: 'disconnected', everConnected: Boolean(states.get(id)?.everConnected), error: undefined })
      } else {
        setState(id, { status: unauthorized ? 'unauthorized' : 'error', error: message })
      }
      // Terminal failure likewise invalidates the pending authorize URL.
      pendingRequests.delete(id)
    } finally {
      // 按身份删除:connect 路由发现旧流程会 stale.abort() 后启动新流程,
      // 旧流程异步 unwind 可能晚于新流程 set——无条件 delete 会抹掉新流程
      // 的 controller,使 /cancel、disconnect 找不到活流程(2026-09-01 深挖)。
      if (pendingFlows.get(id) === controller) pendingFlows.delete(id)
    }
  }

  const submitAuth = async (id: string, fields: Record<string, string>): Promise<void> => {
    const def = getDef(id)
    if (!def) throw new Error(`unknown connector: ${id}`)
    const current = await store.readCredential(id)
    await store.updateCredential(id, { fields: { ...(current?.fields ?? {}), ...fields } })
    if (def.authMode === 'token') {
      const outcome = await registerMcp(def)
      if (outcome.pendingApproval !== undefined) {
        setState(id, { status: 'unauthorized', everConnected: true, error: undefined })
        return
      }
      if (outcome.rejected.length > 0) {
        pendingRequests.delete(id)
        setState(id, { status: 'error', everConnected: true, error: outcome.rejected.join('; ') })
        return
      }
      setState(id, { status: "connected", everConnected: true, connectedAt: Date.now(), error: undefined })
      pendingRequests.delete(id)
      return
    }
    // Device/cli/oauth flows continue after the settings form is submitted.
    await startConnect(id)
  }

  const disconnect = async (id: string): Promise<void> => {
    const def = getDef(id)
    if (def) await unregisterMcp(def)
    // P0-1: a disconnect must also abort any in-flight authorization flow —
    // otherwise the completed OAuth/device flow would "resurrect" the
    // connector and write back credentials after the user disconnected.
    const flow = pendingFlows.get(id)
    if (flow) flow.abort(
      new Error('用户在连接过程中断开了连接'),
    )
    await store.clearCredential(id)
    setState(id, { status: 'disconnected', everConnected: false, error: undefined, connectedAt: undefined })
    pendingRequests.delete(id)
    pendingApprovals.delete(id)
  }

  /** Restore all connector MCP registrations for the CURRENT user. */
  const restoreAll = async (): Promise<void> => {
    for (const def of defs) {
      try {
        const credential = await store.readCredential(def.id)
        if (!credential) continue
        // Refresh OAuth tokens before restoring, then register the MCP servers.
        const refreshed = await refreshOAuthToken(def, credential)
        const effective = refreshed ? await store.updateCredential(def.id, refreshed) : credential
        if (effective.accessToken) {
          const outcome = await registerMcp(def)
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
        }
      } catch (error) {
        // A restore failure (network, missing dependency, MCP connect) must
        // not become an unhandled rejection: the host treats those as fatal
        // and exits the whole app. Surface it on the connector row instead.
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.error(`pico-connectors: failed to restore ${def.id}: ${message}`)
        setState(def.id, { status: 'error', error: message })
      }
    }
  }

  ctx.effect(() => {
    return () => {
      // Supersede any queued/running lifecycle task: a restore that resolves
      // after teardown must not re-register MCP servers (P2-23).
      lifecycleEpoch++
      for (const dispose of mcpDisposers.values()) dispose()
      mcpDisposers.clear()
      // P0-1: teardown must abort any in-flight authorization flow — a
      // lingering OAuth/device flow would keep the callback server up and
      // (on a later disconnect) could write back credentials after teardown.
      for (const flow of pendingFlows.values()) flow.abort(new Error('插件卸载，连接流程中止'))
      pendingFlows.clear()
    }
  }, 'pico connectors: restore + cleanup')

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
          ...state,
        }
      })
      json(res, 200, { connectors: body })
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
        stale.abort(new Error('连接器重新连接，旧授权流程已取消'))
        pendingFlows.delete(id)
        pendingRequests.delete(id)
      }
      const request: ConnectorAuthRequest = { connectorId: id }
      emitRequest(request)
      void startConnect(id).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        setState(id, { status: 'error', error: message })
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
      const flow = pendingFlows.get(id)
      if (flow) flow.abort(new Error('用户取消了连接'))
      setState(id, { status: 'disconnected', everConnected: Boolean(states.get(id)?.everConnected), error: undefined })
      pendingRequests.delete(id)
      json(res, 200, { ok: true })
    }

    const authSubmit: JsonHandler = async (req, res) => {
      const rawId = decodeSegment(req.url?.split('/')[4] ?? '')
      if (rawId === null) return json(res, 400, { error: 'malformed connector id' })
      const id = rawId
      const raw = await readJson(req)
      if (!raw || typeof raw !== 'object' || typeof (raw as { fields?: unknown }).fields !== 'object') {
        return json(res, 400, { error: 'missing fields' })
      }
      // P0-1/P2-17: only string values are meaningful for auth headers; a
      // number/object/array would crash renderHeaders on the MCP registration
      // path with an obscure TypeError.
      const fields = (raw as { fields: Record<string, unknown> }).fields
      for (const [key, value] of Object.entries(fields)) {
        if (typeof value !== 'string') return json(res, 400, { error: `field '${key}' must be a string` })
      }
      try {
        void submitAuth(id, fields as Record<string, string>).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          setState(id, { status: 'error', error: message })
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
      const outcome = await registerMcp(def)
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
      setState(id, { status: 'error', everConnected: Boolean(states.get(id)?.everConnected), error: '本地执行确认被拒绝，未启动本地命令' })
      json(res, 200, { ok: true })
    }

    // Trust fence for every connector route: loopback socket + Host +
    // same-origin markers. State-changing endpoints below also enforce POST.
    const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
      if (browserSameOriginMarker(req) && isLoopbackRequest(req)) return true
      json(res, 403, { error: 'forbidden' })
      return false
    }

    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: '/api/pico/connectors', handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        if (!guard(req, res)) return
        list(req, res)
      } }),
      ctx.webServer.register({ kind: 'prefix', path: '/api/pico/connectors', handler: (req, res) => {
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
        }
        if (!guard(req, res)) return
        const method = req.method ?? 'GET'
        const allowedMethods: Record<string, string> = {
          connect: 'POST',
          cancel: 'POST',
          'auth-submit': 'POST',
          state: 'GET',
          disconnect: 'POST',
          approve: 'POST',
          deny: 'POST',
        }
        const expected = action ? allowedMethods[action] : undefined
        if (expected !== undefined && method !== expected) {
          return json(res, 405, { error: 'method not allowed' })
        }
        const handler = action ? handlers[action] : undefined
        if (handler) handler(req, res)
        else json(res, 404, { error: 'not found' })
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
    await syncServerDefs()
    await restoreAll()
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
