/**
 * Regression for the R3-B2 audit (2026-09-23), finding **R3B2-2**.
 *
 * `deadGrants` records a per-ACCOUNT fact — one credential generation
 * (`updatedAt`) whose grant the authorization server revoked with
 * `invalid_grant` — but it used to be keyed by connector id ALONE, and
 * `teardownAll()` (documented as "reset in-memory state" on a user switch) did
 * not clear it. Account B therefore inherited account A's revocation whenever
 * B's credential file happened to carry the same generation marker, which is
 * exactly what a provisioned/copied credential file looks like: the row said
 * 「需要重新授权」 without a single network round trip and B's MCP servers were
 * never registered, although B's token was perfectly usable.
 *
 * Both cases below drive the REAL plugin (`apply()`), its REAL routes and its
 * REAL credential store. `storeBaseDir` is deliberately left undefined so the
 * plugin resolves the product's own account scope
 * (`<DSH_HOME>/users/<encoded-user>/servers/<server-scope>/connectors`,
 * `./user-scope.ts`): that per-account directory is what makes "account A" and
 * "account B" two different credential files, and therefore what makes the
 * cross-account case meaningful at all. These cases emit sessions WITHOUT a
 * server address, so the scope is the `servers/unscoped` one — the SERVER
 * dimension of the same scope is covered by
 * `tests/audit-0924-credential-server-scope.spec.ts`.
 *
 * Only `ctx.plugin` is faked (the shared harness reproduces upstream
 * mcp-client's "serverName already in use" contract), exactly like the package's
 * other host-state specs. Folder names/id stay generic placeholders.
 */
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { assert, describe, expect, it } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { ConnectorStore } from '../src/store.ts'
import { callRoute, createHarness, scopeDir, seedCredential } from './helpers/connector-harness.ts'
import type { Harness } from './helpers/connector-harness.ts'

/**
 * The generation marker BOTH accounts' credential files carry. Pinned instead
 * of pretended: a real collision needs a provisioned/copied credential file
 * (`updatedAt` is a plain field of the JSON), and the point of this case is the
 * KEY the marker is stored under, not how the two markers got equal.
 */
const GENERATION = 1_700_000_000_000
/** Distinguishes account B's credential mirror on the row from account A's. */
const B_REFRESHED_AT = 1_700_000_000_123

interface Row {
  id: string
  status: string
  errorCode?: string
  refreshedAt?: number | null
}

/** The store directory of one account (the resolution the plugin itself uses). */
const storeDirOf = (username: string): string => scopeDir(username)

async function rowOf(h: Harness, id: string): Promise<Row> {
  const list = JSON.parse((await callRoute(h, '/api/pico/connectors', 'GET')).body) as { connectors: Row[] }
  return list.connectors.find(entry => entry.id === id) as Row
}

/**
 * Poll the row through the plugin's own list route.
 *
 * A local helper on purpose: the shared `waitFor()` takes a SYNCHRONOUS
 * predicate, and everything this case observes lives behind an HTTP route.
 */
async function waitForRow(
  h: Harness,
  id: string,
  predicate: (row: Row) => boolean,
  timeoutMs = 15_000,
): Promise<Row> {
  const deadline = Date.now() + timeoutMs
  let last: Row | undefined
  while (Date.now() < deadline) {
    last = await rowOf(h, id)
    if (predicate(last)) return last
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`connector ${id} row never matched: ${JSON.stringify(last)}`)
}

interface DeadIdp {
  readonly base: string
  /** Requests the IdP has answered so far (every one of them `invalid_grant`). */
  readonly hits: () => number
  readonly close: () => void
}

/** A token endpoint that answers every request the way a revoked grant does. */
async function deadIdp(): Promise<DeadIdp> {
  let hits = 0
  const server = createServer((_req, res) => {
    hits += 1
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end('{"error":"invalid_grant","error_description":"refresh token revoked"}')
  })
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as { port: number }).port)
  }))
  return {
    base: `http://127.0.0.1:${String(port)}`,
    hits: () => hits,
    close: () => server.close(),
  }
}

const defFor = (base: string): unknown => ({
  id: 'dead',
  name: 'Dead',
  description: '',
  authMode: 'oauth',
  auth: {
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    clientId: 'c',
    redirectUri: '',
    pkce: true,
  },
  mcp: [{ serverName: 'dead-mcp', transport: 'stdio', command: 'node', args: ['x.mjs'] }],
})

/** One account's credential file, with the generation marker pinned. */
async function seedAccount(
  username: string,
  fields: { accessToken: string, refreshToken: string, expiresAt: number, refreshedAt?: number },
): Promise<void> {
  await seedCredential(storeDirOf(username), 'dead', { ...fields, clientId: 'c', updatedAt: GENERATION })
}

/** Read the credential back from disk (the collision precondition is asserted on THESE). */
async function readBack(username: string): Promise<{ updatedAt: number }> {
  const credential = await new ConnectorStore({ username }).readCredential('dead')
  if (credential === null) throw new Error(`no credential stored for ${username}`)
  return { updatedAt: credential.updatedAt }
}

/**
 * Boot the plugin for account A whose stored grant is ALREADY revoked (its token
 * is lapsed, so the startup restore must spend one refresh attempt — that is the
 * request which records the dead grant, through the real code path).
 */
