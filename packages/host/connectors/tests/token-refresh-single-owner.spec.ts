/**
 * 单一刷新主人（2026-09-17 定案）：SDK 的 401 自愈与我们的刷新必须共用同一个单飞。
 *
 * 现场：CI Gate 今天红了 6 次，签名固定
 * `InvalidGrantError: refresh token already used`（来自
 * `StreamableHTTPClientTransport.send` → `auth()` → `executeTokenRequest`），
 * 重跑即绿、本地 4 路并发也难复现（窗口由调度决定）。
 *
 * 机制：随包 MCP SDK 的 `authInternal` 会在 401 时自己续期 ——
 * `await provider.tokens()` → `refreshAuthorization(...)` → `saveTokens(...)`。
 * 这条路径**不在** `TokenRefresher.inflight` 里，而我们的心跳/面板/重开恢复走的是
 * 那个单飞。两者并发时同一个**单次** refresh token 被出示两次，启用轮换复用检测
 * 的授权服务器（RFC 6749 §10.4）会吊销整个授权 —— 客户端只看到「需要重新授权」。
 *
 * 收口方式：SDK 的四个 `tokens()` 调用点全部是 `await provider.tokens()`，
 * 所以 provider 在交出令牌前先经 `ensureFresh` 走**同一个** per-id 单飞，
 * SDK 拿到的永远是当前世代，于是它不会再发起自己的刷新。
 *
 * 这些用例是**确定性**的：它们并发调用 `tokens()` 并断言"恰好一次续期"，
 * 回退 `ensureFresh` 接线会立刻变红，不需要赢任何竞态。
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { callRoute, createHarness, waitFor } from './helpers/connector-harness.ts'
import { completeAuthorization, startRealMcpServer, type RealMcpServer } from './helpers/real-mcp-oauth-server.ts'
import { ConnectorStore } from '../src/store.ts'
import { createOAuthProvider, TokenRefresher } from '../src/mcp-oauth-provider.ts'
import type { ConnectorDef } from '../src/types.ts'

const servers: RealMcpServer[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()?.close()
})

function def(origin: string): ConnectorDef {
  return {
    id: 'example-a', name: 'Example-A', description: 'single-owner', authMode: 'oauth',
    auth: {
      authorizeUrl: `${origin}/oauth/authorize`, tokenUrl: `${origin}/oauth/token`, clientId: '',
      redirectUri: 'http://127.0.0.1/callback', pkce: true, publicClient: true,
      discoveryUrl: `${origin}/mcp`, scopes: 'mcp.read offline_access',
    },
    mcp: [{ serverName: 'example-a', transport: 'streamable-http', url: `${origin}/mcp` }],
  }
}

/** 完成一次交互式授权，让磁盘上有一份带 refresh token 的凭据。 */
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

function refreshGrants(server: RealMcpServer): number {
  return server.stats.grants.filter(g => g === 'refresh_token').length
}

describe('SDK 自己续期后，旋转后的 refresh token 必须已经落盘', () => {
  it('saveTokens 返回时磁盘上就是新令牌（不能 fire-and-forget）', async () => {
    // 现场（2026-09-17 flake 定案）：`onPersist` 原来是 `void persist(...)`，
    // 于是 `saveTokens` 在**持久化之前**就 resolve（实测旋转落盘比 SDK 调用返回晚
    // 4–29ms）。随后任何读者（registerMcp 建 provider、restoreAll）都可能拿着
    // 一枚**已被消费**的 refresh token 去续期 ⇒ 轮换复用检测吊销整个授权。
    //
    // 这里把落盘人为放慢，把"0–1ms 的巧合窗口"变成确定可观测的窗口：
    // 未修版本在 `saveTokens` 返回后立刻读盘会看到旧令牌。
    const proto = ConnectorStore.prototype as unknown as {
      writeCredentialUnlocked: (...args: unknown[]) => Promise<void>
    }
    const originalWrite = proto.writeCredentialUnlocked
    vi.spyOn(proto, 'writeCredentialUnlocked').mockImplementation(async function (
      this: ConnectorStore,
      ...args: unknown[]
    ) {
      await new Promise(r => setTimeout(r, 200))
      return await originalWrite.apply(this, args)
    })

    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'persist-window-'))
    await authorizeOnce(dir, server)

    const h = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    await waitFor(() => h.configs.length === 1, 15_000)
    const provider = (h.configs[0] as unknown as {
      authProvider?: { saveTokens: (t: Record<string, unknown>) => Promise<void> }
    }).authProvider
    expect(provider, '注册时必须带上 SDK provider').toBeTruthy()

    const store = new ConnectorStore({ baseDir: dir })
    const before = await store.readCredential('example-a')
    // 模拟 SDK 自己续期完成后的持久化点（SDK 就是这么调 saveTokens 的）。
    await provider!.saveTokens({ access_token: 'at-sdk', refresh_token: 'rt-rotated', expires_in: 3600 })

    const onDisk = await store.readCredential('example-a')
    expect(onDisk?.refreshToken, 'saveTokens 返回时新 refresh token 必须已经落盘').toBe('rt-rotated')
    expect(onDisk?.refreshToken).not.toBe(before?.refreshToken)
    h.dispose()
  }, 30_000)
})

