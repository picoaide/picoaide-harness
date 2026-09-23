/**
 * Regression for the R6-B-2 audit (2026-09-23), finding **connector credentials
 * had an ACCOUNT dimension but no SERVER dimension**.
 *
 * Threat model (real, not hypothetical): one account exists on two deployments
 * — this repo's own topology runs a test and a production deployment, plus two
 * channel stacks on one host — and `/login` re-points the client at another
 * address without leaving the app. `ConnectorStore` used to resolve
 * `<DSH_HOME>/users/<user>/connectors` for BOTH, so after the switch
 * `restoreAll()` read the previous tenant's credential for the same connector
 * id and handed it to the new tenant's endpoint:
 *   - a manual-token connector's `fields` (the plaintext secret) went into the
 *     new endpoint's headers / child env;
 *   - an OAuth connector's access/refresh token was presented to the new
 *     endpoint too — the SDK's `issuer` stamp only helps when the two tenants'
 *     authorization servers DIFFER (it does nothing for a shared IdP, and
 *     `fields` carry no issuer at all).
 *
 * The fix scopes credentials (and the local-approval ledger) by
 * (account, server) — `./user-scope.ts` — and makes the pre-upgrade, unscoped
 * files FAIL CLOSED: they are never adopted, the connector reports "needs a
 * fresh authorization", and the bytes stay on disk.
 *
 * Cases below run the REAL plugin (`apply()`), its REAL routes and its REAL
 * store resolution. Waits are always on a signal that only the NEW scope can
 * produce (a config for an id only that scope has a credential for, or the
 * second scope's own `expiresAt`): a session change clears the rows and runs
 * asynchronously, so "the row is not connected" alone would match the PREVIOUS
 * tenant's leftover row and prove nothing.
 *
 * Folder names / ids stay generic placeholders.
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { ConnectorStore } from '../src/store.ts'
import { serverScopeHash } from '../src/user-scope.ts'
import {
  callRoute,
  createHarness,
  legacyScopeDir,
  scopeDir,
  seedCredential,
  waitFor,
  type Harness,
} from './helpers/connector-harness.ts'
import type { ConnectorDef } from '../src/types.ts'

const SERVER_A = 'https://harness-a.example.com'
const SERVER_B = 'https://harness-b.example.com'
/** The account that exists on BOTH deployments. */
const USER = 'user-a'
/** Same generation marker on both scopes: a provisioned/copied credential file. */
const GENERATION = 1_700_000_000_000
/** B's own token lifetime — the row carries it only after B's restore read B's file. */
const B_EXPIRES_AT = Date.now() + 3_600_000

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
  vi.unstubAllEnvs()
})

/**
 * A fresh DSH home for one case, with `DSH_HOME` already pointing at it.
 *
 * The stub must be in place BEFORE anything resolves a scope: `scopeDir()`
 * (what a case seeds) and the plugin (what reads) both resolve through
 * `process.env`, and a seed that lands in the ambient home while the plugin
 * reads the temp one would turn the case into a no-op.
 */
async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'r6b2-scope-'))
  vi.stubEnv('DSH_HOME', home)
  cleanups.push(async () => { await rm(home, { recursive: true, force: true }) })
  return home
}

/** A manual-token + stdio connector: its `fields` value is the secret to leak. */
function tokenDef(id = 'example-mcp'): ConnectorDef {
  return {
    id,
    name: 'Example',
    description: '',
    authMode: 'token',
    tokenFields: [{ key: 'API_KEY', label: 'API key' }],
    mcp: [{ serverName: `${id}-srv`, transport: 'stdio', command: 'node', args: ['x.mjs'] }],
  } as unknown as ConnectorDef
}

/**
 * The catalog's credential-less shape (V3 review): `device` with no declared
 * device-code authorization and no token fields — a local MCP server that
 * authorizes nothing.
 */
function credentiallessDef(id = 'local-mcp'): ConnectorDef {
  return {
    id,
    name: 'Local',
    description: '',
    authMode: 'device',
    mcp: [{ serverName: `${id}-srv`, transport: 'stdio', command: 'node', args: ['x.mjs'] }],
  } as unknown as ConnectorDef
}

/** A token endpoint that answers every request the way a revoked grant does. */
async function deadIdp(): Promise<{ base: string; hits: () => number }> {
  let hits = 0
  const server = createServer((_req, res) => {
    hits += 1
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end('{"error":"invalid_grant","error_description":"refresh token revoked"}')
  })
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as { port: number }).port)
  }))
  cleanups.push(async () => { server.close() })
  return { base: `http://127.0.0.1:${String(port)}`, hits: () => hits }
}

interface Row {
  id: string
  status: string
  error?: string
  errorCode?: string
  expiresAt?: number
}

