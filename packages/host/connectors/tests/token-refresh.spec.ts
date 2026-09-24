/**
 * Token refresh regressions (2026-09-14).
 *
 * The mechanism is the OFFICIAL MCP authorization implementation: the SDK's
 * `auth()` orchestrator performs RFC 9728 / RFC 8414 discovery, the RFC 6749 §6
 * refresh grant and the token persistence, and we only supply the storage side
 * of `OAuthClientProvider`. These tests pin the three properties a connector
 * actually depends on:
 *
 *  1. an expired token is renewed through the discovered metadata endpoint, and
 *     `expires_in` becomes an absolute `expiresAt`;
 *  2. a definition with static endpoints (no published metadata) refreshes too;
 *  3. a dead grant (`invalid_grant`) is reported as "authorize again" and
 *     NEVER opens a browser, while a 5xx stays retryable and leaves the stored
 *     credential untouched.
 *
 * The fake authorization server is a real HTTP server, so discovery, the token
 * request and the JSON handling all run for real.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The real bridge spawns/connects for real; this suite exercises the config the
// plugin hands it (the auth provider), exactly like the other connector suites.
vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))
import { refreshCredentialTokens, TokenRefresher } from '../src/mcp-oauth-provider.ts'
import type { OAuthTarget } from '../src/mcp-oauth-provider.ts'
import { ConnectorStore } from '../src/store.ts'
import type { ConnectorCredential } from '../src/store.ts'
import { callRoute, createHarness, seedCredential, waitFor } from './helpers/connector-harness.ts'
import type { ConnectorDef } from '../src/types.ts'

interface FakeAuthServer {
  origin: string
  /** Grant types the token endpoint has answered, in order. */
  readonly grants: string[]
  /** Bodies of every token request. */
  readonly tokenBodies: URLSearchParams[]
  /** Set to make the token endpoint refuse the refresh grant. */
  failGrant: 'invalid_grant' | 'server_error' | null
  close: () => Promise<void>
}

/** A real OAuth server: protected-resource metadata, AS metadata, token endpoint. */
async function fakeAuthServer(options: { expiresIn?: number, rotateRefresh?: boolean } = {}): Promise<FakeAuthServer> {
  const state: { failGrant: FakeAuthServer['failGrant'] } = { failGrant: null }
  const grants: string[] = []
  const tokenBodies: URLSearchParams[] = []
  let issued = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    if (url.pathname === '/mcp') {
      // An MCP endpoint that requires authorization: 401 + the RFC 9728
      // resource-metadata pointer the discovery path follows.
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      })
      res.end(JSON.stringify({ error: 'invalid_token' }))
      return
    }
    if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname.startsWith('/.well-known/oauth-protected-resource/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }))
      return
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      }))
      return
    }
    if (url.pathname === '/oauth/register') {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ client_id: 'dyn-1', token_endpoint_auth_method: 'none' }))
      return
    }
    if (url.pathname === '/oauth/token') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const params = new URLSearchParams(body)
        tokenBodies.push(params)
        const grant = params.get('grant_type') ?? ''
        grants.push(grant)
        if (state.failGrant === 'server_error') {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'temporarily_unavailable' }))
          return
        }
        if (state.failGrant === 'invalid_grant') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_grant' }))
          return
        }
        const access = `at-${++issued}`
        if (grant !== 'refresh_token') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'unsupported_grant_type' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          expires_in: options.expiresIn ?? 3600,
          ...(options.rotateRefresh === true ? { refresh_token: `rt-${issued}` } : {}),
        }))
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    grants,
    tokenBodies,
    get failGrant() { return state.failGrant },
    set failGrant(value) { state.failGrant = value },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()) }),
  }
}

