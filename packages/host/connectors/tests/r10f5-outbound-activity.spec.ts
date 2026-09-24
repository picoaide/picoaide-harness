/**
 * R10-F5 regression — the fence's outbound bookkeeping must be BOUNDED.
 *
 * R10-B-06: `outboundActivity` was incremented before `await options.base(...)`
 * and decremented in its `finally`. A `base` that never settles — a custom
 * fetch that ignores its signal, or a socket that simply hangs — therefore never
 * ran that `finally`: the endpoint's count stayed > 0 FOREVER, so every later
 * credential rebuild walked the full grace and logged the misleading
 * `重建等待在途调用超时` line while nothing was on the wire at all (the R9
 * suite's own stalled-fetch case creates exactly such a fetch; it asserts the
 * log line and the rebuild, not that the count came back).
 *
 * The criterion here is the log the user and the operator read: the FIRST
 * rebuild meets a call that really is in flight and says so, the SECOND must
 * not. Timing is used only as a lower bound (a precondition that the first wait
 * really happened), never as the discriminator.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { callRoute, createHarness, waitFor } from './helpers/connector-harness.ts'
import { completeAuthorization, startRealMcpServer, type RealMcpServer } from './helpers/real-mcp-oauth-server.ts'
import { ConnectorStore } from '../src/store.ts'
import type { ConnectorDef } from '../src/types.ts'

/** The injected grace: short enough for a test, long enough to be observable. */
const GRACE_MS = 400

const servers: RealMcpServer[] = []
afterEach(async () => { while (servers.length) await servers.pop()?.close() })

interface RegisteredTransport {
  serverName: string
  url?: string
  headers?: Record<string, string>
  authProvider?: unknown
}

function def(origin: string, headers: Record<string, string>): ConnectorDef {
  return {
    id: 'probe-mcp',
    name: 'Probe MCP',
    description: 'r10f5 b6',
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
    mcp: [{ serverName: 'probe-a', transport: 'streamable-http', url: `${origin}/mcp`, headers }],
  }
}

async function connectAndAuthorize(h: ReturnType<typeof createHarness>): Promise<RegisteredTransport> {
  await callRoute(h, '/api/pico/connectors/probe-mcp/connect', 'POST')
  const deadline = Date.now() + 8000
  let url: string | undefined
  while (Date.now() < deadline) {
    const res = await callRoute(h, '/api/pico/connectors/probe-mcp/state', 'GET')
    url = (JSON.parse(res.body) as { request?: { authorizeUrl?: string } }).request?.authorizeUrl
    if (url) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (url === undefined) throw new Error('no authorize URL')
  await completeAuthorization(url)
  await waitFor(() => h.configs.length === 1, 10_000)
  return h.configs[0] as unknown as RegisteredTransport
}

/**
 * The repo's own recipe for a provider-LESS registration: park the credential
 * inside the refresh lead window, make the metadata endpoint fail, re-register
 * through a session event. Only that shape rebuilds on a credential change.
 */
async function toProviderless(
  h: ReturnType<typeof createHarness>,
  server: RealMcpServer,
  dir: string,
  expected: number,
): Promise<void> {
  const store = new ConnectorStore({ baseDir: dir })
  // `updateCredential` merges into what is on disk, so the patch carries only
  // the refresh-window facts (no `as never` spread of a read record).
  await store.updateCredential('probe-mcp', { expiresAt: Date.now() + 30_000, refreshedAt: Date.now() })
  server.setMetadataFailure(50)
  h.emitSession({ username: 'user-a', serverURL: 'https://harness.example.com' })
  await waitFor(() => h.configs.length === expected, 15_000)
  expect((h.configs[expected - 1] as unknown as RegisteredTransport).authProvider, '前置：这次注册没有 provider').toBeUndefined()
}

/** Write a credential straight to disk — the shape a refresh leaves behind. */
async function announceNewToken(dir: string, accessToken: string): Promise<void> {
  const store = new ConnectorStore({ baseDir: dir })
  await store.updateCredential('probe-mcp', { accessToken, expiresAt: Date.now() + 30_000, refreshedAt: Date.now() })
}

/** Rebuilds that gave up waiting for an in-flight call (the misleading line). */
function timeoutLines(h: ReturnType<typeof createHarness>): number {
  return h.warns.filter(line => line.includes('重建等待在途调用超时')).length
}

describe('R10-B-06: a call that never settles must not charge every later rebuild', () => {
  it('the first rebuild waits for the call in flight, the next one does not', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r10f5-b6-'))
    const h = createHarness([def(server.origin, { 'X-Probe-Key': 'static-value' })], dir, {
      refreshSweepIntervalMs: 0,
      rebuildIdleGraceMs: GRACE_MS,
    })
    try {
      await connectAndAuthorize(h)
      await toProviderless(h, server, dir, 2)
      const config = h.configs.at(-1) as unknown as RegisteredTransport

      // A `tools/call` whose fetch NEVER settles — not even on abort. This is
      // the shape that leaked the count, because the `finally` around
      // `await options.base(...)` only runs once that promise settles.
      let release: ((value: Response) => void) | undefined
      let enter: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enter = resolve })
      const stalled: typeof fetch = async (input, init) => {
        if (!String(init?.body ?? '').includes('tools/call')) return await fetch(input as never, init as never)
        // The fence counts a request BEFORE it calls `base`, so being here is
        // the deterministic signal that this call is on the books.
        enter?.()
        return await new Promise<Response>((resolve) => { release = resolve })
      }
      const client = new Client({ name: 'r10f5-b6', version: '1' }, { capabilities: {} })
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url ?? ''), {
        requestInit: { headers: { ...(config.headers ?? {}) } },
        fetch: stalled,
      }))
      const pending = client.callTool({ name: 'echo', arguments: { text: 'never' } }).then(
        () => 'resolved' as const,
        (error: unknown) => error as Error,
      )
      try {
        await entered

        // (1) Precondition, not the criterion: the first rebuild DOES meet the
        // call in flight and says so (without this, the second assertion could
        // pass because nothing was ever counted).
        await announceNewToken(dir, 'at-r10f5-b6-1')
        const firstAt = Date.now()
        h.emit('pico/connector-credentials-changed', { id: 'probe-mcp' })
        await waitFor(() => h.configs.length === 3, 15_000)
        expect(timeoutLines(h), '前置：第一次重建确实撞上了在途调用').toBe(1)
        expect(Date.now() - firstAt, '前置：等待确实等满了 grace').toBeGreaterThanOrEqual(GRACE_MS - 50)

        // (2) The criterion: the ticket that outlived the grace is given back,
        // so the next rebuild neither waits the grace again nor lies about it.
        await announceNewToken(dir, 'at-r10f5-b6-2')
        h.emit('pico/connector-credentials-changed', { id: 'probe-mcp' })
        await waitFor(() => h.configs.length === 4, 15_000)
        expect(
          timeoutLines(h),
          '一个永不结算的调用不得让此后每次重建都白等满 grace 并留误导 warn（计数永久 >0 的形态）',
        ).toBe(1)
        expect(
          (h.configs.at(-1) as unknown as RegisteredTransport).headers?.Authorization,
          '重建照常拿到轮换后的新凭据',
        ).toBe('Bearer at-r10f5-b6-2')
      } finally {
        release?.(new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'late' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ))
        await client.close().catch(() => {})
        await pending.catch(() => {})
      }
    } finally { h.dispose() }
  }, 90_000)
})
