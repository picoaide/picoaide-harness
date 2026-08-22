import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CliAuthConfig, ConnectorAuthRequest, ConnectorDef, DeviceAuthConfig, OAuthAuthConfig, TokenField } from './types.ts'
import type { ConnectorCredential } from './store.ts'
import type { CliRuntime } from './cli-runtime.ts'

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
  /** Download-on-demand CLI resolver (dws / beisen-cli). */
  cli?: CliRuntime
}

/**
 * Device-flow probes: connectors whose poll is provider-specific (e.g. the
 * sales-easy clawId poll) register a probe under their connector id; the
 * framework surfaces the authorize URL through onRequest and awaits the probe.
 */
export type DeviceProbe = (
  def: ConnectorDef,
  options: AuthRunOptions,
) => Promise<Partial<ConnectorCredential>>

const deviceProbes = new Map<string, DeviceProbe>()

export function registerDeviceProbe(connectorId: string, probe: DeviceProbe): void {
  deviceProbes.set(connectorId, probe)
}

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

/** RFC 7591 dynamic client registration; returns the issued client id. */
async function registerClient(
  auth: OAuthAuthConfig,
  redirectUri: string,
  registrationEndpoint: string,
): Promise<string> {
  const response = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'PicoAide Harness Connector',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: auth.publicClient ? 'none' : 'client_secret_basic',
    }),
  })
  if (!response.ok) throw new Error(`OAuth 客户端注册失败: HTTP ${response.status}`)
  const data = (await response.json()) as { client_id?: string }
  if (!data.client_id) throw new Error('OAuth 客户端注册响应缺少 client_id')
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
interface McpOAuthDiscovery {
  publicMcp?: boolean
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
async function discoverMcpOAuth(mcpUrl: string): Promise<McpOAuthDiscovery> {
  const mcp = new URL(mcpUrl)
  const resource = mcp.origin + mcp.pathname.replace(/\/+$/, '')

  const probe = await fetch(mcpUrl, {
    headers: { Accept: 'text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
  })
  if (probe.status >= 200 && probe.status < 300) return { publicMcp: true, resource }
  if (probe.status !== 401 && probe.status !== 403) {
    throw new Error(`MCP 端点响应异常: HTTP ${probe.status}`)
  }

  const authHeader = probe.headers.get('www-authenticate') ?? ''
  const metadataMatch = /resource_metadata="([^"]+)"/.exec(authHeader)
  const resourceMetadataCandidates = [
    metadataMatch?.[1],
    `${mcp.origin}/.well-known/oauth-protected-resource`,
  ].filter((url): url is string => Boolean(url))

  for (const metadataUrl of [...new Set(resourceMetadataCandidates)]) {
    const metadataResponse = await fetch(metadataUrl, { headers: { Accept: 'application/json' } })
    if (!metadataResponse.ok) continue
    const resourceMetadata = (await metadataResponse.json()) as { authorization_servers?: string[] }
    const authorizationServer = resourceMetadata.authorization_servers?.[0]
    if (!authorizationServer) continue

    const asUrl = new URL(authorizationServer)
    asUrl.pathname = `${asUrl.pathname.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`
    const metadataResponse2 = await fetch(asUrl, { headers: { Accept: 'application/json' } })
    if (!metadataResponse2.ok) continue
    const meta = (await metadataResponse2.json()) as OAuthServerMetadata
    if (!meta.authorization_endpoint || !meta.token_endpoint) continue
    const scopes = meta.scopes_supported?.includes('offline_access')
      ? 'offline_access'
      : meta.scopes_supported?.[0]
    return {
      authorizationEndpoint: meta.authorization_endpoint,
      tokenEndpoint: meta.token_endpoint,
      ...(meta.registration_endpoint ? { registrationEndpoint: meta.registration_endpoint } : {}),
      ...(scopes ? { scopes } : {}),
      resource,
    }
  }
  throw new Error('MCP OAuth 发现失败: 服务器要求授权但未找到 OAuth 元数据')
}

