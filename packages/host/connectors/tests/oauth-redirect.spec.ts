/**
 * Residual C (medium): the OAuth token exchange followed HTTP redirects.
 *
 * Every outbound URL is checked by the outbound policy before it is fetched,
 * but `fetch` follows redirects by default: a token endpoint that passes the
 * policy and then answers `307` with a `Location` the policy would REFUSE as an
 * initial URL still received the POST body — the authorization code and the
 * PKCE `code_verifier` included.
 *
 * These tests run the real flow against real HTTP servers: a discovery server
 * that hands out the token endpoint, a real loopback callback (the flow's own),
 * a real PKCE verifier, and a second listener that must never be reached.
 * `S256(code_verifier)` is recomputed against the `code_challenge` the flow put
 * in the authorize URL, so the verifier at risk is proven to be the real one.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshOAuthToken, runAuth } from '../src/auth.ts'
import { isOutboundUrlAllowed } from '../src/outbound.ts'
import type { ConnectorDef } from '../src/types.ts'

interface Hit {
  path: string
  method: string
  body: string
  host: string
}

type Handler = (url: URL, req: IncomingMessage, res: ServerResponse, body: string) => void

const servers: Server[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.close(() => resolve()) })
})

function listen(server: Server): Promise<number> {
  return new Promise(resolve => server.listen(0, () => resolve((server.address() as AddressInfo).port)))
}

/** One real HTTP server; `handler` receives the parsed request. */
async function startServer(handler: Handler): Promise<{ port: number; close: () => void }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const host = String(req.headers.host ?? '')
      handler(new URL(req.url ?? '/', `http://${host}`), req, res, Buffer.concat(chunks).toString('utf8'))
    })
  })
  const port = await listen(server)
  servers.push(server)
  return { port, close: () => { server.close() } }
}

/**
 * A listener that the outbound policy refuses as an INITIAL url (private LAN
 * address, or the trailing-dot spelling of `localhost`) but that is genuinely
 * reachable — the point of the test is that following the redirect would have
 * delivered the body, so the target must be reachable for the red run.
 */
async function startRefusedTarget(): Promise<{ origin: string; hits: Hit[] }> {
  const hits: Hit[] = []
  const server = await startServer((url, req, res, body) => {
    hits.push({ path: url.pathname, method: req.method ?? '', body, host: String(req.headers.host ?? '') })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ access_token: 'STOLEN', token_type: 'Bearer' }))
  })
  const candidates = [
    ...Object.values(networkInterfaces()).flat()
      .filter(iface => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
      .map(iface => iface!.address),
    'localhost.',
  ]
  for (const authority of candidates) {
    const origin = `http://${authority}:${server.port}`
    if (isOutboundUrlAllowed(`${origin}/x`)) continue
    try {
      const probe = await fetch(`${origin}/reachable`, { redirect: 'manual' })
      if (probe.status === 200) { hits.length = 0; return { origin, hits } }
    } catch { /* authority not reachable from here: try the next candidate */ }
  }
  throw new Error('no refused-but-reachable redirect target available in this environment')
}

interface DiscoveryServer {
  /** Base URL as the discovery documents advertise it (loopback: policy-allowed). */
  origin: string
  hits: Hit[]
  setTokenAnswer: (answer: { status: number; location?: string; accessToken?: string }) => void
}

/** MCP endpoint + protected-resource metadata + RFC 8414 document + token endpoint. */
async function startDiscovery(): Promise<DiscoveryServer> {
  const hits: Hit[] = []
  let answer: { status: number; location?: string; accessToken?: string } = { status: 200, accessToken: 'at-legit' }
  let origin = ''
  const server = await startServer((url, req, res, body) => {
    hits.push({ path: url.pathname, method: req.method ?? '', body, host: String(req.headers.host ?? '') })
    if (url.pathname === '/mcp') {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/prm.json"`,
      })
      res.end('{}')
      return
    }
    if (url.pathname === '/prm.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ authorization_servers: [origin] }))
      return
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        scopes_supported: ['offline_access'],
      }))
      return
    }
    if (url.pathname === '/token') {
      if (answer.location !== undefined) {
        res.writeHead(answer.status, { Location: answer.location })
        res.end()
        return
      }
      res.writeHead(answer.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ access_token: answer.accessToken ?? 'at-legit', refresh_token: 'rt-legit', token_type: 'Bearer' }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  origin = `http://127.0.0.1:${server.port}`
  return {
    get origin() { return origin },
    hits,
    setTokenAnswer: (next) => { answer = next },
  }
}

function oauthDef(discoveryUrl: string): ConnectorDef {
  return {
    id: 'evil-oauth',
    name: 'Evil OAuth',
    description: 'probe',
    authMode: 'oauth',
    auth: {
      authorizeUrl: `${discoveryUrl.replace(/\/mcp$/, '')}/authorize`,
      tokenUrl: '',
      clientId: 'fixed-client',
      redirectUri: 'http://127.0.0.1/callback',
      pkce: true,
      discoveryUrl,
    },
    mcp: [{ serverName: 'evil', transport: 'stdio', command: 'node', args: [] }],
  }
}

interface FlowOutcome {
  error: string | null
  accessToken: string | null
  authorizeUrl: string | null
}

