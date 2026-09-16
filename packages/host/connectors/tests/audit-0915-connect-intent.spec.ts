/**
 * 2026-09-15 交互审计的回归用例（BUG-02 / BUG-06）。
 *
 * BUG-02（取消/断开被竞态击穿）——旧行为：
 *  - `startConnect` 在第一次 `readCredential` 期间不校验任何意图：用户点「取消」
 *    之后它照样把表单发出去、把行改回 `connecting`；
 *  - `cancel` 只 abort `pendingFlows`（那时还没登记），既不 bump generation 也不
 *    清理 pending 表单；
 *  - `submitAuth` 先 `updateCredential` 再校验 generation，于是「提交后立刻断开」
 *    的凭据会在断开之后落到磁盘上，下次启动 `restoreAll` 又把它注册回来
 *    （断开被静默撤销）。
 *
 * BUG-06（公开 MCP 重启后消失）——旧的 `{ updatedAt }` 里没有 `publicMcp` 标记，
 * 重启时 `credentialUsable` 对 oauth 连接器强制要求 accessToken ⇒ 公开端点每次
 * 重启都要用户手动重连一次。
 *
 * 三个用例都做过反向对照：把修复回退即红（见 PR 说明）。
 */
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { ConnectorStore, sameCredential } from '../src/store.ts'
import type { ConnectorDef } from '../src/types.ts'
import { callRoute, createHarness, waitFor } from './helpers/connector-harness.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** oauth + 预连接必填设置：connect 必须在读完凭据之后发布表单。 */
function settingsDef(): ConnectorDef {
  return {
    id: 'racetest',
    name: 'Race',
    description: 'audit BUG-02',
    authMode: 'oauth',
    settings: [{ key: 'tenant', label: 'Tenant', type: 'text', required: true }],
    auth: {
      authorizeUrl: 'http://127.0.0.1:9/oauth/authorize',
      tokenUrl: 'http://127.0.0.1:9/oauth/token',
      clientId: 'client',
      redirectUri: 'http://127.0.0.1/callback',
      pkce: true,
      publicClient: true,
    },
    mcp: [],
  }
}

/** token 连接器：auth-submit 会直接把字段写进凭据库。 */
function tokenDef(): ConnectorDef {
  return {
    id: 'tok',
    name: 'Token',
    description: 'audit BUG-02',
    authMode: 'token',
    tokenFields: [{ key: 'apiKey', label: 'API Key', type: 'password', required: true }],
    mcp: [],
  }
}

/** oauth 连接器，其 MCP 端点无需授权（discovery 探针拿到 2xx）。 */
function publicDef(origin: string): ConnectorDef {
  return {
    id: 'pub',
    name: 'Public',
    description: 'audit BUG-06',
    authMode: 'oauth',
    auth: {
      discoveryUrl: `${origin}/mcp`,
      authorizeUrl: `${origin}/oauth/authorize`,
      tokenUrl: `${origin}/oauth/token`,
      clientId: 'client',
      redirectUri: 'http://127.0.0.1/callback',
      pkce: true,
      publicClient: true,
    },
    mcp: [{ serverName: 'pub', transport: 'streamable-http', url: `${origin}/mcp` }],
  }
}