/** Run an oauth2 authorization-code flow with PKCE and a loopback callback. */
async function runOAuth(def: ConnectorDef, options: AuthRunOptions): Promise<Partial<ConnectorCredential>> {
  const auth = def.auth as OAuthAuthConfig
  const discovered = auth.discoveryUrl ? await discoverMcpOAuth(auth.discoveryUrl) : undefined
  if (discovered?.publicMcp) return { updatedAt: Date.now() } as Partial<ConnectorCredential>
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
    rejectCode(new Error(`OAuth 授权已取消: ${reason}`))
  }
  const onAbort = (): void => abortFlow(options.signal.reason instanceof Error ? options.signal.reason.message : String(options.signal.reason ?? '用户取消'))
  options.signal.addEventListener('abort', onAbort, { once: true })
  const flowTimer = setTimeout(() => abortFlow('等待授权超时（5 分钟）'), OAuthFlowTimeoutMs)
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
      res.end('<html><body><p>授权完成，可以关闭此窗口。</p></body></html>')
      server.close()
      server.closeIdleConnections()
      callbackServer = null
      if (errorParam) {
        rejectCode(new Error(`OAuth 授权失败: ${errorParam}`))
        return
      }
      if (codeParam) resolveCode(codeParam)
      else rejectCode(new Error('OAuth 回调缺少 code'))
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
    ? await registerClient(auth, redirectUri, registrationEndpoint)
    : auth.clientId || ''
  if (!clientId) throw new Error('OAuth 服务器不支持动态客户端注册，且未配置固定 clientId')
  const codeChallengeMethod = auth.pkce ? 'S256' : undefined
  const authorizeUrl = new URL(discovered?.authorizationEndpoint ?? auth.authorizeUrl)
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
  const code = await codePromise

  // The flow settled (code received, error, or abort): stop watching for
  // further aborts and stop the timeout so the token exchange below is not
  // racing a cancelled flow.
  options.signal.removeEventListener('abort', onAbort)
  clearTimeout(flowTimer)
  callbackServer = null

  throwIfAborted(options.signal)
  const tokenUrl = options.tokenUrlOverride ?? discovered?.tokenEndpoint ?? auth.tokenUrl
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  })
  if (discovered?.resource) body.set('resource', discovered.resource)
  if (auth.pkce) body.set('code_verifier', verifier)
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)]),
  })
  if (!response.ok) throw new Error(`OAuth token 换取失败: HTTP ${response.status}`)
  const data = (await response.json()) as Record<string, unknown>
  const accessToken = String(data.access_token ?? '')
  if (!accessToken) throw new Error('OAuth token 响应缺少 access_token')
  return {
    accessToken,
    clientId,
    ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : {}),
  }
}

/** Refresh an access token through the connector's token endpoint. */
export async function refreshOAuthToken(
  def: ConnectorDef,
  credential: ConnectorCredential,
  options: { tokenUrlOverride?: string } = {},
): Promise<Partial<ConnectorCredential> | null> {
  if (def.authMode !== 'oauth' || !credential.refreshToken) return null
  const auth = def.auth as OAuthAuthConfig
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
    const discovered = await discoverMcpOAuth(auth.discoveryUrl)
    tokenUrl = discovered.tokenEndpoint ?? ''
  }
  if (!tokenUrl) return null
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) return null
  const data = (await response.json()) as Record<string, unknown>
  const accessToken = String(data.access_token ?? '')
  if (!accessToken) return null
  return {
    accessToken,
    ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : {}),
  }
}

/** Device-code flow: surface verification URL + user code, poll until connected. */
async function runDevice(def: ConnectorDef, options: AuthRunOptions): Promise<Partial<ConnectorCredential>> {
  const probe = deviceProbes.get(def.id)
  if (probe) return probe(def, options)
  const auth = def.auth as DeviceAuthConfig
  options.onRequest({
    connectorId: def.id,
    verificationUrl: auth.verificationUrl,
  })
  return pollUntilConnected(createProbe(def, options), auth.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, auth.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS, options.signal)
}

export interface AuthProbe {
  /** Optional: obtain the user code to display. */
  issueUserCode?: () => Promise<string>
  /** Resolve true once the user finished authorizing. */
  isConnected: () => Promise<boolean>
}

function createProbe(def: ConnectorDef, options: AuthRunOptions): AuthProbe {
  if (def.authMode === 'cli') {
    const auth = def.auth as CliAuthConfig
    return {
      isConnected: () => runProbeCommand(auth.statusCommand ?? '', auth.statusArgs ?? [], auth.env, options.cli),
    }
  }
  // Default: nothing to probe (device connectors that need a real endpoint
  // define a status probe; without one the flow completes immediately).
  return { isConnected: async () => true }
}

