/**
 * Audit v2.8.2 → HEAD, the residual C3-06/C3-07 deliberately left open: the
 * **DNS-rebinding TOCTOU**.
 *
 * The resolution gate (`outbound.ts`) judged what a NAME resolves to, and then
 * the request went to the global `fetch`, which resolves the same name a SECOND
 * time inside the connection stack. Two resolutions, two answers: a name that
 * answers the policy with a public address and the connection with
 * `169.254.169.254` / `127.0.0.1` / a `10/8` service was refused by nobody —
 * the verdict was about an answer the request never used.
 *
 * The fix is address pinning: `resolveOutboundTarget` returns the verified
 * addresses with the URL, and `sendPinned` (`src/pinned-http.ts`) dials exactly
 * those, keeping the NAME for the request line, the `Host` header and TLS
 * (`servername`), so certificate verification stays an ordinary hostname check.
 *
 * Everything here runs real sockets against real local servers, on reserved
 * names (`*.example.com`) and documentation addresses (`198.51.100.0/24`):
 *  - the rebinding fixture drives the resolver seam (first answer public, every
 *    later answer `127.0.0.1`) while a REAL TCP listener counts what actually
 *    gets dialed — the "internal service" is never contacted, and the resolver
 *    is asked exactly once;
 *  - the allowed path is proven end to end (a real HTTP/HTTPS server answers,
 *    the `Response` really carries the body), because "refuse everything" must
 *    not be able to pass this suite;
 *  - coverage is proven per entry point by stubbing the global fetch to throw:
 *    an outbound path that still uses it cannot pass.
 *
 * Mutation evidence lives in `temp/audit-v282/fixes/P3.md` (drop the pin ⇒ this
 * suite goes red; add a second resolution ⇒ the rebinding fixture goes red).
 */
import { Agent as HttpAgent, createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runAuth } from '../src/auth.ts'
import { createMcpOutboundFetch, ensureMcpTransportRedirectFence, uninstallMcpTransportRedirectFence } from '../src/mcp-transport-fence.ts'
import { refreshCredentialTokens } from '../src/mcp-oauth-provider.ts'
import { outboundFetch, OutboundResolutionUnverifiedError, resolveOutboundTarget } from '../src/outbound.ts'
import { sendPinned, type OutboundTarget } from '../src/pinned-http.ts'
import type { ConnectorDef } from '../src/types.ts'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { startRealMcpServer, type RealMcpServer } from './helpers/real-mcp-oauth-server.ts'

/**
 * Mutable handles on the two module objects whose `globalAgent` this suite
 * replaces. An ESM namespace import is read-only, and the property itself is
 * what the criterion has to move — the point is precisely that the process-wide
 * agent IS reachable when a request does not name one.
 */
const nodeHttp = createRequire(import.meta.url)('node:http') as typeof import('node:http')
const nodeHttps = createRequire(import.meta.url)('node:https') as typeof import('node:https')

const TLS_CERT = readFileSync(new URL('./fixtures/pinned-tls-cert.pem', import.meta.url))
const TLS_KEY = readFileSync(new URL('./fixtures/pinned-tls-key.pem', import.meta.url))

/**
 * The address the rebinding fixture's resolver answers FIRST. It is in the
 * documentation range (`198.51.100.0/24`), which the policy allows for a NAME
 * (the range can never carry a real service, and refusing it by name would
 * break deployments whose resolver returns it) and which no test host routes.
 */
const REBINDING_PUBLIC_ANSWER = '198.51.100.7'
const REBINDING_INTERNAL_ANSWER = '127.0.0.1'

const cleanups: Array<() => Promise<void> | void> = []
/** Variables the ROUTE depends on (P8): an ambient proxy must not decide it. */
const PROXY_ENV_NAMES: readonly string[] = [
  'PICOAI_ALLOW_SYSTEM_PROXY', 'NODE_USE_ENV_PROXY',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
  'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
]
const savedEnv = new Map<string, string>()

