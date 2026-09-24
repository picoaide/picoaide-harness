/**
 * R11-D-02 / R11-D-07 regression — a `fields` **value** that is not a string.
 *
 * R10 N1 fixed the *container* (`"fields": null` must not throw) and left the
 * **values** alone. A credential file is hand-editable on purpose, and JSON
 * happily carries `{"fields":{"API_KEY":null}}` or `{"fields":{"API_KEY":42}}`.
 * Two consumers read such a value and each broke in its own way, from the SAME
 * file:
 *
 *  1. `sameCredential`'s length-prefixed fingerprint evaluated `String(v.length)`
 *     — `null.length` throws a TypeError out of `updateCredentialIfUnchanged`, so
 *     the panel's refresh route answered HTTP 500 and the whole credential-change
 *     chain (live header update + `ctx.emit` → stdio re-registration) never ran
 *     (R11-D-02, the same three-surface shape R10 N1 had one level up).
 *  2. `${FIELD}` coerced the value, so `Authorization: 'Bearer ${API_KEY}'` with
 *     `API_KEY: 42` rendered `Bearer 42` — non-empty, therefore "the
 *     administrator's own credential" — and displaced the provider's live token:
 *     a 401 loop over a value nobody ever typed (R11-D-07).
 *
 * One reading fixes both, and it is the reading the other consumers already use
 * (`buildStdioEnv` skips `typeof value !== 'string'`, `missingDeclaredFields`
 * treats it as missing): a value that is not a string means **this credential
 * carries no such field**, so the slot is filled from the live token (or dropped)
 * exactly like an unknown field name. The normalization lives at the single read
 * boundary (`ConnectorStore.readCredential`) and the render re-checks the same
 * rule, so a credential that reaches the render by another route cannot smuggle a
 * non-string through.
 *
 * Every judge below is a real-path fact: the plugin's own refresh route and its
 * own state route, the credential actually on disk, and the headers of a real
 * `/mcp` request carried by the pinned SDK transport.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { callRoute, createHarness, seedCredential, waitFor } from './helpers/connector-harness.ts'
import { completeAuthorization, startRealMcpServer, type RealMcpServer } from './helpers/real-mcp-oauth-server.ts'
import { ConnectorStore, sameCredential } from '../src/store.ts'
import type { ConnectorDef } from '../src/types.ts'

const servers: RealMcpServer[] = []
afterEach(async () => { while (servers.length) await servers.pop()?.close() })

const ID = 'r11d2-mcp'

/** The declared slot; `Authorization` has its own rules and is the subject of the second case. */
function def(origin: string, declared: string): ConnectorDef {
  return {
    id: ID,
    name: 'R11D2 field values',
    description: 'r11d2',
    authMode: 'oauth',
    auth: {
      authorizeUrl: `${origin}/oauth/authorize`,
      tokenUrl: `${origin}/oauth/token`,
      clientId: '',
      redirectUri: 'http://127.0.0.1/callback',
      pkce: true,
      publicClient: true,
      discoveryUrl: `${origin}/mcp`,
      scopes: 'mcp.read offline_access',
    },
    tokenFields: [{ key: 'API_KEY', label: 'API key', type: 'password' }],
    mcp: [{ serverName: ID, transport: 'streamable-http', url: `${origin}/mcp`, headers: { Authorization: declared } }],
  }
}

/** Connect + authorize through the plugin's own routes; returns the captured registration. */
async function connectAndAuthorize(h: ReturnType<typeof createHarness>): Promise<Record<string, unknown>> {
  await callRoute(h, `/api/pico/connectors/${ID}/connect`, 'POST')
  const deadline = Date.now() + 8_000
  let url: string | undefined
  while (Date.now() < deadline) {
    const res = await callRoute(h, `/api/pico/connectors/${ID}/state`, 'GET')
    url = (JSON.parse(res.body) as { request?: { authorizeUrl?: string } }).request?.authorizeUrl
    if (url !== undefined) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (url === undefined) throw new Error('no authorize URL')
  await completeAuthorization(url)
  await waitFor(() => h.configs.length === 1, 15_000)
  return h.configs[0] as unknown as Record<string, unknown>
}

/** The construction the installed `dsh-mcp-client` performs (see the bridge). */
function productionTransport(config: Record<string, unknown>): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(String(config.url ?? '')), {
    requestInit: { headers: { ...((config.headers ?? {}) as Record<string, string>) } },
    ...(config.authProvider === undefined ? {} : { authProvider: config.authProvider as never }),
  })
}