async function rowOf(h: Harness, id: string): Promise<Row> {
  const list = JSON.parse((await callRoute(h, '/api/pico/connectors', 'GET')).body) as { connectors: Row[] }
  return list.connectors.find(entry => entry.id === id) as Row
}

async function waitForRow(h: Harness, id: string, predicate: (row: Row) => boolean, timeoutMs = 15_000): Promise<Row> {
  const deadline = Date.now() + timeoutMs
  let last: Row | undefined
  while (Date.now() < deadline) {
    last = await rowOf(h, id)
    if (predicate(last)) return last
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`connector ${id} row never matched: ${JSON.stringify(last)}`)
}

/** The child env the plugin handed one stdio server (the leak's carrier). */
const apiKeyOf = (h: Harness, serverName: string): string | undefined =>
  h.configs.find(config => config.serverName === serverName)?.env?.API_KEY

/** Boot the real plugin with the product's own (account, server) scope resolution. */
async function boot(home: string, defs: ConnectorDef[]): Promise<Harness> {
  const harness = createHarness(defs, home, { storeBaseDir: undefined, refreshSweepIntervalMs: 0, requestApproval: () => true })
  cleanups.push(async () => { harness.dispose() })
  return harness
}

describe('R6-B-2 (i): credentials are scoped per (account, server)', () => {
  it('two servers of one account resolve to different directories that cannot read each other', async () => {
    const home = await tempHome()
    void home
    const onA = new ConnectorStore({ username: 'alice', serverURL: SERVER_A })
    const onB = new ConnectorStore({ username: 'alice', serverURL: SERVER_B })

    expect(onA.dir).not.toBe(onB.dir)
    await onA.writeCredential('example-mcp', { fields: { API_KEY: 'TENANT-A-SECRET' }, updatedAt: GENERATION })

    // B is a different tenant: A's secret is not reachable from it at all.
    expect(await onB.readCredential('example-mcp')).toBeNull()
    expect(await onB.credentialIds()).toEqual([])
    // A still reads its own.
    expect((await onA.readCredential('example-mcp'))?.fields).toEqual({ API_KEY: 'TENANT-A-SECRET' })
    // The scope segment is the SHARED server hash, not a second digest.
    expect(onA.dir).toContain(serverScopeHash(SERVER_A)!)
    expect(onA.dir).toContain(join('users', 'alice', 'servers'))
  })

  it('strips trailing slashes and whitespace so one server keeps ONE scope', async () => {
    await tempHome()
    const plain = new ConnectorStore({ username: 'alice', serverURL: SERVER_A }).dir
    expect(new ConnectorStore({ username: 'alice', serverURL: `${SERVER_A}/` }).dir).toBe(plain)
    expect(new ConnectorStore({ username: 'alice', serverURL: `  ${SERVER_A}//  ` }).dir).toBe(plain)
    // No address at all is its own scope — never the legacy directory.
    const unscoped = new ConnectorStore({ username: 'alice' }).dir
    expect(unscoped).not.toBe(plain)
    expect(unscoped).toContain('unscoped')
    expect(unscoped).not.toBe(legacyScopeDir('alice'))
  })

  it('the running plugin never injects tenant A\'s secret into tenant B\'s endpoint', async () => {
    const home = await tempHome()
    // A is connected on the first deployment and holds a secret for
    // `example-mcp`. B is the OTHER deployment: it has no credential for that
    // id, but it does have one for `b-only`, which is what proves B's restore
    // really ran (see the waits below).
    await seedCredential(scopeDir(USER, SERVER_A), 'example-mcp', {
      fields: { API_KEY: 'TENANT-A-SECRET' },
      updatedAt: GENERATION,
    })
    await seedCredential(scopeDir(USER, SERVER_B), 'b-only', {
      fields: { API_KEY: 'TENANT-B-ONLY' },
      updatedAt: GENERATION,
    })
    const harness = await boot(home, [tokenDef('example-mcp'), tokenDef('b-only')])

    harness.emitSession({ username: USER, serverURL: SERVER_A })
    await waitFor(() => harness.configs.length === 1)
    expect(apiKeyOf(harness, 'example-mcp-srv')).toBe('TENANT-A-SECRET')

    // Same account, other deployment. `b-only` is the SECOND def, so its
    // registration proves the loop already walked past `example-mcp`.
    harness.emitSession({ username: USER, serverURL: SERVER_B })
    await waitFor(() => harness.configs.some(config => config.serverName === 'b-only-srv'))
    expect(
      harness.configs.map(config => config.serverName).sort(),
      'the other tenant\'s same-id connector must not register with A\'s secret',
    ).toEqual(['b-only-srv', 'example-mcp-srv'])
    expect((await rowOf(harness, 'example-mcp')).status).toBe('disconnected')

    // A session with NO server address is its own scope as well: still nothing.
    harness.emitSession({ username: USER })
    await waitForRow(harness, 'example-mcp', row => row.status === 'disconnected')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(harness.configs.map(config => config.serverName).sort()).toEqual(['b-only-srv', 'example-mcp-srv'])
  })

  it('each server reads its OWN credential for the same connector id', async () => {
    const home = await tempHome()
    await seedCredential(scopeDir(USER, SERVER_A), 'example-mcp', {
      fields: { API_KEY: 'TENANT-A-SECRET' },
      updatedAt: GENERATION,
    })
    await seedCredential(scopeDir(USER, SERVER_B), 'example-mcp', {
      fields: { API_KEY: 'TENANT-B-SECRET' },
      updatedAt: GENERATION,
    })
    const harness = await boot(home, [tokenDef()])

    harness.emitSession({ username: USER, serverURL: SERVER_A })
    await waitFor(() => harness.configs.length === 1)
    expect(apiKeyOf(harness, 'example-mcp-srv')).toBe('TENANT-A-SECRET')

    harness.emitSession({ username: USER, serverURL: SERVER_B })
    await waitFor(() => harness.configs.length === 2)
    // The registration that just happened is the SECOND one and it must carry
    // B's own credential, never A's.
    expect(harness.configs.at(-1)?.env?.API_KEY).toBe('TENANT-B-SECRET')
    expect(apiKeyOf(harness, 'example-mcp-srv'), 'the FIRST registration still carries A\'s own').toBe('TENANT-A-SECRET')
  })
})

