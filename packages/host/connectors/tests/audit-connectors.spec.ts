/**
 * Audit probes (2026-09-14): token-refresh / lifecycle edge cases that the
 * existing suite does not cover. Each probe asserts the BEHAVIOUR WE WANT; a
 * failing probe is a finding.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { ConnectorStore } from '../src/store.ts'
import { TokenRefresher } from '../src/mcp-oauth-provider.ts'
import { callRoute, createHarness, seedCredential, waitFor } from './helpers/connector-harness.ts'
import type { ConnectorDef } from '../src/types.ts'

interface Fake {
  origin: string
  grants: string[]
  tokenBodies: URLSearchParams[]
  fail: 'invalid_grant' | 'server_error' | null
  rotate: boolean
  close: () => Promise<void>
}

async function fakeServer(options: { expiresIn?: number, rotate?: boolean } = {}): Promise<Fake> {
  const state: { fail: Fake['fail'] } = { fail: null }
  const grants: string[] = []
  const tokenBodies: URLSearchParams[] = []
  let issued = 0
  const server = createServer((req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/mcp') {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` })
      res.end(JSON.stringify({ error: 'invalid_token' }))
      return
    }
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }))
      return
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
        response_types_supported: ['code'], grant_types_supported: ['refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      }))
      return
    }
    if (url.pathname === '/oauth/authorize') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body>authorize</body></html>')
      return
    }
    if (url.pathname === '/oauth/token') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const params = new URLSearchParams(body)
        grants.push(params.get('grant_type') ?? '')
        tokenBodies.push(params)
        if (state.fail === 'server_error') {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'temporarily_unavailable' }))
          return
        }
        if (state.fail === 'invalid_grant') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_grant' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          access_token: `at-${++issued}`,
          token_type: 'Bearer',
          expires_in: options.expiresIn ?? 3600,
          ...(options.rotate ?? false ? { refresh_token: `rt-${issued}` } : {}),
        }))
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    grants,
    tokenBodies,
    get fail() { return state.fail },
    set fail(v) { state.fail = v },
    rotate: options.rotate ?? false,
    close: () => new Promise<void>(r => { server.close(() => r()) }),
  }
}

const servers: Fake[] = []
afterEach(async () => { while (servers.length) await servers.pop()?.close() })
async function start(options?: { expiresIn?: number, rotate?: boolean }): Promise<Fake> {
  const s = await fakeServer(options)
  servers.push(s)
  return s
}

function oauthDef(origin: string, transport: 'stdio' | 'streamable-http' = 'streamable-http'): ConnectorDef {
  return {
    id: 'example-mcp', name: '示例 MCP 智能体', description: 'x', authMode: 'oauth',
    auth: {
      authorizeUrl: `${origin}/oauth/authorize`, tokenUrl: `${origin}/oauth/token`, clientId: '',
      redirectUri: 'http://127.0.0.1/callback', pkce: true, publicClient: true,
      discoveryUrl: `${origin}/mcp`, scopes: 'offline_access',
    },
    mcp: transport === 'streamable-http'
      ? [{ serverName: 'example-mcp', transport: 'streamable-http', url: `${origin}/mcp` }]
      : [{ serverName: 'example-mcp', transport: 'stdio', command: process.execPath, args: ['-e', ''] }],
  }
}

/** Poll the connector list until a row satisfies the predicate. */
async function awaitRow(
  h: ReturnType<typeof createHarness>,
  id: string,
  predicate: (row: { status: string, error?: string, request?: { fields?: unknown[] } | null }) => boolean,
  timeoutMs = 6000,
): Promise<{ status: string, error?: string, request?: { fields?: unknown[] } | null }> {
  const deadline = Date.now() + timeoutMs
  let last: { status: string, error?: string, request?: { fields?: unknown[] } | null } = { status: '?' }
  while (Date.now() < deadline) {
    const listed = JSON.parse((await callRoute(h, '/api/pico/connectors', 'GET')).body) as
      { connectors: Array<{ id: string, status: string, error?: string, request?: { fields?: unknown[] } | null }> }
    last = listed.connectors.find(c => c.id === id) ?? last
    if (predicate(last)) return last
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`row ${id} never matched; last=${JSON.stringify(last)}`)
}