describe('BUG-02: a connect intent must not outlive a cancel', () => {
  it('cancelling during the first credential read publishes no form and leaves the row disconnected', async () => {
    const dir = await tempDir('pico-intent-cancel-')
    // Hold the FIRST credential read so the cancel lands while startConnect is
    // parked exactly where the audit's repro did (before anything was published).
    const original = ConnectorStore.prototype.readCredential
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let held = false
    vi.spyOn(ConnectorStore.prototype, 'readCredential').mockImplementation(async function (
      this: ConnectorStore,
      id: string,
    ) {
      if (!held) {
        held = true
        await gate
      }
      return await original.call(this, id)
    })

    const h = createHarness([settingsDef()], dir)
    await callRoute(h, '/api/pico/connectors/racetest/connect', 'POST')
    await callRoute(h, '/api/pico/connectors/racetest/cancel', 'POST')
    release()
    await new Promise(resolve => setTimeout(resolve, 50))

    const state = JSON.parse((await callRoute(h, '/api/pico/connectors/racetest/state', 'GET')).body) as
      { status: string, request: unknown }
    // The cancelled connect used to come back as `connecting` + a settings form.
    expect(state.status).toBe('disconnected')
    expect(state.request).toBeNull()
    expect(h.configs).toHaveLength(0)
    h.dispose()
  })

  it('a disconnect during the credential write leaves no credential behind', async () => {
    const dir = await tempDir('pico-intent-write-')
    const store = new ConnectorStore({ baseDir: dir })
    // Park INSIDE updateCredential, after the pre-write liveness check passed:
    // this is the window in which the old code wrote a credential after the
    // user's disconnect had already cleared it.
    const original = ConnectorStore.prototype.updateCredential
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let parked = false
    vi.spyOn(ConnectorStore.prototype, 'updateCredential').mockImplementation(async function (
      this: ConnectorStore,
      id: string,
      patch: Parameters<ConnectorStore['updateCredential']>[1],
    ) {
      if (!parked) {
        parked = true
        await gate
      }
      return await original.call(this, id, patch)
    })

    const h = createHarness([tokenDef()], dir)
    void callRoute(h, '/api/pico/connectors/tok/auth-submit', 'POST', { fields: { apiKey: 'secret' } })
    // 确定性：必须等到写真的进入 park（否则用例走的是"写前检查"那条路，
    // 补偿代码根本不会被执行 —— 2026-09-15 复核实测到的假绿）。
    await waitFor(() => parked, 5000)
    await callRoute(h, '/api/pico/connectors/tok/disconnect', 'POST')
    release()
    await new Promise(resolve => setTimeout(resolve, 80))

    expect(await store.readCredential('tok')).toBeNull()
    expect(h.configs).toHaveLength(0)
    h.dispose()
  })

  it('断开后新尝试仍在飞行时，迟到的旧写入也必须被清掉（第二轮复核：判据回归要靠这条钉住）', async () => {
    const dir = await tempDir('pico-intent-write-newer-')
    const store = new ConnectorStore({ baseDir: dir })
    const original = ConnectorStore.prototype.updateCredential
    const gates: Array<() => void> = []
    let calls = 0
    let secondParked!: () => void
    const secondParkedGate = new Promise<void>((resolve) => { secondParked = resolve })
    vi.spyOn(ConnectorStore.prototype, 'updateCredential').mockImplementation(async function (
      this: ConnectorStore,
      id: string,
      patch: Parameters<ConnectorStore['updateCredential']>[1],
    ) {
      calls += 1
      if (calls <= 2) {
        // 第 1 次（陈旧提交）与第 2 次（断开后的新提交）都停在写盘之前：
        // 关键是第 2 次必须**仍然在飞行**、它的意图仍然活着，迟到写入才落进
        // "存在更新意图"的那个分支（第一版用例③用 connect，新意图在迟到写入
        // 落地前就被 endIntent 删掉了，因此钉不住判据回归 —— 复核实测）。
        await new Promise<void>((resolve) => { gates.push(resolve) })
        if (calls === 2) secondParked()
      }
      return await original.call(this, id, patch)
    })

    const h = createHarness([tokenDef()], dir)
    void callRoute(h, '/api/pico/connectors/tok/auth-submit', 'POST', { fields: { apiKey: 'STALE-A' } })
    await waitFor(() => calls === 1 && gates.length === 1, 5000)
    await callRoute(h, '/api/pico/connectors/tok/disconnect', 'POST')
    void callRoute(h, '/api/pico/connectors/tok/auth-submit', 'POST', { fields: { apiKey: 'FRESH-B' } })
    await waitFor(() => calls === 2 && gates.length === 2, 5000)
    void secondParked

    // 放行陈旧写入：它落地时"更新的意图"仍在飞行（这是判据回归的判别条件）。
    gates[0]!()
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(await store.readCredential('tok')).toBeNull()

    // 再放行新写入：新尝试的凭据照常落地，没有被旧补偿误删。
    gates[1]!()
    await new Promise(resolve => setTimeout(resolve, 150))
    expect((await store.readCredential('tok'))?.fields?.['apiKey']).toBe('FRESH-B')
    h.dispose()
  })

  it('a newer write that already landed is never replaced by stale bytes', async () => {
    const dir = await tempDir('pico-intent-write-invariant-')
    const store = new ConnectorStore({ baseDir: dir })
    const original = ConnectorStore.prototype.updateCredential
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let parked = false
    vi.spyOn(ConnectorStore.prototype, 'updateCredential').mockImplementation(async function (
      this: ConnectorStore,
      id: string,
      patch: Parameters<ConnectorStore['updateCredential']>[1],
    ) {
      if (!parked) {
        parked = true
        await gate
      }
      return await original.call(this, id, patch)
    })

    const h = createHarness([tokenDef()], dir)
    void callRoute(h, '/api/pico/connectors/tok/auth-submit', 'POST', { fields: { apiKey: 'STALE-A' } })
    await waitFor(() => parked, 5000)
    await callRoute(h, '/api/pico/connectors/tok/disconnect', 'POST')
    // 更新的意图**真的写了盘**（第二次 updateCredential 不再被 park）。
    await callRoute(h, '/api/pico/connectors/tok/auth-submit', 'POST', { fields: { apiKey: 'FRESH-B' } })
    release()
    await new Promise(resolve => setTimeout(resolve, 120))

    // 不变式：磁盘上绝不能是那份迟到的旧凭据（要么已被清掉，要么是新的）。
    const onDisk = await store.readCredential('tok')
    expect(onDisk?.fields?.['apiKey']).not.toBe('STALE-A')
    h.dispose()
  })
})

