import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config, desktopRendererUrl, inject, type Config as DesktopConfig } from '../src/index.ts'
import type { DesktopRuntime, DesktopShellSpec } from '../src/runtime.ts'

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

  it('registers the active Web port without re-entering global Loader settlement', () => {
    let shell: DesktopShellSpec | undefined
    const runtime: DesktopRuntime = {
      platform: 'darwin',
      schedule: (spec) => {
        shell = spec
        return async () => {}
      },
      mountScheduled: async () => {},
      show: () => {},
      prepareToQuit: () => {},
    }
    const loaderAwait = vi.fn(() => new Promise<void>(() => {}))
    const ctx = {
      desktopRuntime: runtime,
      webServer: { port: 43120 },
      loader: { await: loaderAwait },
      get: vi.fn(() => () => {}),
      effect: vi.fn((register: () => () => Promise<void>) => register()),
    } as unknown as Context

    apply(ctx, config)

    expect(inject).not.toContain('loader')
    expect(loaderAwait).not.toHaveBeenCalled()
    expect(shell).toEqual(expect.objectContaining({
      mode: 'compatibility',
      url: 'http://127.0.0.1:43120/',
    }))
  })

  it('rejects advanced mode before scheduling a native window', () => {
    const runtime: DesktopRuntime = {
      platform: 'darwin',
      schedule: vi.fn(() => async () => {}),
      mountScheduled: async () => {},
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
    expect(runtime.schedule).not.toHaveBeenCalled()
  })
})
