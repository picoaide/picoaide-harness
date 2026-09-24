/**
 * R10 N2 regression — the outbound-ticket give-up must never clear ANOTHER
 * transport's bookkeeping.
 *
 * R10-B-06 gave the fence a release valve: a rebuild that gives up waiting for a
 * call that outlived its grace stops charging later rebuilds with it. The first
 * version released **by endpoint**, so with two transports on one URL (two
 * servers of one connector, or two connectors pointing at the same endpoint) the
 * transport being rebuilt released the OTHER transport's ticket as well. That
 * transport was not retired; when its own credential change arrived it read
 * `idle` and cut a call which could still have settled inside its grace. The
 * audit's probe recorded the moment the bookkeeping started lying:
 *
 * ```
 * [V3-D] outcome=busy waited=310ms busyAfterGiveUp=false baseSettled=false
 * ```
 *
 * The criteria below are the three levels of that finding:
 *
 *  1. the production call shape (`whenMcpOutboundIdle(url, grace)` with no owner)
 *     must leave another transport's ticket alone — the probe's line, inverted;
 *  2. ticket sets really are per transport instance: one instance's wait and
 *     give-up read and release only its own tickets;
 *  3. through the plugin's own rebuild path, where the sole-live-transport proof
 *     comes from the registration records: the rebuild that gives up leaves the
 *     other connector's in-flight call in the accounting, so that call's own
 *     rebuild waits for it and watches it settle (instead of reading `idle` and
 *     cutting it).
 *
 * Everything runs on real `StreamableHTTPClientTransport` instances against a
 * real HTTP MCP endpoint, through the real fence.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import {
  ensureMcpTransportRedirectFence,
  isMcpOutboundBusy,
  mcpOutboundOwnerOf,
  whenMcpOutboundIdle,
} from '../src/mcp-transport-fence.ts'
import { callRoute, createHarness, waitFor } from './helpers/connector-harness.ts'
import {
  completeAuthorization,
  startRealMcpServer,
  startStaticTokenMcpServer,
  type RealMcpServer,
  type StaticTokenMcpServer,
} from './helpers/real-mcp-oauth-server.ts'
import { ConnectorStore } from '../src/store.ts'
import type { ConnectorDef } from '../src/types.ts'

const servers: RealMcpServer[] = []
const staticServers: StaticTokenMcpServer[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()?.close()
  while (staticServers.length) await staticServers.pop()?.close()
})

/** The bearer the ad-hoc transports below authenticate with. */
const PROBE_TOKEN = 'r10-n2-probe-token'

/** The grace injected into the plugin: long enough to observe, short enough to test. */
const GRACE_MS = 3_000

/**
 * How long the fake transport holds the one `tools/call` this file observes. It
 * is the FIXTURE (a slow-but-normal call), not a criterion: it must outlive the
 * first rebuild's grace and settle inside the next one's window — the shape the
 * audit described as "a call that could still have settled inside its grace".
 *
 * Margins are deliberately wide (1.5 s on both sides) because the two windows
 * are both bounded by the same grace: the first rebuild must still find the call
 * running, and the second must still be waiting when it settles, even when CI is
 * loading the box.
 */
const SLOW_CALL_MS = 4_500

function oauthPart(origin: string): Pick<ConnectorDef, 'authMode' | 'auth'> {
  return {
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
  }
}

function def(id: string, serverName: string, origin: string): ConnectorDef {
  return {
    id,
    name: `Probe ${id}`,
    description: 'r10 n2',
    ...oauthPart(origin),
    mcp: [{ serverName, transport: 'streamable-http', url: `${origin}/mcp`, headers: { 'X-Probe-Key': 'static-value' } }],
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

/** One real transport on `origin`, hardened by the fence like production. */
async function openTransport(
  origin: string,
  fetchImpl: typeof fetch,
  toolCall: { text: string },
  bearer: string = PROBE_TOKEN,
): Promise<{ client: Client, pending: Promise<unknown>, owner: object }> {
  const client = new Client({ name: 'r10-n2', version: '1' }, { capabilities: {} })
  // The SDK has no public `transport` getter, so the instance is kept here: the
  // owner token lives ON the instance (the fence installs it while hardening).
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    fetch: fetchImpl,
  })
  await client.connect(transport)
  const owner = mcpOutboundOwnerOf(transport)
  expect(owner, '前置：真实传输必须已被栅栏加固并带上自己的 owner').toBeDefined()
  const pending = client.callTool({ name: 'echo', arguments: toolCall }).catch((error: unknown) => error)
  return { client, pending, owner: owner as object }
}

