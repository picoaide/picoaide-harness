/**
 * 2026-09-14 现场 P0 的回归：蒙版（overlay）视图的会话归属，与「我来操作」的写证明。
 *
 * 现场症状（Windows 客户机 v2.7.3）：登录后在内置浏览器里点「我来操作」没有任何
 * 反应，主机日志刷
 * `pico-browser: refused a local write without browser proof (401) [POST /api/pico/browser/takeover]`。
 *
 * 当时的根因链（真机探针 temp/browser-takeover-proof-probe.mjs 复现过）：
 *   1. 开机 prewarm 在**任何会话之前**建窗口，蒙版 WebContentsView 于是拿
 *      `persist:agent-browser-anonymous`；
 *   2. 登录 → `setPartition(browserPartitionFor(user))` —— Electron 的 WebContents
 *      分区在创建时固定，老蒙版留在旧 jar；
 *   3. `index.ts` 的 cookie 交接把 BrowserAuth 票据镜像进**当前**分区；
 *   4. 蒙版页的写请求（接管/面板/书签/隐藏窗口/下载打开）在 `requireWriteProof`
 *      下 403，而蒙版是窗口锁定时唯一的用户入口 ⇒ 用户彻底无法接管浏览器，
 *      直到窗口被销毁重建。当时修法 = 分区变化时**重建**蒙版视图。
 *
 * **2026-09-21（§7b 方案 A）把整条 cookie 交接链路删掉了**：蒙版改跑
 * **默认 session**（`mountOverlay` 调 `createMaskView()` 不传分区）—— 那正是主应用
 * 窗口与本插件 shell 页所在的那个 jar，`dsh-auth-*` 天然就在里面。于是"蒙版必须跟着
 * 标签分区走"这个要求本身消失，两个后果：
 *   · 蒙版不再需要（也不允许）拿到标签分区里的凭据 —— 标签分区是**模型可驱动**的；
 *   · 切账号不再需要重建蒙版（旧断言在结构上已不成立：重建只会白丢面板状态）。
 *
 * 本文件因此锁**新不变量**（不是把旧用例删掉）：
 *   ① prewarm 挂蒙版时**一个参数都不传** ⇒ 适配器走默认 session；
 *   ② 切账号**不重建、不销毁**蒙版，同时**标签仍然跟着分区走**（两侧都不能放宽）；
 *   ③ 蒙版与标签跑在**不同 session**（模型面对的 jar ≠ 持票的 jar）；
 *   ④ 分区未变时不 churn；没有窗口时切分区不产生任何视图。
 *
 * 变异验证（在包副本里实跑）：`mountOverlay` 改回
 * `this.adapter.createMaskView(this.partition)` ⇒ ①③ 变红；`setPartition` 里恢复
 * `remountOverlay()` ⇒ ② 变红。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ElectronAdapter,
  NativeBounds,
  NativeBrowserWindow,
  NativeImage,
  NativeSession,
  NativeView,
  NativeWebContents,
} from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'

const BOOT_PARTITION = 'persist:agent-browser-anonymous'
const USER_PARTITION = 'persist:agent-browser-admin'

class MockTransport implements CdpTransport {
  attached = false
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  sendCommand(): Promise<unknown> { return Promise.resolve({}) }
  on(): void {}
  removeListener(): void {}
}

class MockSession implements NativeSession {
  partition = BOOT_PARTITION
  clearStorageData = vi.fn(async () => {})
  clearCache = vi.fn(async () => {})
  setPermissionRequestHandler = vi.fn()
  setPermissionCheckHandler = vi.fn()
  on(): void {}
  removeListener(): void {}
}

class MockView implements NativeView {
  transport = new MockTransport()
  session = new MockSession()
  attached = false
  visible = false
  bounds: NativeBounds = { x: 0, y: 0, width: 0, height: 0 }
  url = ''
  destroyed = false
  /** 本视图创建时的分区（undefined = 默认 session，见 §7b 方案 A）。 */
  partition: string | undefined
  loadURL = vi.fn(async (u: string) => { this.url = u })
  downloadURL = vi.fn()
  goBack = vi.fn()
  goForward = vi.fn()
  reload = vi.fn()
  capturePage = vi.fn(async (): Promise<NativeImage> => { throw new Error('unused') })
  setWindowOpenHandler = vi.fn()
  attach(win: NativeBrowserWindow, bounds: NativeBounds): void { this.attached = true; this.bounds = bounds; win.contentView.addChildView(this) }
  setBounds(b: NativeBounds): void { this.bounds = b }
  setVisible(v: boolean): void { this.visible = v }
  detach(): void { this.attached = false }
  moveToTop(): void {}
  destroy(): void { this.destroyed = true }
  get webContents(): NativeWebContents {
    return {
      cdp: this.transport,
      loadURL: this.loadURL,
      downloadURL: this.downloadURL,
      goBack: this.goBack,
      goForward: this.goForward,
      reload: this.reload,
      capturePage: this.capturePage,
      getURL: () => this.url,
      getTitle: () => '',
      isLoading: () => false,
      on: () => {},
      removeListener: () => {},
      session: this.session,
      setWindowOpenHandler: () => {},
      close: () => { this.destroyed = true },
      isDestroyed: () => this.destroyed,
    } as never
  }
}