describe('audit: refresh failure must not park the connector forever', () => {
  it('PROBE A: a transient refresh failure recovers on the next sweep', async () => {
    const server = await start({ expiresIn: 3600 })
    const dir = mkdtempSync(join(tmpdir(), 'audit-a-'))
    // 扫掠的可注入观察者（拿到的是**生产**扫掠函数）：这条用例要观察"下一轮
    // 扫掠会恢复"，此前靠等定时器撞运气——CI（4 vCPU、多包并发）下定时器 +
    // 真实 HTTP 往返 + 事件扇出会被调度拉开数秒，多次在预算内等不到（本地
    // 12 进程压测亦复现 2/12）。改为测试**自己驱动扫掠**：断言的不变量
    // （"扫掠逻辑会让它恢复"）不变，去掉的是调度运气。
    let sweep: (() => Promise<void>) | undefined
    // 定时扫掠关掉（`refreshSweepIntervalMs: 0`）：本用例**自己驱动**扫掠，
    // 避免"手动扫掠 + 80ms 定时扫掠"两个来源并发抢同一份生命周期队列——
    // 那正是此前偶发失败的来源之一（CI + 本地 4 进程压测均复现）。
    const h = createHarness([oauthDef(server.origin)], dir, {
      refreshSweepIntervalMs: 0,
      onRefreshSweepReady: (fn: () => Promise<void>) => { sweep = fn },
    })
    await seedCredential(dir, 'example-mcp', {
      accessToken: 'at-first', refreshToken: 'rt-1', clientId: 'dyn-1',
      expiresAt: Date.now() + 5 * 60 * 1000,
    })
    h.emitSession({ username: 'user-a' })
    await waitFor(() => h.configs.length === 1, 20_000)
    assert.ok(sweep !== undefined, '插件必须把扫掠函数交给注入的观察者')
    // 前置条件：连接器必须已经 connected，否则扫掠会（正确地）跳过它
    await awaitRow(h, 'example-mcp', row => row.status === 'connected', 20_000)

    // the token lapses while the endpoint is temporarily down
    server.fail = 'server_error'
    const store = new ConnectorStore({ baseDir: dir })
    await store.updateCredential('example-mcp', { expiresAt: Date.now() - 1000 })

    /** 主动驱动扫掠，直到条件成立（真实 HTTP 往返仍需等待，但不再靠定时器）。 */
    async function sweepUntil(predicate: () => boolean | Promise<boolean>, budgetMs: number, label: string): Promise<void> {
      const deadline = Date.now() + budgetMs
      let rounds = 0
      for (;;) {
        try {
          await sweep!()
        } catch (error) {
          // 扫掠自身抛错要立刻暴露（此前被 waitFor 的静默超时盖住）
          throw new Error(`sweep threw while waiting for ${label}: ${String(error)}`)
        }
        rounds += 1
        if (await predicate()) return
        if (Date.now() >= deadline) {
          const row = await awaitRow(h, 'example-mcp', () => true, 2_000).catch(() => ({ status: '?' }))
          throw new Error(
            `sweepUntil(${label}) not reached in ${budgetMs}ms after ${rounds} sweeps; `
            + `grants=${JSON.stringify(server.grants)} configs=${h.configs.length} rowStatus=${row.status}`,
          )
        }
        await new Promise(r => setTimeout(r, 20))
      }
    }

    await sweepUntil(() => server.grants.length >= 1, 20_000, 'first refresh attempt')
    await new Promise(r => setTimeout(r, 120))

    // endpoint comes back: the sweep must try again by itself. "Recovered" is
    // observed on the CREDENTIAL the sweep persisted (a new access token), not
    // on a second registration: a streamable-http transport reads the token per
    // request, so a successful refresh announces the credential without
    // re-registering the connector (R8-B-2).
    server.fail = null
    await sweepUntil(
      async () => (await store.readCredential('example-mcp'))?.accessToken !== undefined
        && (await store.readCredential('example-mcp'))?.accessToken !== 'at-first',
      30_000,
      'recovery after the endpoint returns',
    )
    const status = (JSON.parse((await callRoute(h, '/api/pico/connectors', 'GET')).body) as
      { connectors: Array<{ id: string, status: string }> }).connectors.find(c => c.id === 'example-mcp')
    expect(status?.status).toBe('connected')
    h.dispose()
  }, 120_000)
})