beforeEach(() => {
  // This suite is about DIRECT mode (pinned transport): make the route
  // deterministic instead of inheriting whatever the runner's shell has.
  for (const name of PROXY_ENV_NAMES) {
    const value = process.env[name]
    if (value === undefined) continue
    savedEnv.set(name, value)
    delete process.env[name]
  }
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const [name, value] of savedEnv) process.env[name] = value
  savedEnv.clear()
  uninstallMcpTransportRedirectFence()
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/** Start one server on loopback and register its shutdown. */
async function listening<T extends HttpServer | HttpsServer | TcpServer>(server: T): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => { resolve() }) }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no loopback port')
  return address.port
}

/** A real HTTP server that records every request it answers. */
async function serveHttp(): Promise<{ port: number, hits: string[] }> {
  const hits: string[] = []
  const server = createHttpServer((req, res) => {
    hits.push(`${req.method ?? ''} ${req.url ?? ''} host=${req.headers.host ?? ''}`)
    if ((req.url ?? '') === '/event-stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
      setTimeout(() => { res.write('data: second\n\n'); res.end() }, 20)
      return
    }
    if ((req.url ?? '') === '/slow') return
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'identity' })
    res.end(JSON.stringify({ ok: true, host: req.headers.host ?? '' }))
  })
  return { port: await listening(server), hits }
}

/** A real HTTPS server whose certificate covers the fixture names. */
async function serveHttps(): Promise<{ port: number, seen: Array<{ host?: string, servername?: string }> }> {
  const seen: Array<{ host?: string, servername?: string }> = []
  const server = createHttpsServer({ cert: TLS_CERT, key: TLS_KEY }, (req, res) => {
    seen.push({ host: req.headers.host, servername: (req.socket as { servername?: string }).servername })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('tls-ok')
  })
  return { port: await listening(server), seen }
}

/**
 * The "internal service" of a rebinding attack, observed at the TCP layer: a
 * socket that accepts the connection and counts it. Counting connections (not
 * HTTP requests) is what makes the fixture independent of TLS: a dial that
 * reaches this port is a dial that reached the internal address, whatever the
 * handshake does next.
 */
async function serveInternalTcp(): Promise<{ port: number, connections: number }> {
  const state = { port: 0, connections: 0 }
  const server = createTcpServer(socket => {
    state.connections++
    socket.destroy()
  })
  state.port = await listening(server)
  return state
}

