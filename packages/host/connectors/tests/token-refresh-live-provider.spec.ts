/**
 * Regression guard for the refresh-token **reuse** defect found through the
 * 2026-09-16 CI flake.
 *
 * The SDK's `OAuthClientProvider` keeps its own in-memory copy of the tokens and
 * only rewrites it from `saveTokens` — i.e. only when the **SDK itself** ran the
 * refresh. A refresh that *we* ran (background sweep, panel button, restore
 * path) rotates the refresh token in the store while the live transport keeps
 * the **already consumed** one. That transport's next 401 self-heal then
 * presents a dead grant, and a rotation-aware authorization server answers
 * `invalid_grant: refresh token already used`, which per RFC 6749 §10.4 revokes
 * the whole grant — the connector silently degrades to "authorize again".
 *
 * Observed in CI as:
 * `InvalidGrantError: refresh token already used` from
 * `StreamableHTTPClientTransport.send` → `auth()` → `executeTokenRequest`,
 * failing `audit-restart.spec.ts > 续期把 refresh token 轮换后，第二天…`
 * (~50% of runs, load-dependent, never reproduced on a 4-vCPU dev box because
 * the window between our refresh and the SDK's 401 is scheduling-dependent).
 *
 * These cases are **deterministic**: they assert the provider's view right after
 * an out-of-band refresh, so reverting `liveProviders`/`adopt` turns them red
 * without needing to win a race.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { callRoute, createHarness, waitFor } from './helpers/connector-harness.ts'
import { completeAuthorization, startRealMcpServer, type RealMcpServer } from './helpers/real-mcp-oauth-server.ts'
import { ConnectorStore } from '../src/store.ts'
import { createOAuthProvider, type RefreshedTokens } from '../src/mcp-oauth-provider.ts'
import type { ConnectorDef } from '../src/types.ts'

const servers: RealMcpServer[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()?.close()
})

function def(origin: string): ConnectorDef {
  return {
    id: 'example-a', name: 'Example-A', description: 'audit', authMode: 'oauth',
    auth: {
      authorizeUrl: `${origin}/oauth/authorize`, tokenUrl: `${origin}/oauth/token`, clientId: '',
      redirectUri: 'http://127.0.0.1/callback', pkce: true, publicClient: true,
      discoveryUrl: `${origin}/mcp`, scopes: 'mcp.read offline_access',
    },
    mcp: [{ serverName: 'example-a', transport: 'streamable-http', url: `${origin}/mcp` }],
  }
}

/** The transport the plugin registered, with the SDK provider the plugin handed it. */
type LiveConfig = { url: string, authProvider?: { tokens: () => { refresh_token?: string } | undefined } }

function liveConfig(h: ReturnType<typeof createHarness>): LiveConfig {
  const config = h.configs[0]
  if (config === undefined) throw new Error('no MCP config registered')
  return config as unknown as LiveConfig
}

/** Complete one interactive authorization so a credential (with a refresh token) is on disk. */
async function authorizeOnce(dir: string, server: RealMcpServer): Promise<void> {
  const first = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
  await callRoute(first, '/api/pico/connectors/example-a/connect', 'POST')
  const deadline = Date.now() + 8000
  let url: string | undefined
  while (Date.now() < deadline && url === undefined) {
    const res = await callRoute(first, '/api/pico/connectors/example-a/state', 'GET')
    url = (JSON.parse(res.body) as { request?: { authorizeUrl?: string } | null }).request?.authorizeUrl
    if (url === undefined) await new Promise(r => setTimeout(r, 25))
  }
  await completeAuthorization(url as string)
  await waitFor(() => first.configs.length === 1, 8000)
  first.dispose()
}

