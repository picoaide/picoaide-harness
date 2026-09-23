/**
 * Regression for the R4-B audit (2026-09-23), findings **R4-B-8** and **R4-B-10**.
 *
 * The CN-5 fix made a dead grant (`invalid_grant` / `invalid_client`) terminal:
 * the marker in {@link ../src/index.ts} is keyed to the (account scope,
 * connector, credential generation) triple, so the 60 s sweep stops presenting
 * a revoked refresh token to the customer's IdP. Two holes were left:
 *
 *  - **R4-B-8**: the OTHER RFC 6749 §5.2 / RFC 8707 permanent rejections of the
 *    *request* (`invalid_scope`, `invalid_request`, `unsupported_grant_type`,
 *    `invalid_target`) were classified `transient`, so the sweep re-sent a
 *    request that can never succeed, forever.
 *  - **R4-B-10**: the panel's refresh button flipped the row without arming the
 *    marker, so when the button was the first surface to meet a revoked grant
 *    the next sweep presented the already-consumed refresh token one more time
 *    (audit probe: reuse 0→1→2, versus 1 for the sweep-detected control).
 *
 * What is real here: a real loopback token endpoint (a real HTTP server that
 * answers a chosen OAuth error), the plugin's own `apply()` entry point, its own
 * routes, and its own on-disk credential store. Only `ctx.plugin` is faked, the
 * same way the package's other host-state specs do it.
 *
 * Both halves of the 5xx contract are pinned: a 5xx stays `transient` **and**
 * the connector stays in the proactive refresh set (R4-B-10's second half — a
 * manual 5xx used to move the row to `error`, which the sweep whitelist did not
 * contain, so one network hiccup removed the connector from self-healing).
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { refreshCredentialTokens } from '../src/mcp-oauth-provider.ts'
import { ConnectorStore } from '../src/store.ts'
import { callRoute, createHarness, seedCredential, waitFor, type Harness } from './helpers/connector-harness.ts'
import type { ConnectorDef } from '../src/types.ts'

/** Token-endpoint answer the fake authorization server is currently serving. */
interface FakeAnswer {
  status: number
  body: Record<string, unknown>
}

interface FakeIdp {
  readonly base: string
  /** Every `/token` POST it has received, in order. */
  readonly tokenPosts: URLSearchParams[]
  setAnswer: (answer: FakeAnswer | null) => void
  close: () => void
}

/** A real loopback authorization server whose `/token` answers a chosen error. */
async function fakeIdp(): Promise<FakeIdp> {
  let answer: FakeAnswer | null = null
  const tokenPosts: URLSearchParams[] = []
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/token') && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
      req.on('end', () => {
        tokenPosts.push(new URLSearchParams(body))
        const next = answer ?? {
          status: 200,
          body: { access_token: 'at-new', refresh_token: 'rt-2', token_type: 'Bearer', expires_in: 3600 },
        }
        res.writeHead(next.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(next.body))
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not_found"}')
  })
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as { port: number }).port)
  }))
  return {
    base: `http://127.0.0.1:${String(port)}`,
    tokenPosts,
    setAnswer: (next) => { answer = next },
    close: () => { server.close() },
  }
}

/** Static-endpoint OAuth definition (no discovery round trip) with no MCP servers. */
function def(base: string): ConnectorDef {
  return {
    id: 'example-mcp',
    name: 'Example MCP',
    description: 'audit R4-B-8/10 regression',
    authMode: 'oauth',
    auth: {
      authorizeUrl: `${base}/authorize`,
      tokenUrl: `${base}/token`,
      clientId: 'c',
      redirectUri: 'http://127.0.0.1/callback',
      pkce: true,
    },
    mcp: [],
  }
}

/** The connector row as the panel sees it (the plugin's own list route). */
interface Row {
  status: string
  error?: string
  errorCode?: string
}

async function rowOf(h: Harness): Promise<Row> {
  const list = JSON.parse((await callRoute(h, '/api/pico/connectors', 'GET')).body) as { connectors: Row[] }
  return list.connectors[0] as Row
}

async function waitForRow(h: Harness, predicate: (row: Row) => boolean, timeoutMs = 15_000): Promise<Row> {
  const deadline = Date.now() + timeoutMs
  let last: Row | undefined
  while (Date.now() < deadline) {
    last = await rowOf(h)
    if (predicate(last)) return last
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`connector row never matched: ${JSON.stringify(last)}`)
}

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length > 0) cleanups.pop()?.() })