describe('R6-B-2 (ii): unscoped (pre-upgrade) credentials fail closed', () => {
  it('are never adopted, are reported as "authorize again", and stay on disk byte-for-byte', async () => {
    const home = await tempHome()
    // What an upgraded install looks like: the old file is in the legacy dir.
    const legacy = legacyScopeDir(USER)
    await seedCredential(legacy, 'example-mcp', {
      fields: { API_KEY: 'TENANT-UNKNOWN-SECRET' },
      updatedAt: GENERATION,
    })
    const file = join(legacy, 'example-mcp.json')
    const before = createHash('sha256').update(await readFile(file)).digest('hex')

    const harness = await boot(home, [tokenDef()])
    harness.emitSession({ username: USER, serverURL: SERVER_A })

    const row = await waitForRow(harness, 'example-mcp', entry => entry.status === 'unauthorized')
    expect(row.errorCode, 'the row must say "authorization required"').toBe('auth-required')
    expect(row.error, 'and say WHY, in the host locale').toContain('重新授权')
    expect(harness.configs, 'an unattributable secret must never reach an endpoint').toHaveLength(0)
    // Fail-closed for the ROW, but non-destructive for the USER's data.
    expect(existsSync(file), 'the old credential file must not be deleted').toBe(true)
    const after = createHash('sha256').update(await readFile(file)).digest('hex')
    expect(after).toBe(before)
    // The live scope holds nothing (the file was not copied into it either).
    expect(await new ConnectorStore({ username: USER, serverURL: SERVER_A }).readCredential('example-mcp')).toBeNull()

    // The searchable half of the contract: one greppable line naming the ids.
    const line = harness.warns.find(message => message.includes('unscoped-credentials'))
    expect(line, `restore must log the unscoped wave: ${JSON.stringify(harness.warns)}`).toBeDefined()
    expect(line).toContain('example-mcp')
    expect(line).toContain(legacy)
  })

  it('a credential-less connector is NOT dragged into "authorize again"', async () => {
    const home = await tempHome()
    // A leftover file for an id whose CURRENT definition needs no credential at
    // all (a local MCP server): the row must stay usable.
    await seedCredential(legacyScopeDir(USER), 'local-mcp', { fields: { API_KEY: 'STALE' }, updatedAt: GENERATION })
    // The def with a real credential is SECOND: its registration is the signal
    // that the loop already walked past the credential-less one, so the
    // negative assertion below is not vacuous.
    await seedCredential(scopeDir(USER, SERVER_A), 'example-mcp', {
      fields: { API_KEY: 'TENANT-A-SECRET' },
      updatedAt: GENERATION,
    })

    const harness = await boot(home, [credentiallessDef('local-mcp'), tokenDef('example-mcp')])
    harness.emitSession({ username: USER, serverURL: SERVER_A })
    await waitFor(() => harness.configs.length === 1)

    const local = await rowOf(harness, 'local-mcp')
    expect(local.status, 'nothing to authorize ⇒ no "authorize again" row').not.toBe('unauthorized')
    expect(local.error).toBeUndefined()
    expect(local.errorCode).toBeUndefined()
  })
})

