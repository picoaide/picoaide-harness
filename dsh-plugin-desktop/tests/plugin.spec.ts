import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  Config,
  createDesktopModeHandler,
  DESKTOP_MODE_ENDPOINT,
  DESKTOP_SETTINGS_NAMESPACE,
  desktopRendererUrl,
  DesktopSettingsSchema,
  inject,
  type Config as DesktopConfig,
  type DesktopSettings,
} from '../src/index.ts'
import type { DesktopRuntime, DesktopShellSpec } from '../src/runtime.ts'

const config: DesktopConfig = {
  mode: 'compatibility',
  width: 1280,
  height: 840,
  minWidth: 900,
  minHeight: 640,
}

afterEach(() => { vi.useRealTimers() })

interface PluginHarness {
  ctx: Context
  runtime: DesktopRuntime
  shell(): DesktopShellSpec | undefined
  route(): WebRoute | undefined
  update: ReturnType<typeof vi.fn<(patch: object) => Promise<void>>>
  restart: ReturnType<typeof vi.fn<() => Promise<void>>>
  notify(next: DesktopSettings, prev: DesktopSettings): Promise<void>
}

function createHarness(platform: DesktopRuntime['platform'] = 'darwin'): PluginHarness {
  let shell: DesktopShellSpec | undefined
  let route: WebRoute | undefined
  let watcher: ((next: DesktopSettings, prev: DesktopSettings) => void | Promise<void>) | undefined
  const update = vi.fn(async (_patch: object) => {})
  const restart = vi.fn(async () => {})
  const runtime: DesktopRuntime = {
    platform,
    schedule: (spec) => {
      shell = spec
      return async () => {}
    },
    mountScheduled: async () => {},
    show: () => {},
    requestRestart: restart,
    prepareToQuit: () => {},
  }
  const settings = {
    register: vi.fn(() => ({
      get: () => ({ mode: config.mode }),
      watch: (callback: typeof watcher) => {
        watcher = callback
        return () => { watcher = undefined }
      },
      update,
      replace: vi.fn(async () => {}),
    })),
  }
  const ctx = {
    desktopRuntime: runtime,
    webServer: {
      host: '127.0.0.1',
      port: 43120,
      register: vi.fn((next: WebRoute) => {
        route = next
        return () => { route = undefined }
      }),
    },
    settings,
    logger: { warn: vi.fn(), error: vi.fn() },
    get: vi.fn(() => () => {}),
    effect: vi.fn((register: () => unknown) => register()),
  } as unknown as Context
  return {
    ctx,
    runtime,
    shell: () => shell,
    route: () => route,
    update,
    restart,
    notify: async (next, prev) => { await watcher?.(next, prev) },
  }
}

async function withModeServer(
  update: (patch: DesktopSettings) => Promise<void>,
  run: (url: string, origin: string) => Promise<void>,
  reportError: (error: unknown) => void = () => {},
): Promise<void> {
  let handler!: ReturnType<typeof createDesktopModeHandler>
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  const authority = `127.0.0.1:${String(port)}`
  const origin = `http://${authority}`
  handler = createDesktopModeHandler({ authority, update, reportError })
  try {
    await run(`${origin}${DESKTOP_MODE_ENDPOINT}`, origin)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => { error === undefined ? resolve() : reject(error) })
    })
  }
}

async function postWithHost(url: string, origin: string, host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const req = httpRequest(url, {
      method: 'POST',
      headers: { host, origin, 'content-type': 'application/json' },
    }, (res) => {
      res.resume()
      res.once('end', () => { resolve(res.statusCode ?? 0) })
    })
    req.once('error', reject)
    req.end(JSON.stringify({ mode: 'compatibility' }))
  })
}