/** The live bearer the provider holds right now (the token the SDK would send). */
async function liveToken(config: Record<string, unknown>): Promise<string> {
  const provider = config.authProvider as { tokens: () => Promise<{ access_token?: string } | undefined> } | undefined
  expect(provider, 'precondition: a provider-backed registration has an authProvider').toBeDefined()
  const token = (await provider?.tokens())?.access_token ?? ''
  expect(token, 'precondition: the provider holds a live token').not.toBe('')
  return token
}

/** Drive one real tool call through a fresh transport built from the registration. */
async function callThrough(server: RealMcpServer, config: Record<string, unknown>): Promise<string> {
  const client = new Client({ name: 'r11d2', version: '1' }, { capabilities: {} })
  try {
    await client.connect(productionTransport(config))
    const result = await client.callTool({ name: 'echo', arguments: { text: 'r11d2' } }) as { content?: Array<{ text?: string }> }
    return result.content?.[0]?.text ?? ''
  } finally {
    await client.close().catch(() => {})
  }
}

describe('R11-D-02: a `fields` VALUE that is not a string must not take the refresh route down', () => {
  it('{API_KEY: null}: the panel refresh answers 200 and the rotation really lands', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    server.requireExtraHeader('X-Probe-Key')
    const dir = mkdtempSync(join(tmpdir(), 'r11d2-null-value-'))
    server.setRotateRefresh(true)
    // The declared slot is the live-record shape (R9-D-1): the refresh must reach
    // it, which is only observable if the whole chain ran to completion.
    const oauth = def(server.origin, '')
    oauth.mcp = [{ serverName: ID, transport: 'streamable-http', url: `${server.origin}/mcp`, headers: { 'X-Probe-Key': '' } }]
    const h = createHarness([oauth], dir, { refreshSweepIntervalMs: 0 })
    try {
      const config = await connectAndAuthorize(h)
      const before = await liveToken(config)
      const store = new ConnectorStore({ baseDir: dir })
      const stored = await store.readCredential(ID)
      expect(stored?.refreshToken, 'precondition: a real refresh token is on disk').toBeTruthy()

      // Hand-edit the file into the shape the audit used: a null VALUE (the
      // container is a perfectly good record).
      await seedCredential(dir, ID, {
        accessToken: stored?.accessToken,
        refreshToken: stored?.refreshToken,
        clientId: stored?.clientId,
        expiresAt: Date.now() + 3_600_000,
        fields: { API_KEY: null },
      } as never)
      const onDisk = JSON.parse(readFileSync(join(dir, `${ID}.json`), 'utf8')) as { fields?: Record<string, unknown> }
      expect(onDisk.fields, 'precondition: the file really carries a null VALUE').toEqual({ API_KEY: null })

      // ① The refresh must succeed — a throwing CAS fingerprint answered 500 here.
      const refreshed = await callRoute(h, `/api/pico/connectors/${ID}/refresh`, 'POST')
      expect(refreshed.status, `the refresh route must answer 200, not 500: ${refreshed.body.slice(0, 300)}`).toBe(200)

      // ② The rotation must really have been persisted (proves the CAS write ran,
      //    not merely that some handler swallowed an exception) …
      const after = await store.readCredential(ID)
      expect(after?.accessToken, 'the refresh must have rotated and persisted the access token').not.toBe(before)
      // … and the non-string value is gone from the record the store hands out.
      expect(after?.fields, 'a non-string value reads as "no such field"').toEqual({})

      // ③ … and the live header record must have followed it.
      await waitFor(() => (config.headers as Record<string, string>)['X-Probe-Key'] === `Bearer ${after?.accessToken ?? ''}`, 15_000)
      expect(server.stats.mcpUnauthorizedByMethod.POST ?? 0, 'no 401 on the body frames').toBe(0)
    } finally { h.dispose() }
  }, 90_000)

  it('{API_KEY: 42}: numeric and object values are dropped by the store read, not coerced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r11d2-shapes-'))
    const store = new ConnectorStore({ baseDir: dir })
    await seedCredential(dir, ID, {
      accessToken: 'at-live',
      fields: { API_KEY: 42, OTHER: { nested: true }, LIST: ['a'], KEPT: 'value' },
    })
    const read = await store.readCredential(ID)
    expect(read?.fields, 'only string values are fields').toEqual({ KEPT: 'value' })
    // The fingerprint is total: it used to throw on `null.length` / `42.length`.
    expect(() => sameCredential(read ?? { updatedAt: 0 }, { ...(read ?? { updatedAt: 0 }) }), 'sameCredential must not throw').not.toThrow()
    expect(sameCredential(
      { updatedAt: 1, fields: { API_KEY: 42 } } as never,
      { updatedAt: 1, fields: {} } as never,
    ), 'a non-string value and an absent field are the same credential').toBe(true)
  })
})