/** Drive the real flow; when the authorize URL appears, deliver the callback. */
async function driveFlow(discoveryUrl: string): Promise<FlowOutcome> {
  const realFetch = globalThis.fetch
  const controller = new AbortController()
  let authorizeUrl: string | null = null
  const promise = runAuth(oauthDef(discoveryUrl), {
    onRequest: (request) => {
      if (request.authorizeUrl === undefined) return
      authorizeUrl = request.authorizeUrl
      const url = new URL(request.authorizeUrl)
      const redirect = url.searchParams.get('redirect_uri') as string
      const state = url.searchParams.get('state') as string
      // The browser, delivering a genuine authorization code to the loopback
      // callback the flow itself opened.
      void realFetch(`${redirect}?code=THE-AUTH-CODE&state=${encodeURIComponent(state)}`).catch(() => {})
    },
    signal: controller.signal,
    clientName: 'probe',
  })
  const timer = setTimeout(() => controller.abort(new Error('probe timeout')), 10_000)
  try {
    const patch = await promise
    return { error: null, accessToken: patch.accessToken ?? null, authorizeUrl }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), accessToken: null, authorizeUrl }
  } finally {
    clearTimeout(timer)
  }
}

const S256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url')

function verifierOf(body: string): string | null {
  const match = /(?:^|&)code_verifier=([^&]+)/.exec(body)
  return match === null ? null : decodeURIComponent(match[1]!)
}

describe('residual C — the token exchange must not follow redirects', () => {
  it('does not deliver the authorization code or PKCE verifier through a 307', async () => {
    const target = await startRefusedTarget()
    const discovery = await startDiscovery()
    discovery.setTokenAnswer({ status: 307, location: `${target.origin}/token` })

    const outcome = await driveFlow(`${discovery.origin}/mcp`)

    // The invariant: nothing landed on the host the policy refuses.
    expect(target.hits, `redirect target ${target.origin} was reached`).toEqual([])

    // The refusal itself: the flow must not treat the redirect as a token answer.
    expect(outcome.error, 'a redirect must fail the exchange, not be followed').toMatch(/重定向|redirect/i)

    // The attack surface was real: the first hop DID receive a genuine POST
    // whose verifier hashes to the challenge the flow published.
    const firstHop = discovery.hits.filter(hit => hit.path === '/token')
    expect(firstHop).toHaveLength(1)
    expect(firstHop[0]!.body).toContain('code=THE-AUTH-CODE')
    const verifier = verifierOf(firstHop[0]!.body)
    expect(verifier, 'the POST carried a real PKCE verifier').not.toBeNull()
    const challenge = new URL(outcome.authorizeUrl ?? '').searchParams.get('code_challenge')
    expect(S256(verifier!)).toBe(challenge)
  }, 30_000)

  it('does not deliver a refresh token through a 307', async () => {
    const target = await startRefusedTarget()
    const discovery = await startDiscovery()
    discovery.setTokenAnswer({ status: 307, location: `${target.origin}/token` })

    const patch = await refreshOAuthToken(
      oauthDef(`${discovery.origin}/mcp`),
      { refreshToken: 'SECRET-REFRESH-TOKEN', clientId: 'fixed-client', updatedAt: Date.now() },
    )

    expect(target.hits, `redirect target ${target.origin} was reached`).toEqual([])
    expect(patch, 'a redirect must not be accepted as a refresh answer').toBeNull()
    expect(discovery.hits.filter(hit => hit.path === '/token' && hit.body.includes('SECRET-REFRESH-TOKEN'))).toHaveLength(1)
  }, 30_000)

  it('still completes a legitimate exchange over real HTTP', async () => {
    const discovery = await startDiscovery()
    const outcome = await driveFlow(`${discovery.origin}/mcp`)
    expect(outcome.error).toBeNull()
    expect(outcome.accessToken).toBe('at-legit')
  }, 30_000)

  it('sends every outbound request with redirect: "manual"', async () => {
    const discovery = await startDiscovery()
    const realFetch = globalThis.fetch
    const seen: Array<{ url: string; redirect: unknown }> = []
    const spy = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), redirect: init?.redirect })
      return realFetch(input, init)
    })
    globalThis.fetch = spy as unknown as typeof fetch
    try {
      const outcome = await driveFlow(`${discovery.origin}/mcp`)
      expect(outcome.error).toBeNull()
    } finally {
      globalThis.fetch = realFetch
    }
    const outbound = seen.filter(call => {
      try { return new URL(call.url).origin === discovery.origin } catch { return false }
    })
    expect(outbound.length).toBeGreaterThanOrEqual(4)
    for (const call of outbound) {
      expect(call.redirect, `${call.url} must be fetched with redirect:"manual"`).toBe('manual')
    }
  }, 30_000)

  it('refuses a redirect from the token endpoint even to a policy-allowed host', async () => {
    const second = await startDiscovery()
    const discovery = await startDiscovery()
    // Loopback-to-loopback: the target itself would pass the policy as an
    // initial URL, yet the exchange is still not allowed to be rewritten by a
    // remote answer (the code must go to the endpoint that was checked).
    discovery.setTokenAnswer({ status: 307, location: `${second.origin}/token` })

    const outcome = await driveFlow(`${discovery.origin}/mcp`)
    expect(outcome.error).toMatch(/重定向|redirect/i)
    expect(second.hits.filter(hit => hit.path === '/token')).toEqual([])
  }, 30_000)
})
