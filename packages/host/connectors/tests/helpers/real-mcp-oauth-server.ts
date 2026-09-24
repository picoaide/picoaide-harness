/**
 * End-to-end audit harness: a REAL MCP server that is protected by a REAL,
 * standards-shaped authorization server, driven through the connector plugin's
 * own code path.
 *
 * What is real here (nothing is mocked):
 *  - a real `@modelcontextprotocol/sdk` MCP server on a real HTTP transport;
 *  - RFC 9728 protected-resource metadata + RFC 8414 authorization-server
 *    metadata + RFC 7591 dynamic client registration + PKCE;
 *  - bearer validation on every request, access-token expiry, refresh-token
 *    rotation and revocation on reuse;
 *  - the connector's OAuth flow (`runAuth`) with a real loopback callback;
 *  - the connector's refresh engine (`TokenRefresher`) and its auth provider.
 *
 * Used by tests/audit-connectors.spec.ts.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export interface RealMcpServer {
  origin: string
  /** access-token lifetime handed to clients, ms */
  setTokenLifetime: (ms: number) => void
  /** rotate the refresh token on every refresh (spec-recommended) */
  setRotateRefresh: (rotate: boolean) => void
  /** expire every ACCESS token server-side, leaving the client's copy as-is */
  expireAccessTokens: () => void
  /**
   * Delay every `/mcp` answer by this many ms (`0` = answer immediately).
   *
   * A 401 recovery is a two-request conversation on ONE transport: the SDK
   * refreshes, then retries the call. Whether anything the host does during the
   * refresh can still hurt that retry depends on the retry staying in flight
   * longer than that work takes — i.e. on a real server's answer time. The knob
   * makes that window deterministic instead of machine-speed dependent.
   */
  setMcpDelay: (ms: number) => void
  /**
   * Answer the next `count` RFC 9728 resource-metadata requests with 500.
   *
   * The transient shape that makes a REGISTRATION fail its discovery round trip
   * while the MCP endpoint itself keeps working: `mcpAuthProvider` then returns
   * no provider at all, and the transport authenticates with the bearer baked
   * into `requestInit.headers` — a snapshot nothing re-reads (V3A-N6). `0`
   * restores the healthy endpoint.
   */
  setMetadataFailure: (count: number) => void
  /** counts + observations for assertions */
  stats: {
    registrations: number
    grants: string[]
    tokenRequests: URLSearchParams[]
    mcpUnauthorized: number
    toolCalls: number
    refreshTokensIssued: string[]
    revokedRefreshReuse: number
    /** resource-metadata requests: total, and how many were answered 500. */
    metadataRequests: number
    metadataRejected: number
    /**
     * The bearer every `/mcp` request presented, in arrival order (`''` = the
     * request carried no `Authorization` header at all).
     *
     * A status count cannot express WHICH token a retry replayed, and that is
     * the whole 401-recovery property: "the dead token is never sent again"
     * (R7-B P1-1). Recording the sequence makes it assertable directly.
     */
    mcpBearerTokens: string[]
  }
  close: () => Promise<void>
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

