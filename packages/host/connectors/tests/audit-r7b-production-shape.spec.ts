/**
 * Production transport shape regression (R7-B P1-1, 2026-09-24).
 *
 * The shipped `@deepseek-ai/dsh-mcp-client` builds every streamable-http
 * transport as
 *
 *     new StreamableHTTPClientTransport(new URL(config.url), {
 *       requestInit: { headers: config.headers },
 *       ...config.authProvider === undefined ? {} : { authProvider: config.authProvider },
 *     })
 *
 * (`patches/dsh-mcp-client@0.1.6-alpha.2.patch`). The pinned SDK's
 * `_commonHeaders()` writes the provider's LIVE token first and then spreads
 * `requestInit.headers` over it, so any `Authorization` the connector baked
 * into that object WINS over the token a 401 refresh just obtained: the refresh
 * succeeds, the retry replays the DEAD token, and the first tool call fails with
 * `SdkHttpError: Server returned 401 after re-authentication`.
 *
 * The four cases below are the audit's differential, kept as a permanent
 * regression because the judgements are only meaningful side by side:
 *
 *   A — the transport built WITHOUT `requestInit` (what the older 401
 *       regressions used, and a shape production never produces) recovers;
 *   B — the PRODUCTION shape recovers, the server sees exactly one
 *       `refresh_token` grant, no refresh-token reuse, and the dead token is
 *       never presented again (mutation: bake the header back ⇒ B fails with
 *       the signature above);
 *   C — on the production shape our `AuthProvider` face is still NOT classified
 *       as an `OAuthClientProvider` and the outbound fence still finds the
 *       origin scope (if the SDK adapted our provider, `onUnauthorized` would
 *       be replaced by the SDK's own refresh and the single flight would be
 *       bypassed);
 *   D — the same production shape with `Authorization` removed recovers:
 *       the mechanism check that names the header as the cause.
 *
 * Everything runs against the repo's real fixtures: a real HTTP MCP server
 * protected by a real authorization server (discovery, dynamic client
 * registration, PKCE, bearer validation, rotating refresh tokens with reuse
 * detection).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { callRoute, createHarness, waitFor } from './helpers/connector-harness.ts'
import { completeAuthorization, startRealMcpServer, type RealMcpServer } from './helpers/real-mcp-oauth-server.ts'
import type { ConnectorDef } from '../src/types.ts'

const servers: RealMcpServer[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()?.close()
})

function def(origin: string): ConnectorDef {
  return {
    id: 'real-mcp', name: 'Real MCP', description: 'audit', authMode: 'oauth',
    auth: {
      authorizeUrl: `${origin}/oauth/authorize`, tokenUrl: `${origin}/oauth/token`, clientId: '',
      redirectUri: 'http://127.0.0.1/callback', pkce: true, publicClient: true,
      discoveryUrl: `${origin}/mcp`, scopes: 'mcp.read offline_access',
    },
    mcp: [{ serverName: 'real-mcp', transport: 'streamable-http', url: `${origin}/mcp` }],
  }
}

/** The config `registerMcp` hands `dsh-mcp-client` for one server. */
interface RegisteredTransport {
  url: string
  headers: Record<string, string>
  authProvider: {
    token: () => Promise<string | undefined>
    onUnauthorized: (ctx: unknown) => Promise<void>
    tokens: () => Promise<{ access_token?: string, refresh_token?: string } | undefined>
  }
}

async function state(h: ReturnType<typeof createHarness>, id: string): Promise<{ status: string, request?: { authorizeUrl?: string } | null }> {
  const res = await callRoute(h, `/api/pico/connectors/${id}/state`, 'GET')
  return JSON.parse(res.body) as { status: string, request?: { authorizeUrl?: string } | null }
}

async function awaitAuthorizeUrl(h: ReturnType<typeof createHarness>, id: string): Promise<string> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const url = (await state(h, id)).request?.authorizeUrl
    if (url) return url
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error('no authorize URL')
}

/** Run the connector's real authorization flow and return its registered config. */
async function register(h: ReturnType<typeof createHarness>): Promise<RegisteredTransport> {
  await callRoute(h, '/api/pico/connectors/real-mcp/connect', 'POST')
  await completeAuthorization(await awaitAuthorizeUrl(h, 'real-mcp'))
  await waitFor(() => h.configs.length === 1, 8000)
  return h.configs[0] as unknown as RegisteredTransport
}