/** Boot the plugin against a fresh account directory; returns the sweep handle. */
function boot(dir: string, base: string): { harness: Harness, sweep: () => Promise<void> } {
  let sweepFn: (() => Promise<void>) | undefined
  const harness = createHarness([def(base)], dir, {
    refreshSweepIntervalMs: 0,
    onRefreshSweepReady: (fn: () => Promise<void>) => { sweepFn = fn },
  })
  if (sweepFn === undefined) throw new Error('the plugin must expose its sweep to the host')
  return { harness, sweep: sweepFn }
}

describe('R4-B-8: request-level permanent rejections are terminal, not transient', () => {
  it('classifies the RFC 6749 §5.2 / RFC 8707 request rejections as terminal', async () => {
    const idp = await fakeIdp()
    cleanups.push(idp.close)
    const target = { tokenUrl: `${idp.base}/token`, authorizeUrl: `${idp.base}/authorize` }
    const credential = { accessToken: 'at-old', refreshToken: 'rt-1', clientId: 'c', updatedAt: 0 }
    const seen: Array<{ code: string, reason: string, message: string }> = []
    for (const code of ['invalid_scope', 'invalid_request', 'unsupported_grant_type', 'invalid_target', 'invalid_grant', 'server_error']) {
      idp.setAnswer(code === 'server_error'
        ? { status: 503, body: { error: code } }
        : { status: 400, body: { error: code } })
      const outcome = await refreshCredentialTokens(credential, target)
      seen.push({ code, reason: outcome.ok ? 'ok' : outcome.reason, message: outcome.ok ? '' : outcome.message })
    }
    const reasonOf = (code: string): string | undefined => seen.find(row => row.code === code)?.reason
    // The four request-shape refusals: a retry re-sends the identical request.
    expect(reasonOf('invalid_scope')).toBe('terminal')
    expect(reasonOf('invalid_request')).toBe('terminal')
    expect(reasonOf('unsupported_grant_type')).toBe('terminal')
    expect(reasonOf('invalid_target')).toBe('terminal')
    // Unchanged neighbours of the taxonomy.
    expect(reasonOf('invalid_grant')).toBe('reauthorize')
    expect(reasonOf('server_error')).toBe('transient')
    // The terminal copy must name the code and must NOT promise that
    // re-authorizing fixes a request-shape refusal.
    const terminal = seen.find(row => row.code === 'invalid_scope')
    expect(terminal?.message).toContain('invalid_scope')
    expect(terminal?.message).not.toBe(seen.find(row => row.code === 'invalid_grant')?.message)
    expect(idp.tokenPosts.length).toBe(6)
  }, 30_000)

  it('stops the sweep after the first request-level refusal (no second request)', async () => {
    const idp = await fakeIdp()
    cleanups.push(idp.close)
    idp.setAnswer({ status: 400, body: { error: 'invalid_scope', error_description: 'probe' } })
    const dir = mkdtempSync(join(tmpdir(), 'r4b8-'))
    await seedCredential(dir, 'example-mcp', {
      accessToken: 'at-old', refreshToken: 'rt-1', clientId: 'c', expiresAt: Date.now() - 1_000,
    })
    const { harness, sweep } = boot(dir, idp.base)
    cleanups.push(() => { harness.dispose() })

    // The startup restore spends the first (and only) attempt.
    const row = await waitForRow(harness, entry => entry.status === 'unauthorized')
    expect(row.errorCode).toBe('auth-required')
    expect(row.error).toContain('invalid_scope')
    expect(idp.tokenPosts.length, 'the refusal must really have been served once').toBe(1)

    // Two further sweeps: same account, same credential generation, same doomed
    // request — the terminal state must hold.
    await sweep()
    await sweep()
    expect(idp.tokenPosts.length, 'a terminal refusal must not be re-presented').toBe(1)
    // The credential is untouched, so this is the marker stopping the retry and
    // not "the refresher decided there was nothing to do".
    const stored = await new ConnectorStore({ baseDir: dir }).readCredential('example-mcp')
    expect(stored?.refreshToken).toBe('rt-1')
    expect(stored?.accessToken).toBe('at-old')
  }, 30_000)

  it('control: a 5xx stays retryable and the row stays in the proactive refresh set', async () => {
    const idp = await fakeIdp()
    cleanups.push(idp.close)
    idp.setAnswer({ status: 503, body: { error: 'temporarily_unavailable' } })
    const dir = mkdtempSync(join(tmpdir(), 'r4b8-5xx-'))
    await seedCredential(dir, 'example-mcp', {
      accessToken: 'at-old', refreshToken: 'rt-1', clientId: 'c', expiresAt: Date.now() - 1_000,
    })
    const { harness, sweep } = boot(dir, idp.base)
    cleanups.push(() => { harness.dispose() })

    // The row reaching `connected` is what proves the startup restore finished
    // its attempt (the POST alone does not: it lands before the state write).
    await waitForRow(harness, entry => entry.status === 'connected')
    const afterRestore = idp.tokenPosts.length
    expect(afterRestore, 'the 5xx must really have been served once').toBeGreaterThan(0)
    await sweep()
    await sweep()
    expect(
      idp.tokenPosts.length,
      'a 5xx means "retry with the same credential": the sweep must keep trying',
    ).toBeGreaterThan(afterRestore)
  }, 30_000)
})

