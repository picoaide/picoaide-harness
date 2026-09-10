import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serverManifestURL } from '../src/desktop-release.ts'
import type {
  DesktopNotification,
  DesktopRuntime,
  DesktopTrayItem,
  DesktopUpdateSource,
} from '../src/runtime.ts'
import type { UpdateCheckResult, UpdateRequest } from '../src/update-checker.ts'
import { apply, Config, inject, type Config as UpdateConfig } from '../src/updates.ts'

// 客户端只从**它登录的那台服务端**取更新(2026-09-10 定案):每个检查用例都
// 必须先有一个会话,否则状态是"请先登录"而不是"检查失败"。
const SERVER = 'https://server.test'

const testConfig: UpdateConfig = {
  enabled: true,
  initialDelayMs: 10,
  intervalMs: 1000,
  requestTimeoutMs: 1000,
}

const OFFICIAL_MANIFEST_URL = serverManifestURL(SERVER)

/**
 * 只统计**版本清单**请求。
 *
 * 会话内第一次检查会并行探一次服务端渠道内容(拿渠道 id 做一致性校验),
 * 那是每次会话一次的内部请求,不属于"检查了几次"的语义 —— 断言用这个过滤
 * 后的列表,才对得上被测行为。
 */
function manifestRequests(request: { readonly mock: { readonly calls: readonly unknown[][] } }): string[] {
  return request.mock.calls
    .map(call => String(call[0]))
    .filter(url => url === OFFICIAL_MANIFEST_URL)
}

/** 既能当 request 用、又能查调用记录的替身。 */
type RequestSpy = UpdateRequest & { readonly mock: { readonly calls: readonly unknown[][] } }

/** 服务端渠道内容响应(渠道探测读的就是它)。 */
function channelResponse(channelId = 'official'): Response {
  return Response.json({ channel_id: channelId, title: 'Server' })
}

/**
 * 按调用顺序依次返回清单响应的 request 替身。
 *
 * 不能直接用 `mockResolvedValueOnce` 队列:渠道探测会插进来打一次
 * `/api/client/v2/channel`,把队列里的第一个响应吃掉。这里按 URL 分流,
 * 队列只服务于清单请求。
 */
function sequencedManifestRequest(
  ...responses: readonly (Response | Error)[]
): RequestSpy {
  let index = 0
  const spy = vi.fn(async (url: string) => {
    if (String(url).endsWith('/api/client/v2/channel')) return channelResponse()
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (next instanceof Error) throw next
    if (next === undefined) throw new Error('no manifest response queued')
    return next
  })
  return spy as unknown as RequestSpy
}

/** 渠道版本清单:更新源唯一入口,最新版本由 client.version 决定。 */
function manifestResponse(version: unknown): Response {
  const releases = `${SERVER}/updates/client/${String(version)}`
  const digest = 'a'.repeat(64)
  return Response.json({
    schema: 1,
    channel_id: 'official',
    server: { version: String(version), image_tag: `v${String(version)}` },
    client: {
      version,
      assets: {
        'mac-universal': { url: `${releases}/PicoAide-Harness-${String(version)}-mac.dmg`, sha256: digest, size: 0 },
        'win-x64': { url: `${releases}/PicoAide-Harness-${String(version)}-x64-Setup.exe`, sha256: digest, size: 0 },
        'linux-x64': { url: `${releases}/PicoAide-Harness-${String(version)}-x86_64.AppImage`, sha256: digest, size: 0 },
      },
    },
  })
}

interface Harness {
  readonly statePath: string
  readonly tray: DesktopTrayItem
  readonly notifications: DesktopNotification[]
  readonly warnings: unknown[][]
  readonly confirmDownload: ReturnType<typeof vi.fn>
  readonly showManualCheckResult: ReturnType<typeof vi.fn>
  readonly downloadAndOpen: ReturnType<typeof vi.fn>
  readonly refresh: ReturnType<typeof vi.fn>
  readonly registrationDispose: ReturnType<typeof vi.fn>
  readonly publishedStates: ReturnType<typeof vi.fn>
  readonly checkNow: (() => void) | undefined
  /** 模拟会话变化(登录/切换服务端/登出)。 */
  emitSession(next: { serverURL?: string } | null): void
  dispose(): Promise<void>
}

