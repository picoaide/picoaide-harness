/**
 * R10 N2 (second half) regression — the exclusive-transport proof and the
 * outbound-ticket bookkeeping must be the SAME key.
 *
 * R10 N2 first round gave the give-up release a proof: the fence files outbound
 * tickets per transport INSTANCE, and the rebuild waiter can only name the
 * endpoint, so it may release endpoint-wide tickets **only** when no other live
 * registration talks to that endpoint. The proof compared
 * `registration.endpoint === streamableHttpUrl(...).toString()` — raw strings —
 * while the fence files every ticket under `origin + pathname`. Two transports on
 * one endpoint whose URLs differ only in the query string therefore landed in ONE
 * ticket bucket but were "different endpoints" to the proof: the rebuild of the
 * first proved itself alone, gave up, and cleared the second's in-flight ticket
 * (W2 remeasured `busyAfterGiveUp=false` for the `/mcp?a=1` vs `/mcp?a=2` pair —
 * the pre-fix damaged shape — while the same-URL pair had correctly stayed
 * `true`).
 *
 * Both halves are judged here through the plugin's OWN rebuild path, with real
 * `StreamableHTTPClientTransport` instances sending real `tools/call` requests to
 * a real MCP endpoint; the criterion is the fence's own bookkeeping plus the fate
 * of the held call. The positive control keeps R10-B-06 alive: when the proof
 * really does hold, the give-up still releases.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ensureMcpTransportRedirectFence, isMcpOutboundBusy, mcpActivityKey } from '../src/mcp-transport-fence.ts'
import { callRoute, createHarness, waitFor } from './helpers/connector-harness.ts'
import { completeAuthorization, startRealMcpServer, type RealMcpServer } from './helpers/real-mcp-oauth-server.ts'
import { ConnectorStore } from '../src/store.ts'
import type { ConnectorDef } from '../src/types.ts'

const servers: RealMcpServer[] = []
afterEach(async () => { while (servers.length) await servers.pop()?.close() })

/** The grace injected into the plugin: long enough to observe, short enough to test. */
const GRACE_MS = 1_200

/**
 * How long the ad-hoc transport holds its `tools/call`. It is the FIXTURE (a
 * slow-but-normal call), not a criterion: it must outlive the rebuild's grace
 * (so the rebuild gives up with the call still pending) and still be pending when
 * the give-up happens.
 */
const SLOW_CALL_MS = 2_600

/**
 * The two spellings of one endpoint: same origin, same path, and something the
 * bookkeeping key deliberately drops. Both pairs must reach the same ticket
 * bucket, so both must count as "one endpoint" for the exclusive proof:
 *  - a query string (`/mcp?a=1` vs `/mcp?a=2` — W2's counterexample), and
 *  - a fragment (`/mcp#one` vs `/mcp#two`, which never reaches a server at all).
 */
const SPELLING_PAIRS: ReadonlyArray<{ label: string, a: string, b: string }> = [
  { label: 'query string', a: '?a=1', b: '?a=2' },
  { label: 'hash fragment', a: '#one', b: '#two' },
]

/** The same-query spellings the single-connector positive control uses. */
const QUERY_A = '?a=1'

function def(id: string, serverName: string, origin: string, query: string): ConnectorDef {
  return {
    id,
    name: `Probe ${id}`,
    description: 'r10 h2 ticket key parity',
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
    mcp: [{ serverName, transport: 'streamable-http', url: `${origin}/mcp${query}`, headers: {} }],
  }
}

/** A `tools/call` fetch whose answer is held until the caller releases it. */
function stallingFetch(): { fetch: typeof fetch, entered: Promise<void>, release: () => void } {
  let enter: (() => void) | undefined
  let release: (() => void) | undefined
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  const fetchImpl: typeof fetch = async (input, init) => {
    if (!String(init?.body ?? '').includes('tools/call')) return await fetch(input as never, init as never)
    enter?.()
    await held
    return await fetch(input as never, init as never)
  }
  return { fetch: fetchImpl, entered, release: () => { release?.() } }
}