describe('the verdict is the connection: a name cannot be re-pointed after the check', () => {
  it('dials the verified address and asks the resolver exactly once when the name rebinds to 127.0.0.1', async () => {
    const internal = await serveInternalTcp()
    const answers = [REBINDING_PUBLIC_ANSWER, REBINDING_INTERNAL_ANSWER]
    let resolved = 0
    const resolve = async (): Promise<readonly string[]> => {
      const answer = answers[Math.min(resolved, answers.length - 1)] as string
      resolved++
      return [answer]
    }

    // https, because the syntax rule only allows http for loopback names — the
    // shape a hostile endpoint really has to use.
    const error: unknown = await outboundFetch(
      `https://rebind.example.com:${internal.port}/mcp`,
      'MCP 端点',
      { method: 'GET' },
      { resolve, timeoutMs: 2_000 },
    ).then(() => undefined, (cause: unknown) => cause)

    expect(resolved, 'the policy resolves; the connection must not resolve again').toBe(1)
    expect(internal.connections, 'the internal address must never be dialed').toBe(0)
    // The dial went to the verified (unroutable) address, so the request failed
    // instead of quietly succeeding against the internal service.
    expect(error, 'a dial to the verified address cannot answer for the internal one').toBeInstanceOf(Error)
  })

  it('refuses to connect at all when nothing was verified (fail-closed, no resolver fallback)', async () => {
    const internal = await serveInternalTcp()
    const target: OutboundTarget = {
      url: new URL(`https://rebind.example.com:${internal.port}/mcp`),
      addresses: [],
    }
    await expect(sendPinned(target, { method: 'GET' })).rejects.toThrow(/no verified address/u)
    expect(internal.connections).toBe(0)
  })

  it('treats a resolver that cannot answer as a refusal, and dials nothing', async () => {
    const internal = await serveInternalTcp()
    const error: unknown = await outboundFetch(
      `https://rebind.example.com:${internal.port}/mcp`,
      'MCP 端点',
      { method: 'GET' },
      { resolve: async () => { throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }) } },
    ).then(() => undefined, (cause: unknown) => cause)
    // The typed "could not verify" refusal (C3-06), not a connection attempt:
    // an unverifiable name is never a pass, and the empty pin it would leave
    // behind is itself refused by the transport.
    expect(error).toBeInstanceOf(OutboundResolutionUnverifiedError)
    expect((error as OutboundResolutionUnverifiedError).code).toBe('resolution-failed')
    expect(internal.connections).toBe(0)
  })

  it('returns the verified addresses from the single decision point', async () => {
    const target = await resolveOutboundTarget('https://idp.example.com/token', 'OAuth token 端点', undefined, {
      resolve: async () => ['198.51.100.7', '198.51.100.8'],
    })
    expect(target.url.href).toBe('https://idp.example.com/token')
    expect(target.addresses).toEqual(['198.51.100.7', '198.51.100.8'])
  })

  it('pins localhost and *.localhost to loopback instead of resolving the reserved name', async () => {
    const server = await serveHttp()
    // `evil.localhost` is reserved for loopback by RFC 6761, but with
    // `hosts: files dns` the OS resolver may still answer it with anything —
    // including a metadata address. The pin makes the syntax verdict true.
    const response = await outboundFetch(`http://evil.localhost:${server.port}/mcp`, 'MCP 端点')
    expect(response.status).toBe(200)
    expect(server.hits).toEqual([`GET /mcp host=evil.localhost:${server.port}`])
  })
})

