import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, desktopRendererUrl, type Config } from '../src/index.ts'
import type { DesktopRuntime, DesktopShellSpec } from '../src/runtime.ts'

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((settled) => { resolve = settled })
  return { promise, resolve }
}

const config: Config = { width: 1280, height: 840, minWidth: 900, minHeight: 640 }

describe('desktop Host plugin', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('builds a loopback renderer URL for %s', (platform) => {
    const url = new URL(desktopRendererUrl(43120, platform))
    expect(url.origin).toBe('http://127.0.0.1:43120')
    expect(url.searchParams.get('dsh-desktop-platform')).toBe(platform)
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

    expect(shell?.url).toBe('http://127.0.0.1:43120/?dsh-desktop-platform=darwin')
  })
})
