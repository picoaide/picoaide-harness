/**
 * conn-1 (audit R7, P1): a connector outbound request had no deadline of its
 * own, so an endpoint that ACCEPTS the TCP connection and never answers held
 * the ONE serial lifecycle queue (`index.ts` `runLifecycle`) until undici's own
 * `headersTimeout` fired — measured at 300 798 ms. A logout / user switch
 * queued behind that request did not run for up to ~5 minutes, so the previous
 * user's MCP registrations stayed alive and every later operation stacked up.
 *
 * Two things are asserted here, both against REAL sockets:
 *
 * 1. `outboundFetch` itself carries a deadline, and a deadline breach is an
 *    error (the existing failure path), not a silent `null`;
 * 2. the plugin's logout teardown actually runs once the deadline fires —
 *    measured through the previously registered connector's `dispose` count,
 *    because a hung task's own state cannot tell "torn down" from "never ran"
 *    (the R7 methodology note).
 *
 * The production deadline is asserted to stay inside the agreed 15–30 s band;
 * the plugin-level case injects a short deadline through the documented
 * `outboundTimeoutMs` option so the regression does not cost 30 s per run.
 */
import { createServer, type Server, type Socket } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { runAuth } from '../src/auth.ts'
import { OUTBOUND_REQUEST_TIMEOUT_MS, outboundFetch } from '../src/outbound.ts'
import type { ConnectorDef } from '../src/types.ts'
import { createHarness, seedCredential, waitFor } from './helpers/connector-harness.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/** TCP server that accepts the connection and never writes a single byte. */
async function blackHole(): Promise<{ url: string }> {
  const sockets: Socket[] = []
  const server: Server = createServer(() => { /* never answer */ })
  server.on('connection', socket => sockets.push(socket))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { url: `http://127.0.0.1:${port}/mcp` }
}

function oauthDef(discoveryUrl: string): ConnectorDef {
  return {
    id: 'hangy',
    name: 'hangy',
    description: 'OAuth connector whose discovery endpoint never answers',
    authMode: 'oauth',
    auth: {
      discoveryUrl,
      authorizeUrl: 'https://auth.example/authorize',
      // No static token URL: `refreshOAuthToken` has to resolve the endpoint
      // through discovery, which is exactly where the black hole blocks.
      tokenUrl: '',
      registrationEndpoint: 'https://auth.example/register',
      clientId: 'c',
      redirectUri: '',
    },
    mcp: [{ serverName: 'hangy-server', transport: 'stdio', command: 'node', args: [] }],
  }
}

function goodDef(): ConnectorDef {
  return {
    id: 'good',
    name: 'good',
    description: 'connector that registers before the hang',
    authMode: 'token',
    mcp: [{ serverName: 'good-server', transport: 'stdio', command: 'node', args: [] }],
  }
}

describe('conn-1: the production outbound deadline stays inside the agreed band', () => {
  it('defaults to 15–30 s, far below the 300 s HTTP stack default', () => {
    console.log(`[conn-1] OUTBOUND_REQUEST_TIMEOUT_MS = ${OUTBOUND_REQUEST_TIMEOUT_MS}`)
    expect(OUTBOUND_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000)
    expect(OUTBOUND_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
  })
})

describe('conn-1: outboundFetch ends a black-hole request at its own deadline', () => {
  it('rejects with a deadline error instead of waiting for headersTimeout', async () => {
    const { url } = await blackHole()
    const started = Date.now()
    let outcome = ''
    try {
      await outboundFetch(url, 'MCP 端点', { headers: { Accept: 'application/json' } }, { timeoutMs: 300 })
      outcome = 'resolved'
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error)
    }
    const elapsed = Date.now() - started
    console.log(`[conn-1] black-hole settle: ${elapsed}ms / ${outcome}`)
    expect(outcome).not.toBe('resolved')
    expect(outcome).toMatch(/超时/)
    expect(outcome).toContain('MCP 端点')
    // "far earlier than 300 s" — the assertion the audit asked for.
    expect(elapsed).toBeLessThan(5_000)
  }, 20_000)

  it('reports a caller abort as an abort, not as a deadline breach', async () => {
    const { url } = await blackHole()
    const controller = new AbortController()
    controller.abort(new Error('用户取消'))
    let outcome = ''
    try {
      await outboundFetch(url, 'MCP 端点', { signal: controller.signal }, { timeoutMs: 5_000 })
      outcome = 'resolved'
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error)
    }
    console.log(`[conn-1] caller abort outcome: ${outcome}`)
    expect(outcome).not.toBe('resolved')
    expect(outcome).not.toMatch(/超时/)
  }, 20_000)
})

describe('conn-1: OAuth discovery honors the flow abort signal', () => {
  it('unwinds a hung discovery probe when the flow is aborted', async () => {
    const { url } = await blackHole()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('用户取消了连接')), 300)
    cleanups.push(() => clearTimeout(timer))
    const started = Date.now()
    let outcome = ''
    try {
      await runAuth(oauthDef(url), { onRequest: () => {}, signal: controller.signal })
      outcome = 'resolved'
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error)
    }
    const elapsed = Date.now() - started
    console.log(`[conn-1] discovery abort: ${elapsed}ms / ${outcome}`)
    expect(outcome).not.toBe('resolved')
    expect(elapsed).toBeLessThan(5_000)
  }, 20_000)
})

describe('conn-1: logout teardown runs once the hung restore hits its deadline', () => {
  it('disposes the previous registration far earlier than 300 s', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pico-conn1-'))
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
    const { url } = await blackHole()

    // 400 ms deadline: the shape under test is the deadline, not its value.
    const harness = createHarness([goodDef(), oauthDef(url)], dir, {
      outboundTimeoutMs: 400,
      requestApproval: () => true,
    })
    await seedCredential(dir, 'good', { accessToken: 'tok-good' })
    await seedCredential(dir, 'hangy', { refreshToken: 'refresh-hangy' })

    // Boot: `good` registers, then `hangy` blocks the queue inside discovery.
    harness.emitSession({ username: 'user-a' })
    await waitFor(() => harness.fibers.length === 1, 5_000)
    console.log(`[conn-1] registrations before logout: ${harness.fibers.length}`)

    // Logout: teardown is queued behind the hung restore.
    const started = Date.now()
    harness.emitSession(null)
    await waitFor(() => harness.fibers[0]!.dispose.mock.calls.length > 0, 8_000)
    const elapsed = Date.now() - started
    console.log(`[conn-1] teardown after logout: ${elapsed}ms (unbounded = ~300000ms)`)
    expect(elapsed).toBeLessThan(5_000)
    harness.dispose()
  }, 30_000)
})
