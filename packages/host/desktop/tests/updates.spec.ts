import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
import { UpdateDownloadError } from '../src/update-download.ts'
import { apply, Config, inject, type Config as UpdateConfig } from '../src/updates.ts'

// 客户端只从**它登录的那台服务端**取更新(2026-09-10 定案):每个检查用例都
// 必须先有一个会话,否则状态是"请先登录"而不是"检查失败"。
const SERVER = 'https://server.test'

const testConfig: UpdateConfig = {
  enabled: true,
  backgroundDownload: true,
  initialDelayMs: 10,
  intervalMs: 1000,
  requestTimeoutMs: 1000,
  // 退避延迟压到 1ms:测的是"有没有重试/重试几次",不是等多久。
  checkRetryDelaysMs: [1, 1, 1],
  transferRetryDelaysMs: [1, 1, 1, 1, 1],
  retryJitterRatio: 0,
}

const OFFICIAL_MANIFEST_URL = serverManifestURL(SERVER)

/**
 * 请求是否发往 `base` 这台服务端。
 *
 * 按**解析后的 origin** 判断，不做子串匹配：`url.startsWith('https://server.test')`
 * 会把 `https://server.test.evil.example/x` 也算成"同一台服务端"
 * （CodeQL js/incomplete-url-substring-sanitization）。
 * @param url - 被检查的请求地址。
 * @param base - 允许的服务端地址。
 * @returns 同源时为 true；无法解析的地址为 false。
 */
function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin
  } catch {
    return false
  }
}

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
 * 渠道版本清单:更新源唯一入口,最新版本由 client.version 决定。
 * @param version - 清单声明的客户端版本。
 * @param digest - 安装包 SHA-256;复用安装包的用例必须给**真实**哈希(缺省是全 a 的占位)。
 */
function manifestResponse(version: unknown, digest = 'a'.repeat(64)): Response {
  const releases = `${SERVER}/updates/client/${String(version)}`
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

/**
 * 本平台的一份最小合法安装包夹具。
 *
 * 必须按平台给对容器格式:复用校验里有平台魔数检查,拿 DMG 冒充 AppImage
 * 只会测出"不可复用"(2026-09-12 实测)。
 */
function installerArtifactFixture(): Uint8Array {
  if (process.platform === 'darwin') {
    const dmg = Buffer.alloc(1024, 0x5a)
    dmg.write('koly', dmg.byteLength - 512, 'ascii')
    return dmg
  }
  if (process.platform === 'win32') {
    const pe = Buffer.alloc(512, 0)
    pe.write('MZ', 0, 'ascii')
    pe.writeUInt32LE(0x80, 0x3c)
    pe.set([0x50, 0x45, 0x00, 0x00], 0x80)
    return pe
  }
  const appImage = Buffer.alloc(512, 0)
  appImage.set([0x7f, 0x45, 0x4c, 0x46], 0)
  appImage.set([0x41, 0x49, 0x02], 8)
  return appImage
}

/**
 * 本平台在测试清单里的安装包文件名(与源码"按下载地址末段命名"的规则一致)。
 * @param version - manifest version.
 * @returns the artifact file name the downloader will use.
 */
function installerNameFor(version: string): string {
  const url = new URL(manifestAssetURL(version))
  return url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
}

/** 测试清单里下载地址的前缀(与服务端镜像布局同形)。 */
function manifestAssetURL(version: string): string {
  return `${SERVER}/updates/client/${version}/PicoAide-Harness-${version}-${process.platform === 'darwin' ? 'mac.dmg' : process.platform === 'win32' ? 'x64-Setup.exe' : 'x86_64.AppImage'}`
}

/**
 * 完成件的落地路径(与源码"版本目录 + 清单下载地址末段"的规则一致)。
 * @param userDataPath - Electron user-data directory.
 * @param version - canonical version.
 * @returns absolute installer path.
 */
function installerPathFor(userDataPath: string, version: string): string {
  return join(userDataPath, 'updates', version, installerNameFor(version))
}

/** 把一份合法安装包夹具写到某个版本目录,模拟"上一轮已经下载好"。 */
async function writeInstallerFixture(userDataPath: string, version: string): Promise<void> {
  const target = installerPathFor(userDataPath, version)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, installerArtifactFixture())
}