describe('R10 N2: the endpoint union never releases another transport\'s ticket', () => {
  it('production shape: a give-up with another live transport keeps both tickets', async () => {
    const server = await startStaticTokenMcpServer(PROBE_TOKEN)
    staticServers.push(server)
    await ensureMcpTransportRedirectFence()
    const first = stallingFetch()
    const second = stallingFetch()
    const a = await openTransport(server.origin, first.fetch, { text: '甲' })
    const b = await openTransport(server.origin, second.fetch, { text: '乙' })
    const url = `${server.origin}/mcp`
    try {
      await first.entered
      await second.entered
      expect(isMcpOutboundBusy(url, a.owner)).toBe(true)
      expect(isMcpOutboundBusy(url, b.owner)).toBe(true)

      // 生产形态：调用者只能报端点、给不出 owner，且端点上还有别的活传输 ⇒ 放弃时
      // 一个票都不能清（复审探针的 busyAfterGiveUp=false 反向）。
      const outcome = await whenMcpOutboundIdle(url, 150, { soleLiveTransport: false })
      expect(outcome, '边界确实到期（前置：这条路径真的等超时了）').toBe('busy')
      expect(isMcpOutboundBusy(url), '端点读数必须仍然说自己忙').toBe(true)
      expect(isMcpOutboundBusy(url, a.owner), '甲 自己的票必须原封不动').toBe(true)
      expect(isMcpOutboundBusy(url, b.owner), '乙 自己的票必须原封不动').toBe(true)

      // 同一个调用在"端点上只有我一条传输"的证明下仍然是 R10-B-06 的阀门：
      // 放弃即归还（那次调用本来就要被这次重建掐断）。
      expect(await whenMcpOutboundIdle(url, 150, { soleLiveTransport: true }), '这一轮仍然等到超时').toBe('busy')
      expect(isMcpOutboundBusy(url), '独占端点时的放弃必须归还记账（R10-B-06 不退化）').toBe(false)

      // 迟到的 `finally` 必须是 no-op：既不能复活记账，也不能减到别人头上。
      first.release()
      second.release()
      await a.pending
      await b.pending
      await waitFor(() => !isMcpOutboundBusy(url), 5_000)
    } finally {
      first.release()
      second.release()
      await a.client.close().catch(() => {})
      await b.client.close().catch(() => {})
    }
  }, 60_000)
})

describe('R10 N2: each transport instance owns its ticket set', () => {
  it('one instance\'s give-up releases only its own tickets; the other stays busy', async () => {
    const server = await startStaticTokenMcpServer(PROBE_TOKEN)
    staticServers.push(server)
    await ensureMcpTransportRedirectFence()
    const first = stallingFetch()
    const second = stallingFetch()
    const a = await openTransport(server.origin, first.fetch, { text: '甲' })
    const b = await openTransport(server.origin, second.fetch, { text: '乙' })
    const url = `${server.origin}/mcp`
    try {
      await first.entered
      await second.entered
      expect(mcpOutboundOwnerOf({}), '未加固的对象没有 owner').toBeUndefined()
      expect(a.owner, '两条传输必须各有自己的 owner 令牌').not.toBe(b.owner)
      expect(isMcpOutboundBusy(url, a.owner)).toBe(true)
      expect(isMcpOutboundBusy(url, b.owner)).toBe(true)

      // 甲 用自己的 owner 等待并放弃：只归还甲自己的票。
      expect(await whenMcpOutboundIdle(url, 150, { owner: a.owner })).toBe('busy')
      expect(isMcpOutboundBusy(url, a.owner), '自己的票被归还（R10-B-06 的阀门仍在）').toBe(false)
      expect(isMcpOutboundBusy(url, b.owner), '乙 的票必须一字未动').toBe(true)
      expect(isMcpOutboundBusy(url)).toBe(true)

      // 乙 自己做同样的事，端点才空。
      expect(await whenMcpOutboundIdle(url, 150, { owner: b.owner })).toBe('busy')
      expect(isMcpOutboundBusy(url)).toBe(false)

      // 迟到的 `finally`（票早已被归还）必须是 no-op，不能减到别人的计数上。
      const late = stallingFetch()
      const c = await openTransport(server.origin, late.fetch, { text: '丙' })
      await late.entered
      expect(isMcpOutboundBusy(url)).toBe(true)
      first.release()
      second.release()
      await a.pending
      await b.pending
      expect(isMcpOutboundBusy(url), '别人的票结算不得影响仍在途的那一条').toBe(true)
      late.release()
      await c.pending
      await waitFor(() => !isMcpOutboundBusy(url), 5_000)
      await c.client.close().catch(() => {})
    } finally {
      first.release()
      second.release()
      await a.client.close().catch(() => {})
      await b.client.close().catch(() => {})
    }
  }, 60_000)
})

