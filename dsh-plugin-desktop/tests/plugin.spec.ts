import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config, desktopRendererUrl, type Config as DesktopConfig } from '../src/index.ts'
import type { DesktopRuntime, DesktopShellSpec } from '../src/runtime.ts'

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((settled) => { resolve = settled })
  return { promise, resolve }
}

const config: DesktopConfig = {
  mode: 'compatibility',
  width: 1280,
  height: 840,
  minWidth: 900,
  minHeight: 640,
}

describe('desktop Host plugin', () => {
  it('defaults to compatibility mode and validates the reserved mode name', () => {
    expect(Config({} as DesktopConfig)).toEqual(config)
    expect(Config({ mode: 'advanced' } as DesktopConfig)).toEqual({ ...config, mode: 'advanced' })
    expect(() => Config({ mode: 'custom' } as never)).toThrow()
  })

  it('builds the unmodified loopback Web root', () => {
    const url = new URL(desktopRendererUrl(43120))
    expect(url.origin).toBe('http://127.0.0.1:43120')
    expect(url.pathname).toBe('/')
    expect([...url.searchParams]).toEqual([])
  })

  it('reads the ephemeral Web port only after the Host Loader settles', async () => {
    const settled = deferred()
    let port: number | undefined
    let shell: DesktopShellSpec | undefined
    const runtime: DesktopRuntime = {
      platform: 'darwin',
      mountAfter: (ready, resolveSpec) => {
        void ready.then(() => { shell = resolveSpec() })
        return async () => {}
      },
      whenMounted: async () => {},
      show: () => {},
      prepareToQuit: () => {},
    }
    const ctx = {
      desktopRuntime: runtime,
      webServer: { get port() { return port } },
      loader: { await: () => settled.promise },
      get: vi.fn(() => () => {}),
      effect: vi.fn((register: () => () => Promise<void>) => register()),
    } as unknown as Context

    apply(ctx, config)
    expect(shell).toBeUndefined()
    port = 43120
    settled.resolve()
    await settled.promise
    await Promise.resolve()

    expect(shell).toEqual(expect.objectContaining({
      mode: 'compatibility',
      url: 'http://127.0.0.1:43120/',
    }))
  })

  it('rejects advanced mode before scheduling a native window', () => {
    const runtime: DesktopRuntime = {
      platform: 'darwin',
      mountAfter: vi.fn(() => async () => {}),
      whenMounted: async () => {},
      show: () => {},
      prepareToQuit: () => {},
    }
    const ctx = {
      desktopRuntime: runtime,
      effect: vi.fn(),
    } as unknown as Context

    expect(() => apply(ctx, { ...config, mode: 'advanced' })).toThrow(
      'advanced shell mode is not implemented',
    )
    expect(ctx.effect).not.toHaveBeenCalled()
    expect(runtime.mountAfter).not.toHaveBeenCalled()
  })
})