describe('上游契约：SDK 必须 await provider.tokens()', () => {
  it('每一个 .tokens() 调用点都带 await（异步保鲜依赖这一点，升级上游必须重查）', async () => {
    // 我们把 provider 的 `tokens()` 改成"快过期先经单飞续期再交出"，这只有在
    // 调用方 `await` 时才成立。pinned SDK 现在四个调用点全是 `await`；一旦升级把
    // 某一处改回同步读取，同步位置会拿到一个 Promise（真值！）—— 于是它把
    // Promise 当成令牌用，鉴权头会变成 "[object Promise]"，而且没有任何测试会红。
    // 所以这里对**依赖包源码**做一次形状断言：这是升级路径上的护栏，不是产品断言。
    const dir = fileURLToPath(new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/client/', import.meta.url))
    const files = readdirSync(dir).filter(f => f.endsWith('.js'))
    expect(files.length).toBeGreaterThan(0)
    const bare: string[] = []
    let awaited = 0
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8')
      for (const match of text.matchAll(/(.{24})\.tokens\(\)/gsu)) {
        if (/await\s+[\w.$]+\.$|await\s+this\._authProvider\.$|await\s+[\w.$]*\.$/.test(match[1]) || /await\s+[\w.$]*$/u.test(match[1])) {
          awaited += 1
        } else {
          bare.push(`${file}: ${match[1].trim()}`)
        }
      }
    }
    expect(awaited, 'SDK 里应当存在 await provider.tokens() 调用点').toBeGreaterThan(0)
    expect(bare, `这些 .tokens() 调用点没有 await：\n${bare.join('\n')}`).toEqual([])
  })
})

describe('SDK 的 tokens() 与我们的刷新共用一个单飞（不允许二次出示同一个 refresh token）', () => {
  it('三个并发 tokens() 加上面板刷新 ⇒ 恰好一次续期、零 reuse', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'single-owner-'))
    await authorizeOnce(dir, server)

    const store = new ConnectorStore({ baseDir: dir })
    const stale = await store.readCredential('example-a')
    expect(stale?.refreshToken, '前置：磁盘上必须有 refresh token').toBeTruthy()
    // 让"本地记录的过期时间已过"（关机超过一小时）——这是 provider 会走
    // ensureFresh 的判据，也是 CI 那条约 50% 复现率的窗口的入口。
    await store.updateCredential('example-a', { expiresAt: Date.now() - 60_000 })
    const credential = (await store.readCredential('example-a'))!
    const target = {
      discoveryUrl: `${server.origin}/mcp`,
      tokenUrl: `${server.origin}/oauth/token`,
      authorizeUrl: `${server.origin}/oauth/authorize`,
      redirectUri: 'http://127.0.0.1/callback',
      clientId: credential.clientId ?? '',
    }
    const refresher = new TokenRefresher({
      read: (id) => store.readCredential(id),
      write: (id, patch) => store.updateCredential(id, patch),
      writeIfUnchanged: (id, expected, patch) => store.updateCredentialIfUnchanged(id, expected, patch),
      scope: () => store.dir,
      target: () => target,
    })
    const created = createOAuthProvider({
      credential,
      target,
      // 与 registerMcp 的接线同形：同一个 per-id 单飞，成功后把令牌交给 provider。
      ensureFresh: async () => {
        const outcome = await refresher.refresh('example-a', {})
        return outcome.ok ? outcome.tokens : null
      },
    })

    const before = refreshGrants(server)
    // 三个并发消费者 = SDK 在三条请求上各自 `await provider.tokens()`；
    // 面板刷新 = 我们自己的另一条触发点。四条路径必须汇成一次续期。
    const [a, b, c] = await Promise.all([
      created.provider.tokens(),
      created.provider.tokens(),
      created.provider.tokens(),
    ])

    expect(refreshGrants(server) - before).toBe(1)
    expect(server.stats.revokedRefreshReuse).toBe(0)
    // 交出来的必须是**当前世代**：磁盘上的那份。
    const onDisk = await store.readCredential('example-a')
    expect(onDisk?.refreshToken).toBeTruthy()
    for (const t of [a, b, c]) {
      expect(t?.refresh_token).toBe(onDisk?.refreshToken)
      expect(t?.access_token).toBe(onDisk?.accessToken)
    }
  }, 30_000)

  it('内置地址与面板刷新并发：我们自己的触发点也不额外续期', async () => {
    const server = await startRealMcpServer()
    servers.push(server)
    const dir = mkdtempSync(join(tmpdir(), 'single-owner-route-'))
    await authorizeOnce(dir, server)
    server.expireAccessTokens()

    const h = createHarness([def(server.origin)], dir, { refreshSweepIntervalMs: 0 })
    await waitFor(() => h.configs.length === 1, 15_000)
    const provider = (h.configs[0] as unknown as { authProvider?: { tokens: () => Promise<unknown> } }).authProvider
    expect(provider, '注册时必须带上 SDK provider').toBeTruthy()

    const before = refreshGrants(server)
    const [, res] = await Promise.all([
      provider!.tokens(),
      callRoute(h, '/api/pico/connectors/example-a/refresh', 'POST'),
    ])
    expect(res.status).toBe(200)
    // 面板刷新自己就是一次续期；tokens() 若也自己刷一次，这里会是 2。
    expect(refreshGrants(server) - before).toBe(1)
    expect(server.stats.revokedRefreshReuse).toBe(0)
    h.dispose()
  }, 30_000)
})
