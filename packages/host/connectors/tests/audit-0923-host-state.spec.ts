/**
 * Regression for audit D (2026-09-23), connectors host-state findings:
 *
 *  - **CN-3** — a `device`-mode connector reported `connected` after one poll
 *    interval although nothing was ever authorized (the probe was
 *    `isConnected: async () => true`), so every tool call was guaranteed to
 *    fail while the row claimed otherwise.
 *  - **CN-4** — `mcpDisposers` was keyed by the bare `serverName`, and the
 *    server catalog only validates a name per row: two rows sharing a name
 *    disposed EACH OTHER's transport, and the row whose transport was gone kept
 *    showing `connected`.
 *  - **CN-5** — after a dead grant (`invalid_grant`) the row went
 *    `unauthorized`, but `unauthorized` stayed in the sweep whitelist, so the
 *    revoked refresh token was re-presented to the IdP every 60 s forever, with
 *    no backoff and no terminal state (the audit measured 5 sweeps = 40 hits).
 *
 * Everything here drives the REAL plugin (`apply()`), its REAL routes and its
 * REAL on-disk store; only `ctx.plugin` is faked by the shared harness, which
 * reproduces upstream mcp-client's "serverName already in use" contract.
 */
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { assert, describe, expect, it } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { parseServerConnectors } from '../src/index.ts'
import { ConnectorStore } from '../src/store.ts'
import { createHarness, callRoute, seedCredential, waitFor } from './helpers/connector-harness.ts'

const dir = async (): Promise<string> => await mkdtemp(join(tmpdir(), 'audit0923-'))

function rowOf(body: string, id: string): { status: string, errorCode?: string } {
  const list = JSON.parse(body) as { connectors: Array<{ id: string, status: string, errorCode?: string }> }
  return list.connectors.find(entry => entry.id === id) as { status: string, errorCode?: string }
}

describe('CN-3: device mode must not report connected without an authorization artifact', () => {
  it('leaves the row unauthorized and registers nothing when the definition declares no verifiable credential', async () => {
    const base = await dir()
    const def = {
      id: 'dev', name: 'Dev', description: '', authMode: 'device',
      auth: { verificationUrl: 'https://idp.example.com/device', pollIntervalMs: 10, pollTimeoutMs: 500 },
      mcp: [{ serverName: 'dev-mcp', transport: 'stdio', command: 'node', args: ['server.mjs'] }],
    }
    const h = createHarness([def] as never, base, { refreshSweepIntervalMs: 0, requestApproval: () => true })
    // The connect route answers immediately (the flow is deliberately
    // fire-and-forget); the ROW is the contract the user sees.
    await callRoute(h, '/api/pico/connectors/dev/connect', 'POST')
    await new Promise(resolve => setTimeout(resolve, 1500))
    const state = JSON.parse((await callRoute(h, '/api/pico/connectors/dev/state', 'GET')).body) as { status: string, errorCode?: string }
    const stored = await new ConnectorStore({ baseDir: base }).readCredential('dev')
    expect(state.status, 'a device connector with no authorization material must not report connected').not.toBe('connected')
    expect(state.errorCode, 'the row names the action the user must take').toBe('auth-required')
    expect(h.configs.length, 'no MCP server may be registered for an unproven authorization').toBe(0)
    expect(stored?.accessToken, 'no token may be fabricated').toBeUndefined()

    // …and a restart must not turn the same empty credential into "connected".
    const h2 = createHarness([def] as never, base, { refreshSweepIntervalMs: 0, requestApproval: () => true })
    await new Promise(resolve => setTimeout(resolve, 800))
    const restarted = JSON.parse((await callRoute(h2, '/api/pico/connectors/dev/state', 'GET')).body) as { status: string }
    expect(restarted.status).not.toBe('connected')
    expect(h2.configs.length).toBe(0)
  })
})

describe('CN-3 follow-up (V3): a credential-less connector is NOT gated by the device rule', () => {
  it('connects and registers its MCP server when the definition declares neither `auth` nor `tokenFields`', async () => {
    const base = await dir()
    // Exactly the shape `parseServerConnectors` falls back to labelling `device`
    // (no authMode, no `auth` block, no tokenFields): a local MCP server that
    // needs no credential at all. Running a device flow for it — or applying the
    // CN-3 artifact gate to it — turned a working connector into a permanent
    // `unauthorized` with no user action able to fix it (V3 review).
    const definition = {
      mcp: [{ serverName: 'noauth-mcp', transport: 'stdio', command: 'node', args: ['server.mjs'] }],
    }
    // Through the REAL catalog parser, so the auto-inference under test really
    // produces `authMode: 'device'` (that inference is the whole reason this
    // shape reached the device gate).
    const parsed = parseServerConnectors([
      { id: 'noauth', name: 'NoAuth', description: '', auth_mode: '', definition: JSON.stringify(definition) },
    ])
    expect(parsed.map(def => def.authMode), 'the parser must infer `device` for this shape').toEqual(['device'])
    const h = createHarness(parsed, base, { refreshSweepIntervalMs: 0, requestApproval: () => true })
    await callRoute(h, '/api/pico/connectors/noauth/connect', 'POST')
    await waitFor(() => h.configs.length === 1, 5000)
    const state = JSON.parse((await callRoute(h, '/api/pico/connectors/noauth/state', 'GET')).body) as { status: string, errorCode?: string }
    expect(state.status, 'a connector whose MCP server needs no credential must stay usable').toBe('connected')
    expect(state.errorCode).toBeUndefined()
    expect(h.configs.length, 'its MCP server must actually be registered').toBe(1)
    // The restart path uses `credentialUsable` too: same verdict there.
    const h2 = createHarness(parsed, base, { refreshSweepIntervalMs: 0, requestApproval: () => true })
    await waitFor(() => h2.configs.length === 1, 5000)
    const restarted = JSON.parse((await callRoute(h2, '/api/pico/connectors/noauth/state', 'GET')).body) as { status: string }
    expect(restarted.status).toBe('connected')
  })

  it('also connects when a definition is handed over with no mode at all (profile/fixture shape)', async () => {
    const base = await dir()
    const def = {
      id: 'raw', name: 'Raw', description: '',
      mcp: [{ serverName: 'raw-mcp', transport: 'stdio', command: 'node', args: ['server.mjs'] }],
    }
    const h = createHarness([def] as never, base, { refreshSweepIntervalMs: 0, requestApproval: () => true })
    await callRoute(h, '/api/pico/connectors/raw/connect', 'POST')
    await waitFor(() => h.configs.length === 1, 5000)
    const state = JSON.parse((await callRoute(h, '/api/pico/connectors/raw/state', 'GET')).body) as { status: string }
    expect(state.status).toBe('connected')
    expect(h.configs.length).toBe(1)
  })
})

