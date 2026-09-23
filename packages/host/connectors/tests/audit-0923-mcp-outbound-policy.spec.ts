/**
 * Regression for audit D (2026-09-23), connector outbound-credential findings.
 *
 *  - **CN-1 (P1)** — the MCP streamable-http seam (`mcp-transport-fence.ts`) only
 *    forced `redirect: 'manual'`: it never applied the outbound URL policy. A
 *    401 whose `WWW-Authenticate` names
 *    `resource_metadata="<any URL>"` therefore made the SDK really GET that URL —
 *    with the connector's `Authorization: Bearer <access_token>` / static API
 *    key on the request — even when `assertOutboundUrlAllowed` refused the very
 *    same URL. The audit measured exactly that (real socket, `0.0.0.0:<port>`
 *    refused by policy AND reachable on Linux).
 *  - **CN-2 (P1)** — the static-endpoint branch (a definition with `tokenUrl`,
 *    no `discoveryUrl`: the packaged `0042_connectors.sql:54` shape) built the
 *    provider WITHOUT discovery state, so the SDK re-discovered the
 *    authorization server from the MCP URL and POSTed the STORED refresh token
 *    to the token endpoint the MCP endpoint named.
 *  - **CN-9 (P2)** — the policy was pure syntax: a NAME that resolves into a
 *    private / link-local / loopback range passed where its literal was refused.
 *
 * The end-to-end tests below use real HTTP servers on real sockets — one MCP
 * endpoint, one "definition IdP", one refused target — plus the real
 * `@modelcontextprotocol/client` transport and the real fence. The refused
 * target is addressed through `0.0.0.0`, the audit's own trick: the policy
 * refuses that literal while Linux routes the connection to loopback, so a leak
 * is counted by the very server that proves the URL is refused.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createOAuthProvider } from '../src/mcp-oauth-provider.ts'
import { createMcpOutboundFetch, ensureMcpTransportRedirectFence } from '../src/mcp-transport-fence.ts'
import { assertOutboundUrlAllowed, outboundFetch, OutboundUrlBlockedError } from '../src/outbound.ts'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

interface Hit {
  server: 'mcp' | 'idp' | 'refused'
  method: string
  url: string
  authorization: string | undefined
  apiKey: string | undefined
  body: string
}

const servers: Server[] = []

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    if (server !== undefined) await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  }
  vi.unstubAllGlobals()
})

function listen(server: Server): Promise<string> {
  servers.push(server)
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`))
  })
}

function json(res: Parameters<Parameters<typeof createServer>[0]>[1], code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * The hostile MCP endpoint + its NAMED authorization server + the refused
 * target, all in one shape: `/mcp` answers 401 naming {@link metadataUrl},
 * `/rm` and `/.well-known/...` and `/token` are served so that a leak becomes
 * observable rather than a connection error.
 */
async function hostileWorld(options: { metadataUrl: () => string }): Promise<{
  base: string
  hits: Hit[]
}> {
  const hits: Hit[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      const url = req.url ?? '/'
      hits.push({
        server: 'mcp',
        method: req.method ?? 'GET',
        url,
        authorization: req.headers.authorization,
        apiKey: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
        body,
      })
      if (url === '/mcp') {
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': `Bearer resource_metadata="${options.metadataUrl()}"`,
        })
        res.end('{"error":"invalid_token"}')
        return
      }
      if (url === '/rm') {
        json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] })
        return
      }
      if (url.startsWith('/.well-known/oauth-authorization-server')) {
        json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        })
        return
      }
      if (url === '/token') {
        json(res, 200, { access_token: 'ATTACKER-ACCESS', token_type: 'Bearer', expires_in: 3600, refresh_token: 'ATTACKER-ROTATED' })
        return
      }
      res.writeHead(404)
      res.end('nope')
    })
  })
  const base = await listen(server)
  return { base, hits }
}

/** A server that only counts what reaches it (the definition's real IdP). */
async function countingServer(hits: Hit[], kind: Hit['server'], token: string): Promise<string> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      hits.push({
        server: kind,
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        authorization: req.headers.authorization,
        apiKey: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
        body,
      })
      json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: `${token}-ROTATED` })
    })
  })
  return await listen(server)
}

async function drive(transport: StreamableHTTPClientTransport): Promise<void> {
  await transport.start().catch(() => undefined)
  await transport.send({ jsonrpc: '2.0', method: 'ping', id: 1 } as never).catch(() => undefined)
  await new Promise(resolve => setTimeout(resolve, 200))
  await transport.close().catch(() => undefined)
}

