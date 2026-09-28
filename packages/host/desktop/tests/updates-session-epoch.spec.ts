/**
 * AA3-01（第二十七轮，P1）：**会话派生异步投影**的代际守卫 —— 正式判据。
 *
 * ## 为什么要有这个文件（而不是"再写一条探针"）
 *
 * 上一轮（Z2-03）用来登记本缺陷的探针在假定时器下只推进固定步数就取
 * `publishedStates.mock.calls.at(-1)`，于是**迟到续体还没跑完时，"最后一次发布"
 * 恰好是会话切换那一刻的清零发布**（`readyVersion=undefined`）⇒ 缺陷仍在时断言
 * 也通过。实测：单跑该用例 5/5 红、**同文件整跑 3/3 绿** —— 而 CI 是整包跑，
 * 所以那条判据在 CI 上永远不会替本缺陷报警（AA3-02）。
 *
 * 本文件是它的**正确形态**，三条腿缺一不可：
 *
 *  1. **对照组自校准**：同一条续体在**会话不变**时确实把 `downloadedVersion`
 *     落进 `state.json` ⇒ 证明夹具能观察到那次写入（否则"观察不到"可能只是夹具瞎）；
 *  2. **单调断言**：对**全部**发布做 `filter(readyVersion !== undefined)` 并断言为空
 *     —— 不取"最后一次"，所以迟到续体跑没跑完都不影响结论；
 *  3. **正交信号**：等一个与断言无关的落地证据（请求真的发出去了 / 落盘真的发生），
 *     再给一段有界静默期 —— 该窗口由对照组自校准。
 *
 * 用**真定时器**（`initialDelayMs` 压到 5ms）而不是假定时器：把时序交给真实事件
 * 循环，才能用"轮询到某个正交信号"这种与断言独立的等待（假定时器下只能靠"推进
 * 多少毫秒"猜，那正是上一条判据失效的机制）。
 *
 * ## 覆盖的路径
 *
 *  - **下载路径**：`await adapter.downloadUpdate` → `rememberDownload`（**跨重启存活**）
 *    → `readyVersion/readyPath` → `announceUpdateReady`；
 *  - **检查路径**：`await pending` → `observeResult` → `availableVersion`；
 *  - **安装交接**：`installReady()` 必须复检"这份包属于**当前** source"才把路径交给
 *    `adapter.installUpdate`（`electron-runtime.ts` 在 macOS 直接 `shell.openPath`）；
 *    正负两条腿（拒绝复核不过的、照常交付复核通过的）成对存在，避免恒真断言；
 *  - **跨重启污染**：被丢弃的那一笔**不得**进 `state.json`，真重启一次也不得被复用。
 *
 * 公开仓纪律：本文件只出现保留命名空间（`server.test` / `other.test`）。
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRuntime, DesktopTrayItem } from '../src/runtime.ts'
import { apply, type Config as UpdateConfig } from '../src/updates.ts'
import { serverManifestURL } from '../src/desktop-release.ts'

const SERVER = 'https://server.test'
const OTHER = 'https://other.test'

const config: UpdateConfig = {
  enabled: true,
  backgroundDownload: true,
  initialDelayMs: 5,
  intervalMs: 600_000,
  requestTimeoutMs: 2_000,
  checkRetryDelaysMs: [1, 1, 1],
  transferRetryDelaysMs: [1, 1, 1, 1, 1],
  downloadStallTimeoutMs: 5_000,
  downloadTotalTimeoutMs: 30_000,
  retryJitterRatio: 0,
}

/** 服务端渠道内容响应（渠道探测读的就是它）。 */
function channelResponse(channelId = 'official'): Response {
  return Response.json({ channel_id: channelId, title: 'Server' })
}

/** 清单里该平台的资产名（与源码"按下载地址末段命名"的规则一致）。 */
function assetNameFor(version: string): string {
  const suffix = process.platform === 'darwin'
    ? 'mac.dmg'
    : process.platform === 'win32' ? 'x64-Setup.exe' : 'x86_64.AppImage'
  return `PicoAide-Harness-${version}-${suffix}`
}