describe('R10 N2 (production path): two connectors on one endpoint, one of them rebuilt', () => {
  it('the rebuild that gives up leaves the other connector\'s in-flight call alone', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'r10-n2-'))
    // Both connectors point at the SAME endpoint: the shared bucket the finding
    // is about. `connector-a` is the one that gets rebuilt first.
    const h = createHarness(
      [def('connector-a', 'probe-a', server.origin), def('connector-b', 'probe-b', server.origin)],
      dir,
      { refreshSweepIntervalMs: 0, rebuildIdleGraceMs: GRACE_MS },
    )
    const url = `${server.origin}/mcp`
    try {
      await authorize(h, 'connector-a', 1)
      await authorize(h, 'connector-b', 2)
      expect(h.configs.map(config => config.serverName).sort(), '前置：两条注册都在').toEqual(['probe-a', 'probe-b'])
      await toProviderless(h, server, dir, 4)

      // 乙（connector-b 的 probe-b）有一个**会正常结算的长调用**在途：慢，但会返回 ——
      // 这正是复审描述里"本可在 grace 内结算"的那一个。
      const live = (await new ConnectorStore({ baseDir: dir }).readCredential('connector-b'))?.accessToken
      expect(live, '前置：connector-b 必须有可用令牌').toBeTruthy()
      const held = stallingFetch()
      // 这次调用是"慢但正常"的：它活过甲那一次 grace，然后在乙的等待窗口内结算
      // （`SLOW_CALL_MS` 与 `GRACE_MS` 一起构成这个形状，两者都是夹具参数）。
      const slow = setTimeout(held.release, SLOW_CALL_MS)
      slow.unref?.()
      const client = new Client({ name: 'r10-n2-prod', version: '1' }, { capabilities: {} })
      await client.connect(new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${String(live)}` } },
        fetch: held.fetch,
      }))
      const pending = client.callTool({ name: 'echo', arguments: { text: '乙' } }).catch((error: unknown) => error)
      try {
        await held.entered

        // 甲（probe-a）的凭据变更 ⇒ 它重建、等满 grace、放弃。这一步**不得**动乙的记账。
        await announceNewToken(dir, 'connector-a', 'at-n2-a')
        h.emit('pico/connector-credentials-changed', { id: 'connector-a' })
        await waitFor(() => h.configs.length === 5, 15_000)
        expect(
          h.warns.filter(line => line.includes('probe-a') && line.includes('超时')).length,
          '前置：甲 的重建确实等满了 grace 才放弃',
        ).toBe(1)
        expect(
          isMcpOutboundBusy(url),
          '甲 放弃等待之后，乙 的在途调用必须仍然在账上（旧行为：这里已是 false）',
        ).toBe(true)

        // 乙 自己的凭据变更 ⇒ 它的重建必须**等**那个调用结算（grace 内），而不是读到
        // idle 直接掐断（那次结算由上面的 `SLOW_CALL_MS` 定时器触发）。
        await announceNewToken(dir, 'connector-b', 'at-n2-b')
        h.emit('pico/connector-credentials-changed', { id: 'connector-b' })
        await waitFor(() => h.configs.length === 6, 15_000)
        expect(
          h.warns.filter(line => line.includes('probe-b') && line.includes('等在途调用结束')).length,
          '乙 的重建必须在 grace 内等到在途调用结算（旧行为：读到 idle，立即重建并掐断）',
        ).toBe(1)
        expect(
          h.warns.filter(line => line.includes('probe-b') && line.includes('超时')).length,
          '乙 等到了结算，不该留超时 warn',
        ).toBe(0)
        expect(await pending, '被等待的那次调用必须照常拿到结果').toMatchObject({
          content: [{ type: 'text', text: 'echo:乙' }],
        })
      } finally {
        clearTimeout(slow)
        held.release()
        await client.close().catch(() => {})
        await pending.catch(() => {})
      }
    } finally { h.dispose() }
  }, 90_000)
})

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
  await waitFor(() => h.configs.length >= expected, 10_000)
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
  const patch = { expiresAt: Date.now() + 30_000, refreshedAt: Date.now() }
  await store.updateCredential('connector-a', patch)
  await store.updateCredential('connector-b', patch)
  server.setMetadataFailure(50)
  h.emitSession({ username: 'user-a', serverURL: 'https://harness.example.com' })
  await waitFor(() => h.configs.length === expected, 15_000)
  for (const config of h.configs.slice(-2)) {
    expect((config as unknown as { authProvider?: unknown }).authProvider, '前置：这次注册没有 provider').toBeUndefined()
  }
}

/** Write a credential straight to disk — the shape a refresh leaves behind. */
async function announceNewToken(dir: string, id: string, accessToken: string): Promise<void> {
  const store = new ConnectorStore({ baseDir: dir })
  await store.updateCredential(id, { accessToken, expiresAt: Date.now() + 30_000, refreshedAt: Date.now() })
}
