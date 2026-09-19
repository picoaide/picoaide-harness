/**
 * Electron 适配器回归：协议特权位与两次注册（默认 session + 分区）。
 *
 * `electron` 用 `vi.mock` 替身注入：本模块的静态 `import { protocol, session }
 * from 'electron'` 在纯 Node 下解析到的是 Electron 包的 CJS 入口（无命名导出），
 * 所以这个 spec 是"适配器形状"唯一的离线判据。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const registerSchemesAsPrivileged = vi.fn()
const defaultHandle = vi.fn()
const partitionHandle = vi.fn()
const fromPartition = vi.fn(() => ({ protocol: { handle: partitionHandle } }))
const defaultSessionFetch = vi.fn(async () => new Response('ok', { status: 200 }))

vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged },
  session: {
    defaultSession: { protocol: { handle: defaultHandle }, fetch: defaultSessionFetch },
    fromPartition,
  },
}))

const { DEFAULT_APP_SCHEME } = await import('./app-protocol.ts')
const { createRealElectronAdapter, registerAppScheme } = await import('./electron-adapter.ts')

beforeEach(() => {
  registerSchemesAsPrivileged.mockClear()
  defaultHandle.mockClear()
  partitionHandle.mockClear()
  fromPartition.mockClear()
  defaultSessionFetch.mockClear()
})

describe('registerAppScheme', () => {
  it('registers the frozen privilege set exactly once per scheme (§16.1 渠道参数化)', () => {
    registerAppScheme('schema-probe-a-app')
    registerAppScheme('schema-probe-a-app')
    expect(registerSchemesAsPrivileged).toHaveBeenCalledTimes(1)
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([{
      scheme: 'schema-probe-a-app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: true,
        codeCache: true,
      },
    }])
  })

  it('refuses an invalid or reserved scheme instead of registering it (fail-loud)', () => {
    for (const bad of ['', 'A-app', '-app', 'app_', 'https', 'file', 'javascript', 'x'.repeat(33)]) {
      expect(() => registerAppScheme(bad), bad).toThrow()
    }
    expect(registerSchemesAsPrivileged).not.toHaveBeenCalled()
  })

  it('registers a different channel scheme independently (per-scheme idempotency)', () => {
    registerAppScheme('schema-probe-b-app')
    registerSchemesAsPrivileged.mockClear()
    registerAppScheme('schema-probe-b-app')
    registerAppScheme('schema-probe-c-app')
    expect(registerSchemesAsPrivileged).toHaveBeenCalledTimes(1)
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({ scheme: 'schema-probe-c-app' }),
    ])
  })
})

describe('createRealElectronAdapter', () => {
  it('registers the handler on the default session and on a named partition', () => {
    const adapter = createRealElectronAdapter()
    const handler = (): Response => new Response('x')
    adapter.handleAppScheme(DEFAULT_APP_SCHEME, handler)
    expect(defaultHandle).toHaveBeenCalledWith(DEFAULT_APP_SCHEME, handler)

    adapter.handleInSession('schema-probe-d-app', 'persist:agent-browser-alice', handler)
    expect(fromPartition).toHaveBeenCalledWith('persist:agent-browser-alice')
    expect(partitionHandle).toHaveBeenCalledWith('schema-probe-d-app', handler)
  })

  it('routes outbound requests through the Chromium session stack', async () => {
    const adapter = createRealElectronAdapter()
    expect(adapter.fetch).toBeTypeOf('function')
    const response = await adapter.fetch!('https://harness.example.com/x', { method: 'POST' })
    expect(defaultSessionFetch).toHaveBeenCalledWith('https://harness.example.com/x', { method: 'POST' })
    expect(await response.text()).toBe('ok')
  })
})