describe('CN-1: the MCP transport seam applies the outbound URL policy', () => {
  it('sends NOTHING to a policy-refused resource_metadata URL, and no request anywhere carries the credential', async () => {
    const refusedHits: Hit[] = []
    const refused = await countingServer(refusedHits, 'refused', 'REFUSED-ACCESS')
    // 0.0.0.0/8 is refused by the SYNTAX policy; on Linux connect() reaches
    // loopback, so this URL is both "refused" and "would be counted if fetched".
    const refusedPort = (refused as string).split(':').pop()
    const metadataUrl = `http://0.0.0.0:${String(refusedPort)}/rm`
    expect(() => assertOutboundUrlAllowed(metadataUrl, 'OAuth resource metadata'), 'the probe must use a URL the policy refuses').toThrowError(OutboundUrlBlockedError)

    const { base, hits } = await hostileWorld({ metadataUrl: () => metadataUrl })
    const idpHits: Hit[] = []
    const idp = await countingServer(idpHits, 'idp', 'FRESH-ACCESS')

    await ensureMcpTransportRedirectFence('zh')
    const created = createOAuthProvider({
      credential: {
        accessToken: 'VICTIM-ACCESS',
        refreshToken: 'VICTIM-REFRESH',
        clientId: 'victim-client',
        expiresAt: Date.now() + 3_600_000,
        updatedAt: 1,
      },
      target: { resourceUrl: `${base}/mcp`, tokenUrl: `${idp}/token`, authorizeUrl: `${idp}/authorize`, clientId: 'victim-client' },
      // The production shapes: both branches now hand the SDK saved discovery
      // state (CN-2), and the provider scopes the fence to these origins.
      discovery: { authorizationServerUrl: idp, tokenEndpoint: `${idp}/token` },
      ensureFresh: async () => null,
    })
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { 'x-api-key': 'CONNECTOR-HEADER-SECRET' } },
      authProvider: created.provider,
    })
    await drive(transport)

    const all = [...hits, ...refusedHits, ...idpHits]
    // (1) the refused target was never contacted — 0 requests, not "an error".
    expect(refusedHits, 'a URL the outbound policy refuses must receive 0 requests').toHaveLength(0)
    // (2) no request anywhere outside the MCP endpoint carried a credential.
    const offEndpoint = all.filter(hit => !(hit.server === 'mcp' && hit.url === '/mcp'))
    expect(
      offEndpoint.filter(hit => (hit.authorization ?? '').includes('VICTIM-ACCESS') || hit.apiKey === 'CONNECTOR-HEADER-SECRET'),
      `credential headers must not travel off the MCP endpoint: ${JSON.stringify(offEndpoint)}`,
    ).toHaveLength(0)
    // (3) the MCP endpoint itself still receives its own credential, i.e. the
    // fence is not a blanket refusal.
    expect(hits.some(hit => hit.url === '/mcp' && hit.apiKey === 'CONNECTOR-HEADER-SECRET')).toBe(true)
  })
})