describe('R7-B production transport shape', () => {
  it('A: no requestInit (a shape production never builds) — recovers', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r7b-a-'))
    const h = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    const config = await register(h)
    const client = new Client({ name: 'audit', version: '1' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { authProvider: config.authProvider })
    await client.connect(transport)
    try {
      server.expireAccessTokens()
      const call = await client.callTool({ name: 'echo', arguments: { text: 'A' } })
      expect(call.content?.[0]?.text).toBe('echo:A')
    } finally {
      await client.close().catch(() => {})
      h.dispose()
    }
  }, 30_000)

  it('B: production shape (requestInit.headers = renderHeaders output) — recovers with the NEW token', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r7b-b-'))
    const h = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    const config = await register(h)

    // The fix itself, asserted at the config boundary: with a provider carrying
    // the credential, our `Authorization` must not be baked into requestInit —
    // it would shadow the live token the SDK writes first.
    expect(config.headers.Authorization).toBeUndefined()
    const stale = (await config.authProvider.tokens())?.access_token
    expect(stale, '前置：授权完成后必须有一枚访问令牌').toBeTruthy()
    const before = server.stats.grants.filter(g => g === 'refresh_token').length

    const client = new Client({ name: 'audit', version: '1' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
      authProvider: config.authProvider,
    })
    await client.connect(transport)
    try {
      server.expireAccessTokens()
      const call = await client.callTool({ name: 'echo', arguments: { text: 'B' } })
      expect(call.content?.[0]?.text).toBe('echo:B')
      expect(server.stats.grants.filter(g => g === 'refresh_token').length - before).toBe(1)
      expect(server.stats.revokedRefreshReuse).toBe(0)
      // 旧令牌不能出现在续期后的重试里：活令牌出现之后，服务端一次都不许再见到它。
      const live = (await config.authProvider.tokens())?.access_token
      expect(live).toBeDefined()
      expect(live).not.toBe(stale)
      const seen = server.stats.mcpBearerTokens
      expect(seen.at(-1)).toBe(live)
      const firstLive = seen.indexOf(live!)
      expect(firstLive).toBeGreaterThanOrEqual(0)
      expect(seen.slice(firstLive).filter(token => token === stale)).toEqual([])
      expect(seen.filter(token => token === stale).length).toBeGreaterThanOrEqual(1)
      // 同一条活着的传输自己就恢复了（不需要等同账号重注册把新传输换上来）。
      const second = await client.callTool({ name: 'echo', arguments: { text: 'B2' } })
      expect(second.content?.[0]?.text).toBe('echo:B2')
      expect(server.stats.grants.filter(g => g === 'refresh_token').length - before).toBe(1)
    } finally {
      await client.close().catch(() => {})
      h.dispose()
    }
  }, 30_000)

  it('C: the provider face is NOT OAuth-classified and the fence still finds the origin scope', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r7b-c-'))
    const h = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    const config = await register(h)
    const { allowedOutboundOriginsOf } = await import('../src/outbound.ts')
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
      authProvider: config.authProvider,
    }) as unknown as { _oauthProvider?: unknown, _authProvider?: unknown }
    // An OAuth-classified provider is REPLACED by the SDK's `adaptOAuthProvider`,
    // whose `onUnauthorized` is the SDK's own refresh — that is how the single
    // flight gets bypassed, so the classification is part of this regression.
    expect(transport._oauthProvider).toBeUndefined()
    expect(transport._authProvider).toBe(config.authProvider)
    expect((allowedOutboundOriginsOf(transport._authProvider) ?? new Set()).size).toBeGreaterThan(0)
    h.dispose()
  }, 30_000)

  it('D: production shape WITHOUT the baked Authorization — recovers (mechanism check)', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r7b-d-'))
    const h = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    const config = await register(h)
    // Built by hand rather than taken from the connector: this is the control
    // that isolates the header, independent of how the connector renders it.
    const baked = { ...config.headers, Authorization: `Bearer ${(await config.authProvider.tokens())?.access_token ?? ''}` }
    const { Authorization: _drop, ...rest } = baked
    const client = new Client({ name: 'audit', version: '1' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: rest },
      authProvider: config.authProvider,
    })
    await client.connect(transport)
    try {
      server.expireAccessTokens()
      const call = await client.callTool({ name: 'echo', arguments: { text: 'D' } })
      expect(call.content?.[0]?.text).toBe('echo:D')
    } finally {
      await client.close().catch(() => {})
      h.dispose()
    }
  }, 30_000)
})
