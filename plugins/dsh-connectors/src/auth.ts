import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CliAuthConfig, ConnectorAuthRequest, ConnectorDef, DeviceAuthConfig, OAuthAuthConfig, TokenField } from './types.ts'
import type { ConnectorCredential } from './store.ts'

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

/** Discover the OAuth endpoints for an MCP server (RFC 8414 metadata). */
async function discoverMcpOAuth(discoveryUrl: string): Promise<OAuthServerMetadata & { scopes?: string }> {
  const response = await fetch(discoveryUrl, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`MCP OAuth 元数据获取失败: HTTP ${response.status}`)
  const meta = (await response.json()) as OAuthServerMetadata
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error('MCP OAuth 元数据缺少 authorization_endpoint/token_endpoint')
  }
  const scopes = meta.scopes_supported?.includes('offline_access')
    ? 'offline_access'
    : meta.scopes_supported?.[0]
  return { ...meta, ...(scopes ? { scopes } : {}) }
}

/** Run an oauth2 authorization-code flow with PKCE and a loopback callback. */
async function runOAuth(def: ConnectorDef, options: AuthRunOptions): Promise<Partial<ConnectorCredential>> {
  const auth = def.auth as OAuthAuthConfig
  const discovered = auth.discoveryUrl ? await discoverMcpOAuth(auth.discoveryUrl) : undefined
  const callbackHost = options.callbackHost ?? '127.0.0.1'
  const { verifier, challenge } = pkce()
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.listen(0, callbackHost, () => {
      const address = server.address() as AddressInfo
      server.close()
      resolve(address.port)
    })
    server.on('error', reject)
  })
  const redirectUri = `http://${callbackHost}:${port}/callback`
  const registrationEndpoint = discovered?.registration_endpoint ?? auth.registrationEndpoint
  const clientId = registrationEndpoint
    ? await registerClient(auth, redirectUri, registrationEndpoint)
    : auth.clientId || ''
  if (!clientId) throw new Error('OAuth 服务器不支持动态客户端注册，且未配置固定 clientId')
  const codePromise = new Promise<string>((resolve, reject) => {
    const callbackServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${callbackHost}:${port}`)
      const codeParam = url.searchParams.get('code')
      const errorParam = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body><p>授权完成，可以关闭此窗口。</p></body></html>')
      callbackServer.close()
      if (errorParam) {
        reject(new Error(`OAuth 授权失败: ${errorParam}`))
        return
      }
      if (codeParam) resolve(codeParam)
      else reject(new Error('OAuth 回调缺少 code'))
    })
    callbackServer.listen(port, callbackHost)
    callbackServer.on('error', reject)
  })
  const codeChallengeMethod = auth.pkce ? 'S256' : undefined
  const authorizeUrl = new URL(discovered?.authorization_endpoint ?? auth.authorizeUrl)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  const scopes = discovered?.scopes ?? auth.scopes
  if (scopes) authorizeUrl.searchParams.set('scope', scopes)
  if (auth.pkce) {
    authorizeUrl.searchParams.set('code_challenge', challenge)
    authorizeUrl.searchParams.set('code_challenge_method', codeChallengeMethod ?? 'S256')
  }
  options.onRequest({ connectorId: def.id, authorizeUrl: authorizeUrl.toString() })
  const code = await codePromise

  throwIfAborted(options.signal)
  const tokenUrl = options.tokenUrlOverride ?? discovered?.token_endpoint ?? auth.tokenUrl
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  })
  if (auth.pkce) body.set('code_verifier', verifier)
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: options.signal,
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
  const response = await fetch(options.tokenUrlOverride ?? auth.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
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

function createProbe(def: ConnectorDef, _options: AuthRunOptions): AuthProbe {
  if (def.authMode === 'cli') {
    const auth = def.auth as CliAuthConfig
    return {
      isConnected: () => runProbeCommand(auth.statusCommand ?? '', auth.statusArgs ?? [], auth.env),
    }
  }
  // Default: nothing to probe (device connectors that need a real endpoint
  // define a status probe; without one the flow completes immediately).
  return { isConnected: async () => true }
}

async function runProbeCommand(command: string, args: string[], env?: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: 'ignore',
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

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(auth.command, auth.args, {
      env: { ...process.env, ...auth.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let codeReported = false

    const extract = (text: string, source: string): void => {
      if (!deviceFlow || codeReported) return
      let uri: string | undefined
      try {
        const match = text.match(new RegExp(deviceFlow.uriPattern))
        uri = (match?.[1] ?? match?.[0])?.trim()
      } catch { /* invalid pattern */ }
      if (!uri) return
      let code: string | undefined
      if (deviceFlow.codePattern) {
        try {
          const match = text.match(new RegExp(deviceFlow.codePattern))
          code = (match?.[1] ?? match?.[0])?.trim()
        } catch { /* invalid pattern */ }
      }
      codeReported = true
      void source
      options.onRequest({ connectorId: def.id, verificationUrl: uri, ...(code !== undefined ? { userCode: code } : {}) })
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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && auth.installCommand) {
        reject(new Error(`未找到命令 ${auth.command}，请先安装：${auth.installCommand}`))
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