/** Connect + authorize one connector through the plugin's own routes. */
async function authorize(h: ReturnType<typeof createHarness>, id: string, expected: number): Promise<void> {
  await callRoute(h, `/api/pico/connectors/${id}/connect`, 'POST')
  const deadline = Date.now() + 8000
  let url: string | undefined
  while (Date.now() < deadline) {
    const res = await callRoute(h, `/api/pico/connectors/${id}/state`, 'GET')
    url = (JSON.parse(res.body) as { request?: { authorizeUrl?: string } }).request?.authorizeUrl
    if (url) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (url === undefined) throw new Error(`no authorize URL for ${id}`)
  await completeAuthorization(url)
  await waitFor(() => h.configs.length >= expected, 15_000)
}

/**
 * The repo's own recipe for a PROVIDER-LESS registration (the only http shape a
 * credential change rebuilds): park the credential inside the refresh lead
 * window, make the metadata endpoint fail, re-register through a session event.
 */
async function toProviderless(
  h: ReturnType<typeof createHarness>,
  server: RealMcpServer,
  dir: string,
  ids: string[],
  expected: number,
): Promise<void> {
  const store = new ConnectorStore({ baseDir: dir })
  const patch = { expiresAt: Date.now() + 30_000, refreshedAt: Date.now() }
  for (const id of ids) await store.updateCredential(id, patch)
  server.setMetadataFailure(50)
  h.emitSession({ username: 'user-a', serverURL: 'https://harness.example.com' })
  await waitFor(() => h.configs.length === expected, 15_000)
  for (const config of h.configs.slice(-ids.length)) {
    expect((config as unknown as { authProvider?: unknown }).authProvider, '前置：这次注册没有 provider').toBeUndefined()
  }
}

/** Write a credential straight to disk — the shape a refresh leaves behind. */
async function announceNewToken(dir: string, id: string, accessToken: string): Promise<void> {
  const store = new ConnectorStore({ baseDir: dir })
  await store.updateCredential(id, { accessToken, expiresAt: Date.now() + 30_000, refreshedAt: Date.now() })
}

/**
 * A real hardened transport on `url` with one `tools/call` held on the wire: the
 * in-flight ticket this file is about.
 */
async function openHeldCall(url: string, bearer: string): Promise<{
  client: Client
  pending: Promise<unknown>
  release: () => void
}> {
  await ensureMcpTransportRedirectFence()
  const held = stallingFetch()
  const client = new Client({ name: 'r10-h2', version: '1' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    fetch: held.fetch,
  }))
  const pending = client.callTool({ name: 'echo', arguments: { text: '在途' } }).catch((error: unknown) => error)
  await held.entered
  const slow = setTimeout(held.release, SLOW_CALL_MS)
  slow.unref?.()
  return { client, pending, release: held.release }
}