describe('the pinned transport is a real HTTP client (the allowed path stays healthy)', () => {
  it('performs a request to an allowed IP literal and returns a usable Response', async () => {
    const server = await serveHttp()
    const response = await outboundFetch(`http://127.0.0.1:${server.port}/mcp`, 'MCP 端点')
    expect(response.status).toBe(200)
    expect(response.url).toBe(`http://127.0.0.1:${server.port}/mcp`)
    await expect(response.json()).resolves.toEqual({ ok: true, host: `127.0.0.1:${server.port}` })
  })

  it('streams the body (the SSE shape the MCP transport reads) and honours an abort', async () => {
    const server = await serveHttp()
    const response = await outboundFetch(`http://127.0.0.1:${server.port}/event-stream`, 'MCP 端点', {
      headers: { accept: 'text/event-stream' },
    })
    const body = response.body
    expect(body, 'a streaming answer must keep its body').not.toBeNull()
    const reader = (body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done === true) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    expect(text).toBe('data: first\n\ndata: second\n\n')

    const controller = new AbortController()
    const pending = outboundFetch(`http://127.0.0.1:${server.port}/slow`, 'MCP 端点', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow()
  })

  it('negotiates and decodes a compressed answer (the transport advertises only what it decodes)', async () => {
    const compressed = createHttpServer((req, res) => {
      const encoding = req.headers['accept-encoding'] ?? ''
      const payload = Buffer.from(JSON.stringify({ ok: true, encoding }))
      if (String(encoding).includes('gzip')) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
        res.end(gzipSync(payload))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(payload)
    })
    const port = await listening(compressed)
    const response = await outboundFetch(`http://127.0.0.1:${port}/mcp`, 'MCP 端点')
    // The body arrives decoded, and the encoding headers go with it: a caller
    // must not be told the bytes are still gzipped.
    expect(response.headers.get('content-encoding')).toBeNull()
    await expect(response.json()).resolves.toEqual({ ok: true, encoding: 'gzip, deflate' })
  })

  it('keeps the NAME in the Host header and in TLS (SNI + certificate identity)', async () => {
    const server = await serveHttps()
    const target: OutboundTarget = {
      url: new URL(`https://pinned.example.com:${server.port}/mcp`),
      addresses: ['127.0.0.1'],
    }
    const response = await sendPinned(target, { method: 'GET' }, { tls: { ca: TLS_CERT } })
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('tls-ok')
    // The pinned address is where the bytes went; the NAME is what the server
    // saw — that is the difference between pinning and "connect to the IP".
    expect(server.seen).toEqual([{ host: `pinned.example.com:${server.port}`, servername: 'pinned.example.com' }])
  })

  it('verifies the certificate against the URL name (refusing a self-signed or mismatched one)', async () => {
    const server = await serveHttps()
    const target: OutboundTarget = {
      url: new URL(`https://pinned.example.com:${server.port}/mcp`),
      addresses: ['127.0.0.1'],
    }
    // No CA: the fixture certificate is self-signed, so verification must fail —
    // pinning must not have quietly disabled it.
    await expect(sendPinned(target, { method: 'GET' })).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    // With the CA but a name the certificate does not cover: the identity check
    // runs against the NAME, exactly like an ordinary HTTPS client.
    await expect(sendPinned(
      { url: new URL(`https://other.example.com:${server.port}/mcp`), addresses: ['127.0.0.1'] },
      { method: 'GET' },
      { tls: { ca: TLS_CERT } },
    )).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
  })

  it('does not follow a redirect: the checked URL is the only one that receives the request', async () => {
    const elsewhere = await serveHttp()
    const redirecting = createHttpServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${elsewhere.port}/mcp` })
      res.end()
    })
    const redirectPort = await listening(redirecting)
    // `outboundFetch` reports the 3xx as a policy refusal (residual C) — what
    // matters here is that the payload never travels to the `Location` target.
    await expect(outboundFetch(`http://127.0.0.1:${redirectPort}/mcp`, 'MCP 端点'))
      .rejects.toThrow(/重定向/u)
    expect(elsewhere.hits).toEqual([])
  })
})

describe('coverage: every connector outbound entry uses the pinned transport', () => {
  /**
   * A global fetch that records being used and refuses. Any outbound path still
   * built on it fails loudly instead of silently resolving the name again — the
   * marker is the criterion, so a path that is merely "still wired to fetch"
   * cannot pass.
   */
  function poisonGlobalFetch(): string[] {
    const used: string[] = []
    vi.stubGlobal('fetch', (input: unknown) => {
      used.push(String(input))
      throw new Error(`UNPINNED-TRANSPORT-USED ${String(input)}`)
    })
    return used
  }

  it('outboundFetch (OAuth discovery / token exchange / MCP probe) never touches the global fetch', async () => {
    const server = await serveHttp()
    const used = poisonGlobalFetch()
    const response = await outboundFetch(`http://127.0.0.1:${server.port}/mcp`, 'MCP 端点')
    expect(response.status).toBe(200)
    expect(used).toEqual([])
    expect(server.hits).toHaveLength(1)
  })

  it('the MCP streamable-http fence (no injected base = the production shape) never touches the global fetch', async () => {
    const server = await serveHttp()
    const used = poisonGlobalFetch()
    const fenced = createMcpOutboundFetch({
      ownUrl: () => `http://127.0.0.1:${server.port}/mcp`,
      locale: () => 'zh',
    })
    const response = await fenced(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    })
    expect(response.status).toBe(200)
    expect(used).toEqual([])
    expect(server.hits).toEqual([`POST /mcp host=127.0.0.1:${server.port}`])
    // Negative control: an injected base IS the transport's own choice, so the
    // criterion above is about the production shape, not about the stub being
    // unreachable.
    const injected = createMcpOutboundFetch({
      base: (input, init) => globalThis.fetch(input, init),
      ownUrl: () => `http://127.0.0.1:${server.port}/mcp`,
      locale: () => 'zh',
    })
    await expect(injected(`http://127.0.0.1:${server.port}/mcp`, { method: 'POST' }))
      .rejects.toThrow(/UNPINNED-TRANSPORT-USED/u)
  })

  it('a real streamable-http transport (the construction `hardenTransport` sees) reaches the server through the pin', async () => {
    const server = await serveHttp()
    // The production path: `installMcpTransportRedirectFence` hardens the SDK
    // class, and the transport is built WITHOUT a `fetch`, so the wrapper's own
    // transport is the only way out (`hardenTransport`'s default base).
    await ensureMcpTransportRedirectFence()
    const used = poisonGlobalFetch()
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: {} },
    })
    await transport.send({ jsonrpc: '2.0', method: 'ping', id: 1 } as never).catch(() => undefined)
    expect(server.hits.length, 'the request must really reach the endpoint').toBeGreaterThan(0)
    expect(used).toEqual([])
  })

  it('the OAuth provider refresh entry (SDK auth()) never touches the global fetch', async () => {
    const server: RealMcpServer = await startRealMcpServer()
    cleanups.push(() => server.close())
    const used = poisonGlobalFetch()
    const outcome = await refreshCredentialTokens(
      { accessToken: 'at-stale', refreshToken: 'rt-the-server-never-issued', clientId: 'example-client' },
      { discoveryUrl: `${server.origin}/mcp`, redirectUri: 'http://127.0.0.1/callback' },
      {},
    )
    // The token POST really went out through the pinned transport (the fake
    // authorization server saw the grant), and the flow failed on the grant
    // itself — never on a marker that only the poisoned global fetch produces.
    expect(server.stats.grants).toContain('refresh_token')
    expect(used).toEqual([])
    expect(JSON.stringify(outcome)).not.toContain('UNPINNED-TRANSPORT-USED')
  })

  /**
   * The entry the criteria above do NOT reach: `auth.ts`'s OAuth funnel.
   *
   * Every case before this one drives a FUNCTION that already sits next to the
   * transport (`outboundFetch`, the fence, `refreshCredentialTokens`). The six
   * outbound call sites INSIDE `auth.ts` — RFC 7591 registration, the MCP
   * probe, both metadata documents, the code exchange and the token POST — were
   * only ever "covered" by driving `outboundFetch` directly, so a change that
   * handed this one funnel back to `globalThis.fetch` (all gates still running,
   * redirects still refused, only the CONNECTION unpinned) left the whole
   * connectors suite green. This case drives the funnel itself against a real
   * authorization server.
   */
  it('runAuth drives the OAuth funnel (DCR + both metadata documents + authorize + token exchange) through the pin', async () => {
    const server: RealMcpServer = await startRealMcpServer()
    cleanups.push(() => server.close())
    // The flow's own "user's browser" leg is scaffolding, not a connector
    // outbound path: it keeps the REAL fetch, captured before the poison.
    const realFetch = globalThis.fetch
    const used = poisonGlobalFetch()
    const definition: ConnectorDef = {
      id: 'example-mcp',
      name: 'Example MCP',
      description: 'x',
      authMode: 'oauth',
      auth: {
        authorizeUrl: '',
        tokenUrl: '',
        // Empty ⇒ the flow performs RFC 7591 dynamic client registration.
        clientId: '',
        redirectUri: 'http://127.0.0.1/callback',
        pkce: true,
        publicClient: true,
        discoveryUrl: `${server.origin}/mcp`,
      },
      mcp: [{ serverName: 'example-mcp', transport: 'streamable-http', url: `${server.origin}/mcp` }],
    }
    const flow = runAuth(definition, {
      onRequest: (request) => {
        const authorizeUrl = request.authorizeUrl
        if (authorizeUrl === undefined) return
        void realFetch(authorizeUrl).catch(() => undefined)
      },
      signal: new AbortController().signal,
      outboundTimeoutMs: 8_000,
    })
    const credential = await flow
    // The whole chain really ran against the real authorization server: the
    // registration POST, the RFC 9728 probe, the code exchange and the PKCE
    // verifier all left the process. "Refuse everything" cannot pass this.
    expect(server.stats.registrations, 'dynamic client registration reached the server').toBeGreaterThan(0)
    expect(server.stats.metadataRequests, 'RFC 9728 resource metadata reached the server').toBeGreaterThan(0)
    expect(server.stats.grants, 'the token exchange reached the server').toContain('authorization_code')
    expect(String(credential.accessToken ?? '')).toMatch(/^at-/u)
    // ...and not one hop of it used the pre-fix transport.
    expect(used).toEqual([])
  })
})