async function bootWithRevokedAccountA(): Promise<{
  idp: DeadIdp
  harness: Harness
  restoreHome: () => void
}> {
  const home = await mkdtemp(join(tmpdir(), 'r3b2-2-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const restoreHome = (): void => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }

  const idp = await deadIdp()
  const def = defFor(idp.base)
  // A: lapsed token ⇒ the restore refreshes ⇒ 400 invalid_grant ⇒ dead grant.
  await seedAccount('user-a', { accessToken: 'a-token', refreshToken: 'a-revoked', expiresAt: Date.now() - 1000 })
  // B: a healthy credential file carrying the SAME generation marker.
  await seedAccount('user-b', {
    accessToken: 'b-token',
    refreshToken: 'b-refresh',
    expiresAt: Date.now() + 3_600_000,
    refreshedAt: B_REFRESHED_AT,
  })

  // `storeBaseDir: undefined` = keep the product's per-account resolution.
  const harness = createHarness([def] as never, home, {
    storeBaseDir: undefined,
    refreshSweepIntervalMs: 0,
    requestApproval: () => true,
  })
  return { idp, harness, restoreHome }
}

describe('R3B2-2: a dead grant belongs to ONE ACCOUNT, not to the connector', () => {
  it('does not carry account A\'s revoked grant over to a healthy account B', async () => {
    const { idp, harness, restoreHome } = await bootWithRevokedAccountA()
    try {
      // --- account A: the revoked grant is detected and stays terminal --------
      const aRow = await waitForRow(harness, 'dead', row => row.status === 'unauthorized')
      const hitsAfterA = idp.hits()
      expect(hitsAfterA, 'the revoked refresh token must really have been presented once').toBeGreaterThan(0)
      expect(aRow.errorCode).toBe('auth-required')
      expect(harness.configs, 'a dead grant must not register MCP servers').toHaveLength(0)

      // The collision precondition: both accounts' files carry one generation.
      // Without it the cross-account case would prove nothing.
      const [aCredential, bCredential] = [await readBack('user-a'), await readBack('user-b')]
      expect(aCredential.updatedAt, 'the case needs equal generation markers').toBe(GENERATION)
      expect(bCredential.updatedAt, 'the case needs equal generation markers').toBe(GENERATION)

      // --- account B: SAME connector, SAME generation marker, healthy token --
      harness.emitSession({ username: 'user-b' })
      // B's own credential mirror reaches the row only through `restoreAll`
      // reading B's file, so waiting for it proves the transition really ran
      // before the verdict is asserted (and keeps the pre-fix failure precise).
      const bRow = await waitForRow(
        harness,
        'dead',
        row => row.refreshedAt === B_REFRESHED_AT && row.status !== 'disconnected',
      )
      expect(bRow.status, 'B has a usable credential and must connect').toBe('connected')
      expect(bRow.errorCode, 'B must not be told to authorize again').toBeUndefined()
      expect(
        harness.configs.map(config => config.serverName),
        'B\'s MCP servers must be registered',
      ).toEqual(['dead-mcp'])
      // B's credential still had 3600 s of life: the healthy path needs no IdP.
      expect(idp.hits(), 'B must not have been probed at the dead IdP').toBe(hitsAfterA)

      // --- back to A: the marker is still A's (it was scoped, not cleared) ---
      harness.emitSession({ username: 'user-a' })
      const aAgain = await waitForRow(harness, 'dead', row => row.status === 'unauthorized')
      expect(aAgain.errorCode).toBe('auth-required')
      expect(idp.hits(), 'A must be refused locally, without re-presenting the revoked token').toBe(hitsAfterA)
      assert.ok(true)
    } finally {
      idp.close()
      restoreHome()
    }
  })

  it('still judges the same account + same connector + same generation as a dead grant', async () => {
    const { idp, harness, restoreHome } = await bootWithRevokedAccountA()
    try {
      await waitForRow(harness, 'dead', row => row.status === 'unauthorized')
      const hitsAfterFirstDetection = idp.hits()
      expect(hitsAfterFirstDetection).toBeGreaterThan(0)

      // Rewrite A's OWN credential: a new `refreshedAt` mirror under the SAME
      // generation (the value the dead-grant marker keys on), token still
      // lapsed. The marker can only reach the row through a fresh `restoreAll`
      // read of this file, which is the positive control for this case.
      const A_MIRROR = 1_700_000_000_456
      await seedAccount('user-a', {
        accessToken: 'a-token',
        refreshToken: 'a-revoked',
        expiresAt: Date.now() - 1000,
        refreshedAt: A_MIRROR,
      })

      // The same account re-enters (log out + log back in; the superseded
      // logged-out task is deliberately not awaited — the newest transition
      // carries the full desired state).
      harness.emitSession(null)
      harness.emitSession({ username: 'user-a' })

      const row = await waitForRow(harness, 'dead', entry => entry.refreshedAt === A_MIRROR)
      expect(row.status, 'the row must still demand a fresh authorization').toBe('unauthorized')
      expect(row.errorCode).toBe('auth-required')
      expect(harness.configs, 'a known-dead credential must never register').toHaveLength(0)
      expect(
        idp.hits(),
        'the same generation must not be re-presented to the IdP after a session round trip',
      ).toBe(hitsAfterFirstDetection)
      assert.ok(true)
    } finally {
      idp.close()
      restoreHome()
    }
  })
})