export async function startRealMcpServer(): Promise<RealMcpServer> {
  const stats: RealMcpServer['stats'] = {
    registrations: 0, grants: [], tokenRequests: [], mcpUnauthorized: 0, toolCalls: 0,
    refreshTokensIssued: [], revokedRefreshReuse: 0, mcpBearerTokens: [],
    metadataRequests: 0, metadataRejected: 0,
  }
  let tokenLifetimeMs = 60 * 60 * 1000
  let rotateRefresh = true
  let mcpDelayMs = 0
  let metadataFailures = 0
  /** token -> { expiresAt, kind } */
  const tokens = new Map<string, { expiresAt: number, kind: 'access' | 'refresh', used: boolean }>()
  const clients = new Map<string, { redirectUris: string[] }>()
  const codes = new Map<string, { clientId: string, challenge: string, redirectUri: string, scope?: string }>()

  const origin = (): string => {
    const address = http.address() as AddressInfo | null
    return `http://127.0.0.1:${address?.port ?? 0}`
  }

  const issue = (kind: 'access' | 'refresh'): string => {
    const token = `${kind === 'access' ? 'at' : 'rt'}-${randomUUID()}`
    tokens.set(token, { expiresAt: Date.now() + (kind === 'access' ? tokenLifetimeMs : 30 * 24 * 3600 * 1000), kind, used: false })
    if (kind === 'refresh') stats.refreshTokensIssued.push(token)
    return token
  }

  function mcpServer(): Server {
    const server = new Server({ name: 'audit-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      stats.toolCalls++
      return { content: [{ type: 'text', text: `echo:${String(request.params.arguments?.text ?? '')}` }] }
    })
    return server
  }

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const readBody = (req: IncomingMessage): Promise<string> => new Promise(resolve => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => resolve(body))
  })

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin())
    const o = origin()

    // ---- RFC 9728 protected resource metadata -----------------------------
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      stats.metadataRequests++
      if (metadataFailures > 0) {
        metadataFailures--
        stats.metadataRejected++
        return json(res, 500, { error: 'temporarily_unavailable' })
      }
      return json(res, 200, { resource: `${o}/mcp`, authorization_servers: [o], bearer_methods_supported: ['header'] })
    }
    // ---- RFC 8414 authorization server metadata ---------------------------
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      return json(res, 200, {
        issuer: o,
        authorization_endpoint: `${o}/oauth/authorize`,
        token_endpoint: `${o}/oauth/token`,
        registration_endpoint: `${o}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['mcp.read', 'offline_access'],
      })
    }
    // ---- RFC 7591 dynamic client registration -----------------------------
    if (url.pathname === '/oauth/register' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}') as { redirect_uris?: string[] }
      const clientId = `client-${randomUUID()}`
      clients.set(clientId, { redirectUris: body.redirect_uris ?? [] })
      stats.registrations++
      return json(res, 201, { client_id: clientId, token_endpoint_auth_method: 'none', redirect_uris: body.redirect_uris ?? [] })
    }
    // ---- authorization endpoint: auto-approve and redirect with a code ----
    if (url.pathname === '/oauth/authorize') {
      const clientId = url.searchParams.get('client_id') ?? ''
      const redirectUri = url.searchParams.get('redirect_uri') ?? ''
      const challenge = url.searchParams.get('code_challenge') ?? ''
      const state = url.searchParams.get('state') ?? ''
      const scope = url.searchParams.get('scope') ?? undefined
      if (!clientId || !redirectUri || !challenge) return json(res, 400, { error: 'invalid_request' })
      const code = `code-${randomUUID()}`
      codes.set(code, { clientId, challenge, redirectUri, ...(scope === undefined ? {} : { scope }) })
      const target = new URL(redirectUri)
      target.searchParams.set('code', code)
      if (state !== '') target.searchParams.set('state', state)
      res.writeHead(302, { location: target.toString() })
      return res.end()
    }
    // ---- token endpoint: PKCE code exchange + rotating refresh ------------
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req))
      stats.grants.push(params.get('grant_type') ?? '')
      stats.tokenRequests.push(params)
      const grant = params.get('grant_type')
      if (grant === 'authorization_code') {
        const code = params.get('code') ?? ''
        const entry = codes.get(code)
        if (!entry) return json(res, 400, { error: 'invalid_grant' })
        codes.delete(code)
        const verifier = params.get('code_verifier') ?? ''
        const computed = base64url(createHash('sha256').update(verifier).digest())
        if (computed !== entry.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' })
        const access = issue('access')
        const refresh = issue('refresh')
        return json(res, 200, {
          access_token: access, refresh_token: refresh, token_type: 'Bearer',
          expires_in: Math.floor(tokenLifetimeMs / 1000), scope: 'mcp.read offline_access',
        })
      }
      if (grant === 'refresh_token') {
        const presented = params.get('refresh_token') ?? ''
        const entry = tokens.get(presented)
        if (!entry || entry.kind !== 'refresh') return json(res, 400, { error: 'invalid_grant' })
        if (entry.used) {
          // rotation + reuse detection (RFC 6819 §5.2.2.3 style)
          stats.revokedRefreshReuse++
          return json(res, 400, { error: 'invalid_grant', error_description: 'refresh token already used' })
        }
        entry.used = true
        const access = issue('access')
        const body: Record<string, unknown> = {
          access_token: access, token_type: 'Bearer', expires_in: Math.floor(tokenLifetimeMs / 1000),
          scope: 'mcp.read offline_access',
        }
        if (rotateRefresh) body.refresh_token = issue('refresh')
        else {
          // keep the presented one usable
          entry.used = false
          body.refresh_token = presented
        }
        return json(res, 200, body)
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    // ---- the protected MCP endpoint ---------------------------------------
    if (url.pathname === '/mcp') {
      const header = req.headers.authorization ?? ''
      const token = header.replace(/^Bearer\s+/iu, '')
      // Recorded on arrival, BEFORE the delay: the wire fact ("which token did
      // the retry carry") must not depend on whether the caller is still there
      // when the answer is ready.
      stats.mcpBearerTokens.push(token)
      if (mcpDelayMs > 0) await new Promise<void>(resolve => { setTimeout(resolve, mcpDelayMs) })
      const entry = token === '' ? undefined : tokens.get(token)
      const valid = entry !== undefined && entry.kind === 'access' && entry.expiresAt > Date.now()
      if (!valid) {
        stats.mcpUnauthorized++
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': `Bearer error="invalid_token", resource_metadata="${o}/.well-known/oauth-protected-resource"`,
        })
        return res.end(JSON.stringify({ error: 'invalid_token' }))
      }
      // stateless: one transport+server pair per request
      const server = mcpServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await server.connect(transport)
      res.on('finish', () => { void transport.close().catch(() => {}); void server.close().catch(() => {}) })
      await transport.handleRequest(req, res)
      return
    }
    json(res, 404, { error: 'not_found' })
  })

  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))

  return {
    origin: origin(),
    setTokenLifetime: (ms) => { tokenLifetimeMs = ms },
    expireAccessTokens: () => {
      for (const [token, entry] of tokens) if (entry.kind === 'access') tokens.delete(token)
    },
    setRotateRefresh: (rotate) => { rotateRefresh = rotate },
    setMcpDelay: (ms) => { mcpDelayMs = Math.max(0, Math.floor(ms)) },
    setMetadataFailure: (count) => { metadataFailures = Math.max(0, Math.floor(count)) },
    stats,
    close: () => new Promise<void>(resolve => { http.close(() => resolve()) }),
  }
}

/** Follow one authorization URL the way a browser would (GET + redirect). */
export async function completeAuthorization(authorizeUrl: string): Promise<void> {
  const response = await fetch(authorizeUrl, { redirect: 'manual' })
  if (response.status !== 302 && response.status !== 303) {
    throw new Error(`authorize endpoint answered ${response.status}`)
  }
  const location = response.headers.get('location')
  if (!location) throw new Error('authorize endpoint returned no location')
  // the connector's loopback callback receives the redirect; a browser would
  // navigate there. Fetching it is the closest headless equivalent.
  const callback = await fetch(location, { redirect: 'manual' }).catch(() => undefined)
  if (callback === undefined) return
}

export interface StaticTokenMcpServer {
  origin: string
  /** Requests that arrived with a bearer token, in order. */
  readonly seenTokens: string[]
  close: () => Promise<void>
}

/**
 * A real MCP server that authenticates with a FIXED bearer token (the token-form
 * connector class: POST /connect → the panel submits fields → the transport is
 * built with `headers.Authorization`). No OAuth, no refresh.
 */
export async function startStaticTokenMcpServer(
  expectedToken: string,
  /**
   * The header the endpoint authenticates. `Authorization` is the default; a
   * definition that auto-fills a BEARER into a header of its own name
   * (`X-Probe-Key: ''` — "leave empty to fill in the bearer") needs its own, or
   * the wire assertion would read a header the transport never sends (V3A-N1).
   */
  header = 'Authorization',
): Promise<StaticTokenMcpServer> {
  const seenTokens: string[] = []
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/mcp') return json(res, 404, { error: 'not_found' })
    const raw = req.headers[header.toLowerCase()]
    const token = String(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')).replace(/^Bearer\s+/iu, '')
    seenTokens.push(token)
    if (token !== expectedToken) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'invalid_token' }))
    }
    const server = new Server({ name: 'static-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }],
    }))
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    res.on('finish', () => { void transport.close().catch(() => {}); void server.close().catch(() => {}) })
    await transport.handleRequest(req, res)
  })
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${address.port}`,
    seenTokens,
    close: () => new Promise<void>(resolve => { httpServer.close(() => resolve()) }),
  }
}