class MockAdapter implements ElectronAdapter {
  readonly views: MockView[] = []
  readonly overlays: MockView[] = []
  readonly windows: Array<{ visible: boolean; destroyed: boolean }> = []
  /** 标签页的分区 session。 */
  readonly partitionSession = new MockSession()
  /** 默认 session：蒙版 + shell 页 + 主应用窗口所在的那个 jar（持票的那个）。 */
  readonly defaultSession = new MockSession()
  /** 每次 `createMaskView` 收到的**实参个数**：0 = 没传分区 = 默认 session。 */
  readonly maskArgCounts: number[] = []
  showSaveDialog = vi.fn(async () => ({ canceled: true }))
  openPath = vi.fn(async () => ({}))
  createView(partition?: string): NativeView {
    const v = new MockView()
    v.partition = partition ?? BOOT_PARTITION
    v.session = this.partitionSession
    this.views.push(v)
    return v
  }
  createMaskView(...args: Array<string | undefined>): NativeView {
    const v = new MockView()
    v.partition = args[0]
    v.session = args[0] === undefined ? this.defaultSession : this.partitionSession
    this.maskArgCounts.push(args.length)
    this.overlays.push(v)
    return v
  }
  createBrowserWindow(): never {
    const w = { visible: false, destroyed: false }
    this.windows.push(w)
    return {
      loadURL: async () => {},
      show: () => { w.visible = true },
      hide: () => { w.visible = false },
      focus: () => {},
      isVisible: () => w.visible,
      isDestroyed: () => w.destroyed,
      close: () => { w.destroyed = true },
      setTitle: () => {},
      getContentSize: () => ({ width: 1100, height: 780 }),
      contentView: { addChildView: () => {}, removeChildView: () => {} },
      onResize: () => () => {},
      onClosed: () => () => {},
      focusPage: () => {},
    } as never
  }
  getSession(): NativeSession { return this.partitionSession }
}

const dirs: string[] = []
function cleanup(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

function makeRuntime(): { runtime: BrowserRuntime; adapter: MockAdapter } {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.mask-part-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(adapter as never, {}, undefined, BOOT_PARTITION, { store })
  runtime.setShellOrigin('http://127.0.0.1:45678')
  return { runtime, adapter }
}

describe('mask overlay session (§7b option A: default session, not the tab partition)', () => {
  it('① prewarm mounts the mask with NO partition argument (⇒ default session)', async () => {
    const { runtime, adapter } = makeRuntime()
    try {
      await runtime.prewarm()
      expect(adapter.overlays).toHaveLength(1)
      // 0 个实参 = `createMaskView()`：适配器据此**不写** webPreferences.partition，
      // 于是视图落在 Electron 默认 session —— 持票的那个 jar（适配器侧的判据见
      // audit-0921-credential-isolation.spec.ts）。
      expect(adapter.maskArgCounts).toEqual([0])
      expect(adapter.overlays[0]?.partition).toBeUndefined()
      expect(adapter.overlays[0]?.url).toBe('http://127.0.0.1:45678/browser-overlay')
    } finally {
      runtime.dispose()
      cleanup()
    }
  })

  it('② a user switch neither rebuilds nor destroys the mask — while tabs still follow the partition', async () => {
    const { runtime, adapter } = makeRuntime()
    try {
      await runtime.prewarm()
      const mask = adapter.overlays[0]!
      runtime.setPartition(USER_PARTITION)
      // 蒙版的写证明（应用自己的 dsh-auth-*）在默认 session 里，与标签分区无关：
      // 切账号既不需要、也不允许把它销毁重建（重建只会白丢面板状态）。
      expect(adapter.overlays).toHaveLength(1)
      expect(adapter.overlays[0]).toBe(mask)
      expect(mask.destroyed).toBe(false)
      expect(mask.attached).toBe(true)
      // 另一半不能放宽：模型面对的标签必须落在**新用户**的分区里。
      await runtime.open('https://a.example')
      expect(adapter.views.at(-1)?.partition).toBe(USER_PARTITION)
    } finally {
      runtime.dispose()
      cleanup()
    }
  })

  it('③ the mask and the tabs live in DIFFERENT sessions (the model jar never holds the proof)', async () => {
    const { runtime, adapter } = makeRuntime()
    try {
      await runtime.prewarm()
      await runtime.open('https://a.example')
      const mask = adapter.overlays[0]!
      const tab = adapter.views[0]!
      expect(mask.session).toBe(adapter.defaultSession)
      expect(tab.session).toBe(adapter.partitionSession)
      expect(mask.session).not.toBe(tab.session)
    } finally {
      runtime.dispose()
      cleanup()
    }
  })

  it('④ an unchanged partition does not churn the mask view', async () => {
    const { runtime, adapter } = makeRuntime()
    try {
      await runtime.prewarm()
      runtime.setPartition(BOOT_PARTITION)
      expect(adapter.overlays).toHaveLength(1)
      expect(adapter.overlays[0]?.destroyed).toBe(false)
    } finally {
      runtime.dispose()
      cleanup()
    }
  })

  it('⑤ a partition switch without a window creates nothing; the next prewarm still mounts one mask', async () => {
    const { runtime, adapter } = makeRuntime()
    try {
      runtime.setPartition(USER_PARTITION)
      expect(adapter.overlays).toHaveLength(0)
      await runtime.prewarm()
      expect(adapter.overlays).toHaveLength(1)
      expect(adapter.maskArgCounts).toEqual([0])
    } finally {
      runtime.dispose()
      cleanup()
    }
  })
})
