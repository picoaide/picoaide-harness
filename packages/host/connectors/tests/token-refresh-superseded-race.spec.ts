/**
 * Regression guard for the registration-ordering race that defeated
 * `liveProviders` (found in the v2.7.4→HEAD audit, 2026-09-16).
 *
 * `mcpAuthProvider` used to install the provider handle itself, BEFORE
 * `registerMcp` reached its post-await `superseded()` check. A registration
 * that was superseded (the user pressed connect again while it was parked in
 * discovery; the connect route aborts the old flow) therefore still overwrote
 * the slot of the registration that HAD loaded a transport. The next
 * out-of-band refresh then fed the dead handle, the live transport kept the
 * consumed refresh token, and its next 401 hit `invalid_grant: refresh token
 * already used`.
 *
 * The case is deterministic: a loopback proxy holds the FIRST discovery
 * request (registration A), lets registration B complete, then releases A.
 * Without the ordering fix, A's late `liveProviders.set` wins and B never sees
 * the rotated token.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { callRoute, createHarness, waitFor, type Harness } from './helpers/connector-harness.ts'
import { completeAuthorization, startRealMcpServer, type RealMcpServer } from './helpers/real-mcp-oauth-server.ts'
import { ConnectorStore } from '../src/store.ts'
import type { ConnectorDef } from '../src/types.ts'

const servers: RealMcpServer[] = []
const proxies: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  while (proxies.length) await proxies.pop()?.close()
  while (servers.length) await servers.pop()?.close()
})

/** OAuth connector whose discovery + MCP endpoint go through the holding proxy. */
function raceDef(proxyOrigin: string, origin: string): ConnectorDef {
  return {
    id: 'moka', name: 'Moka', description: 'audit', authMode: 'oauth',
    auth: {
      authorizeUrl: `${origin}/oauth/authorize`, tokenUrl: `${origin}/oauth/token`, clientId: '',
      redirectUri: 'http://127.0.0.1/callback', pkce: true, publicClient: true,
      discoveryUrl: `${proxyOrigin}/mcp`, scopes: 'mcp.read offline_access',
    },
    mcp: [{ serverName: 'moka', transport: 'streamable-http', url: `${proxyOrigin}/mcp` }],
  }
}

/**
 * Forwarding proxy that holds the FIRST request until {@link HoldingProxy.release}.
 * Used to park registration A inside its discovery round trip while B runs.
 */
function startHoldingProxy(target: string, holdAt = 2): Promise<{
  origin: string
  arrived: Promise<void>
  release: () => Promise<void>
  close: () => Promise<void>
}> {
  // Request 1 is the pre-authorization MCP probe (`runAuth`); request 2 is the
  // registration's discovery round trip — that is the one to park.
  let requests = 0
  let held: { req: IncomingMessage, res: ServerResponse, body: Buffer } | undefined
  let markArrived!: () => void
  const arrived = new Promise<void>((resolve) => { markArrived = resolve })

  const forward = (req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> =>
    new Promise((resolve) => {
      const upstream = httpRequest(target + (req.url ?? '/'), {
        method: req.method,
        headers: { ...req.headers, host: new URL(target).host },
      }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
        up.on('end', () => { res.end(); resolve() })
      })
      upstream.on('error', () => { res.writeHead(502); res.end(); resolve() })
      if (body.length > 0) upstream.write(body)
      upstream.end()
    })

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      requests += 1
      if (requests === holdAt) {
        held = { req, res, body }
        markArrived()
        return
      }
      void forward(req, res, body)
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        arrived,
        async release() {
          const current = held
          if (current === undefined) return
          held = undefined
          await forward(current.req, current.res, current.body)
        },
        close: () => new Promise<void>((done) => {
          server.closeAllConnections()
          server.close(() => { done() })
        }),
      })
    })
  })
}

/** Poll the state route until a NEW authorize URL appears (or the flow stalls). */
async function waitForAuthorizeUrl(h: Harness, previous?: string): Promise<string> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const res = await callRoute(h, '/api/pico/connectors/moka/state', 'GET')
    const request = (JSON.parse(res.body) as { request?: { authorizeUrl?: string } | null }).request
    const url = request?.authorizeUrl
    if (typeof url === 'string' && url !== '' && url !== previous) return url
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('authorize URL never appeared')
}

describe('a superseded registration must not steal the live provider', () => {
  it('feeds the rotated token to the transport that actually loaded', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    // Fresh grants expire inside the refresh lead, so BOTH registrations take
    // the discovery path (the held request becomes A's parking spot).
    server.setTokenLifetime(5_000)
    const proxy = await startHoldingProxy(server.origin)
    proxies.push(proxy)
    const dir = mkdtempSync(join(tmpdir(), 'live-provider-superseded-'))
    const h = createHarness([raceDef(proxy.origin, server.origin)], dir, { refreshSweepIntervalMs: 0 })
    // Let an empty startup restore finish before the credential exists.
    await new Promise(resolve => setTimeout(resolve, 100))

    // Registration A: authorize, then park in the held discovery request.
    await callRoute(h, '/api/pico/connectors/moka/connect', 'POST')
    const firstUrl = await waitForAuthorizeUrl(h)
    await completeAuthorization(firstUrl)
    await proxy.arrived

    // Registration B: a second connect supersedes A's intent. Its discovery
    // request is forwarded immediately, so B loads a transport while A waits.
    await callRoute(h, '/api/pico/connectors/moka/connect', 'POST')
    await completeAuthorization(await waitForAuthorizeUrl(h, firstUrl))
    await waitFor(() => h.configs.length === 1, 15_000)

    // Release A: with the old ordering its late provider install overwrites
    // the live slot here.
    await proxy.release()
    await new Promise(resolve => setTimeout(resolve, 300))

    // An out-of-band refresh must reach the transport that is actually live.
    const refreshed = await callRoute(h, '/api/pico/connectors/moka/refresh', 'POST')
    expect(refreshed.status).toBe(200)
    const stored = await new ConnectorStore({ baseDir: dir }).readCredential('moka')
    const live = h.configs[0] as unknown as { authProvider?: { tokens: () => { refresh_token?: string } | undefined } }
    expect(live.authProvider?.tokens()?.refresh_token).toBe(stored?.refreshToken)
    expect(server.stats.revokedRefreshReuse).toBe(0)
    h.dispose()
  }, 60_000)
})