describe('BUG-06: a public MCP endpoint survives a restart', () => {
  it('persists the public marker and registers again from the stored credential', async () => {
    const dir = await tempDir('pico-public-mcp-')
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => resolve()) })
    cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const first = createHarness([publicDef(origin)], dir, { refreshSweepIntervalMs: 0 })
    await callRoute(first, '/api/pico/connectors/pub/connect', 'POST')
    await waitFor(() => first.configs.length === 1, 8000)
    const stored = await new ConnectorStore({ baseDir: dir }).readCredential('pub')
    expect(stored?.publicMcp).toBe(true)
    expect(stored?.accessToken).toBeUndefined()
    first.dispose()

    // "Restart": a fresh plugin instance on the same store must register the
    // same server from the stored credential alone.
    const second = createHarness([publicDef(origin)], dir, { refreshSweepIntervalMs: 0 })
    await waitFor(() => second.configs.length === 1, 8000)
    const row = JSON.parse((await callRoute(second, '/api/pico/connectors', 'GET')).body) as
      { connectors: Array<{ id: string, status: string }> }
    expect(row.connectors.find(c => c.id === 'pub')?.status).toBe('connected')
    second.dispose()
  })
})

describe('ConnectorStore.clearCredentialIfUnchanged：原子 compare-and-delete', () => {
  it('内容一致才删；不一致（已被更新的写入换掉）返回 false 且不动文件', async () => {
    const dir = await tempDir('pico-store-cas-')
    const store = new ConnectorStore({ baseDir: dir })
    await store.writeCredential('c', { updatedAt: 1, fields: { apiKey: 'A' } })
    expect(await store.clearCredentialIfUnchanged('c', { updatedAt: 1, fields: { apiKey: 'A' } })).toBe(true)
    expect(await store.readCredential('c')).toBeNull()

    await store.writeCredential('c', { updatedAt: 2, fields: { apiKey: 'B' } })
    expect(await store.clearCredentialIfUnchanged('c', { updatedAt: 1, fields: { apiKey: 'A' } })).toBe(false)
    expect((await store.readCredential('c'))?.fields?.['apiKey']).toBe('B')
  })

  it('并发写不会被比较-删除误删（50 轮属性断言）', async () => {
    const dir = await tempDir('pico-store-cas-race-')
    const store = new ConnectorStore({ baseDir: dir })
    for (let round = 0; round < 50; round += 1) {
      await store.writeCredential('c', { updatedAt: 1, fields: { apiKey: 'A' } })
      await Promise.all([
        store.clearCredentialIfUnchanged('c', { updatedAt: 1, fields: { apiKey: 'A' } }),
        store.updateCredential('c', { fields: { apiKey: 'B' } }),
      ])
      // 无论两者谁先，新写入都必须留在盘上（旧实现"先读后删"在强制交错下会把它删掉）。
      expect((await store.readCredential('c'))?.fields?.['apiKey'], `round ${round}`).toBe('B')
    }
  })

  it('非法 updatedAt 被规范为 0，后续写入恢复单调', async () => {
    const dir = await tempDir('pico-store-bad-updatedat-')
    const store = new ConnectorStore({ baseDir: dir })
    await store.writeCredential('c', { updatedAt: 1, fields: { apiKey: 'A' } })
    // 手工把时间戳写坏：必须写 `1e999` 字面量（JSON.stringify(Infinity) 会先变成
    // null，那样走不到数值校验分支）。解析后 typeof 是 number 但非有限。
    const file = join(dir, 'c.json')
    const fsPromises = await import('node:fs/promises')
    const rawText = (await fsPromises.readFile(file, 'utf8')).replace(/"updatedAt":\s*\d+/u, '"updatedAt":1e999')
    await fsPromises.writeFile(file, rawText)
    const read = await store.readCredential('c')
    expect(read?.updatedAt).toBe(0)
    const written = await store.updateCredential('c', { accessToken: 'a1' })
    expect(Number.isSafeInteger(written.updatedAt)).toBe(true)
    expect(written.updatedAt).toBeGreaterThan(0)
    const second = await store.updateCredential('c', { accessToken: 'a2' })
    expect(second.updatedAt).toBeGreaterThan(written.updatedAt)
  })

  it('updateCredentialIfUnchanged：快照变了 / 文件没了都不写（断开不复活）', async () => {
    const dir = await tempDir('pico-store-cas-update-')
    const store = new ConnectorStore({ baseDir: dir })
    const first = await store.updateCredential('c', { accessToken: 'a1', fields: { apiKey: 'A' } })
    expect((await store.updateCredentialIfUnchanged('c', first, { accessToken: 'a2' }))?.accessToken).toBe('a2')
    // 期望快照已经过期（盘上是 a2 的那次写）⇒ 不再覆盖更新结果
    expect(await store.updateCredentialIfUnchanged('c', first, { accessToken: 'a3' })).toBeNull()
    const second = await store.readCredential('c')
    // 断开（文件被清）后迟到的刷新写入不得复活凭据
    await store.clearCredential('c')
    expect(await store.updateCredentialIfUnchanged('c', second!, { accessToken: 'a4' })).toBeNull()
    expect(await store.readCredential('c')).toBeNull()
  })

  it('updateCredential 的 updatedAt 严格递增（同毫秒也不重复）', async () => {
    const dir = await tempDir('pico-store-updatedat-')
    const store = new ConnectorStore({ baseDir: dir })
    const first = await store.updateCredential('c', { accessToken: 'a1' })
    const second = await store.updateCredential('c', { accessToken: 'a2' })
    const third = await store.updateCredential('c', { accessToken: 'a3' })
    // adoptLatestRefresh relies on this ordering when a refresh and an
    // interactive re-authorization land in the same millisecond.
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt)
    expect(third.updatedAt).toBeGreaterThan(second.updatedAt)
  })

  it('sameCredential 逐字段比较（含 clientId/clientSecret/refreshedAt，且不受 fields 键序影响）', async () => {
    const base = { updatedAt: 5, fields: { a: '1', b: '2' } }
    expect(sameCredential(base, { updatedAt: 5, fields: { b: '2', a: '1' } })).toBe(true)
    expect(sameCredential(base, { ...base, clientId: 'x' })).toBe(false)
    expect(sameCredential(base, { ...base, clientSecret: 'x' })).toBe(false)
    expect(sameCredential(base, { ...base, refreshedAt: 9 })).toBe(false)
    expect(sameCredential(base, { updatedAt: 6, fields: base.fields })).toBe(false)
  })
})