describe('the route out of the process is decided here, not by the process', () => {
  /**
   * An agent shaped like the one a deployment's escape hatch installs: the
   * process-wide `http(s).globalAgent` under `NODE_USE_ENV_PROXY=1`. It dials
   * the local proxy listener whatever host the caller asked for, and it records
   * the host it was asked to reach — i.e. the NAME that a proxy would resolve
   * itself, instead of the address the policy verified.
   */
  function ambientProxyAgent(proxyPort: number, dialed: string[]): HttpAgent {
    const agent = new HttpAgent({ keepAlive: false })
    const connect = agent.createConnection.bind(agent)
    agent.createConnection = (options, callback) => {
      const asked = options as { host?: unknown, port?: unknown }
      dialed.push(`${String(asked.host)}:${String(asked.port)}`)
      return connect({ ...(options as object), host: '127.0.0.1', port: proxyPort } as never, callback)
    }
    return agent
  }

  it('never takes the process-wide agent route, so an ambient proxy cannot void the pin', async () => {
    const origin = await serveHttp()
    const proxyHits: string[] = []
    const proxy = createHttpServer((req, res) => {
      proxyHits.push(`${req.method ?? ''} ${req.url ?? ''}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"proxied":true}')
    })
    const proxyPort = await listening(proxy)
    const savedHttpAgent = nodeHttp.globalAgent
    const savedHttpsAgent = nodeHttps.globalAgent
    const httpDialed: string[] = []
    const httpsDialed: string[] = []
    const httpSpy = ambientProxyAgent(proxyPort, httpDialed)
    const httpsSpy = ambientProxyAgent(proxyPort, httpsDialed)
    nodeHttp.globalAgent = httpSpy
    nodeHttps.globalAgent = httpsSpy
    try {
      // The device bites: a request that does NOT name an agent is taken over by
      // the process-wide one, exactly as `NODE_USE_ENV_PROXY=1` arranges in
      // production (Node installs the env-proxy agent as the global one). This
      // control is what makes "the transport stayed direct" a measurement
      // instead of an assumption.
      await new Promise<void>((resolve, reject) => {
        const control = nodeHttp.request(
          { host: 'ambient.example', port: origin.port, path: '/control' },
          response => { response.resume(); response.on('end', () => { resolve() }) },
        )
        control.on('error', reject)
        control.end()
      })
      expect(httpDialed, 'the control really is taken over by the process-wide agent')
        .toEqual([`ambient.example:${origin.port}`])
      expect(proxyHits, 'the control really left through the proxy listener').toHaveLength(1)
      expect(origin.hits, 'the control never reached the origin').toEqual([])

      // The subject: the pinned transport must name its own agent, so the
      // process-wide one is never consulted and the verified address — not the
      // name — is what a socket is opened to.
      httpDialed.length = 0
      httpsDialed.length = 0
      proxyHits.length = 0
      const response = await outboundFetch(`http://127.0.0.1:${origin.port}/mcp`, 'MCP 端点')
      expect(response.status).toBe(200)
      await response.text()
      // Ordered so that a regression reports the ROUTE it took (the process-wide
      // agent, hence the proxy) and not merely the origin it missed.
      expect(httpDialed, 'the pinned request never consulted the process-wide agent').toEqual([])
      expect(httpsDialed).toEqual([])
      expect(proxyHits, 'the pinned request never left through the proxy route').toEqual([])
      expect(origin.hits).toEqual([`GET /mcp host=127.0.0.1:${origin.port}`])
    } finally {
      nodeHttp.globalAgent = savedHttpAgent
      nodeHttps.globalAgent = savedHttpsAgent
    }
  })
})