/** 一份**本平台合法**的最小安装包夹具（复用校验里有平台容器魔数检查）。 */
function installerFixture(): Uint8Array {
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

/** 夹具字节的 SHA-256（清单里声明的就是它）。 */
function sha256Hex(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * 某台服务端的版本清单。
 * @param base - 服务端 origin（下载地址的 base 随之不同）。
 * @param version - 清单声明的客户端版本。
 * @param digest - 安装包 SHA-256。
 */
function manifest(base: string, version: string, digest: string): Response {
  const releases = `${base}/updates/client/${version}`
  return Response.json({
    schema: 1,
    channel_id: 'official',
    server: { version, image_tag: `v${version}` },
    client: {
      version,
      assets: {
        'mac-universal': { url: `${releases}/PicoAide-Harness-${version}-mac.dmg`, sha256: digest, size: 0 },
        'win-x64': { url: `${releases}/PicoAide-Harness-${version}-x64-Setup.exe`, sha256: digest, size: 0 },
        'linux-x64': { url: `${releases}/PicoAide-Harness-${version}-x86_64.AppImage`, sha256: digest, size: 0 },
      },
    },
  })
}

interface StatePublish {
  readonly availableVersion?: string
  readonly readyVersion?: string
  readonly readyPath?: string
}

interface Fixture {
  readonly root: string
  readonly statePath: string
  readonly downloadUpdate: ReturnType<typeof vi.fn>
  readonly announceUpdateReady: ReturnType<typeof vi.fn>
  readonly installUpdate: ReturnType<typeof vi.fn>
  /** 每一次 `publishState` 的载荷（**单调断言对全部元素取值**，不取 `at(-1)`）。 */
  readonly published: StatePublish[]
  /** 每一次 `adapter.request` 的 URL（正交信号：判据前提用）。 */
  readonly requested: string[]
  /** 结算唯一一次在飞传输（用例自己决定它何时完成）。 */
  finishDownload(path: string): void
  /** 模拟会话变化（登录另一台服务端）。 */
  switchTo(serverURL: string): void
  /** 托盘「安装…并重启」入口（只在真的下载好之后出现）。 */
  invokeInstall(): void
  /** 「安装」入口现在可见吗。 */
  installEntryVisible(): boolean
  /** 读 `state.json`（被丢弃的迟到落盘不得出现在这里）。 */
  readState(): Promise<Record<string, unknown>>
  /** 放行被 `gateManifestFor` 挂住的清单请求。 */
  releaseGate(): void
  dispose(): Promise<void>
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

/**
 * 造一个场景夹具：某台服务端发布某个版本（触发后台静默下载），安装包传输由用例
 * 自己决定何时完成。
 * @param options.releases - 每台服务端"当前发布什么"（缺省 `server.test` 发布 2.1.0）。
 * @param options.downloadUpdate - 传输替身（缺省 = 由 `finishDownload` 结算的 deferred）。
 * @param options.userDataRoot - 复用现成的 user-data 目录（跨重启判据用）。
 * @param options.statePath - 覆盖状态文件路径（跨重启判据用）。
 * @param options.gateManifestFor - 让这台 origin 的**清单**请求挂在闸门上，直到用例放行。
 */
async function fixture(options: {
  readonly releases?: Readonly<Record<string, { readonly version: string, readonly digest: string }>>
  readonly downloadUpdate?: ReturnType<typeof vi.fn>
  readonly userDataRoot?: string
  readonly statePath?: string
  readonly gateManifestFor?: string
} = {}): Promise<Fixture> {
  const root = options.userDataRoot ?? await mkdtemp(join(tmpdir(), 'aa3-updates-'))
  if (options.userDataRoot === undefined) roots.push(root)
  const statePath = options.statePath ?? join(root, 'private', 'state.json')
  const released = options.releases ?? {
    [SERVER]: { version: '2.1.0', digest: sha256Hex(installerFixture()) },
  }

  let session: { serverURL?: string } | null = { serverURL: SERVER }
  let tray: DesktopTrayItem | undefined
  let disposer: (() => void | Promise<void>) | undefined
  let releaseGate: (() => void) | undefined
  const gate = options.gateManifestFor === undefined
    ? undefined
    : new Promise<void>((resolve) => { releaseGate = resolve })
  const published: StatePublish[] = []
  const requested: string[] = []
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const pending: ((path: string) => void)[] = []

  const downloadUpdate = options.downloadUpdate
    ?? vi.fn(() => new Promise<string>((resolve) => { pending.push(resolve) }))
  const announceUpdateReady = vi.fn(async () => {})
  const installUpdate = vi.fn(async () => {})

  const runtime = {
    locale: 'en',
    productName: 'PicoAide Harness',
    updates: {
      isPackaged: true,
      currentVersion: '2.0.0',
      statePath,
      canDownload: true,
      userDataPath: root,
      request: async (url: string) => {
        requested.push(url)
        if (url.includes('/channel')) return channelResponse()
        const origin = new URL(url).origin
        if (gate !== undefined && origin === options.gateManifestFor) await gate
        const entry = released[origin]
        if (entry === undefined) return new Response('unknown server', { status: 404 })
        return manifest(origin, entry.version, entry.digest)
      },
      showManualCheckResult: vi.fn(async () => {}),
      downloadUpdate,
      announceUpdateReady,
      installUpdate,
      notify: vi.fn(),
      publishState: (state: StatePublish) => { published.push(state) },
      checkNow: undefined,
    },
    registerTrayItem: (item: DesktopTrayItem) => {
      tray = item
      return { refresh: vi.fn(), dispose: vi.fn() }
    },
  } as unknown as DesktopRuntime

  const ctx = {
    desktopRuntime: runtime,
    logger: { warn: vi.fn() },
    effect: (register: () => (() => void | Promise<void>)) => { disposer = register(); return disposer },
    get: (name: string) => name === 'picoSession' ? { getSession: () => session, isRestored: () => true } : undefined,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(handler)
      listeners.set(event, set)
      return () => { set.delete(handler) }
    },
  }

  apply(ctx as never, config)

  return {
    root,
    statePath,
    downloadUpdate,
    announceUpdateReady,
    installUpdate,
    published,
    requested,
    finishDownload: (path: string) => { pending.shift()?.(path) },
    switchTo: (serverURL: string) => {
      session = { serverURL }
      for (const handler of listeners.get('pico/session-changed') ?? []) handler(session)
    },
    invokeInstall: () => {
      for (const entry of tray?.submenu?.() ?? []) entry.invoke()
    },
    installEntryVisible: () => (tray?.submenu?.() ?? []).length > 0,
    readState: async (): Promise<Record<string, unknown>> => {
      const raw = await readFile(statePath, 'utf8').catch(() => '{}')
      try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} }
    },
    releaseGate: () => { releaseGate?.() },
    dispose: async () => { await disposer?.() },
  }
}

