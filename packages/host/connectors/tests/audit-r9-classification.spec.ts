/**
 * 2026-09-16 R9 审计回归：连接失败的行状态分类必须只用**稳定 code**。
 *
 * 背景（i18n #77 把分类从中文子串迁到 `auth-required` code）：
 *  - base 的判据是 `message.includes('授权' | 'token' | '登录')`；
 *  - 迁移时有两处漏包/错包，都会让用户在面板上看到与实际相反的结论：
 *    ① `discoverMcpOAuth` 里被出站策略拒绝的 authorize/token 端点抛的是裸
 *       `OutboundUrlBlockedError`（旧判据命中 `授权`/`token` ⇒ unauthorized），
 *       漏包后落 `error`，英文界面还会被套回 `Connection failed: …` 兜底；
 *    ② `server-side` 定义缺 `fetchToken`（JSON 定义不可能带函数）被 `authRequired`
 *       包成 `auth-required` ⇒ 面板让用户"重新授权"一个永远不会成功的连接器，
 *       而旧判据对它不命中（`fetchToken` 是大写 T）⇒ 应为普通 error。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { runAuth } from '../src/auth.ts'
import { connectorErrorCodeOf } from '../src/connector-error.ts'
import { callRoute, createHarness } from './helpers/connector-harness.ts'
import type { ConnectorDef } from '../src/types.ts'

const realFetch = globalThis.fetch

afterEach(() => { globalThis.fetch = realFetch })

/** Poll the connector row until the connect flow settles. */
async function rowAfterConnect(
  harness: ReturnType<typeof createHarness>,
  id: string,
): Promise<{ status?: string, error?: string, errorCode?: string }> {
  let row: { status?: string, error?: string, errorCode?: string } = {}
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const res = await callRoute(harness, `/api/pico/connectors/${id}/state`, 'GET')
    row = JSON.parse(res.body) as typeof row
    if (row.status === 'error' || row.status === 'unauthorized') return row
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return row
}

it('a policy-blocked authorize/token endpoint published by discovery stays `unauthorized`', async () => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url === 'https://mcp.example/mcp') {
      return new Response('nope', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"' },
      })
    }
    if (url === 'https://mcp.example/.well-known/oauth-protected-resource') {
      return new Response(JSON.stringify({
        resource: 'https://mcp.example/mcp',
        authorization_servers: ['https://as.example'],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.startsWith('https://as.example/.well-known/oauth-authorization-server')) {
      return new Response(JSON.stringify({
        issuer: 'https://as.example',
        authorization_endpoint: 'https://169.254.169.254/authorize',
        token_endpoint: 'https://169.254.169.254/token',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch

  const def = {
    id: 'evil-mcp',
    name: 'Evil MCP',
    description: 'x',
    authMode: 'oauth',
    auth: {
      authorizeUrl: '',
      tokenUrl: '',
      clientId: 'static-client',
      redirectUri: 'http://127.0.0.1/callback',
      pkce: true,
      publicClient: true,
      discoveryUrl: 'https://mcp.example/mcp',
    },
    mcp: [{ serverName: 'evil-mcp', transport: 'streamable-http', url: 'https://mcp.example/mcp' }],
  } as unknown as ConnectorDef

  const dir = mkdtempSync(join(tmpdir(), 'r9-classify-'))
  const harness = createHarness([def], dir)
  await callRoute(harness, '/api/pico/connectors/evil-mcp/connect', 'POST')
  const row = await rowAfterConnect(harness, 'evil-mcp')
  harness.dispose()

  expect(row.status).toBe('unauthorized')
  expect(row.errorCode).toBe('auth-required')
  expect(String(row.error)).toMatch(/169\.254\.169\.254|内网|链路本地|元数据/u)
}, 20_000)

it('a server-side definition without fetchToken is a configuration error, not `unauthorized`', async () => {
  const def = {
    id: 'ss',
    name: 'ss',
    description: 'server side',
    authMode: 'server-side',
    auth: {},
    mcp: [{ serverName: 'ss-server', transport: 'stdio', command: 'node', args: [] }],
  } as unknown as ConnectorDef
  const dir = mkdtempSync(join(tmpdir(), 'r9-classify-ss-'))
  const harness = createHarness([def], dir)
  await callRoute(harness, '/api/pico/connectors/ss/connect', 'POST')
  const row = await rowAfterConnect(harness, 'ss')
  harness.dispose()

  expect(row.status).toBe('error')
  expect(row.errorCode).toBeUndefined()
  expect(String(row.error)).toContain('fetchToken')
}, 20_000)

it('a NETWORK failure at the token exchange stays an ordinary error', async () => {
  // 2026-09-16 R2 audit: `flowFetch` wrapped EVERY throw of an authorizing step
  // into `auth-required`, so a flaky network (undici `TypeError: fetch failed`)
  // told the user to "authorize again" — the pre-i18n substring rule classified
  // it as an ordinary error. Only policy/timeout failures may be upgraded.
  const realFetch = globalThis.fetch
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url === 'https://mcp.example/mcp') {
      return new Response('nope', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"' },
      })
    }
    if (url === 'https://mcp.example/.well-known/oauth-protected-resource') {
      return json({ resource: 'https://mcp.example/mcp', authorization_servers: ['https://as.example'] })
    }
    if (url.startsWith('https://as.example/.well-known/oauth-authorization-server')) {
      return json({
        issuer: 'https://as.example',
        authorization_endpoint: 'https://as.example/authorize',
        // A closed port: undici rejects with TypeError('fetch failed').
        token_endpoint: 'https://127.0.0.1:1/token',
      })
    }
    // The loopback callback goes to the REAL fetch (a local http server).
    return await realFetch(url)
  }) as unknown as typeof fetch

  const def = {
    id: 'probe-net',
    name: 'probe',
    description: 'probe',
    authMode: 'oauth',
    auth: {
      discoveryUrl: 'https://mcp.example/mcp',
      authorizeUrl: '',
      tokenUrl: '',
      clientId: 'c',
      redirectUri: 'http://127.0.0.1/callback',
      pkce: true,
      publicClient: true,
    },
    mcp: [{ serverName: 'probe', transport: 'streamable-http', url: 'https://mcp.example/mcp' }],
  } as unknown as ConnectorDef

  try {
    const controller = new AbortController()
    let error: unknown
    try {
      await runAuth(def, {
        signal: controller.signal,
        locale: 'zh',
        onRequest: (request: { authorizeUrl?: string }) => {
          if (typeof request.authorizeUrl !== 'string') return
          const parsed = new URL(request.authorizeUrl)
          const redirect = parsed.searchParams.get('redirect_uri') ?? ''
          const state = parsed.searchParams.get('state') ?? ''
          setTimeout(() => { void realFetch(`${redirect}?state=${state}&code=THE-CODE`).catch(() => {}) }, 0)
        },
      })
    } catch (cause) {
      error = cause
    }
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toContain('fetch failed')
    expect(connectorErrorCodeOf(error)).toBeUndefined()
    // …and the pre-i18n rule agrees: this is an ordinary error, not "authorize again".
    const baseRule = message.includes('授权') || message.includes('token') || message.includes('登录')
    expect(baseRule).toBe(false)
  } finally {
    globalThis.fetch = realFetch
  }
}, 20_000)