async function runProbeCommand(command: string, args: string[], env?: Record<string, string>, cli?: CliRuntime): Promise<boolean> {
  // The status command may also need the downloaded binary.
  const resolved = cli ? await cli.resolve(command, args) : null
  return new Promise((resolve) => {
    const child = spawn(resolved?.command ?? command, resolved?.args ?? args, {
      env: { ...process.env, ...env },
      stdio: 'ignore',
      shell: resolved?.shell,
    })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

async function pollUntilConnected(
  probe: AuthProbe,
  pollIntervalMs: number,
  pollTimeoutMs: number,
  signal: AbortSignal,
): Promise<Partial<ConnectorCredential>> {
  const deadline = Date.now() + pollTimeoutMs
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    await sleep(pollIntervalMs, signal)
    if (await probe.isConnected()) return { updatedAt: Date.now() } as Partial<ConnectorCredential>
  }
  throw new Error('授权轮询超时，请重试')
}

/** Token form flow: emit the field list; the UI answers with the values. */
async function runToken(def: ConnectorDef, options: AuthRunOptions): Promise<Partial<ConnectorCredential>> {
  const fields = def.tokenFields ?? []
  options.onRequest({ connectorId: def.id, fields })
  // The UI writes fields through the service (connect -> requestFields ->
  // submitToken), so this flow only validates the shape.
  return { updatedAt: Date.now() } as Partial<ConnectorCredential>
}

/**
 * CLI flow (mirrors WorkBuddy's CliExecutor.runAuth): spawn the login
 * command, scan stdout/stderr for the device-flow verification URL and user
 * code (pushed to the UI through onRequest), then keep the process running
 * until it exits naturally (exit 0 = authorized). Falls back to the login +
 * status-poll sequence when no deviceFlow is configured.
 */
async function runCli(def: ConnectorDef, options: AuthRunOptions): Promise<Partial<ConnectorCredential>> {
  const auth = def.auth as CliAuthConfig
  const signal = options.signal
  const deviceFlow = auth.deviceFlow
  const waitForExit = auth.authWaitForExit ?? deviceFlow !== undefined
  const timeoutMs = auth.timeoutMs ?? (waitForExit ? 300_000 : 10_000)

  // Download-on-demand: when the CLI is not installed, the runtime fetches
  // the pinned native binary and reports progress through the pending
  // request so the UI can show "正在下载…" instead of a bare ENOENT.
  const resolved = options.cli
    ? await options.cli.resolve(auth.command, auth.args, (message) => {
        options.onRequest({ connectorId: def.id, message })
      })
    : null
  const spawnCommand = resolved?.command ?? auth.command
  const spawnArgs = resolved?.args ?? auth.args

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(spawnCommand, spawnArgs, {
      env: { ...process.env, ...auth.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: resolved?.shell,
    })
    let stdout = ''
    let stderr = ''
    let reportedUri: string | undefined
    let reportedCode: string | undefined

    const extract = (text: string, _source: string): void => {
      if (!deviceFlow) return
      let uri: string | undefined
      try {
        const match = text.match(new RegExp(deviceFlow.uriPattern))
        uri = (match?.[1] ?? match?.[0])?.trim()
      } catch { /* invalid pattern */ }
      let code: string | undefined
      if (deviceFlow.codePattern) {
        try {
          const match = text.match(new RegExp(deviceFlow.codePattern))
          code = (match?.[1] ?? match?.[0])?.trim()
        } catch { /* invalid pattern */ }
      }
      if (!uri && !code) return
      // The URL and the code may land in different output chunks; keep
      // reporting until both are known.
      if (uri === reportedUri && code === reportedCode) return
      reportedUri = uri ?? reportedUri
      reportedCode = code ?? reportedCode
      options.onRequest({ connectorId: def.id, ...(reportedUri !== undefined ? { verificationUrl: reportedUri } : {}), ...(reportedCode !== undefined ? { userCode: reportedCode } : {}) })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      extract(stdout, 'stdout')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      extract(stderr, 'stderr')
    })
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // The CLI binary is missing: always name the command and, when the
        // def knows the install method, surface it so the UI can show an
        // actionable hint instead of a bare ENOENT.
        const hint = auth.installCommand
          ? `，请先安装：${auth.installCommand}`
          : '，请确认已安装该命令行工具并加入 PATH'
        reject(new Error(`未找到命令 ${auth.command}${hint}`))
        return
      }
      reject(error)
    })
    child.on('exit', (code) => resolve(code))

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      reject(new Error(`登录命令超时（${Math.round(timeoutMs / 1000)}s）`))
    }, timeoutMs)
    child.on('exit', () => { clearTimeout(timer) })
    signal.addEventListener('abort', () => {
      try { child.kill() } catch { /* already gone */ }
    }, { once: true })
  })

  throwIfAborted(signal)
  if (exitCode !== 0) throw new Error(`登录命令退出码 ${exitCode ?? 'error'}`)
  if (waitForExit) return { updatedAt: Date.now() } as Partial<ConnectorCredential>
  return pollUntilConnected(createProbe(def, options), auth.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, auth.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS, signal)
}

/** Server-side flow: fetch the managed token through the injected callback. */
async function runServerSide(def: ConnectorDef, options: AuthRunOptions): Promise<Partial<ConnectorCredential>> {
  void def
  const auth = def.auth as { fetchToken: () => Promise<string> }
  options.onRequest({ connectorId: def.id })
  const accessToken = await auth.fetchToken()
  if (!accessToken) throw new Error('服务端未返回 token')
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
    case 'cli':
      return runCli(def, options)
    case 'server-side':
      return runServerSide(def, options)
  }
}

export type { TokenField }