async function createHarness(options: {
  readonly packaged?: boolean
  readonly currentVersion?: string
  readonly canDownload?: boolean
  readonly config?: UpdateConfig
  readonly request?: DesktopRuntime['updates']['request']
  readonly confirmDownload?: (version: string) => Promise<boolean>
  readonly showManualCheckResult?: (result: UpdateCheckResult | null) => Promise<void>
  readonly downloadAndOpen?: (version: string, source: DesktopUpdateSource, signal: AbortSignal) => Promise<void>
  readonly notify?: (notification: DesktopNotification) => void
  readonly locale?: DesktopRuntime['locale']
  readonly state?: string
  /** 会话里的服务端地址;`null` = 未登录(默认 SERVER)。 */
  readonly serverURL?: string | null
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-updates-'))
  const statePath = join(root, 'private', 'state.json')
  if (options.state !== undefined) {
    await mkdir(join(root, 'private'), { recursive: true })
    await writeFile(statePath, options.state, { mode: 0o600 })
  }
  const notifications: DesktopNotification[] = []
  const warnings: unknown[][] = []
  const refresh = vi.fn()
  const registrationDispose = vi.fn()
  const confirmDownload = vi.fn(options.confirmDownload ?? (async () => false))
  const showManualCheckResult = vi.fn(options.showManualCheckResult ?? (async () => {}))
  const downloadAndOpen = vi.fn(options.downloadAndOpen ?? (async () => {}))
  const publishedStates = vi.fn()
  let tray: DesktopTrayItem | undefined
  let disposer: (() => void | Promise<void>) | undefined
  const updatesAdapter = {
    isPackaged: options.packaged ?? true,
    currentVersion: options.currentVersion ?? '2.0.0',
    statePath,
    canDownload: options.canDownload ?? true,
    request: options.request ?? (async () => manifestResponse('2.0.0')),
    confirmDownload,
    showManualCheckResult,
    downloadAndOpen,
    notify: options.notify ?? ((notification: DesktopNotification) => { notifications.push(notification) }),
    publishState: publishedStates,
    checkNow: undefined as (() => void) | undefined,
  }
  const runtime = {
    locale: options.locale ?? 'en',
    updates: updatesAdapter,
    registerTrayItem: (item: DesktopTrayItem) => {
      tray = item
      return { refresh, dispose: registrationDispose }
    },
  } as unknown as DesktopRuntime
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  let session: { serverURL?: string } | null = options.serverURL === null
    ? null
    : { serverURL: options.serverURL ?? SERVER }
  const ctx = {
    desktopRuntime: runtime,
    logger: { warn: (...args: unknown[]) => { warnings.push(args) } },
    effect: (register: () => (() => void | Promise<void>)) => {
      disposer = register()
      return disposer
    },
    // 会话服务由 enterprise 提供;这里给最小替身,让插件能读到服务端地址。
    get: (name: string) => name === 'picoSession'
      ? { getSession: () => session }
      : undefined,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(handler)
      listeners.set(event, set)
      return () => { set.delete(handler) }
    },
  } as unknown as Context

  apply(ctx, options.config ?? testConfig)
  if (tray === undefined) throw new Error('Update tray item was not registered.')
  return {
    statePath,
    tray,
    notifications,
    warnings,
    confirmDownload,
    showManualCheckResult,
    downloadAndOpen,
    refresh,
    registrationDispose,
    publishedStates,
    checkNow: updatesAdapter.checkNow,
    emitSession: (next: { serverURL?: string } | null) => {
      session = next
      for (const handler of listeners.get('pico/session-changed') ?? []) handler(next)
    },
    dispose: async () => { await disposer?.() },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('desktop update Host plugin', () => {
  it('exposes the packaged 60-second and six-hour background policy', () => {
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

  it('checks the manifest of the signed-in server', async () => {
    const calls: string[] = []
    const request = vi.fn(async (url: string) => {
      calls.push(url)
      return manifestResponse('2.1.0')
    })
    const harness = await createHarness({ packaged: false, request })

    await harness.tray.invoke()

    // 第一个请求是服务端渠道内容(取渠道 id),第二个才是版本清单 ——
    // 更新源始终是登录的那台服务端(2026-09-10 定案)。
    // 清单请求先发,渠道探测与它并行(绝不排在前面吃掉超时预算)。
    expect(calls[0]).toBe(OFFICIAL_MANIFEST_URL)
    expect(calls).toContain(`${SERVER}/api/client/v2/channel`)
    expect(calls.every(url => url.startsWith(SERVER))).toBe(true)
    expect(harness.confirmDownload).toHaveBeenCalledWith('2.1.0')
    await harness.dispose()
  })

  it('reports "not signed in" instead of a network failure when there is no session', async () => {
    const request = vi.fn(async () => manifestResponse('2.1.0'))
    const harness = await createHarness({ packaged: false, request, serverURL: null })

    await harness.tray.invoke()

    // 未登录 = 没有更新源。必须报成"请先登录",而不是让用户去查网络。
    expect(request).not.toHaveBeenCalled()
    expect(harness.publishedStates).toHaveBeenCalledWith(expect.objectContaining({
      lastError: 'not-signed-in',
    }))
    await harness.dispose()
  })

  it('drops the previous server state when the session changes', async () => {
    const request = vi.fn(async () => manifestResponse('2.1.0'))
    const harness = await createHarness({ packaged: false, request })

    await harness.tray.invoke()
    expect(harness.confirmDownload).toHaveBeenCalledWith('2.1.0')

    // 切换服务端(或登出)必须清掉上一台的"有新版本",否则会把 A 服务端的
    // 版本提示成 B 服务端可升级。
    harness.emitSession(null)
    expect(harness.publishedStates).toHaveBeenLastCalledWith(expect.objectContaining({
      availableVersion: undefined,
    }))
    await harness.dispose()
  })

  it('renders the update tray command in the active native locale', async () => {
    const harness = await createHarness({ packaged: false, locale: 'zh' })

    expect(harness.tray.label()).toBe('检查更新…')

    await harness.dispose()
  })

  it.each([
    { packaged: false, enabled: true },
    { packaged: true, enabled: false },
  ])('reports a manual up-to-date result while automatic polling is disabled: %#', async ({ packaged, enabled }) => {
    vi.useFakeTimers()
    const request = vi.fn(async () => manifestResponse('2.0.0'))
    const harness = await createHarness({
      packaged,
      request,
      config: { ...testConfig, enabled },
    })

    await vi.advanceTimersByTimeAsync(testConfig.intervalMs)
    expect(request).not.toHaveBeenCalled()
    expect(harness.tray.label()).toBe('Check for Updates…')
    await harness.tray.invoke()
    expect(manifestRequests(request)).toHaveLength(1)
    expect(harness.showManualCheckResult).toHaveBeenCalledWith({
      status: 'up-to-date',
      currentVersion: '2.0.0',
      latestVersion: '2.0.0',
    })
    expect(harness.confirmDownload).not.toHaveBeenCalled()
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
    expect(harness.notifications).toEqual([])
    expect(harness.warnings).toEqual([])
  })

  it('prompts once for a background update and persists only state v2 prompt history', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => manifestResponse('2.1.0'))
    const harness = await createHarness({ request })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => { expect(harness.confirmDownload).toHaveBeenCalledWith('2.1.0') })
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
    expect(harness.tray.label()).toBe('PicoAide Harness 2.1.0 Available')
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
        version: 2,
        lastPromptedVersion: '2.1.0',
      })
    })
    if (process.platform !== 'win32') {
      expect((await stat(harness.statePath)).mode & 0o777).toBe(0o600)
    }

    await vi.advanceTimersByTimeAsync(testConfig.intervalMs)
    await vi.waitFor(() => { expect(manifestRequests(request)).toHaveLength(2) })
    expect(harness.confirmDownload).toHaveBeenCalledOnce()
    expect(harness.notifications).toEqual([])
    expect(harness.warnings).toEqual([])
  })

  it('downloads and opens only after confirmation', async () => {
    vi.useFakeTimers()
    let resolveDownload!: () => void
    const download = new Promise<void>(resolve => { resolveDownload = resolve })
    const harness = await createHarness({
      request: async () => manifestResponse('2.1.0'),
      confirmDownload: async () => true,
      downloadAndOpen: async () => download,
    })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => { expect(harness.downloadAndOpen).toHaveBeenCalledOnce() })
    const [version, source, signal] = harness.downloadAndOpen.mock.calls[0] as [string, { manifestURL: string }, AbortSignal]
    expect(version).toBe('2.1.0')
    // 更新源 = 登录的那台服务端(2026-09-10 定案),随下载请求下传。
    expect(source.manifestURL).toBe(OFFICIAL_MANIFEST_URL)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    expect(harness.tray.label()).toBe('Downloading PicoAide Harness 2.1.0…')
    expect(harness.notifications).toEqual([])

    resolveDownload()
    await vi.waitFor(() => { expect(harness.tray.label()).toBe('PicoAide Harness 2.1.0 Available') })
    expect(harness.notifications).toEqual([])
    expect(harness.tray.label()).toBe('PicoAide Harness 2.1.0 Available')
  })

  it('keeps the precise download failure category instead of collapsing to network (P2-63)', async () => {
    vi.useFakeTimers()
    const harness = await createHarness({
      request: async () => manifestResponse('2.1.0'),
      confirmDownload: async () => true,
      downloadAndOpen: async () => {
        throw Object.assign(new Error('digest mismatch'), { code: 'checksum-mismatch' })
      },
    })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => { expect(harness.downloadAndOpen).toHaveBeenCalledOnce() })
    await vi.waitFor(() => {
      const last = harness.publishedStates.mock.calls.at(-1)?.[0] as { lastError?: string } | undefined
      expect(last?.lastError).toBe('checksum-mismatch')
    })
    await harness.dispose()
  })

  it('maps an unclassified download failure to network (P2-63)', async () => {
    vi.useFakeTimers()
    const harness = await createHarness({
      request: async () => manifestResponse('2.1.0'),
      confirmDownload: async () => true,
      downloadAndOpen: async () => { throw new Error('socket hang up') },
    })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => { expect(harness.downloadAndOpen).toHaveBeenCalledOnce() })
    await vi.waitFor(() => {
      const last = harness.publishedStates.mock.calls.at(-1)?.[0] as { lastError?: string } | undefined
      expect(last?.lastError).toBe('network')
    })
    await harness.dispose()
  })

  it('treats a manual available-version selection as a fresh confirmation', async () => {
    const confirmDownload = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const harness = await createHarness({
      packaged: false,
      request: async () => manifestResponse('2.1.0'),
      confirmDownload,
    })

    await harness.tray.invoke()
    expect(confirmDownload).toHaveBeenCalledOnce()
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
    expect(harness.tray.label()).toBe('PicoAide Harness 2.1.0 Available')

    await harness.tray.invoke()
    expect(confirmDownload).toHaveBeenCalledTimes(2)
    expect(harness.downloadAndOpen).toHaveBeenCalledOnce()
    expect(harness.showManualCheckResult).not.toHaveBeenCalled()
  })

  it('rechecks the version after confirmation and skips a rotated download', async () => {
    const request = sequencedManifestRequest(manifestResponse('2.1.0'), manifestResponse('2.2.0'))
    const harness = await createHarness({
      packaged: false,
      request,
      confirmDownload: async () => true,
    })

    await harness.tray.invoke()

    expect(manifestRequests(request)).toHaveLength(2)
    expect(harness.confirmDownload).toHaveBeenCalledWith('2.1.0')
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
    expect(harness.showManualCheckResult).not.toHaveBeenCalled()
    expect(harness.tray.label()).toBe('PicoAide Harness 2.2.0 Available')
  })

  it('still downloads the confirmed version when the post-confirm re-check fails', async () => {
    const request = sequencedManifestRequest(manifestResponse('2.1.0'), new TypeError('offline'))
    const downloadAndOpen = vi.fn(async () => {})
    const harness = await createHarness({
      packaged: false,
      request,
      confirmDownload: async () => true,
      downloadAndOpen,
    })

    await harness.tray.invoke()

    // The user confirmed 2.1.0; a flaky re-check must not turn Download into a no-op.
    expect(harness.downloadAndOpen).toHaveBeenCalledWith('2.1.0', expect.objectContaining({ manifestURL: OFFICIAL_MANIFEST_URL }), expect.any(AbortSignal), expect.any(Function))
  })

  it.each([
    ['up-to-date', async () => manifestResponse('2.0.0')],
    ['failed', async () => new Response('unavailable', { status: 503 })],
  ] as const)('keeps an automatic %s result silent', async (_case, request) => {
    vi.useFakeTimers()
    const requestSpy = vi.fn(request) as unknown as RequestSpy
    const harness = await createHarness({ request: requestSpy })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => { expect(manifestRequests(requestSpy)).toHaveLength(1) })

    expect(harness.showManualCheckResult).not.toHaveBeenCalled()
    expect(harness.confirmDownload).not.toHaveBeenCalled()
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
  })

  it.each([
    ['same version', async () => manifestResponse('2.0.0'), {
      status: 'up-to-date', currentVersion: '2.0.0', latestVersion: '2.0.0',
    }],
    ['older version', async () => manifestResponse('1.9.9'), {
      status: 'up-to-date', currentVersion: '2.0.0', latestVersion: '1.9.9',
    }],
    ['non-canonical manifest version', async () => manifestResponse('2.01.0'), null],
    ['manifest without an installer', async () => Response.json({ schema: 1, client: { version: '2.1.0' } }), null],
    ['service unavailable', async () => new Response('unavailable', { status: 503 }), null],
    ['manifest redirect', async () => { throw new TypeError('Failed to fetch') }, null],
    ['network failure', async () => { throw new TypeError('offline') }, null],
  ] as const)('reports a manual %s result without prompting or downloading', async (_case, request, expected) => {
    const harness = await createHarness({ packaged: false, request })

    await harness.tray.invoke()

    expect(harness.showManualCheckResult).toHaveBeenCalledWith(expected)
    expect(harness.confirmDownload).not.toHaveBeenCalled()
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
    expect(harness.notifications).toEqual([])
    expect(harness.warnings).toEqual([])
    expect(harness.tray.label()).toBe('Check for Updates…')
  })

  it('silently resets legacy state and does not use it as an available version cache', async () => {
    vi.useFakeTimers()
    const harness = await createHarness({
      request: async () => manifestResponse('2.1.0'),
      state: JSON.stringify({
        version: 1,
        checkedVersion: '2.0.0',
        etag: '"legacy"',
        lastNotifiedVersion: '2.1.0',
        availableRelease: {
          tagName: 'v2.1.0',
          version: '2.1.0',
          htmlUrl: 'https://example.test/legacy',
        },
      }),
    })

    expect(harness.tray.label()).toBe('Check for Updates…')
    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => { expect(harness.confirmDownload).toHaveBeenCalledWith('2.1.0') })
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
        version: 2,
        lastPromptedVersion: '2.1.0',
      })
    })
    expect(harness.warnings).toEqual([])
  })

  it('does not prompt on a platform without a fixed download entry', async () => {
    const harness = await createHarness({
      packaged: false,
      canDownload: false,
      request: async () => manifestResponse('2.1.0'),
    })

    await harness.tray.invoke()

    expect(harness.confirmDownload).not.toHaveBeenCalled()
    expect(harness.showManualCheckResult).toHaveBeenCalledWith({
      status: 'update-available',
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
    })
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
    expect(harness.notifications).toEqual([])
    expect(harness.tray.label()).toBe('Check for Updates…')
  })

  it('shares one pending download and silently restores availability after failure', async () => {
    let rejectDownload!: (cause: Error) => void
    const download = new Promise<void>((_resolve, reject) => { rejectDownload = reject })
    const harness = await createHarness({
      packaged: false,
      request: async () => manifestResponse('2.1.0'),
      confirmDownload: async () => true,
      downloadAndOpen: async () => download,
    })

    const first = harness.tray.invoke()
    await vi.waitFor(() => { expect(harness.downloadAndOpen).toHaveBeenCalledOnce() })
    const second = harness.tray.invoke()
    expect(harness.downloadAndOpen).toHaveBeenCalledOnce()
    rejectDownload(new Error('offline'))
    await Promise.all([first, second])

    expect(harness.downloadAndOpen).toHaveBeenCalledOnce()
    expect(harness.notifications).toEqual([])
    expect(harness.warnings).toEqual([])
    expect(harness.tray.label()).toBe('PicoAide Harness 2.1.0 Available')
  })

  it('aborts checks and downloads and removes the tray item on effect disposal', async () => {
    let checkSignal: AbortSignal | undefined
    const checking = await createHarness({
      packaged: false,
      request: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        checkSignal = init.signal as AbortSignal
        checkSignal.addEventListener('abort', () => {
          reject(new DOMException('disposed', 'AbortError'))
        }, { once: true })
      }),
    })
    const pendingCheck = checking.tray.invoke()
    await vi.waitFor(() => { expect(checkSignal).toBeDefined() })
    await checking.dispose()
    await pendingCheck
    expect(checkSignal?.aborted).toBe(true)
    expect(checking.registrationDispose).toHaveBeenCalledOnce()
    expect(checking.notifications).toEqual([])

    let downloadSignal: AbortSignal | undefined
    const downloading = await createHarness({
      packaged: false,
      request: async () => manifestResponse('2.1.0'),
      confirmDownload: async () => true,
      downloadAndOpen: async (_version, _source, signal) => new Promise<void>((_resolve, reject) => {
        downloadSignal = signal
        signal.addEventListener('abort', () => {
          reject(new DOMException('disposed', 'AbortError'))
        }, { once: true })
      }),
    })
    const pendingDownload = downloading.tray.invoke()
    await vi.waitFor(() => { expect(downloadSignal).toBeDefined() })
    await downloading.dispose()
    await pendingDownload
    expect(downloadSignal?.aborted).toBe(true)
    expect(downloading.registrationDispose).toHaveBeenCalledOnce()
    expect(downloading.notifications).toEqual([])
    expect(downloading.warnings).toEqual([])
  })

  it('does not wait for an open manual result dialog during disposal', async () => {
    let closeDialog!: () => void
    const dialog = new Promise<void>(resolve => { closeDialog = resolve })
    const harness = await createHarness({
      packaged: false,
      showManualCheckResult: async () => dialog,
    })
    const pending = harness.tray.invoke()
    await vi.waitFor(() => { expect(harness.showManualCheckResult).toHaveBeenCalledOnce() })

    await harness.dispose()
    expect(harness.registrationDispose).toHaveBeenCalledOnce()

    closeDialog()
    await pending
  })

  it('reports a timed-out shared manual request and restores the idle tray label', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const request = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal
      signals.push(signal)
      signal.addEventListener('abort', () => {
        reject(new DOMException('cancelled', 'AbortError'))
      }, { once: true })
    }))
    const harness = await createHarness({ packaged: false, request })

    const first = harness.tray.invoke()
    const second = harness.tray.invoke()
    await vi.waitFor(() => { expect(manifestRequests(request)).toHaveLength(1) })
    expect(harness.tray.label()).toBe('Checking for Updates…')
    await vi.advanceTimersByTimeAsync(testConfig.requestTimeoutMs)
    await Promise.all([first, second])

    expect(signals[0]?.aborted).toBe(true)
    expect(harness.confirmDownload).not.toHaveBeenCalled()
    expect(harness.showManualCheckResult).toHaveBeenCalledWith(null)
    expect(harness.notifications).toEqual([])
    expect(harness.warnings).toEqual([])
    expect(harness.tray.label()).toBe('Check for Updates…')
  })

  it('publishes renderer snapshots on initial state and observable transitions', async () => {
    const request = vi.fn(async () => manifestResponse('2.3.0'))
    const harness = await createHarness({ request })
    // Initial static facts are published as soon as the state machine mounts.
    expect(harness.publishedStates).toHaveBeenCalled()
    expect(harness.publishedStates).toHaveBeenLastCalledWith({
      availableVersion: undefined,
      downloadingVersion: undefined,
      isPackaged: true,
      canDownload: true,
      currentVersion: '2.0.0',
    })

    // An available version publishes a downloadable snapshot.
    await harness.tray.invoke()
    await vi.waitFor(() => { expect(harness.publishedStates).toHaveBeenCalled() })
    expect(harness.publishedStates).toHaveBeenLastCalledWith(expect.objectContaining({
      availableVersion: '2.3.0',
      downloadingVersion: undefined,
    }))
  })

  it('installs the renderer check trigger and connects it to the manual flow', async () => {
    const request = vi.fn(async () => manifestResponse('2.3.0'))
    const harness = await createHarness({ request })
    expect(typeof harness.checkNow).toBe('function')
    // The trigger drives the same manual check (confirm dialog appears).
    harness.checkNow?.()
    await vi.waitFor(() => { expect(harness.confirmDownload).toHaveBeenCalledWith('2.3.0') })
  })
})