describe('R4-B-10: the panel refresh button arms the same terminal state as the sweep', () => {
  it('a manual dead grant stops the next sweep from re-presenting the consumed token', async () => {
    const idp = await fakeIdp()
    cleanups.push(idp.close)
    const dir = mkdtempSync(join(tmpdir(), 'r4b10-'))
    // A healthy credential: boot registers without touching the IdP, so the
    // manual button is the FIRST surface to meet the revoked grant.
    await seedCredential(dir, 'example-mcp', {
      accessToken: 'at-old', refreshToken: 'rt-1', clientId: 'c', expiresAt: Date.now() + 3_600_000,
    })
    const { harness, sweep } = boot(dir, idp.base)
    cleanups.push(() => { harness.dispose() })
    await waitForRow(harness, entry => entry.status === 'connected')
    expect(idp.tokenPosts.length, 'a healthy credential needs no IdP round trip at boot').toBe(0)

    // The grant is revoked out of band, and the access token lapses.
    idp.setAnswer({ status: 400, body: { error: 'invalid_grant', error_description: 'refresh token already used' } })
    await new ConnectorStore({ baseDir: dir }).updateCredential('example-mcp', { expiresAt: Date.now() - 1_000 })

    const manual = await callRoute(harness, '/api/pico/connectors/example-mcp/refresh', 'POST')
    expect(manual.status).toBe(409)
    expect((JSON.parse(manual.body) as { reason?: string }).reason).toBe('reauthorize')
    const afterManual = idp.tokenPosts.length
    expect(afterManual, 'the button really did present the credential once').toBe(1)
    expect((await rowOf(harness)).status).toBe('unauthorized')

    // Pre-fix this added one more presentation of the already-used token.
    await sweep()
    await sweep()
    expect(
      idp.tokenPosts.length,
      'a dead grant detected by the button must arm the same terminal state as the sweep',
    ).toBe(afterManual)
  }, 30_000)

  it('a manual 5xx keeps the connector in the proactive refresh set', async () => {
    const idp = await fakeIdp()
    cleanups.push(idp.close)
    const dir = mkdtempSync(join(tmpdir(), 'r4b10-5xx-'))
    await seedCredential(dir, 'example-mcp', {
      accessToken: 'at-old', refreshToken: 'rt-1', clientId: 'c', expiresAt: Date.now() + 3_600_000,
    })
    const { harness, sweep } = boot(dir, idp.base)
    cleanups.push(() => { harness.dispose() })
    await waitForRow(harness, entry => entry.status === 'connected')

    idp.setAnswer({ status: 503, body: { error: 'temporarily_unavailable' } })
    const manual = await callRoute(harness, '/api/pico/connectors/example-mcp/refresh', 'POST')
    expect(manual.status).toBe(409)
    expect((JSON.parse(manual.body) as { reason?: string }).reason).toBe('transient')
    const row = await rowOf(harness)
    expect(row.status).toBe('error')

    // The row is `error` and its token lapsed: the sweep must still try.
    await new ConnectorStore({ baseDir: dir }).updateCredential('example-mcp', { expiresAt: Date.now() - 1_000 })
    const before = idp.tokenPosts.length
    await sweep()
    expect(
      idp.tokenPosts.length,
      'a transient manual failure must not remove the row from the proactive refresh set',
    ).toBeGreaterThan(before)
  }, 30_000)
})