describe('R11-D-07: a non-string field value must not steal the authorization slot', () => {
  it('Authorization: Bearer ${API_KEY} with API_KEY = 42 must send the provider token, never "Bearer 42"', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r11d2-slot-'))
    // The endpoint authenticates the provider's bearer: if the declaration won the
    // slot, every frame would carry `Bearer 42` and 401.
    const h = createHarness([def(server.origin, 'Bearer ${API_KEY}')], dir, { refreshSweepIntervalMs: 0 })
    try {
      const config = await connectAndAuthorize(h)
      expect(await callThrough(server, config), 'precondition: the registration is usable').toBe('echo:r11d2')

      // Hand-edit the file the way an external tool would: the authorization is
      // still the real one, only the declared field value is not a string.
      const store = new ConnectorStore({ baseDir: dir })
      const stored = await store.readCredential(ID)
      expect(stored?.refreshToken, 'precondition: a real refresh token is on disk').toBeTruthy()
      await seedCredential(dir, ID, {
        accessToken: stored?.accessToken,
        refreshToken: stored?.refreshToken,
        clientId: stored?.clientId,
        expiresAt: Date.now() + 3_600_000,
        fields: { API_KEY: 42 },
      } as never)

      // A credential change is what re-renders the live record; the panel refresh
      // is the production route that drives it (and the one the user has).
      const refreshed = await callRoute(h, `/api/pico/connectors/${ID}/refresh`, 'POST')
      expect(refreshed.status, `the refresh route must answer 200: ${refreshed.body.slice(0, 300)}`).toBe(200)
      const token = await liveToken(config)
      const authorization = (config.headers as Record<string, string>).Authorization
      // The provider owns the slot, so the record must NOT carry a declared
      // Authorization at all. Without the rule the coerced value won the slot and
      // the record held the literal `Bearer 42`.
      expect(authorization ?? '', 'a non-string value carries no credential: the declared slot must not win').not.toContain('42')
      expect(authorization, 'the provider owns the slot (the framework copy is dropped)').toBeUndefined()
      expect(token, 'precondition: the provider really holds a token').not.toBe('')
      expect(await callThrough(server, config), 'the connector must still be usable').toBe('echo:r11d2')
      expect(server.stats.mcpUnauthorizedByMethod.POST ?? 0, 'no 401 anywhere on the body frames').toBe(0)
      for (const record of server.stats.mcpHeaders) {
        expect(String(record.authorization ?? ''), 'no frame may carry the coerced value').not.toContain('Bearer 42')
      }
    } finally { h.dispose() }
  }, 90_000)
})
