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

/**
 * 浏览器包的 session 守卫（R2-L2-5）：**适配器的转发**是本节要证的接线 ——
 * scheme 传错（例如传成深链 scheme）或漏传 partition 时，真机探针与浏览器包自己的
 * 单测都不会红（探针在探针内部重实现了一遍闸门）。
 */
const guardEnsureSession = vi.fn()
const guardInstallGate = vi.fn()
vi.mock('@picoaide/dsh-browser/guard', () => ({
  ensureSessionGuard: guardEnsureSession,
  installAppSchemeRequestGate: guardInstallGate,
}))

const { DEFAULT_APP_SCHEME } = await import('./app-protocol.ts')
const { createRealElectronAdapter, registerAppScheme } = await import('./electron-adapter.ts')
// 动态 import（不是静态）：静态 import 会在上面的替身声明**之前**求值 mock 工厂。
const { session } = await import('electron')

beforeEach(() => {
  registerSchemesAsPrivileged.mockClear()
  defaultHandle.mockClear()
  partitionHandle.mockClear()
  fromPartition.mockClear()
  defaultSessionFetch.mockClear()
  guardEnsureSession.mockClear()
  guardInstallGate.mockClear()
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

  it('把权限守卫与请求闸门转发到正确的 session（默认 / 分区），带 scheme 与判据（R2-L2-5）', () => {
    const adapter = createRealElectronAdapter()
    const isAppSurface = (id: number | undefined): boolean => id === 7

    // 默认 session：两个守卫都不带 partition。
    adapter.ensureSessionGuard?.()
    expect(guardEnsureSession).toHaveBeenCalledTimes(1)
    expect(guardEnsureSession.mock.calls[0]?.[0]).toBe(session.defaultSession)

    adapter.installAppSchemeRequestGate?.('schema-probe-e-app', isAppSurface)
    expect(guardInstallGate).toHaveBeenCalledTimes(1)
    const [defaultTarget, defaultOptions] = guardInstallGate.mock.calls[0] as unknown as [unknown, { scheme: string, isAppSurfaceWebContents: unknown }]
    expect(defaultTarget).toBe(session.defaultSession)
    // scheme 与判据都要**原样**转发：这里是"传成深链 scheme / 判据写反"的唯一判据点。
    expect(defaultOptions.scheme).toBe('schema-probe-e-app')
    expect(defaultOptions.isAppSurfaceWebContents).toBe(isAppSurface)

    // 分区：target 换成该分区，参数不变。
    adapter.ensureSessionGuard?.('persist:agent-browser-alice')
    adapter.installAppSchemeRequestGate?.('schema-probe-e-app', isAppSurface, 'persist:agent-browser-alice')
    expect(fromPartition).toHaveBeenCalledWith('persist:agent-browser-alice')
    expect(guardEnsureSession).toHaveBeenLastCalledWith(expect.objectContaining({ protocol: { handle: partitionHandle } }))
    const [partitionTarget, partitionOptions] = guardInstallGate.mock.calls[1] as unknown as [unknown, { scheme: string, isAppSurfaceWebContents: unknown }]
    expect(partitionTarget).toEqual(expect.objectContaining({ protocol: { handle: partitionHandle } }))
    expect(partitionOptions.scheme).toBe('schema-probe-e-app')
    expect(partitionOptions.isAppSurfaceWebContents).toBe(isAppSurface)
  })

  it('routes outbound requests through the Chromium session stack', async () => {
    const adapter = createRealElectronAdapter()
    expect(adapter.fetch).toBeTypeOf('function')
    const response = await adapter.fetch!('https://harness.example.com/x', { method: 'POST' })
    expect(defaultSessionFetch).toHaveBeenCalledWith('https://harness.example.com/x', { method: 'POST' })
    expect(await response.text()).toBe('ok')
  })
})