describe('R10 N2: the exclusive proof and the ticket key are one normalization', () => {
  it('the proof compares endpoints under the fence\'s own activity key', () => {
    const origin = 'http://127.0.0.1:1'
    // 记账键把查询串与 hash 都丢掉（票桶只有 origin+pathname），所以"同一端点"的判据
    // 必须给出同一个答案：两对拼写都要落在同一个键上（W2 反例的 `/mcp?a=1` vs `/mcp?a=2`，
    // 以及同样只差"不发往服务器那一段"的 `/mcp#one` vs `/mcp#two`）。
    for (const pair of SPELLING_PAIRS) {
      expect(
        mcpActivityKey(`${origin}/mcp${pair.a}`),
        `只差${pair.label}的两条 URL 必须落在同一个记账键上`,
      ).toBe(mcpActivityKey(`${origin}/mcp${pair.b}`))
      expect(mcpActivityKey(`${origin}/mcp${pair.a}`)).toBe(mcpActivityKey(`${origin}/mcp`))
    }
    // 不同路径/不同 origin 仍然是不同端点（判据不能退化成"永远不是独占"）。
    expect(mcpActivityKey(`${origin}/mcp`)).not.toBe(mcpActivityKey(`${origin}/other`))
    expect(mcpActivityKey(`${origin}/mcp`)).not.toBe(mcpActivityKey('http://127.0.0.1:2/mcp'))
    // 解析不出来的 URL 没有桶：调用方因此永远证明不了"我是唯一"。
    expect(mcpActivityKey('not a url')).toBeNull()
  })

  for (const pair of SPELLING_PAIRS) {
  it(`a rebuild of the "${pair.a}" connector must not clear the "${pair.b}" sibling's in-flight ticket`, async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r10h2-key-'))
    const h = createHarness(
      [def('connector-a', 'probe-a', server.origin, pair.a), def('connector-b', 'probe-b', server.origin, pair.b)],
      dir,
      { refreshSweepIntervalMs: 0, rebuildIdleGraceMs: GRACE_MS },
    )
    const bucket = `${server.origin}/mcp`
    let held: Awaited<ReturnType<typeof openHeldCall>> | undefined
    try {
      await authorize(h, 'connector-a', 1)
      await authorize(h, 'connector-b', 2)
      expect(h.configs.map(config => config.url).sort(), `前置：两条活传输的 URL 只差${pair.label}`)
        .toEqual([`${bucket}${pair.a}`, `${bucket}${pair.b}`].sort())
      // 两条都变成 provider-less（凭据变更才会重建 transport）。
      await toProviderless(h, server, dir, ['connector-a', 'connector-b'], 4)

      const live = (await new ConnectorStore({ baseDir: dir }).readCredential('connector-b'))?.accessToken
      expect(live, '前置：connector-b 必须有可用令牌').toBeTruthy()
      // 乙 的在途调用：它落在与甲**同一个**票桶里（只差那一段被丢掉的拼写）。
      held = await openHeldCall(`${bucket}${pair.b}`, String(live))
      expect(isMcpOutboundBusy(bucket), '前置：票必须在桶里').toBe(true)

      // 甲 的凭据变更 ⇒ 甲重建、等满 grace、放弃。这一步**不得**动乙的记账。
      await announceNewToken(dir, 'connector-a', 'at-h2-a')
      h.emit('pico/connector-credentials-changed', { id: 'connector-a' })
      await waitFor(() => h.warns.some(line => line.includes('probe-a') && line.includes('超时')), 15_000)
      expect(
        isMcpOutboundBusy(bucket),
        '甲 放弃等待之后，乙 的在途票据必须仍然在账上（比较原串时这里是 false）',
      ).toBe(true)

      // 后果面：乙 的调用必须能照常结算，而不是被别人的重建"读成 idle 后掐断"。
      held.release()
      expect(await held.pending).toMatchObject({ content: [{ type: 'text', text: 'echo:在途' }] })
      await waitFor(() => !isMcpOutboundBusy(bucket), 15_000)
    } finally {
      held?.release()
      await held?.client.close().catch(() => {})
      await held?.pending.catch(() => {})
      h.dispose()
    }
  }, 90_000)
  }

  it('positive control: with no sibling live transport the give-up still releases (R10-B-06)', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r10h2-solo-'))
    const h = createHarness([def('connector-a', 'probe-a', server.origin, QUERY_A)], dir, {
      refreshSweepIntervalMs: 0,
      rebuildIdleGraceMs: GRACE_MS,
    })
    const bucket = `${server.origin}/mcp`
    let held: Awaited<ReturnType<typeof openHeldCall>> | undefined
    try {
      await authorize(h, 'connector-a', 1)
      await toProviderless(h, server, dir, ['connector-a'], 2)
      const live = (await new ConnectorStore({ baseDir: dir }).readCredential('connector-a'))?.accessToken
      // 同桶里只有这一条活传输（桶里没有别的注册条目）⇒ 证明成立 ⇒ 放弃即归还。
      held = await openHeldCall(`${bucket}${QUERY_A}`, String(live))
      expect(isMcpOutboundBusy(bucket)).toBe(true)

      await announceNewToken(dir, 'connector-a', 'at-h2-solo')
      h.emit('pico/connector-credentials-changed', { id: 'connector-a' })
      await waitFor(() => h.warns.some(line => line.includes('probe-a') && line.includes('超时')), 15_000)
      expect(isMcpOutboundBusy(bucket), '真独占时的放弃必须仍然归还记账（阀门不退化）').toBe(false)

      // 迟到的 `finally` 不得把记账复活（票 id 已随桶一起消失）。
      held.release()
      await held.pending
      expect(isMcpOutboundBusy(bucket)).toBe(false)
    } finally {
      held?.release()
      await held?.client.close().catch(() => {})
      await held?.pending.catch(() => {})
      h.dispose()
    }
  }, 90_000)
})
