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

import { ConnectorStore } from '../src/store.ts'
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
    // Park INSIDE updateCredential, before the bytes reach the file: this is the
    // window in which the old code wrote a credential after the user's
    // disconnect had already cleared it.
    const original = ConnectorStore.prototype.updateCredential
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let held = false
    vi.spyOn(ConnectorStore.prototype, 'updateCredential').mockImplementation(async function (
      this: ConnectorStore,
      id: string,
      patch: Parameters<ConnectorStore['updateCredential']>[1],
    ) {
      if (!held) {
        held = true
        await gate
      }
      return await original.call(this, id, patch)
    })

    const h = createHarness([tokenDef()], dir)
    await callRoute(h, '/api/pico/connectors/tok/auth-submit', 'POST', { fields: { apiKey: 'secret' } })
    await callRoute(h, '/api/pico/connectors/tok/disconnect', 'POST')
    release()
    await new Promise(resolve => setTimeout(resolve, 80))

    // Without the compensating cleanup the late write recreated the file and the
    // next restore registered a connector the user had just disconnected.
    expect(await store.readCredential('tok')).toBeNull()
    expect(h.configs).toHaveLength(0)
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