describe('desktop update channel from the manifest (prerelease installs)', () => {
  it('prompts a prerelease install for the newer prerelease published in the manifest', async () => {
    vi.useFakeTimers()
    // 渠道由清单内容决定:预发布版本写进 latest.json 就是预发布渠道,
    // 客户端不再按已装版本分流到不同的 GitHub 端点。
    const request = vi.fn(async () => manifestResponse('2.1.0-rc.2'))
    const harness = await createHarness({ currentVersion: '2.1.0-rc.1', request })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => { expect(harness.confirmDownload).toHaveBeenCalledWith('2.1.0-rc.2') })
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
    expect(harness.tray.label()).toBe('PicoAide Harness 2.1.0-rc.2 Available')
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
        version: 2,
        lastPromptedVersion: '2.1.0-rc.2',
      })
    })

    await harness.dispose()
  })

  it('accepts prerelease prompt history and does not prompt for it again', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => manifestResponse('2.1.0-rc.2'))
    const harness = await createHarness({
      currentVersion: '2.1.0-rc.1',
      request,
      state: JSON.stringify({ version: 2, lastPromptedVersion: '2.1.0-rc.2' }),
    })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.advanceTimersByTimeAsync(testConfig.intervalMs)
    expect(harness.confirmDownload).not.toHaveBeenCalled()
    // The availability snapshot stays visible (same as the stable flow after a
    // dismissed prompt); only the re-prompt is suppressed by the persisted
    // prerelease history.
    expect(harness.tray.label()).toBe('PicoAide Harness 2.1.0-rc.2 Available')

    await harness.dispose()
  })

  it('reports no update while the manifest still publishes the installed prerelease', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => manifestResponse('2.1.0-rc.1'))
    const harness = await createHarness({ currentVersion: '2.1.0-rc.1', request })

    await harness.tray.invoke()

    expect(harness.showManualCheckResult).toHaveBeenCalledWith({
      status: 'up-to-date',
      currentVersion: '2.1.0-rc.1',
      latestVersion: '2.1.0-rc.1',
    })
    expect(harness.confirmDownload).not.toHaveBeenCalled()

    await harness.dispose()
  })

  it('still runs a stable check when the installed version is stable', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => manifestResponse('2.0.0'))
    const harness = await createHarness({ request })

    await harness.tray.invoke()
    expect(manifestRequests(request)).toHaveLength(1)
    expect(harness.showManualCheckResult).toHaveBeenCalledWith({
      status: 'up-to-date',
      currentVersion: '2.0.0',
      latestVersion: '2.0.0',
    })
    expect(harness.confirmDownload).not.toHaveBeenCalled()

    await harness.dispose()
  })
})