/** 夹具字节的 SHA-256(小写十六进制)。 */
function sha256Hex(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

interface Harness {
  readonly statePath: string
  readonly userDataPath: string
  readonly tray: DesktopTrayItem
  readonly notifications: DesktopNotification[]
  readonly warnings: unknown[][]
  readonly showManualCheckResult: ReturnType<typeof vi.fn>
  readonly downloadUpdate: ReturnType<typeof vi.fn>
  readonly announceUpdateReady: ReturnType<typeof vi.fn>
  readonly installUpdate: ReturnType<typeof vi.fn>
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
  readonly showManualCheckResult?: (result: UpdateCheckResult | null) => Promise<void>
  readonly downloadUpdate?: (version: string, source: DesktopUpdateSource, signal: AbortSignal) => Promise<string>
  readonly announceUpdateReady?: (version: string, path: string) => Promise<void>
  readonly installUpdate?: (version: string, path: string) => Promise<void>
  readonly notify?: (notification: DesktopNotification) => void
  readonly locale?: DesktopRuntime['locale']
  readonly state?: string
  /** 会话里的服务端地址;`null` = 未登录(默认 SERVER)。 */
  readonly serverURL?: string | null
  /** 复用现成的 user-data 目录(重启复用安装包用);缺省新建临时目录。 */
  readonly userDataRoot?: string
  /** 覆盖状态文件路径(与 `userDataRoot` 搭配);缺省 `<root>/private/state.json`。 */
  readonly statePath?: string
} = {}): Promise<Harness> {
  const root = options.userDataRoot ?? await mkdtemp(join(tmpdir(), 'dsh-updates-'))
  const statePath = options.statePath ?? join(root, 'private', 'state.json')
  if (options.state !== undefined) {
    await mkdir(join(root, 'private'), { recursive: true })
    await writeFile(statePath, options.state, { mode: 0o600 })
  }
  const notifications: DesktopNotification[] = []
  const warnings: unknown[][] = []
  const refresh = vi.fn()
  const registrationDispose = vi.fn()
  const showManualCheckResult = vi.fn(options.showManualCheckResult ?? (async () => {}))
  const downloadUpdate = vi.fn(options.downloadUpdate ?? (async () => '/tmp/picoaide-installer'))
  const announceUpdateReady = vi.fn(options.announceUpdateReady ?? (async () => {}))
  const installUpdate = vi.fn(options.installUpdate ?? (async () => {}))
  const publishedStates = vi.fn()
  let tray: DesktopTrayItem | undefined
  let disposer: (() => void | Promise<void>) | undefined
  const updatesAdapter = {
    isPackaged: options.packaged ?? true,
    currentVersion: options.currentVersion ?? '2.0.0',
    statePath,
    canDownload: options.canDownload ?? true,
    userDataPath: root,
    request: options.request ?? (async () => manifestResponse('2.0.0')),
    showManualCheckResult,
    downloadUpdate,
    announceUpdateReady,
    installUpdate,
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
    userDataPath: root,
    tray,
    notifications,
    warnings,
    showManualCheckResult,
    downloadUpdate,
    announceUpdateReady,
    installUpdate,
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
  it('exposes the packaged 60-second and six-hour background download policy', () => {
    expect(inject).toEqual(['desktopRuntime'])
    expect(Config({} as UpdateConfig)).toEqual({
      enabled: true,
      // 缺省后台静默下载:发现新版本就先下,下完再提示。
      backgroundDownload: true,
      initialDelayMs: 60_000,
      intervalMs: 21_600_000,
      requestTimeoutMs: 15_000,
      // 3 次检查尝试 / 5 次传输尝试(首次 + 每个延迟项一次重试)。
      checkRetryDelaysMs: [2_000, 8_000, 20_000],
      transferRetryDelaysMs: [2_000, 8_000, 20_000, 30_000, 30_000],
      retryJitterRatio: 0.25,
    })
    expect(() => Config({ intervalMs: 0 } as UpdateConfig)).toThrow()
    expect(() => Config({ requestTimeoutMs: 0 } as UpdateConfig)).toThrow()
    expect(() => Config({ retryJitterRatio: 1.5 } as UpdateConfig)).toThrow()
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
    expect(calls.every(url => sameOrigin(url, SERVER))).toBe(true)
    // 有可用版本就直接下载(后台静默),不再先问一句"要不要下载"。
    await vi.waitFor(() => { expect(harness.downloadUpdate).toHaveBeenCalledOnce() })
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
    await vi.waitFor(() => { expect(harness.downloadUpdate).toHaveBeenCalledOnce() })

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
    expect(harness.downloadUpdate).not.toHaveBeenCalled()
    expect(harness.announceUpdateReady).not.toHaveBeenCalled()
    expect(harness.notifications).toEqual([])
    expect(harness.warnings).toEqual([])
  })

  it('downloads a background update silently and persists only state v2 history', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => manifestResponse('2.1.0'))
    const harness = await createHarness({ request })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    // 后台流程:先静默下载(不弹任何对话框),下完才通报一次"可安装"。
    await vi.waitFor(() => { expect(harness.announceUpdateReady).toHaveBeenCalledWith('2.1.0', expect.any(String)) })
    expect(harness.showManualCheckResult).not.toHaveBeenCalled()
    expect(harness.tray.label()).toBe('PicoAide Harness 2.1.0 Ready to Install')
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
        version: 2,
        lastPromptedVersion: '2.1.0',
        downloadedVersion: '2.1.0',
        downloadedPath: expect.any(String),
      })
    })
    if (process.platform !== 'win32') {
      expect((await stat(harness.statePath)).mode & 0o777).toBe(0o600)
    }

    await vi.advanceTimersByTimeAsync(testConfig.intervalMs)
    await vi.waitFor(() => { expect(manifestRequests(request)).toHaveLength(2) })
    // 同一版本已经下好:第二次轮询不重复传输、也不重复通报。
    expect(harness.downloadUpdate).toHaveBeenCalledOnce()
    expect(harness.announceUpdateReady).toHaveBeenCalledOnce()
    expect(harness.notifications).toEqual([])
    expect(harness.warnings).toEqual([])
  })

  it('downloads silently, then announces the ready installer', async () => {
    vi.useFakeTimers()
    let resolveDownload!: (path: string) => void
    const download = new Promise<string>(resolve => { resolveDownload = resolve })
    const harness = await createHarness({
      request: async () => manifestResponse('2.1.0'),
      downloadUpdate: async () => download,
    })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => { expect(harness.downloadUpdate).toHaveBeenCalledOnce() })
    const [version, source, signal] = harness.downloadUpdate.mock.calls[0] as [string, { manifestURL: string }, AbortSignal]
    expect(version).toBe('2.1.0')
    // 更新源 = 登录的那台服务端(2026-09-10 定案),随下载请求下传。
    expect(source.manifestURL).toBe(OFFICIAL_MANIFEST_URL)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    expect(harness.tray.label()).toBe('Downloading PicoAide Harness 2.1.0…')
    // 下载期间绝不打断用户:没有对话框、没有系统通知。
    expect(harness.announceUpdateReady).not.toHaveBeenCalled()
    expect(harness.showManualCheckResult).not.toHaveBeenCalled()
    expect(harness.notifications).toEqual([])

    resolveDownload('/tmp/picoaide-installer')
    await vi.waitFor(() => { expect(harness.tray.label()).toBe('PicoAide Harness 2.1.0 Ready to Install') })
    expect(harness.announceUpdateReady).toHaveBeenCalledWith('2.1.0', '/tmp/picoaide-installer')
    expect(harness.notifications).toEqual([])
  })

  it('keeps the precise download failure category instead of collapsing to network (P2-63)', async () => {
    vi.useFakeTimers()
    const harness = await createHarness({
      request: async () => manifestResponse('2.1.0'),
      downloadUpdate: async () => {
        throw Object.assign(new UpdateDownloadError('checksum-mismatch', 'digest mismatch'), {
          code: 'checksum-mismatch',
        })
      },
    })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    // 校验和不符属于"可重试":字节留在 .partial 里续传,预算内重试到底才报错。
    await vi.waitFor(() => {
      const last = harness.publishedStates.mock.calls.at(-1)?.[0] as { lastError?: string } | undefined
      expect(last?.lastError).toBe('checksum-mismatch')
    })
    expect(harness.downloadUpdate).toHaveBeenCalledTimes(testConfig.transferRetryDelaysMs.length + 1)
    expect(harness.announceUpdateReady).not.toHaveBeenCalled()
    await harness.dispose()
  })

  it('maps an unclassified download failure to network (P2-63)', async () => {
    vi.useFakeTimers()
    const harness = await createHarness({
      request: async () => manifestResponse('2.1.0'),
      downloadUpdate: async () => { throw new Error('socket hang up') },
    })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => {
      const last = harness.publishedStates.mock.calls.at(-1)?.[0] as { lastError?: string } | undefined
      expect(last?.lastError).toBe('network')
    })
    expect(harness.downloadUpdate).toHaveBeenCalledTimes(testConfig.transferRetryDelaysMs.length + 1)
    await harness.dispose()
  })

  it('installs the downloaded installer on the next manual action instead of re-downloading', async () => {
    const harness = await createHarness({
      packaged: false,
      request: async () => manifestResponse('2.1.0'),
      downloadUpdate: async () => '/tmp/picoaide-installer',
    })

    await harness.tray.invoke()
    await vi.waitFor(() => { expect(harness.tray.label()).toBe('PicoAide Harness 2.1.0 Ready to Install') })
    expect(harness.downloadUpdate).toHaveBeenCalledOnce()

    // 第二个动作 = 安装(不是再下一次):已下载的文件被直接交给平台安装流程。
    await harness.tray.invoke()
    await vi.waitFor(() => { expect(harness.installUpdate).toHaveBeenCalledWith('2.1.0', '/tmp/picoaide-installer') })
    expect(harness.downloadUpdate).toHaveBeenCalledOnce()
    expect(harness.showManualCheckResult).not.toHaveBeenCalled()
  })

  it('reuses a downloadable installer across a restart without transferring it again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-updates-reuse-'))
    try {
      // 上一轮已经下载好并记账:新进程启动后必须先认这份文件,而不是重新下载。
      // 落地文件名由清单里的下载地址派生(渠道化产物名),这里照同一规则取。
      const installer = join(root, 'updates', '2.1.0', installerNameFor('2.1.0'))
      await mkdir(dirname(installer), { recursive: true })
      await writeFile(installer, installerArtifactFixture())
      await mkdir(join(root, 'private'), { recursive: true })
      await writeFile(join(root, 'private', 'state.json'), JSON.stringify({
        version: 2,
        lastPromptedVersion: '2.1.0',
        downloadedVersion: '2.1.0',
        downloadedPath: installer,
      }))
      const artifact = installerArtifactFixture()
      const request = vi.fn(async (url: string) => {
        if (url.endsWith('/api/client/v2/channel')) return channelResponse()
        return manifestResponse('2.1.0', sha256Hex(artifact))
      })
      const harness = await createHarness({
        packaged: false,
        request,
        userDataRoot: root,
        statePath: join(root, 'private', 'state.json'),
      })

      await vi.waitFor(() => { expect(harness.tray.label()).toBe('PicoAide Harness 2.1.0 Ready to Install') })
      expect(harness.downloadUpdate).not.toHaveBeenCalled()
      expect(harness.announceUpdateReady).not.toHaveBeenCalled()
      await harness.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
    expect(harness.downloadUpdate).not.toHaveBeenCalled()
    expect(harness.announceUpdateReady).not.toHaveBeenCalled()
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
    expect(harness.downloadUpdate).not.toHaveBeenCalled()
    expect(harness.announceUpdateReady).not.toHaveBeenCalled()
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
    await vi.waitFor(() => { expect(harness.downloadUpdate).toHaveBeenCalledOnce() })
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
        version: 2,
        lastPromptedVersion: '2.1.0',
        downloadedVersion: '2.1.0',
        downloadedPath: expect.any(String),
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

    expect(harness.downloadUpdate).not.toHaveBeenCalled()
    expect(harness.showManualCheckResult).toHaveBeenCalledWith({
      status: 'update-available',
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
    })
    expect(harness.announceUpdateReady).not.toHaveBeenCalled()
    expect(harness.notifications).toEqual([])
    expect(harness.tray.label()).toBe('Check for Updates…')
  })

  it('retries a transient transfer failure and succeeds on the next attempt', async () => {
    const downloadUpdate = vi.fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce('/tmp/picoaide-installer')
    const harness = await createHarness({
      packaged: false,
      request: async () => manifestResponse('2.1.0'),
      downloadUpdate,
    })

    await harness.tray.invoke()
    await vi.waitFor(() => { expect(harness.tray.label()).toBe('PicoAide Harness 2.1.0 Ready to Install') })

    // 网络抖动不该让用户看到失败:重试一次就成功,并且中间态暴露了第几次尝试。
    expect(downloadUpdate).toHaveBeenCalledTimes(2)
    const states = harness.publishedStates.mock.calls.map(call => call[0] as { retryAttempt: number })
    expect(states.some(state => state.retryAttempt === 2)).toBe(true)
    expect(harness.announceUpdateReady).toHaveBeenCalledWith('2.1.0', '/tmp/picoaide-installer')
    expect(harness.notifications).toEqual([])
    expect(harness.warnings).toEqual([])
  })

  it('shares one pending download and keeps availability after the retry budget is spent', async () => {
    let rejectDownload!: (cause: Error) => void
    const download = new Promise<string>((_resolve, reject) => { rejectDownload = reject })
    const harness = await createHarness({
      packaged: false,
      request: async () => manifestResponse('2.1.0'),
      downloadUpdate: async () => download,
    })

    const first = harness.tray.invoke()
    await vi.waitFor(() => { expect(harness.downloadUpdate).toHaveBeenCalledOnce() })
    const second = harness.tray.invoke()
    await vi.waitFor(() => { expect(harness.downloadUpdate).toHaveBeenCalledOnce() })
    rejectDownload(new Error('offline'))
    await Promise.all([first, second])

    // 同一个版本同时只跑一次传输:第二个动作复用了进行中的下载。
    expect(harness.downloadUpdate).toHaveBeenCalledTimes(testConfig.transferRetryDelaysMs.length + 1)
    expect(harness.announceUpdateReady).not.toHaveBeenCalled()
    expect(harness.notifications).toEqual([])
    expect(harness.warnings).toEqual([])
    // 传输失败后仍然"有可用新版本"(用户还能再点一次),但错误已可见。
    expect(harness.tray.label()).toBe('PicoAide Harness 2.1.0 Available')
    expect(harness.publishedStates).toHaveBeenLastCalledWith(expect.objectContaining({ lastError: 'network' }))
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
      downloadUpdate: async (_version, _source, signal) => new Promise<string>((_resolve, reject) => {
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
    // 每次重试各自计时:一次 1ms 推进就把每一轮的"退避 → 下一次请求 → 再超时"
    // 全部走完(advanceTimersByTimeAsync 会执行期间新排上的定时器)。
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([first, second])

    expect(signals[0]?.aborted).toBe(true)
    expect(harness.downloadUpdate).not.toHaveBeenCalled()
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
    expect(harness.publishedStates).toHaveBeenLastCalledWith(expect.objectContaining({
      availableVersion: undefined,
      downloadingVersion: undefined,
      readyVersion: undefined,
      isPackaged: true,
      canDownload: true,
      currentVersion: '2.0.0',
    }))

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
    // The trigger drives the same manual flow: 检查 → 静默下载 → 可安装。
    harness.checkNow?.()
    await vi.waitFor(() => { expect(harness.downloadUpdate).toHaveBeenCalledWith('2.3.0', expect.anything(), expect.any(AbortSignal), expect.any(Function)) })
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
    await vi.waitFor(() => { expect(harness.announceUpdateReady).toHaveBeenCalledWith('2.1.0-rc.2', expect.any(String)) })
    expect(harness.tray.label()).toBe('PicoAide Harness 2.1.0-rc.2 Ready to Install')
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
        version: 2,
        lastPromptedVersion: '2.1.0-rc.2',
        downloadedVersion: '2.1.0-rc.2',
        downloadedPath: expect.any(String),
      })
    })

    await harness.dispose()
  })

  it('keeps a recorded prerelease download ready across restarts without re-prompting', async () => {
    vi.useFakeTimers()
    // 清单声明的哈希必须与磁盘上的完成件一致,复用校验才会通过。
    const request = vi.fn(async () => manifestResponse('2.1.0-rc.2', sha256Hex(installerArtifactFixture())))
    const harness = await createHarness({
      currentVersion: '2.1.0-rc.1',
      request,
      state: JSON.stringify({ version: 2, lastPromptedVersion: '2.1.0-rc.2' }),
    })
    // 状态里记着"这一版已经下载好":把完成件真的放到版本目录里(名字按清单
    // 下载地址派生),启动后必须直接复用,既不重下也不再提示。
    await writeInstallerFixture(harness.userDataPath, '2.1.0-rc.2')

    await harness.dispose()
    const restarted = await createHarness({
      currentVersion: '2.1.0-rc.1',
      request,
      state: JSON.stringify({
        version: 2,
        lastPromptedVersion: '2.1.0-rc.2',
        downloadedVersion: '2.1.0-rc.2',
        downloadedPath: installerPathFor(harness.userDataPath, '2.1.0-rc.2'),
      }),
      userDataRoot: harness.userDataPath,
    })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    // 复用校验要先读状态文件与磁盘(真实 I/O),再回落到"可安装"。
    await vi.waitFor(() => { expect(restarted.tray.label()).toBe('PicoAide Harness 2.1.0-rc.2 Ready to Install') })
    await vi.advanceTimersByTimeAsync(testConfig.intervalMs)
    // 后续轮询看到"这一版已经在待安装位":不重下、也不再提示。
    expect(restarted.downloadUpdate).not.toHaveBeenCalled()
    expect(restarted.announceUpdateReady).not.toHaveBeenCalled()
    expect(restarted.tray.label()).toBe('PicoAide Harness 2.1.0-rc.2 Ready to Install')

    await restarted.dispose()
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
    expect(harness.downloadUpdate).not.toHaveBeenCalled()

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
    expect(harness.downloadUpdate).not.toHaveBeenCalled()

    await harness.dispose()
  })
})