describe('ConnectorStore：独占区与比较的两条收尾护栏（第三轮复核建议）', () => {
  it('sameCredential 对含 NUL 的字段值不再误判（长度前缀）', () => {
    expect(sameCredential({ updatedAt: 1, fields: { a: 'x', b: 'y' } }, { updatedAt: 1, fields: { a: 'x\u0000b=y' } }))
      .toBe(false)
    expect(sameCredential({ updatedAt: 1, fields: { 'a\u0000b': 'x' } }, { updatedAt: 1, fields: { a: 'x', b: 'y' } }))
      .toBe(false)
  })

  it('独占区非重入：在独占任务里调公开写方法是显式异常，而不是无声挂死', async () => {
    const dir = await tempDir('pico-store-reentrant-')
    const store = new ConnectorStore({ baseDir: dir })
    await store.writeCredential('c', { updatedAt: 1, fields: { apiKey: 'A' } })
    // 直接在独占任务里调用公开写方法（模拟误用）：AsyncLocalStorage 判定为
    // "独占任务内" ⇒ 显式异常，而不是排到自己后面无声挂死。
    const exclusive = (store as unknown as { exclusive: (task: () => Promise<void>) => Promise<void> }).exclusive.bind(store)
    await expect(exclusive(async () => { await store.clearCredential('c') })).rejects.toThrow(/not re-entrant/u)
    // 凭据链路没有被挂死：后续正常写读照常工作。
    expect((await store.readCredential('c'))?.fields?.['apiKey']).toBe('A')
  })
})