describe('R6-B-2 (iii): one account re-logging into the SAME server keeps its terminal state', () => {
  it('keeps the credential across logout/login (no clear() on user switch)', async () => {
    const home = await tempHome()
    await seedCredential(scopeDir(USER, SERVER_A), 'example-mcp', {
      fields: { API_KEY: 'TENANT-A-SECRET' },
      updatedAt: GENERATION,
    })
    const harness = await boot(home, [tokenDef()])

    harness.emitSession({ username: USER, serverURL: SERVER_A })
    await waitFor(() => harness.configs.length === 1)

    harness.emitSession(null)
    harness.emitSession({ username: USER, serverURL: SERVER_A })
    await waitFor(() => harness.configs.length === 2, 20_000)
    expect((await rowOf(harness, 'example-mcp')).status).toBe('connected')
    expect(apiKeyOf(harness, 'example-mcp-srv')).toBe('TENANT-A-SECRET')
    // Nothing was rewritten: same scope, same file.
    expect(await new ConnectorStore({ username: USER, serverURL: SERVER_A }).readCredential('example-mcp'))
      .not.toBeNull()
  })
})

describe('R6-B-2 (iv): the dead-grant marker is scoped with the directory it was recorded for', () => {
  it('does not carry a revoked grant from one server to another', async () => {
    const home = await tempHome()
    const idp = await deadIdp()
    const def = {
      id: 'dead',
      name: 'Dead',
      description: '',
      authMode: 'oauth',
      auth: {
        authorizeUrl: `${idp.base}/authorize`,
        tokenUrl: `${idp.base}/token`,
        clientId: 'c',
        redirectUri: '',
        pkce: true,
      },
      mcp: [{ serverName: 'dead-mcp', transport: 'stdio', command: 'node', args: ['x.mjs'] }],
    } as unknown as ConnectorDef

    // A: lapsed token ⇒ the restore spends one refresh ⇒ invalid_grant ⇒ the
    // marker is recorded under A's scope (dir A, connector id, generation).
    await seedCredential(scopeDir(USER, SERVER_A), 'dead', {
      accessToken: 'a-token',
      refreshToken: 'a-revoked',
      clientId: 'c',
      expiresAt: Date.now() - 1_000,
      updatedAt: GENERATION,
    })
    // B: the SAME generation marker (a provisioned/copied file) but a healthy
    // token — if the marker were keyed by id alone, B would inherit A's
    // revocation and never register.
    await seedCredential(scopeDir(USER, SERVER_B), 'dead', {
      accessToken: 'b-token',
      refreshToken: 'b-refresh',
      clientId: 'c',
      expiresAt: B_EXPIRES_AT,
      updatedAt: GENERATION,
    })

    const harness = await boot(home, [def])
    harness.emitSession({ username: USER, serverURL: SERVER_A })
    expect((await waitForRow(harness, 'dead', row => row.status === 'unauthorized')).errorCode).toBe('auth-required')
    expect(idp.hits(), 'A\'s revoked token really went to the token endpoint').toBeGreaterThan(0)
    const hitsAfterA = idp.hits()

    // B's own `expiresAt` reaches the row only from B's file, so waiting on it
    // proves B's restore read B's scope (a row left over from A cannot match).
    harness.emitSession({ username: USER, serverURL: SERVER_B })
    const bRow = await waitForRow(harness, 'dead', row => row.expiresAt === B_EXPIRES_AT && row.status !== 'disconnected')
    expect(bRow.status, 'B\'s healthy credential must connect').toBe('connected')
    expect(bRow.errorCode).toBeUndefined()
    expect(harness.configs.map(config => config.serverName), 'B\'s MCP server must be registered').toEqual(['dead-mcp'])
    expect(idp.hits(), 'B has 3600 s of life and must not be probed').toBe(hitsAfterA)
  })
})

describe('R6-B-2: the local-approval ledger follows the same scope', () => {
  it('an approval given for one server is not reused for another', async () => {
    await tempHome()
    const { ConnectorApprovalStore } = await import('../src/approvals.ts')
    const record = { fingerprint: 'f'.repeat(64), command: 'node', args: ['x.mjs'], envKeys: [], approvedAt: Date.now() }

    await new ConnectorApprovalStore({ username: USER, serverURL: SERVER_A }).approve(record)
    expect(await new ConnectorApprovalStore({ username: USER, serverURL: SERVER_A }).isApproved(record.fingerprint)).toBe(true)
    expect(await new ConnectorApprovalStore({ username: USER, serverURL: SERVER_B }).isApproved(record.fingerprint)).toBe(false)
  })
})