const servers: FakeAuthServer[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

async function startServer(options?: { expiresIn?: number, rotateRefresh?: boolean }): Promise<FakeAuthServer> {
  const server = await fakeAuthServer(options)
  servers.push(server)
  return server
}

function discoveryTarget(origin: string): OAuthTarget {
  return { discoveryUrl: `${origin}/mcp`, scope: 'offline_access' }
}

function credential(patch: Partial<ConnectorCredential> = {}): ConnectorCredential {
  return { accessToken: 'at-stale', refreshToken: 'rt-1', clientId: 'dyn-1', updatedAt: 0, ...patch }
}

describe('refreshCredentialTokens (official SDK refresh flow)', () => {
  it('renews through discovered metadata and reports an absolute expiry', async () => {
    const server = await startServer({ expiresIn: 120 })
    const outcome = await refreshCredentialTokens(credential(), discoveryTarget(server.origin))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.tokens.accessToken).toBe('at-1')
    // Kept when the server does not rotate it.
    expect(outcome.tokens.refreshToken).toBe('rt-1')
    const lifetime = outcome.tokens.expiresAt - Date.now()
    expect(lifetime).toBeGreaterThan(100_000)
    expect(lifetime).toBeLessThanOrEqual(120_000)
    expect(server.grants).toEqual(['refresh_token'])
    // RFC 6749 §6 grant shape, RFC 8707 resource indicator included.
    expect(server.tokenBodies[0]?.get('refresh_token')).toBe('rt-1')
    expect(server.tokenBodies[0]?.get('client_id')).toBe('dyn-1')
    expect(server.tokenBodies[0]?.get('resource')).toBe(`${server.origin}/mcp`)
  })

  it('stores a rotated refresh token instead of the consumed one', async () => {
    const server = await startServer({ rotateRefresh: true })
    const outcome = await refreshCredentialTokens(credential(), discoveryTarget(server.origin))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.tokens.refreshToken).toBe('rt-1')
    expect(outcome.tokens.accessToken).toBe('at-1')
  })

  it('refreshes a definition with static endpoints and no published metadata', async () => {
    const server = await startServer()
    const outcome = await refreshCredentialTokens(
      credential(),
      // Exactly the sales-easy shape: no discoveryUrl, only endpoints. The
      // target still names the MCP resource, like the connector does.
      {
        tokenUrl: `${server.origin}/oauth/token`,
        authorizeUrl: `${server.origin}/oauth/authorize`,
        resourceUrl: `${server.origin}/mcp`,
        scope: 'offline_access',
      },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(server.grants).toEqual(['refresh_token'])
    // RFC 6749 §6: the refresh grant omits `scope` (keep the original grant).
    expect(server.tokenBodies[0]?.get('scope')).toBeNull()
    // RFC 8707 binding is preserved even without published metadata: the MCP
    // resource URL the definition declares is what the grant is bound to.
    expect(server.tokenBodies[0]?.get('resource')).toBe(`${server.origin}/mcp`)
  })

  it('reports a dead grant as reauthorize and never touches the credential', async () => {
    const server = await startServer()
    server.failGrant = 'invalid_grant'
    const outcome = await refreshCredentialTokens(credential(), discoveryTarget(server.origin))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('reauthorize')
    expect(outcome.message).toContain('重新授权')
  })

  it('keeps a 5xx retryable instead of demanding re-authorization', async () => {
    const server = await startServer()
    server.failGrant = 'server_error'
    const outcome = await refreshCredentialTokens(credential(), discoveryTarget(server.origin))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('transient')
  })

  it('sends no `scope` on refresh (echoing it back is rejected by real servers)', async () => {
    const server = await startServer()
    const outcome = await refreshCredentialTokens(
      credential(),
      // The connector definition carries scopes; the refresh grant must still
      // omit them (2026-09-14: a real authorization server answered
      // `invalid_scope` — "refresh scope 超出原授权范围" — when we echoed it).
      { ...discoveryTarget(server.origin), scope: 'offline_access' },
    )
    expect(outcome.ok).toBe(true)
    expect(server.grants).toEqual(['refresh_token'])
    expect(server.tokenBodies[0]?.get('scope')).toBeNull()
    expect(server.tokenBodies[0]?.get('grant_type')).toBe('refresh_token')
  })

  it('does nothing for a credential without a refresh token', async () => {
    const outcome = await refreshCredentialTokens(credential({ refreshToken: undefined }), { tokenUrl: 'https://example.com/token' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('not-applicable')
  })
})

describe('TokenRefresher', () => {
  function harnessFor(server: FakeAuthServer, store: ConnectorStore): TokenRefresher {
    return new TokenRefresher({
      read: (id) => store.readCredential(id),
      write: (id, patch) => store.updateCredential(id, patch),
      target: () => discoveryTarget(server.origin),
    })
  }

  function tempStore(): { dir: string, store: ConnectorStore } {
    const dir = mkdtempSync(join(tmpdir(), 'conn-refresh-'))
    return { dir, store: new ConnectorStore({ baseDir: dir, username: null }) }
  }

  it('single-flights concurrent refreshes (one grant, one rotation)', async () => {
    const server = await startServer({ rotateRefresh: true })
    const { store } = tempStore()
    await store.writeCredential('example-mcp', credential({ expiresAt: Date.now() - 1000 }))
    const refresher = harnessFor(server, store)
    const outcomes = await Promise.all([
      refresher.refresh('example-mcp'),
      refresher.refresh('example-mcp'),
      refresher.refresh('example-mcp'),
    ])
    expect(outcomes.every(outcome => outcome.ok)).toBe(true)
    // One token request for three callers: the second refresh would have
    // consumed the rotated refresh token the first one just stored.
    expect(server.grants).toEqual(['refresh_token'])
    const stored = await store.readCredential('example-mcp')
    expect(stored?.accessToken).toBe('at-1')
    expect(stored?.refreshToken).toBe('rt-1')
    expect(stored?.expiresAt).toBeGreaterThan(Date.now())
  })

  it('treats a user switch during the refresh as a silent no-op', async () => {
    const server = await startServer({ rotateRefresh: true })
    const { store } = tempStore()
    await store.writeCredential('example-mcp', credential({ expiresAt: Date.now() - 1000 }))
    let scope = 'user-a'
    const announced: string[] = []
    const refresher = new TokenRefresher({
      read: (id) => store.readCredential(id),
      write: (id, patch) => store.updateCredential(id, patch),
      writeIfUnchanged: async () => { scope = 'user-b'; return null },
      scope: () => scope,
      target: () => discoveryTarget(server.origin),
      onRefreshed: (id) => { announced.push(id) },
    })
    const outcome = await refresher.refresh('example-mcp', { force: true })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('not-applicable')
    expect(announced).toEqual([])
  })

  it('mirrors a NEWER credential instead of the stale refresh result when the CAS misses', async () => {
    const server = await startServer({ rotateRefresh: true })
    const { store } = tempStore()
    const before = credential({ expiresAt: Date.now() - 1000 })
    await store.writeCredential('example-mcp', before)
    const announced: Array<{ id: string; token: string | undefined }> = []
    const refresher = new TokenRefresher({
      read: (id) => store.readCredential(id),
      write: (id, patch) => store.updateCredential(id, patch),
      // An interactive re-authorization (or SDK self-heal) won the write order
      // while the refresh was on the wire: the refresh must not overwrite it,
      // but the winning credential should be mirrored into live providers.
      writeIfUnchanged: async (id) => {
        await store.updateCredential(id, {
          accessToken: 'at-newer', refreshToken: 'rt-newer', expiresAt: Date.now() + 3_600_000,
        })
        return null
      },
      target: () => discoveryTarget(server.origin),
      onRefreshed: (id, tokens) => { announced.push({ id, token: tokens.accessToken }) },
    })
    const outcome = await refresher.refresh('example-mcp', { force: true })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.tokens.accessToken).toBe('at-newer')
    expect(announced).toEqual([{ id: 'example-mcp', token: 'at-newer' }])
    expect((await store.readCredential('example-mcp'))?.accessToken).toBe('at-newer')
  })

  it('treats a disconnect during the refresh as not-applicable and never resurrects', async () => {
    const server = await startServer({ rotateRefresh: true })
    const { store } = tempStore()
    await store.writeCredential('example-mcp', credential({ expiresAt: Date.now() - 1000 }))
    const announced: string[] = []
    const refresher = new TokenRefresher({
      read: (id) => store.readCredential(id),
      write: (id, patch) => store.updateCredential(id, patch),
      writeIfUnchanged: async (id) => { await store.clearCredential(id); return null },
      target: () => discoveryTarget(server.origin),
      onRefreshed: (id) => { announced.push(id) },
    })
    const outcome = await refresher.refresh('example-mcp', { force: true })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('not-applicable')
    expect(announced).toEqual([])
    expect(await store.readCredential('example-mcp')).toBeNull()
  })

  it('skips the round trip while the stored token is still fresh', async () => {
    const server = await startServer()
    const { store } = tempStore()
    await store.writeCredential('example-mcp', credential({ expiresAt: Date.now() + 10 * 60 * 1000 }))
    const refresher = harnessFor(server, store)
    const outcome = await refresher.refresh('example-mcp')
    expect(outcome.ok).toBe(true)
    expect(server.grants).toEqual([])
  })

  it('a forced refresh is NOT swallowed by an in-flight clock-path refresh', async () => {
    // R7-B P2-b：`force` 原先只作用于**创建 inflight 槽位**的那一次。在飞的"看时钟"
    // 请求会走"还新鲜，什么都不做"的快路径（零令牌端点请求）并回报 `ok: true`，把
    // 随后到达的强制请求（401 路径：服务器说这枚令牌已死，本地 `expiresAt` 还在未来）
    // 整个吞掉 —— 401 钩子于是 adopt 一枚死令牌，重试照旧 401。
    //
    // 判据不是"赢得竞态"：把时钟请求**停在** `read` 里做确定性握手，强制请求必然落在
    // 它的飞行窗口内（`refresh()` 在第一次 await 之前就同步登记了 inflight 槽位）。
    const server = await startServer({ expiresIn: 3600 })
    const { store } = tempStore()
    // 本地时钟说这枚令牌还能用一小时 —— 正是被 401 推翻的那个状态。
    await store.writeCredential('example-mcp', credential({ expiresAt: Date.now() + 60 * 60 * 1000 }))

    let releaseRead!: () => void
    const gate = new Promise<void>(resolve => { releaseRead = resolve })
    let enteredRead!: () => void
    const readEntered = new Promise<void>(resolve => { enteredRead = resolve })
    let parked = true
    const refresher = new TokenRefresher({
      read: async (id) => {
        if (parked) {
          parked = false
          enteredRead()
          await gate
        }
        return await store.readCredential(id)
      },
      write: (id, patch) => store.updateCredential(id, patch),
      target: () => discoveryTarget(server.origin),
    })

    const clockPath = refresher.refresh('example-mcp')
    await readEntered
    expect(refresher.isRefreshing('example-mcp'), '前置：时钟路径必须真的在飞').toBe(true)
    const forced = refresher.refresh('example-mcp', { force: true })
    releaseRead()

    const [clockOutcome, forcedOutcome] = await Promise.all([clockPath, forced])
    expect(clockOutcome.ok).toBe(true)
    expect(forcedOutcome.ok).toBe(true)
    // 修复前：强制请求复用了那次快路径 ⇒ 令牌端点零请求，两个结果都是旧令牌。
    expect(server.grants).toEqual(['refresh_token'])
    const stored = await store.readCredential('example-mcp')
    expect(stored?.accessToken).toBe('at-1')
    expect(stored?.refreshToken).toBe('rt-1')
    expect(forcedOutcome.ok && forcedOutcome.tokens.accessToken).toBe('at-1')
    expect(forcedOutcome.ok && forcedOutcome.tokens.accessToken).not.toBe('at-stale')
  })

  it('a forced refresh reuses an in-flight run that DID reach the server (one grant, no double spend)', async () => {
    // 反向对照：强制请求只能被"越过时钟快路径"的在飞请求满足。这条钉住另一侧 ——
    // 在飞请求自己就是一次真实续期时，后来的强制请求**不得**再刷一次（同一个单次
    // refresh token 出示两次会被轮换复用检测吊销整条授权）。
    const server = await startServer({ expiresIn: 3600 })
    const { store } = tempStore()
    await store.writeCredential('example-mcp', credential({ expiresAt: Date.now() - 60_000 }))
    let releaseWrite!: () => void
    const gate = new Promise<void>(resolve => { releaseWrite = resolve })
    let enteredWrite!: () => void
    const writeEntered = new Promise<void>(resolve => { enteredWrite = resolve })
    let parked = true
    const refresher = new TokenRefresher({
      read: (id) => store.readCredential(id),
      write: async (id, patch) => {
        if (parked) {
          parked = false
          enteredWrite()
          await gate
        }
        return await store.updateCredential(id, patch)
      },
      target: () => discoveryTarget(server.origin),
    })

    // 时钟路径这次真的会续期（本地也判定已过期），把它停在**落盘**那一步。
    const clockPath = refresher.refresh('example-mcp')
    await writeEntered
    const forced = refresher.refresh('example-mcp', { force: true })
    releaseWrite()

    const [clockOutcome, forcedOutcome] = await Promise.all([clockPath, forced])
    expect(clockOutcome.ok && forcedOutcome.ok).toBe(true)
    expect(server.grants).toEqual(['refresh_token'])
    const stored = await store.readCredential('example-mcp')
    expect(stored?.accessToken).toBe('at-1')
  })

  it('leaves the stored credential untouched when the refresh is retryable', async () => {
    const server = await startServer()
    server.failGrant = 'server_error'
    const { store } = tempStore()
    await store.writeCredential('example-mcp', credential({ expiresAt: Date.now() - 1000 }))
    const refresher = harnessFor(server, store)
    const outcome = await refresher.refresh('example-mcp', { force: true })
    expect(outcome.ok).toBe(false)
    const stored = await store.readCredential('example-mcp')
    expect(stored?.accessToken).toBe('at-stale')
    expect(stored?.refreshToken).toBe('rt-1')
  })

  it('refreshes a credential with no recorded expiry exactly once per sweep', async () => {
    const server = await startServer()
    const { store } = tempStore()
    // No expiresAt (credential written by an older build): read as "possibly
    // stale", so the first sweep asks — and then the recorded expiry stops it.
    await store.writeCredential('example-mcp', credential())
    const refresher = harnessFor(server, store)
    const first = await refresher.refresh('example-mcp')
    const second = await refresher.refresh('example-mcp')
    expect(first.ok && second.ok).toBe(true)
    expect(server.grants).toEqual(['refresh_token'])
  })
})

describe('refresh route + panel metadata', () => {
  it('refreshes through the real route and exposes the new expiry', async () => {
    const server = await startServer({ expiresIn: 900 })
    const def: ConnectorDef = {
      id: 'example-mcp',
      name: '示例 MCP 智能体',
      description: 'x',
      authMode: 'oauth',
      auth: {
        authorizeUrl: `${server.origin}/oauth/authorize`,
        tokenUrl: `${server.origin}/oauth/token`,
        clientId: '',
        redirectUri: 'http://127.0.0.1/callback',
        pkce: true,
        publicClient: true,
        discoveryUrl: `${server.origin}/mcp`,
        scopes: 'offline_access',
      },
      mcp: [{ serverName: 'example-mcp', transport: 'streamable-http', url: `${server.origin}/mcp` }],
    }
    const dir = mkdtempSync(join(tmpdir(), 'conn-route-'))
    // The credential exists BEFORE the plugin restores it: this is the real
    // sequence (a stored token from an earlier session), and it is what makes
    // the row report the manual-refresh affordance.
    await seedCredential(dir, 'example-mcp', {
      accessToken: 'at-stale',
      refreshToken: 'rt-1',
      clientId: 'dyn-1',
      // Still fresh on restore, so the startup path does not spend a round trip
      // here — the manual route below is the subject. The server rejects the
      // token, which is exactly what a manual refresh is for.
      expiresAt: Date.now() + 10 * 60 * 1000,
    })
    const h = createHarness([def], dir, { refreshSweepIntervalMs: 0 })
    const before = (JSON.parse((await callRoute(h, '/api/pico/connectors', 'GET')).body) as
      { connectors: Array<{ id: string, status: string }> }).connectors.find(item => item.id === 'example-mcp')
    expect(before?.status).toBe('disconnected')

    const refreshed = await callRoute(h, '/api/pico/connectors/example-mcp/refresh', 'POST')
    expect(refreshed.status).toBe(200)
    const payload = JSON.parse(refreshed.body) as { ok: boolean, expiresAt: number }
    expect(payload.ok).toBe(true)
    expect(payload.expiresAt).toBeGreaterThan(Date.now())

    const after = (JSON.parse((await callRoute(h, '/api/pico/connectors', 'GET')).body) as
      { connectors: Array<{ id: string, status: string, expiresAt: number | null }> }).connectors.find(item => item.id === 'example-mcp')
    expect(after?.status).toBe('connected')
    expect(after?.expiresAt).toBeGreaterThan(Date.now())
    // No token material ever leaves the host through the list route.
    expect(refreshed.body).not.toContain('rt-1')
    expect(refreshed.body).not.toContain('dyn-1')
    expect(server.grants).toEqual(['refresh_token'])
    h.dispose()
  })

  it('rejects a manual refresh for a connector with no OAuth target', async () => {
    const def: ConnectorDef = {
      id: 'glitchtip',
      name: 'GlitchTip',
      description: 'x',
      authMode: 'token',
      tokenFields: [{ key: 'token', label: 'Token', type: 'password' }],
      mcp: [{ serverName: 'glitchtip', transport: 'streamable-http', url: 'https://example.com/mcp' }],
    }
    const dir = mkdtempSync(join(tmpdir(), 'conn-route-token-'))
    const h = createHarness([def], dir, { refreshSweepIntervalMs: 0 })
    await seedCredential(dir, 'glitchtip', { fields: { token: 'fixed' } })
    const res = await callRoute(h, '/api/pico/connectors/glitchtip/refresh', 'POST')
    expect(res.status).toBe(400)
    h.dispose()
  })
})

describe('re-registration must not collide with the live MCP instance', () => {
  /**
   * The upstream mcp-client reserves `serverName` for the LIFETIME of the plugin
   * instance: loading a second instance while the first is alive throws
   * `mcp-client: serverName "…" is already in use`. Every re-registration path
   * therefore has to retire the previous instance first — otherwise the row ends
   * up "连接失败" exactly like the field report from 2026-09-14 (Windows,
   * v2.7.3-beta.2: the manual refresh route re-registered while the old instance
   * was still retrying).
   *
   * The connector is a STDIO one because that is the class a credential change
   * still re-registers (R8-B-2): the child receives the token in `env` at spawn
   * and cannot read the store later. A streamable-http transport reads the live
   * credential per request, so re-registering it would only dispose the
   * transport a call in flight is using. The retirement ORDER this case pins is
   * the same on both paths, and the same-key takeover is additionally covered
   * for the restore path by `lifecycle.spec.ts > disposes the previous
   * registration when the same server key is registered again`.
   */
  it('re-registers from the manual refresh route while the old instance is live', async () => {
    const server = await startServer({ expiresIn: 900 })
    const def: ConnectorDef = {
      id: 'example-mcp',
      name: '示例 MCP 智能体',
      description: 'x',
      authMode: 'oauth',
      auth: {
        authorizeUrl: `${server.origin}/oauth/authorize`,
        tokenUrl: `${server.origin}/oauth/token`,
        clientId: '',
        redirectUri: 'http://127.0.0.1/callback',
        pkce: true,
        publicClient: true,
        discoveryUrl: `${server.origin}/mcp`,
        scopes: 'offline_access',
      },
      mcp: [{ serverName: 'example-mcp', transport: 'stdio', command: process.execPath, args: ['-e', ''] }],
    }
    const dir = mkdtempSync(join(tmpdir(), 'conn-rereg-stdio-'))
    const h = createHarness([def], dir, { refreshSweepIntervalMs: 0, requestApproval: () => true })
    // `at-seeded` is a value the fixture cannot issue, so "the child carries the
    // REFRESHED token" is a decidable statement.
    await seedCredential(dir, 'example-mcp', {
      accessToken: 'at-seeded',
      refreshToken: 'rt-1',
      clientId: 'dyn-1',
      expiresAt: Date.now() + 30 * 60 * 1000,
    })
    h.emitSession({ username: 'user-a' })
    await waitFor(() => h.configs.length === 1)
    expect(h.configs[0]?.env?.PICOAIDE_CONNECTOR_ACCESS_TOKEN).toBe('at-seeded')
    const first = h.fibers[0]?.dispose
    expect(first).toBeDefined()

    // Refresh + re-register without a teardown in between: the live instance
    // still owns "example-mcp" at this moment.
    const refreshed = await callRoute(h, '/api/pico/connectors/example-mcp/refresh', 'POST')
    expect(refreshed.status).toBe(200)
    await waitFor(() => h.configs.length === 2)
    // The previous instance was retired, not leaked — and the new child carries
    // the token the refresh persisted (the reason the event exists at all).
    const stored = await new ConnectorStore({ baseDir: dir }).readCredential('example-mcp')
    expect(stored?.accessToken).not.toBe('at-seeded')
    expect(first).toHaveBeenCalled()
    expect(h.fibers.length).toBeGreaterThanOrEqual(2)
    expect((h.configs[1] as unknown as { env?: Record<string, string> })?.env?.PICOAIDE_CONNECTOR_ACCESS_TOKEN).toBe(stored?.accessToken)
    h.dispose()
  })
})

describe('MCP registration receives the official auth provider', () => {
  function oauthDef(origin: string): ConnectorDef {
    return {
      id: 'sales-easy',
      name: 'Sales Easy',
      description: 'x',
      authMode: 'oauth',
      auth: {
        authorizeUrl: `${origin}/oauth/authorize`,
        tokenUrl: `${origin}/oauth/token`,
        clientId: '',
        redirectUri: 'http://127.0.0.1/callback',
        pkce: true,
        publicClient: true,
        discoveryUrl: `${origin}/mcp`,
        scopes: 'offline_access',
      },
      mcp: [{ serverName: 'neo-crm', transport: 'streamable-http', url: `${origin}/mcp` }],
    }
  }

  it('hands the transport an OAuthClientProvider carrying the stored tokens', async () => {
    const server = await startServer()
    const dir = mkdtempSync(join(tmpdir(), 'conn-provider-'))
    const h = createHarness([oauthDef(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    // A credential the plugin restores: registration must attach a provider so
    // the SDK (not a one-shot header) owns the bearer token from then on.
    await seedCredential(dir, 'sales-easy', {
      accessToken: 'at-live',
      refreshToken: 'rt-1',
      clientId: 'dyn-1',
      expiresAt: Date.now() + 30 * 60 * 1000,
    })
    h.emitSession({ username: 'user-a' })
    await waitFor(() => h.configs.length === 1)
    const config = h.configs[0] as unknown as {
      transport: string
      headers?: Record<string, string>
      authProvider?: { tokens: () => { access_token?: string } | undefined }
    }
    expect(config.transport).toBe('streamable-http')
    expect(typeof config.authProvider?.tokens).toBe('function')
    expect((await config.authProvider?.tokens())?.access_token).toBe('at-live')
    h.dispose()
  })

  it('re-registers a STDIO connector after its credential is refreshed', async () => {
    // The child receives its token in `env` at spawn time, so a refresh is only
    // real for it once the server is registered again.
    const server = await startServer()
    const def = oauthDef(server.origin)
    def.id = 'stdio-crm'
    def.mcp = [{ serverName: 'stdio-crm', transport: 'stdio', command: process.execPath, args: ['-e', ''] }]
    const dir = mkdtempSync(join(tmpdir(), 'conn-reregister-'))
    const h = createHarness([def], dir, { refreshSweepIntervalMs: 0, requestApproval: () => true })
    await seedCredential(dir, 'stdio-crm', {
      accessToken: 'at-first',
      refreshToken: 'rt-1',
      clientId: 'dyn-1',
      expiresAt: Date.now() + 30 * 60 * 1000,
    })
    h.emitSession({ username: 'user-a' })
    await waitFor(() => h.configs.length === 1)
    expect(h.configs[0]?.env?.PICOAIDE_CONNECTOR_ACCESS_TOKEN).toBe('at-first')

    // The refresh engine writes a new token and announces it on the host bus.
    const store = new ConnectorStore({ baseDir: dir })
    await store.updateCredential('stdio-crm', { accessToken: 'at-second', expiresAt: Date.now() + 30 * 60 * 1000 })
    h.emit('pico/connector-credentials-changed', { id: 'stdio-crm' })

    await waitFor(() => h.configs.length === 2)
    expect(h.configs[1]?.env?.PICOAIDE_CONNECTOR_ACCESS_TOKEN).toBe('at-second')
    expect(server.grants).toEqual([])
    h.dispose()
  })
})

describe('background sweep (stdio connectors cannot re-read a token)', () => {
  it('refreshes a lapsed credential and re-registers the server without any tool call', async () => {
    const server = await startServer({ expiresIn: 3600 })
    // sales-easy shape: no discoveryUrl, only endpoints — refresh works through
    // the declared token endpoint alone.
    const def: ConnectorDef = {
      id: 'stdio-crm',
      name: 'Stdio CRM',
      description: 'x',
      authMode: 'oauth',
      auth: {
        authorizeUrl: `${server.origin}/oauth/authorize`,
        tokenUrl: `${server.origin}/oauth/token`,
        clientId: '',
        redirectUri: 'http://127.0.0.1/callback',
        pkce: true,
        publicClient: true,
        scopes: 'offline_access',
      },
      mcp: [{ serverName: 'stdio-crm', transport: 'stdio', command: process.execPath, args: ['-e', ''] }],
    }
    const dir = mkdtempSync(join(tmpdir(), 'conn-sweep-'))
    // 定时扫掠关掉、由测试自己驱动：本用例要观察的是"扫掠会刷新并重注册"这个
    // 不变量，而不是"定时器在 8 秒内被调度到"。CI（4 vCPU、多包并发）下定时器
    // 会被调度拉开数秒，此前多次在 8s 预算内等不到（2026-09-16 Gate 红过一次）。
    let sweep: (() => Promise<void>) | undefined
    const h = createHarness([def], dir, {
      refreshSweepIntervalMs: 0,
      requestApproval: () => true,
      onRefreshSweepReady: (fn: () => Promise<void>) => { sweep = fn },
    })
    await seedCredential(dir, 'stdio-crm', {
      accessToken: 'at-first',
      refreshToken: 'rt-1',
      clientId: 'dyn-1',
      // Fresh on restore so the startup path does not spend a round trip; the
      // sweep below is the subject.
      expiresAt: Date.now() + 5 * 60 * 1000,
    })
    h.emitSession({ username: 'user-a' })
    await waitFor(() => h.configs.length === 1)
    expect(h.configs[0]?.env?.PICOAIDE_CONNECTOR_ACCESS_TOKEN).toBe('at-first')
    assert.ok(sweep !== undefined, '插件必须把扫掠函数交给注入的观察者')

    // The token lapses while the app keeps running: nothing calls the server,
    // so only the sweep can notice.
    const store = new ConnectorStore({ baseDir: dir })
    await store.updateCredential('stdio-crm', { expiresAt: Date.now() - 1000 })

    /** 主动驱动扫掠直到一轮往返完成（真实 HTTP 仍需等待，但不再靠定时器）。 */
    const deadline = Date.now() + 20_000
    let rounds = 0
    while (server.grants.length === 0 || h.configs.length < 2) {
      if (Date.now() >= deadline) {
        throw new Error(
          `sweep never refreshed the lapsed credential in ${rounds} sweeps; `
          + `grants=${JSON.stringify(server.grants)} configs=${h.configs.length}`,
        )
      }
      await sweep()
      rounds += 1
      if (server.grants.length === 0 || h.configs.length < 2) await new Promise(r => setTimeout(r, 20))
    }
    expect(server.grants.length).toBe(1)
    expect(h.configs[1]?.env?.PICOAIDE_CONNECTOR_ACCESS_TOKEN).toBe('at-1')
    const stored = await store.readCredential('stdio-crm')
    expect(stored?.expiresAt).toBeGreaterThan(Date.now())
    h.dispose()
  })
})