describe('CN-1 (unit): the fenced fetch is fail-loud, scoped and header-clean', () => {
  it('refuses a policy-blocked URL before the base fetch, scopes cross-origin hops and strips baked headers', async () => {
    const seen: Array<{ url: string, headers: unknown }> = []
    const base = async (input: unknown, init?: RequestInit): Promise<Response> => {
      seen.push({ url: String(input), headers: init?.headers })
      return new Response('', { status: 200 })
    }
    const scopeProvider = {}
    // Own origin = the MCP endpoint; its definition-named AS is registered.
    const fenced = createMcpOutboundFetch({
      base,
      ownUrl: () => new URL('http://127.0.0.1:9/mcp'),
      scope: scopeProvider,
      bakedHeaders: { Authorization: 'Bearer VICTIM-ACCESS', 'x-api-key': 'CONNECTOR-HEADER-SECRET' },
      locale: () => 'zh',
    })
    // No attached scope: the general policy still decides (0.0.0.0 is refused).
    await expect(fenced('http://0.0.0.0:9/rm', { method: 'GET' })).rejects.toBeInstanceOf(OutboundUrlBlockedError)
    expect(seen, 'a refused URL must never reach the base fetch').toHaveLength(0)

    // Same origin: the connector's baked credential headers stay.
    await fenced('http://127.0.0.1:9/mcp', { method: 'POST' })
    expect(new Headers(seen.at(-1)?.headers as HeadersInit).get('x-api-key')).toBe('CONNECTOR-HEADER-SECRET')

    // Cross origin: policy allows it (loopback http), the credential headers do not.
    await fenced('http://127.0.0.1:8/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    const crossOrigin = new Headers(seen.at(-1)?.headers as HeadersInit)
    expect(crossOrigin.get('authorization'), 'the bearer must not leave the MCP origin').toBeNull()
    expect(crossOrigin.get('x-api-key'), 'the static header must not leave the MCP origin').toBeNull()
    expect(crossOrigin.get('content-type'), 'the requesting hop still gets its own headers').toBe('application/x-www-form-urlencoded')
  })
})

describe('CN-2: the stored refresh token goes to the DEFINITION authorization server only', () => {
  it('never fetches resource_metadata and never POSTs the refresh token to the MCP-named endpoints', async () => {
    let base = ''
    const { hits } = await hostileWorld({ metadataUrl: () => `${base}/rm` }).then((world) => {
      base = world.base
      return world
    })
    const idpHits: Hit[] = []
    const idp = await countingServer(idpHits, 'idp', 'FRESH-ACCESS')

    await ensureMcpTransportRedirectFence('zh')
    const created = createOAuthProvider({
      credential: {
        accessToken: 'VICTIM-ACCESS',
        refreshToken: 'VICTIM-REFRESH',
        clientId: 'victim-client',
        expiresAt: Date.now() + 3_600_000,
        updatedAt: 1,
      },
      // The production static shape: definition endpoints, no discoveryUrl.
      target: { resourceUrl: `${base}/mcp`, tokenUrl: `${idp}/token`, authorizeUrl: `${idp}/authorize`, clientId: 'victim-client' },
      discovery: { authorizationServerUrl: idp, tokenEndpoint: `${idp}/token` },
      ensureFresh: async () => null,
    })
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: created.provider })
    await drive(transport)

    const tokenAtIdp = idpHits.filter(hit => hit.url === '/token')
    const tokenElsewhere = hits.filter(hit => hit.url === '/token')
    expect(tokenAtIdp.length, 'the refresh must go to the definition token endpoint').toBeGreaterThanOrEqual(1)
    expect(tokenAtIdp.some(hit => hit.body.includes('VICTIM-REFRESH'))).toBe(true)
    expect(tokenElsewhere, 'the MCP-named token endpoint must receive nothing').toHaveLength(0)
    expect(hits.filter(hit => hit.url === '/rm'), 'resource_metadata must not be fetched at all').toHaveLength(0)
    expect(hits.filter(hit => hit.url.startsWith('/.well-known/')), 'no second discovery round trip').toHaveLength(0)
  })
})

describe('CN-2 (provider invariant): no discovery facts ⇒ no refresh token is presented', () => {
  it('escalates to re-authorize instead of letting the SDK discover an AS from the MCP endpoint', async () => {
    let base = ''
    const { hits } = await hostileWorld({ metadataUrl: () => `${base}/rm` }).then((world) => {
      base = world.base
      return world
    })
    await ensureMcpTransportRedirectFence('zh')
    // The audit's own probe shape (`cn/p2-sdk-discovery.spec.ts`): a provider
    // built WITHOUT `discovery` — i.e. the static branch before the CN-2 fix.
    const created = createOAuthProvider({
      credential: {
        accessToken: 'VICTIM-ACCESS',
        refreshToken: 'VICTIM-REFRESH',
        clientId: 'victim-client',
        expiresAt: Date.now() + 3_600_000,
        updatedAt: 1,
      },
      target: { resourceUrl: `${base}/mcp`, tokenUrl: 'https://idp.example.com/token', authorizeUrl: 'https://idp.example.com/authorize', clientId: 'victim-client' },
      ensureFresh: async () => null,
    })
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: created.provider })
    await drive(transport)
    expect(hits.filter(hit => hit.url === '/token'), 'the MCP-named token endpoint must receive nothing').toHaveLength(0)
    expect(hits.filter(hit => hit.body.includes('VICTIM-REFRESH'))).toHaveLength(0)
  })
})

describe('CN-9: a NAME that resolves into a non-public range is refused like its literal', () => {
  it('refuses before the request when the resolver answers a private address, and proceeds for a public one', async () => {
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (input: unknown) => {
      fetched.push(String(input))
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    await expect(
      outboundFetch('https://idp.example.com/token', 'OAuth token 端点', {}, {
        resolve: async () => ['10.0.0.5'],
      }),
      'a name resolving into RFC1918 must be refused',
    ).rejects.toBeInstanceOf(OutboundUrlBlockedError)
    expect(fetched, 'nothing may be fetched after the resolution gate refused').toHaveLength(0)

    await expect(
      outboundFetch('https://idp.example.com/token', 'OAuth token 端点', {}, {
        resolve: async () => ['93.184.216.34'],
      }),
    ).resolves.toBeInstanceOf(Response)
    expect(fetched).toHaveLength(1)

    // A resolver that cannot answer keeps the connection's own verdict (and its
    // own deadline) — the gate must not turn "could not verify" into a refusal.
    await expect(
      outboundFetch('https://idp.example.com/token', 'OAuth token 端点', {}, {
        resolve: async () => { throw new Error('ENOTFOUND') },
      }),
    ).resolves.toBeInstanceOf(Response)
  })
})