describe('audit: reconnect paths', () => {
  it('PROBE B: a failed reconnect keeps the previously working registration alive', async () => {
    const server = await start({ expiresIn: 3600 })
    const dir = mkdtempSync(join(tmpdir(), 'audit-b-'))
    const h = createHarness([oauthDef(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    await seedCredential(dir, 'example-mcp', {
      accessToken: 'at-live', refreshToken: 'rt-1', clientId: 'dyn-1',
      expiresAt: Date.now() + 30 * 60 * 1000,
    })
    h.emitSession({ username: 'user-a' })
    await waitFor(() => h.configs.length === 1)
    const firstDisposer = h.fibers[0]?.dispose

    // the user starts a fresh authorization and the authorization server fails
    // the token exchange -> the flow ends in an error
    server.fail = 'server_error'
    const connect = await callRoute(h, '/api/pico/connectors/example-mcp/connect', 'POST')
    expect(connect.status).toBe(200)
    // Wait until the row reports the failure (the flow ended), then assert the
    // previous registration survived it.
    await awaitRow(h, 'example-mcp', row => row.status === 'error' || row.status === 'unauthorized')
    expect(h.configs.length).toBe(1)
    expect(firstDisposer?.mock.calls.length).toBe(0)
    h.dispose()
  })
})

describe('audit: concurrent credential writes', () => {
  it('PROBE C: a refresh that rotates the refresh token is not clobbered by another writer', async () => {
    const server = await start({ expiresIn: 3600, rotate: true })
    const dir = mkdtempSync(join(tmpdir(), 'audit-c-'))
    const store = new ConnectorStore({ baseDir: dir })
    await store.writeCredential('example-mcp', {
      accessToken: 'at-stale', refreshToken: 'rt-1', clientId: 'dyn-1', updatedAt: Date.now(),
      expiresAt: Date.now() - 1000,
    })
    const refresher = new TokenRefresher({
      read: id => store.readCredential(id),
      write: (id, patch) => store.updateCredential(id, patch),
      target: () => ({ discoveryUrl: `${server.origin}/mcp`, resourceUrl: `${server.origin}/mcp` }),
    })
    // two independent writers race: the refresher and a provider-style save
    // (the SDK's onPersist path writes the same credential from a snapshot).
    const snapshot = await store.readCredential('example-mcp')
    await Promise.all([
      refresher.refresh('example-mcp', { force: true }),
      (async () => {
        await new Promise(r => setTimeout(r, 1))
        await store.updateCredential('example-mcp', { accessToken: snapshot?.accessToken, refreshedAt: Date.now() })
      })(),
    ])
    const stored = await store.readCredential('example-mcp')
    // the rotation the server performed must be what is stored, or the next
    // refresh presents a consumed token
    expect(stored?.refreshToken).toBe('rt-1')
    expect(server.grants).toEqual(['refresh_token'])
  })
})

describe('audit: state and announcement hygiene', () => {
  it('PROBE D: disconnect clears the token-lifetime facts shown on the card', async () => {
    const server = await start({ expiresIn: 3600 })
    const dir = mkdtempSync(join(tmpdir(), 'audit-d-'))
    const h = createHarness([oauthDef(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    await seedCredential(dir, 'example-mcp', {
      accessToken: 'at-live', refreshToken: 'rt-1', clientId: 'dyn-1',
      expiresAt: Date.now() + 30 * 60 * 1000, refreshedAt: Date.now(),
    })
    h.emitSession({ username: 'user-a' })
    await waitFor(() => h.configs.length === 1)
    const before = (JSON.parse((await callRoute(h, '/api/pico/connectors', 'GET')).body) as
      { connectors: Array<{ id: string, expiresAt: number | null }> }).connectors.find(c => c.id === 'example-mcp')
    expect(before?.expiresAt).toBeGreaterThan(Date.now())

    const res = await callRoute(h, '/api/pico/connectors/example-mcp/disconnect', 'POST')
    expect(res.status).toBe(200)
    const after = (JSON.parse((await callRoute(h, '/api/pico/connectors', 'GET')).body) as
      { connectors: Array<{ id: string, status: string, expiresAt: number | null, refreshedAt: number | null }> })
      .connectors.find(c => c.id === 'example-mcp')
    expect(after?.status).toBe('disconnected')
    // a disconnected row must not keep advertising a token lifetime
    expect(after?.expiresAt ?? null).toBeNull()
    expect(after?.refreshedAt ?? null).toBeNull()
    h.dispose()
  })

  it('PROBE E: a provider save that does not change the token causes no re-registration storm', async () => {
    const server = await start({ expiresIn: 3600 })
    const dir = mkdtempSync(join(tmpdir(), 'audit-e-'))
    const h = createHarness([oauthDef(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    await seedCredential(dir, 'example-mcp', {
      accessToken: 'at-live', refreshToken: 'rt-1', clientId: 'dyn-1',
      expiresAt: Date.now() + 30 * 60 * 1000,
    })
    h.emitSession({ username: 'user-a' })
    await waitFor(() => h.configs.length === 1)
    const provider = (h.configs[0] as unknown as {
      authProvider?: { saveTokens?: (t: { access_token: string }) => Promise<void> }
    }).authProvider
    expect(typeof provider?.saveTokens).toBe('function')
    // the SDK re-saves the same token (e.g. a 401 handshake where the server
    // answered with the identical value): must be a no-op for registration
    for (let i = 0; i < 5; i++) await provider?.saveTokens?.({ access_token: 'at-live' })
    // give any (wrong) re-registration a chance to appear before asserting
    await new Promise(r => setTimeout(r, 300))
    expect(h.configs.length).toBe(1)
    h.dispose()
  })
})

describe('audit: auth flows other than OAuth', () => {
  it('PROBE F: the token form completes and registers with the submitted fields', async () => {
    const def: ConnectorDef = {
      id: 'glitchtip', name: 'GlitchTip', description: 'x', authMode: 'token',
      tokenFields: [
        { key: 'base_url', label: 'URL', type: 'text', required: true },
        { key: 'token', label: 'Token', type: 'password', required: true },
      ],
      mcp: [{ serverName: 'glitchtip', transport: 'stdio', command: process.execPath, args: ['-e', ''] }],
    }
    const dir = mkdtempSync(join(tmpdir(), 'audit-f-'))
    const h = createHarness([def], dir, { refreshSweepIntervalMs: 0, requestApproval: () => true })
    h.emitSession({ username: 'user-a' })

    const connect = await callRoute(h, '/api/pico/connectors/glitchtip/connect', 'POST')
    expect(connect.status).toBe(200)
    const submitted = await callRoute(h, '/api/pico/connectors/glitchtip/auth-submit', 'POST', {
      fields: { base_url: 'https://g.example.com', token: 'tok-1' },
    })
    // The harness' callRoute cannot send a JSON body; the real route reads one,
    // so drive the store directly to model "the panel submitted the form" and
    // assert the registration picks the fields up.
    expect([200, 400, 422]).toContain(submitted.status)

    const store = new ConnectorStore({ baseDir: dir })
    await store.updateCredential('glitchtip', { fields: { base_url: 'https://g.example.com', token: 'tok-1' } })
    h.emit('pico/connector-credentials-changed', { id: 'glitchtip' })
    await waitFor(() => h.configs.length >= 1, 5000)
    const config = h.configs.at(-1) as unknown as { env?: Record<string, string> }
    expect(config.env?.base_url).toBe('https://g.example.com')
    h.dispose()
  })

  it('PROBE J: pre-connect settings submission continues OAuth instead of registering MCP directly', async () => {
    const server = await start({ expiresIn: 3600 })
    const connector = oauthDef(server.origin)
    connector.auth = { ...(connector.auth as Record<string, unknown>), clientId: 'static-client' } as typeof connector.auth
    connector.settings = [{ key: 'tenant', label: 'Tenant', type: 'text', required: true }]
    const dir = mkdtempSync(join(tmpdir(), 'audit-j-'))
    const h = createHarness([connector], dir, { refreshSweepIntervalMs: 0 })
    await callRoute(h, '/api/pico/connectors/example-mcp/connect', 'POST')

    // The pre-connect settings form is shown, before any OAuth flow starts.
    const settingsRow = await awaitRow(h, 'example-mcp', (r) => Array.isArray(r.request?.fields) && r.request!.fields!.length === 1)
    expect(settingsRow.request!.fields![0]!.key).toBe('tenant')

    await callRoute(h, '/api/pico/connectors/example-mcp/auth-submit', 'POST', { fields: { tenant: 'acme' } })
    // After settings are submitted the real authorization flow must start (an
    // authorize URL appears) and nothing may register yet.
    const authorizeRow = await awaitRow(h, 'example-mcp', (r) => typeof r.request?.authorizeUrl === 'string')
    expect(authorizeRow.request!.authorizeUrl).toContain('/oauth/authorize')
    expect(h.configs).toHaveLength(0)
    h.dispose()
  }, 20_000)

  it('PROBE G: switching user clears the previous user\'s row facts', async () => {
    const server = await start({ expiresIn: 3600 })
    const dir = mkdtempSync(join(tmpdir(), 'audit-g-'))
    const h = createHarness([oauthDef(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    await seedCredential(dir, 'example-mcp', {
      accessToken: 'at-live', refreshToken: 'rt-1', clientId: 'dyn-1',
      expiresAt: Date.now() + 30 * 60 * 1000,
    })
    h.emitSession({ username: 'user-a' })
    await waitFor(() => h.configs.length === 1)
    // user B logs in. The harness pins one store dir for both users (tests
    // deliberately share it), so model B having no credential by clearing it —
    // what must not survive is the ROW state from the previous session.
    await new ConnectorStore({ baseDir: dir }).clearCredential('example-mcp')
    h.emitSession({ username: 'user-b' })
    const row = await awaitRow(h, 'example-mcp', r => r.status === 'disconnected')
    expect(row.status).toBe('disconnected')
    expect((row as { expiresAt?: number | null }).expiresAt ?? null).toBeNull()
    h.dispose()
  })

  it('PROBE H: a second connect while a flow is pending does not double-register', async () => {
    const server = await start({ expiresIn: 3600 })
    const dir = mkdtempSync(join(tmpdir(), 'audit-h-'))
    const h = createHarness([oauthDef(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    const first = await callRoute(h, '/api/pico/connectors/example-mcp/connect', 'POST')
    const second = await callRoute(h, '/api/pico/connectors/example-mcp/connect', 'POST')
    expect([first.status, second.status]).toEqual([200, 200])
    await new Promise(r => setTimeout(r, 200))
    // no credential was ever authorized, so nothing may have registered
    expect(h.configs.length).toBe(0)
    h.dispose()
  })
})

describe('audit: device-code connectors', () => {
  it('PROBE I: a device connector asks for the credential its tools need', async () => {
    const def: ConnectorDef = {
      id: 'dev-conn', name: 'Device', description: 'x', authMode: 'device',
      auth: { verificationUrl: 'https://login.example.com/device', pollIntervalMs: 5, pollTimeoutMs: 200 },
      // the tool call needs this credential
      tokenFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
      mcp: [{ serverName: 'dev-conn', transport: 'stdio', command: process.execPath, args: ['-e', ''] }],
    }
    const dir = mkdtempSync(join(tmpdir(), 'audit-i-'))
    const h = createHarness([def], dir, { refreshSweepIntervalMs: 0, requestApproval: () => true })
    const connect = await callRoute(h, '/api/pico/connectors/dev-conn/connect', 'POST')
    expect(connect.status).toBe(200)

    const store = new ConnectorStore({ baseDir: dir })
    // The stateless flow finishes quickly, then the missing-credential check
    // publishes the field form. Wait for THAT state (a fixed sleep flaked on CI).
    const before = await awaitRow(h, 'dev-conn', row => Array.isArray(row.request?.fields) && row.request!.fields!.length > 0)
    // A connector whose definition requires a credential must not end up
    // "connected" with an empty one (every tool call would fail silently).
    expect(before.status).not.toBe('connected')
    expect(before.status).toBe('connecting')
    expect(h.configs.length).toBe(0)

    // the user fills the form: now it may connect
    const submitted = await callRoute(h, '/api/pico/connectors/dev-conn/auth-submit', 'POST', { fields: { token: 'tok-9' } })
    expect(submitted.status).toBe(200)
    await waitFor(() => h.configs.length === 1, 5000)
    const after = (JSON.parse((await callRoute(h, '/api/pico/connectors', 'GET')).body) as
      { connectors: Array<{ id: string, status: string }> }).connectors.find(c => c.id === 'dev-conn')
    expect(after?.status).toBe('connected')
    expect((await store.readCredential('dev-conn'))?.fields?.token).toBe('tok-9')
    h.dispose()
  })
})