/** 某个版本在本平台的**规范落点**（与下载器/复用校验同一套规则）。 */
function canonicalInstallerPath(root: string, version: string): string {
  return join(root, 'updates', version, assetNameFor(version))
}

/** 轮询到某个谓词成立（或超时）；返回是否成立。 */
async function waitFor(predicate: () => boolean | Promise<boolean>, budgetMs = 5_000): Promise<boolean> {
  const until = Date.now() + budgetMs
  while (Date.now() < until) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

/** 等后台静默下载真的被发起（判据前提，不成立就直接红）。 */
async function waitForDownload(f: Fixture): Promise<void> {
  expect(await waitFor(() => f.downloadUpdate.mock.calls.length > 0), '后台静默下载没有被发起（判据前提不成立）').toBe(true)
}

/** **单调断言**：任何一次发布都不得带 `readyVersion`。 */
function announcedReadyVersions(f: Fixture): string[] {
  return f.published.filter((state) => state.readyVersion !== undefined).map((state) => String(state.readyVersion))
}

/** **单调断言**：任何一次发布都不得把某个版本标成"可用"。 */
function publishedAvailableVersions(f: Fixture): string[] {
  return f.published.filter((state) => state.availableVersion !== undefined).map((state) => String(state.availableVersion))
}

/** 把一份**摘要与清单一致**的安装包写到规范落点。 */
async function placeInstaller(root: string, version: string, bytes: Uint8Array): Promise<string> {
  const target = canonicalInstallerPath(root, version)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  return target
}

describe('AA3-01：会话派生的异步投影必须带代际守卫（updates.ts）', () => {
  /**
   * **对照组（判据自校准）**：会话不变时，同一条续体确实把 `downloadedVersion`
   * 落盘。没有它，下面那条"不得落盘"可能是恒真的 —— 那正是上一轮那条 flaky 判据
   * 的失效形态（AA3-02）。
   */
  it('对照组：会话不变时，迟到续体确实把待安装版本落盘', async () => {
    const f = await fixture()
    await waitForDownload(f)
    const installer = await placeInstaller(f.root, '2.1.0', installerFixture())
    f.finishDownload(installer)
    const landed = await waitFor(async () => (await f.readState()).downloadedVersion === '2.1.0')
    await f.dispose()
    expect(landed, '对照组没能观察到 downloadedVersion 落盘 ⇒ 夹具无法观察该写入').toBe(true)
  })

  /**
   * **缺陷组**：下载途中换服务端 ⇒ 迟到续体整份丢弃。
   *
   * 三条断言都是**单调**的（对全部发布取值），因此"迟到续体跑没跑完"不影响结论；
   * 有界静默期由对照组自校准（对照组证明这段窗口足够观察到同一条写入）。
   */
  it('切换服务端后，迟到续体不得落盘、不得置 ready、不得通报（单调断言）', async () => {
    const f = await fixture()
    await waitForDownload(f)
    const installer = await placeInstaller(f.root, '2.1.0', installerFixture())

    // 用户切到另一台服务端，**然后**上一台的传输才完成。
    f.switchTo(OTHER)
    f.finishDownload(installer)
    await new Promise((resolve) => setTimeout(resolve, 500))

    const observed = {
      downloadedVersion: (await f.readState()).downloadedVersion,
      announcedReady: announcedReadyVersions(f),
      announceUpdateReadyCalls: f.announceUpdateReady.mock.calls.length,
      installEntryVisible: f.installEntryVisible(),
    }
    await f.dispose()
    expect(observed, `当前会话是 ${OTHER}，但上一台服务端 ${SERVER} 的安装包被固化`).toEqual({
      downloadedVersion: undefined,
      announcedReady: [],
      announceUpdateReadyCalls: 0,
      installEntryVisible: false,
    })
  })

  /**
   * **跨重启污染**：`state.json` 的 `downloadedVersion` 是**跨重启存活**的复用判据
   * —— 被丢弃的那一笔进了它，下一次启动就会把上一台服务端的安装包当"已下载好"。
   * 所以这里除了断言"没写进去"，还真的**重启一次**（同一 user-data 目录 + 同一
   * 状态文件），断言重启后也不会出现"可安装"。
   */
  it('被丢弃的那一笔不得进 state.json，重启后也不得被复用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aa3-updates-restart-'))
    roots.push(root)
    const bytes = installerFixture()
    const releases = {
      [SERVER]: { version: '2.1.0', digest: sha256Hex(bytes) },
      // 第二台服务端发布的是**已装版本** ⇒ 重启后不该有任何"有新版本"。
      [OTHER]: { version: '2.0.0', digest: sha256Hex(bytes) },
    }
    const statePath = join(root, 'private', 'state.json')

    const first = await fixture({ releases, userDataRoot: root, statePath })
    await waitForDownload(first)
    const installer = await placeInstaller(root, '2.1.0', bytes)
    first.switchTo(OTHER)
    first.finishDownload(installer)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const afterDiscard = (await first.readState()).downloadedVersion
    await first.dispose()

    // 真重启：同一状态文件 + 同一 user-data 目录，会话直接是第二台服务端。
    const second = await fixture({ releases, userDataRoot: root, statePath })
    second.switchTo(OTHER)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const afterRestart = {
      downloadedVersion: (await second.readState()).downloadedVersion,
      announcedReady: announcedReadyVersions(second),
      installEntryVisible: second.installEntryVisible(),
    }
    await second.dispose()

    expect(
      { afterDiscard, afterRestart },
      '上一台服务端的安装包在被丢弃之后仍然（或重启后）变成了"已下载待安装"',
    ).toEqual({
      afterDiscard: undefined,
      afterRestart: { downloadedVersion: undefined, announcedReady: [], installEntryVisible: false },
    })
  })

  /**
   * **检查路径**：清单响应迟到时不得把上一台服务端的版本标成可用 —— 否则托盘与
   * 渲染层会提示一个当前服务端根本没有的升级（点了必然失败）。
   */
  it('清单检查期间切换服务端：迟到响应不得把上一台的版本标成可用（单调断言）', async () => {
    const f = await fixture({
      releases: {
        [SERVER]: { version: '2.1.0', digest: sha256Hex(installerFixture()) },
        // 第二台服务端发布的是**已装版本** ⇒ 它自己不会有任何"有新版本"。
        [OTHER]: { version: '2.0.0', digest: sha256Hex(installerFixture()) },
      },
      gateManifestFor: SERVER,
    })

    // 前提（正交信号）：第一台服务端的清单请求真的发出去了，并且还挂在闸门上。
    expect(
      await waitFor(() => f.requested.includes(serverManifestURL(SERVER))),
      '上一台服务端的清单请求没有被发起（判据前提不成立）',
    ).toBe(true)

    f.switchTo(OTHER)
    f.releaseGate()
    await new Promise((resolve) => setTimeout(resolve, 400))

    const available = publishedAvailableVersions(f)
    await f.dispose()
    expect(available, `当前会话是 ${OTHER}（它发布 2.0.0 = 已是最新），但上一台的 2.1.0 被标成"有新版本"`).toEqual([])
  })

  /**
   * **安装交接的归属复检（负向腿）**：`installReady()` 只认"按**当前源**的清单复核
   * 通过、且磁盘上那份文件就在规范落点"的路径。下载器返回一个复核不过的路径时，
   * **绝不能**交给 `adapter.installUpdate` —— 那一步在 macOS 上就是 `shell.openPath`，
   * 会真的把安装包拉起来。
   */
  it('归属复检不过时，installReady 不得把路径交给平台安装器', async () => {
    const f = await fixture({
      downloadUpdate: vi.fn(async () => join(tmpdir(), 'aa3-not-the-canonical-installer')),
    })
    await waitForDownload(f)
    expect(await waitFor(() => f.installEntryVisible()), '下载完成后托盘应出现"安装"入口').toBe(true)

    f.invokeInstall()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const calls = f.installUpdate.mock.calls.length
    const stillVisible = f.installEntryVisible()
    await f.dispose()
    expect(calls, '复核不过的路径被交给了平台安装器').toBe(0)
    // 复检不过 ⇒ "待安装"作废（入口随之消失），而不是留一个点了没反应的按钮。
    expect(stillVisible).toBe(false)
  })

  /**
   * **安装交接的归属复检（正向腿）**：复核通过时照常交付 —— 证明上一条不是"永远拒绝"
   * 的恒真断言。
   */
  it('归属复检通过时，installReady 照常把规范落点交给平台安装器', async () => {
    const f = await fixture()
    await waitForDownload(f)
    const installer = await placeInstaller(f.root, '2.1.0', installerFixture())
    f.finishDownload(installer)
    expect(await waitFor(() => f.installEntryVisible()), '下载完成后托盘应出现"安装"入口').toBe(true)

    f.invokeInstall()
    expect(await waitFor(() => f.installUpdate.mock.calls.length > 0)).toBe(true)
    expect(f.installUpdate).toHaveBeenCalledWith('2.1.0', installer)
    await f.dispose()
  })
})