describe('a live transport must adopt a refresh token we rotated out of band', () => {
  it('hands the rotated refresh token to the registered provider', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'live-provider-'))
    await authorizeOnce(dir, server)

    // A running app: the transport registered with the credential on disk, so
    // the provider's in-memory mirror holds refresh token RT1.
    const h = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    await waitFor(() => h.configs.length === 1, 15_000)
    const before = liveConfig(h).authProvider?.tokens()?.refresh_token
    expect(before, 'the registration should carry a refresh token').toBeTruthy()

    // An out-of-band refresh — the panel button's route, same engine the
    // background sweep and the restore path use. The server rotates RT1 → RT2.
    const refreshed = await callRoute(h, '/api/pico/connectors/example-a/refresh', 'POST')
    expect(refreshed.status).toBe(200)

    const stored = await new ConnectorStore({ baseDir: dir }).readCredential('example-a')
    expect(stored?.refreshToken, 'the server must have rotated the refresh token').toBeTruthy()
    expect(stored?.refreshToken).not.toBe(before)

    // THE GUARD: the transport that is still in use must hold RT2, not RT1.
    // Without `liveProviders`/`adopt` this reads RT1 and the next 401 reuses a
    // consumed token.
    expect(liveConfig(h).authProvider?.tokens()?.refresh_token).toBe(stored?.refreshToken)
    h.dispose()
  }, 30_000)

  it('keeps the connector working across a restart that reuses the rotated token', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'live-provider-restart-'))
    await authorizeOnce(dir, server)

    // day 2: reopen, refresh out of band, then use the transport.
    const day2 = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    await waitFor(() => day2.configs.length === 1, 15_000)
    await callRoute(day2, '/api/pico/connectors/example-a/refresh', 'POST')
    day2.dispose()

    // day 3: reopen with the rotated credential; the server must never see a
    // reuse (revokedRefreshReuse is the server's own count of rejected reuses).
    server.expireAccessTokens()
    const day3 = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    await waitFor(() => day3.configs.length === 1, 15_000)
    expect(server.stats.revokedRefreshReuse).toBe(0)
    day3.dispose()
  }, 40_000)
})

describe('adopt() semantics', () => {
  const credential = {
    accessToken: 'access-1', refreshToken: 'refresh-1', clientId: 'client-1',
    expiresAt: Date.now() + 3600_000,
  }
  const target = {
    authorizeUrl: 'https://as.example/authorize', tokenUrl: 'https://as.example/token',
    redirectUri: 'http://127.0.0.1/callback', scope: undefined, discoveryUrl: 'https://as.example/mcp',
  } as unknown as Parameters<typeof createOAuthProvider>[0]['target']

  it('replaces the access token and the rotated refresh token', () => {
    const handle = createOAuthProvider({ credential, target })
    expect(handle.tokens?.refresh_token).toBe('refresh-1')
    const next: RefreshedTokens = { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: Date.now() + 60_000 }
    handle.adopt(next)
    expect(handle.tokens?.access_token).toBe('access-2')
    expect(handle.tokens?.refresh_token).toBe('refresh-2')
    expect(handle.tokens?.token_type).toBe('Bearer')
  })

  it('keeps the refresh token when a rotation does not issue a new one', () => {
    // RFC 6749 §6 lets a server answer without a new refresh token; dropping the
    // one we hold would leave the next refresh with no material at all.
    const handle = createOAuthProvider({ credential, target })
    handle.adopt({ accessToken: 'access-3', expiresAt: Date.now() + 60_000 })
    expect(handle.tokens?.access_token).toBe('access-3')
    expect(handle.tokens?.refresh_token).toBe('refresh-1')
  })

  it('feeds the SDK-facing view, not just an internal field', () => {
    // `tokens()` is what the SDK reads on its 401 path; the guard must land there.
    const handle = createOAuthProvider({ credential, target })
    handle.adopt({ accessToken: 'access-4', refreshToken: 'refresh-4', expiresAt: Date.now() + 60_000 })
    expect(handle.provider.tokens()?.refresh_token).toBe('refresh-4')
    expect(handle.provider.tokens()?.access_token).toBe('access-4')
  })
})