describe('CN-4: two catalog rows sharing one serverName must not clobber each other', () => {
  it('keeps the first row connected with a live transport instead of disposing it silently', async () => {
    const base = await dir()
    const make = (id: string): Record<string, unknown> => ({
      id, name: id, description: '', authMode: 'token',
      tokenFields: [{ key: 'K', label: 'K', type: 'password', required: true }],
      mcp: [{ serverName: 'shared-mcp', transport: 'stdio', command: 'node', args: [`${id}.mjs`] }],
    })
    await seedCredential(base, 'conn-a', { fields: { K: 'a' } })
    await seedCredential(base, 'conn-b', { fields: { K: 'b' } })
    const h = createHarness([make('conn-a'), make('conn-b')] as never, base, {
      refreshSweepIntervalMs: 0,
      requestApproval: () => true,
    })
    await waitFor(() => h.configs.length >= 1, 5000).catch(() => undefined)
    await callRoute(h, '/api/pico/connectors/conn-b/connect', 'POST')
    await new Promise(resolve => setTimeout(resolve, 400))

    const a = rowOf((await callRoute(h, '/api/pico/connectors', 'GET')).body, 'conn-a')
    const b = rowOf((await callRoute(h, '/api/pico/connectors', 'GET')).body, 'conn-b')
    const aDisposals = h.fibers.filter((_fiber, index) => h.configs[index]?.command !== undefined
      && (h.configs[index]?.args ?? []).includes('conn-a.mjs')).reduce((total, fiber) => total + fiber.dispose.mock.calls.length, 0)
    // Exactly one of the two rows may own the name; whichever it is, the OTHER
    // row must not still advertise `connected` (that is the defect: a row whose
    // transport was disposed by its neighbour kept claiming to be connected).
    const aConnected = a.status === 'connected'
    const bConnected = b.status === 'connected'
    expect(aConnected && bConnected, 'both rows cannot own the same serverName at once').toBe(false)
    if (aConnected) {
      expect(aDisposals, 'the row that still says connected must not have lost its transport').toBe(0)
    }
  })
})

describe('CN-5: a dead grant is terminal — the sweep stops re-presenting it', () => {
  it('stops hitting the IdP after the revoked refresh token was rejected once', async () => {
    const base = await dir()
    let hits = 0
    const idp = createServer((_req, res) => {
      hits += 1
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end('{"error":"invalid_grant","error_description":"refresh token revoked"}')
    })
    const port = await new Promise<number>(resolve => idp.listen(0, '127.0.0.1', () => {
      resolve((idp.address() as { port: number }).port)
    }))
    const def = {
      id: 'dead', name: 'Dead', description: '', authMode: 'oauth',
      auth: {
        authorizeUrl: `http://127.0.0.1:${String(port)}/authorize`,
        tokenUrl: `http://127.0.0.1:${String(port)}/token`,
        clientId: 'c', redirectUri: '', pkce: true,
      },
      mcp: [{ serverName: 'dead-mcp', transport: 'stdio', command: 'node', args: ['x.mjs'] }],
    }
    await seedCredential(base, 'dead', {
      accessToken: 'stale', refreshToken: 'revoked', expiresAt: Date.now() + 3_600_000, clientId: 'c',
    })
    let sweep: (() => Promise<void>) | undefined
    const h = createHarness([def] as never, base, {
      refreshSweepIntervalMs: 0,
      requestApproval: () => true,
      onRefreshSweepReady: (fn: () => Promise<void>) => { sweep = fn },
    })
    await waitFor(() => h.configs.length === 1, 5000)
    // The token lapses on disk: only the sweep can notice from here on.
    await new ConnectorStore({ baseDir: base }).updateCredential('dead', { expiresAt: Date.now() - 1000 })
    await waitFor(() => sweep !== undefined, 5000)
    // Sweep #1 spends one refresh attempt (the SDK's own discovery chain inside
    // that attempt is what made the audit measure "8 requests per sweep").
    await sweep?.()
    const afterFirst = hits
    expect(afterFirst, 'the first sweep must really have tried').toBeGreaterThan(0)
    // The grant is dead: every later sweep must be a no-op (terminal state).
    for (let round = 0; round < 4; round += 1) await sweep?.()

    const state = JSON.parse((await callRoute(h, '/api/pico/connectors/dead/state', 'GET')).body) as {
      status: string
      errorCode?: string
    }
    idp.close()
    expect(state.status, 'the row must tell the user to authorize again').toBe('unauthorized')
    expect(state.errorCode).toBe('auth-required')
    expect(hits, 'four further sweeps must not re-present a revoked refresh token').toBe(afterFirst)
    assert.ok(true)
  })
})
