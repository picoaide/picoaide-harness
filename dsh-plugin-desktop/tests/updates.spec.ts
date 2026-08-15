import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopNotification,
  DesktopRuntime,
  DesktopTrayItem,
} from '../src/runtime.ts'
import { apply, Config, inject, type Config as UpdateConfig } from '../src/updates.ts'

const testConfig: UpdateConfig = {
  enabled: true,
  initialDelayMs: 10,
  intervalMs: 1000,
  requestTimeoutMs: 1000,
}

const releaseUrl = (tag: string): string =>
  `https://github.com/anywhere-labs/deepseek-harness-desktop/releases/tag/${encodeURIComponent(tag)}`

function releaseResponse(tag: string, etag = '"latest"'): Response {
  return Response.json({
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: releaseUrl(tag),
  }, { headers: { etag } })
}

interface Harness {
  readonly statePath: string
  readonly tray: DesktopTrayItem
  readonly notifications: DesktopNotification[]
  readonly opened: string[]
  readonly warnings: unknown[][]
  readonly refresh: ReturnType<typeof vi.fn>
  readonly registrationDispose: ReturnType<typeof vi.fn>
  dispose(): void
}

async function createHarness(options: {
  readonly packaged?: boolean
  readonly config?: UpdateConfig
  readonly request?: DesktopRuntime['updates']['request']
  readonly notify?: (notification: DesktopNotification) => void
  readonly state?: string
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-updates-'))
  const statePath = join(root, 'private', 'state.json')
  if (options.state !== undefined) {
    await mkdir(join(root, 'private'), { recursive: true })
    await writeFile(statePath, options.state, { mode: 0o600 })
  }
  const notifications: DesktopNotification[] = []
  const opened: string[] = []
  const warnings: unknown[][] = []
  const refresh = vi.fn()
  const registrationDispose = vi.fn()
  let tray: DesktopTrayItem | undefined
  let disposer: (() => void) | undefined
  const runtime = {
    updates: {
      isPackaged: options.packaged ?? true,
      currentVersion: '2.0.0',
      statePath,
      request: options.request ?? (async () => releaseResponse('v2.0.0')),
      openRelease: async (url: string) => { opened.push(url) },
      notify: options.notify ?? ((notification: DesktopNotification) => { notifications.push(notification) }),
    },
    registerTrayItem: (item: DesktopTrayItem) => {
      tray = item
      return { refresh, dispose: registrationDispose }
    },
  } as unknown as DesktopRuntime
  const ctx = {
    desktopRuntime: runtime,
    logger: { warn: (...args: unknown[]) => { warnings.push(args) } },
    effect: (register: () => (() => void)) => {
      disposer = register()
      return disposer
    },
  } as unknown as Context

  apply(ctx, options.config ?? testConfig)
  if (tray === undefined) throw new Error('Update tray item was not registered.')
  return {
    statePath,
    tray,
    notifications,
    opened,
    warnings,
    refresh,
    registrationDispose,
    dispose: () => { disposer?.() },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('desktop update Host plugin', () => {
  it('exposes explicit background policy defaults', () => {
    expect(inject).toEqual(['desktopRuntime'])
    expect(Config({} as UpdateConfig)).toEqual({
      enabled: true,
      initialDelayMs: 60_000,
      intervalMs: 21_600_000,
      requestTimeoutMs: 15_000,
    })
    expect(() => Config({ intervalMs: 0 } as UpdateConfig)).toThrow()
    expect(() => Config({ requestTimeoutMs: 0 } as UpdateConfig)).toThrow()
  })

  it.each([
    { packaged: false, enabled: true },
    { packaged: true, enabled: false },
  ])('keeps manual tray checks while automatic polling is disabled: %#', async ({ packaged, enabled }) => {
    vi.useFakeTimers()
    const request = vi.fn(async () => releaseResponse('v2.0.0'))
    const harness = await createHarness({
      packaged,
      request,
      config: { ...testConfig, enabled },
    })

    await vi.advanceTimersByTimeAsync(1000)
    expect(request).not.toHaveBeenCalled()
    expect(harness.tray.label()).toBe('Check for Updates…')
    await harness.tray.invoke()
    expect(request).toHaveBeenCalledOnce()
    expect(harness.notifications).toEqual([{
      title: 'DSH Desktop is Up to Date',
      body: 'Version 2.0.0 is the latest stable release.',
    }])
  })

  it('polls after the configured delays, persists ETag privately, and notifies once', async () => {
    vi.useFakeTimers()
    const headers: Array<string | null> = []
    let call = 0
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      headers.push(new Headers(init.headers).get('if-none-match'))
      call += 1
      return call === 1
        ? releaseResponse('v2.1.0', '"v2.1"')
        : new Response(null, { status: 304, headers: { etag: '"v2.1"' } })
    })
    const harness = await createHarness({ request })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => { expect(request).toHaveBeenCalledOnce() })
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toMatchObject({
        lastNotifiedVersion: '2.1.0',
      })
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(testConfig.intervalMs)
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2) })

    expect(headers).toEqual([null, '"v2.1"'])
    expect(harness.notifications).toEqual([{
      title: 'DSH Desktop Update Available',
      body: 'Version 2.1.0 is available.',
      openUrl: releaseUrl('v2.1.0'),
    }])
    expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
      version: 1,
      checkedVersion: '2.0.0',
      etag: '"v2.1"',
      lastNotifiedVersion: '2.1.0',
      availableRelease: {
        tagName: 'v2.1.0',
        version: '2.1.0',
        htmlUrl: releaseUrl('v2.1.0'),
      },
    })
    expect((await stat(harness.statePath)).mode & 0o777).toBe(0o600)
    expect(harness.tray.label()).toBe('DSH Desktop 2.1.0 Available')
  })

  it('loads ETag and notification state, then opens only the validated release URL', async () => {
    vi.useFakeTimers()
    const seenEtags: Array<string | null> = []
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      seenEtags.push(new Headers(init.headers).get('if-none-match'))
      return new Response(null, { status: 304, headers: { etag: '"persisted"' } })
    })
    const harness = await createHarness({
      request,
      state: JSON.stringify({
        version: 1,
        checkedVersion: '2.0.0',
        etag: '"persisted"',
        lastNotifiedVersion: '2.1.0',
        availableRelease: {
          tagName: 'v2.1.0',
          version: '2.1.0',
          htmlUrl: releaseUrl('v2.1.0'),
        },
      }),
    })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => { expect(request).toHaveBeenCalledOnce() })
    expect(seenEtags).toEqual(['"persisted"'])
    expect(harness.notifications).toEqual([])
    expect(harness.tray.label()).toBe('DSH Desktop 2.1.0 Available')

    await harness.tray.invoke()
    expect(harness.opened).toEqual([releaseUrl('v2.1.0')])
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([
    ['malformed JSON', '{broken'],
    ['header injection', JSON.stringify({ version: 1, etag: '"ok"\r\nInjected: yes' })],
    ['oversized contents', 'x'.repeat(4097)],
  ])('warns and atomically resets %s cache state without blocking checks', async (_case, savedState) => {
    vi.useFakeTimers()
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).has('if-none-match')).toBe(false)
      return releaseResponse('v2.0.0', '"recovered"')
    })
    const harness = await createHarness({ request, state: savedState })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => { expect(request).toHaveBeenCalledOnce() })

    expect(harness.warnings.flat().join(' ')).toContain('update state was reset')
    expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
      version: 1,
      checkedVersion: '2.0.0',
      etag: '"recovered"',
    })
  })

  it('discards an ETag and cached release checked by another installed version', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).has('if-none-match')).toBe(false)
      return releaseResponse('v2.1.0', '"current"')
    })
    const harness = await createHarness({
      request,
      state: JSON.stringify({
        version: 1,
        checkedVersion: '1.9.0',
        etag: '"old"',
        lastNotifiedVersion: '2.1.0',
        availableRelease: {
          tagName: 'v2.1.0',
          version: '2.1.0',
          htmlUrl: releaseUrl('v2.1.0'),
        },
      }),
    })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => { expect(request).toHaveBeenCalledOnce() })
    expect(harness.notifications).toEqual([])
    expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toMatchObject({
      checkedVersion: '2.0.0',
      etag: '"current"',
    })
  })

  it('turns a manual 304 into the cached available release result', async () => {
    const request = vi.fn(async () => new Response(null, { status: 304, headers: { etag: '"cached"' } }))
    const harness = await createHarness({
      packaged: false,
      request,
      state: JSON.stringify({
        version: 1,
        checkedVersion: '2.0.0',
        etag: '"cached"',
        availableRelease: {
          tagName: 'v2.1.0',
          version: '2.1.0',
          htmlUrl: releaseUrl('v2.1.0'),
        },
      }),
    })

    await harness.tray.invoke()
    expect(harness.notifications).toEqual([{
      title: 'DSH Desktop Update Available',
      body: 'Version 2.1.0 is available.',
      openUrl: releaseUrl('v2.1.0'),
    }])
    expect(harness.tray.label()).toBe('DSH Desktop 2.1.0 Available')
    await harness.tray.invoke()
    expect(harness.opened).toEqual([releaseUrl('v2.1.0')])
    expect(request).toHaveBeenCalledOnce()
  })

  it('logs background failures and presents manual failures', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => { throw new TypeError('offline') })
    const harness = await createHarness({ request })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    expect(harness.notifications).toEqual([])
    expect(harness.warnings.flat().join(' ')).toContain('background update check failed (network)')

    await harness.tray.invoke()
    expect(harness.notifications).toEqual([{
      title: 'Unable to Check for Updates',
      body: 'The update service could not be reached.',
    }])
  })

  it('shares one in-flight manual request and aborts it at the configured timeout', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const request = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal
      signals.push(signal)
      signal.addEventListener('abort', () => { reject(new DOMException('cancelled', 'AbortError')) }, { once: true })
    }))
    const harness = await createHarness({ packaged: false, request })

    const first = harness.tray.invoke()
    const second = harness.tray.invoke()
    await vi.waitFor(() => { expect(request).toHaveBeenCalledOnce() })
    expect(harness.tray.label()).toBe('Checking for Updates…')
    await vi.advanceTimersByTimeAsync(testConfig.requestTimeoutMs)
    await Promise.all([first, second])

    expect(signals[0]?.aborted).toBe(true)
    expect(harness.notifications).toEqual([{
      title: 'Unable to Check for Updates',
      body: 'The update check was cancelled.',
    }])
    expect(harness.tray.label()).toBe('Check for Updates…')
  })

  it('clears timers, aborts work, and removes the tray item on effect disposal', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const request = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal as AbortSignal
      signal.addEventListener('abort', () => { reject(new DOMException('disposed', 'AbortError')) }, { once: true })
    }))
    const harness = await createHarness({ packaged: false, request })
    const pending = harness.tray.invoke()
    await vi.waitFor(() => { expect(request).toHaveBeenCalledOnce() })

    harness.dispose()
    await pending
    await vi.advanceTimersByTimeAsync(10_000)

    expect(signal?.aborted).toBe(true)
    expect(harness.registrationDispose).toHaveBeenCalledOnce()
    expect(harness.notifications).toEqual([])
    expect(request).toHaveBeenCalledOnce()
  })

  it('notifies a manual 304 result instead of treating it as a background failure', async () => {
    const harness = await createHarness({
      packaged: false,
      request: async () => new Response(null, { status: 304 }),
    })

    await harness.tray.invoke()
    expect(harness.notifications).toEqual([{
      title: 'Update Check Complete',
      body: 'Release information has not changed.',
    }])
  })
})