describe('desktop Host plugin', () => {
  it('defaults to compatibility mode and validates both schemas', () => {
    expect(Config({} as DesktopConfig)).toEqual(config)
    expect(Config({ mode: 'advanced' } as DesktopConfig)).toEqual({ ...config, mode: 'advanced' })
    expect(DesktopSettingsSchema({} as DesktopSettings)).toEqual({ mode: 'compatibility' })
    expect(() => Config({ mode: 'custom' } as never)).toThrow()
    expect(String(DESKTOP_SETTINGS_NAMESPACE)).toBe('dsh-desktop')
  })

  it('builds the loopback root with validated renderer mode and platform markers', () => {
    const url = new URL(desktopRendererUrl(43120, 'advanced', 'darwin'))
    expect(url.origin).toBe('http://127.0.0.1:43120')
    expect(url.pathname).toBe('/')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'dsh-desktop-mode': 'advanced',
      'dsh-desktop-platform': 'darwin',
    })
  })

  it('registers settings and the active Web port without re-entering Loader settlement', async () => {
    const harness = createHarness()
    const loaderAwait = vi.fn(() => new Promise<void>(() => {}))
    Object.assign(harness.ctx, { loader: { await: loaderAwait } })

    apply(harness.ctx, config)

    expect(inject).toContain('settings')
    expect(inject).not.toContain('loader')
    const register = vi.mocked(harness.ctx.settings.register)
    expect(register.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ applies: 'restart' }))
    expect(register.mock.calls[0]?.[2]).not.toHaveProperty('base')
    expect(loaderAwait).not.toHaveBeenCalled()
    expect(harness.route()).toEqual(expect.objectContaining({
      kind: 'exact',
      path: DESKTOP_MODE_ENDPOINT,
      handler: expect.any(Function),
    }))
    expect(harness.shell()).toEqual(expect.objectContaining({
      mode: 'compatibility',
      url: 'http://127.0.0.1:43120/?dsh-desktop-mode=compatibility&dsh-desktop-platform=darwin',
      productName: 'DSH Desktop',
      windowTitle: 'DeepSeek Harness Desktop',
      iconPath: expect.stringMatching(/\/build\/app-icon\.png$/u),
      trayIcons: {
        templatePath: expect.stringMatching(/\/build\/tray-iconTemplate\.png$/u),
        bluePath: expect.stringMatching(/\/build\/tray-icon-blue\.png$/u),
      },
    }))

    await harness.shell()?.requestModeChange('advanced')
    expect(harness.update).toHaveBeenCalledWith({ mode: 'advanced' })
  })

  it('requests one orderly restart after the settings scope commits another mode', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    apply(harness.ctx, config)

    await harness.notify({ mode: 'compatibility' }, { mode: 'compatibility' })
    expect(harness.restart).not.toHaveBeenCalled()

    harness.restart.mockImplementation(() => new Promise<void>(() => {}))
    await harness.notify({ mode: 'advanced' }, { mode: 'compatibility' })
    await vi.runAllTimersAsync()
    expect(harness.restart).toHaveBeenCalledOnce()
  })

  it('refuses to expose desktop settings writes from a non-loopback Web server', () => {
    const harness = createHarness()
    Object.assign(harness.ctx.webServer, { host: '0.0.0.0' })

    expect(() => apply(harness.ctx, config)).toThrow('requires a loopback Web server')
    expect(harness.route()).toBeUndefined()
  })

  it('accepts only a same-origin JSON POST containing the mode field', async () => {
    const update = vi.fn(async (_patch: DesktopSettings) => {})
    await withModeServer(update, async (url, origin) => {
      const accepted = await fetch(url, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ mode: 'advanced' }),
      })
      expect(accepted.status).toBe(204)
      expect(update).toHaveBeenCalledWith({ mode: 'advanced' })

      const wrongMethod = await fetch(url, { headers: { origin } })
      expect(wrongMethod.status).toBe(405)
      expect(wrongMethod.headers.get('allow')).toBe('POST')

      const wrongOrigin = await fetch(url, {
        method: 'POST',
        headers: { origin: 'http://localhost', 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'compatibility' }),
      })
      expect(wrongOrigin.status).toBe(403)

      const wrongHost = await postWithHost(
        url,
        origin,
        new URL(origin).host.replace('127.0.0.1', 'localhost'),
      )
      expect(wrongHost).toBe(403)

      const wrongMedia = await fetch(url, {
        method: 'POST',
        headers: { origin, 'content-type': 'text/plain' },
        body: JSON.stringify({ mode: 'compatibility' }),
      })
      expect(wrongMedia.status).toBe(415)

      const extraField = await fetch(url, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'compatibility', extra: true }),
      })
      expect(extraField.status).toBe(400)

      const tooLarge = await fetch(url, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'advanced', padding: 'x'.repeat(128) }),
      })
      expect(tooLarge.status).toBe(413)
    })
  })

  it('reports a rejected settings update without exposing Host details', async () => {
    const failure = new Error('settings write rejected')
    const reportError = vi.fn()
    await withModeServer(
      async () => { throw failure },
      async (url, origin) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'advanced' }),
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'mode-rejected' })
      },
      reportError,
    )
    expect(reportError).toHaveBeenCalledWith(failure)
  })

  it('refuses advanced settings on Linux before persistence', () => {
    const harness = createHarness('linux')
    apply(harness.ctx, config)
    const register = vi.mocked(harness.ctx.settings.register)
    const options = register.mock.calls[0]?.[2]

    expect(() => options?.validate?.({ mode: 'advanced' })).toThrow(
      'supported on macOS and Windows',
    )
    expect(() => options?.validate?.({ mode: 'compatibility' })).not.toThrow()
  })
})
