/**
 * 2026-09-14 现场 P0 回归：蒙版（overlay）视图必须跟着浏览器分区走。
 *
 * 症状（Windows 客户机 v2.7.3）：登录后在内置浏览器里点「我来操作」没有任何
 * 反应，主机日志刷
 * `pico-browser: refused a local write without browser proof (401) [POST /api/pico/browser/takeover]`。
 *
 * 根因链（真机探针 temp/browser-takeover-proof-probe.mjs 已复现）：
 *   1. 开机 prewarm 在**任何会话之前**建窗口，蒙版 WebContentsView 于是拿
 *      `persist:agent-browser-anonymous`；
 *   2. 登录 → `setPartition(browserPartitionFor(user))` —— 只影响**新建**的
 *      tab 视图；Electron 的 WebContents 分区在创建时固定，老蒙版留在旧 jar；
 *   3. `index.ts` 的 cookie 交接把 BrowserAuth 票据镜像进**当前**分区（探针实测
 *      新建 tab 的 jar 里有 `dsh-auth-*`，蒙版 jar 里没有）；
 *   4. 蒙版页的写请求（接管/面板/书签…）在 `requireWriteProof` 下 403，而蒙版
 *      是窗口锁定时唯一的用户入口 ⇒ 用户彻底无法接管浏览器，直到窗口被销毁重建。
 *
 * 本文件锁住修法：分区变化时**重建**蒙版视图（destroy + 用新分区重新挂载）。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ElectronAdapter,
  NativeBounds,
  NativeBrowserWindow,
  NativeDownloadItem,
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
  partition = BOOT_PARTITION
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
  readonly partitionSession = new MockSession()
  showSaveDialog = vi.fn(async () => ({ canceled: true }))
  openPath = vi.fn(async () => ({}))
  createView(partition?: string): NativeView { const v = new MockView(); v.partition = partition ?? BOOT_PARTITION; this.views.push(v); return v }
  /** The mask view records the partition it was created with — the assertion target. */
  createMaskView(partition?: string): NativeView { const v = new MockView(); v.partition = partition ?? BOOT_PARTITION; this.overlays.push(v); return v }
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

function makeRuntime(): { runtime: BrowserRuntime; adapter: MockAdapter; dir: string } {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.mask-part-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(adapter as never, {}, undefined, BOOT_PARTITION, { store })
  runtime.setShellOrigin('http://127.0.0.1:45678')
  return { runtime, adapter, dir }
}

describe('mask overlay follows the browser partition (R7-RV-4)', () => {
  it('boot prewarm mounts the mask on the boot partition', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    try {
      await runtime.prewarm()
      expect(adapter.overlays).toHaveLength(1)
      expect(adapter.overlays[0]?.partition).toBe(BOOT_PARTITION)
      expect(adapter.overlays[0]?.url).toBe('http://127.0.0.1:45678/browser-overlay')
    } finally {
      runtime.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a user switch rebuilds the mask on the new partition (the takeover entry keeps its write proof)', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    try {
      await runtime.prewarm()
      const stale = adapter.overlays[0]!
      runtime.setPartition(USER_PARTITION)
      expect(adapter.overlays).toHaveLength(2)
      const fresh = adapter.overlays[1]!
      expect(fresh.partition).toBe(USER_PARTITION)
      expect(fresh.url).toBe('http://127.0.0.1:45678/browser-overlay')
      // The stale view must be gone: a live one would keep the old cookie jar
      // and keep failing the BrowserAuth write proof.
      expect(stale.destroyed).toBe(true)
      expect(stale.attached).toBe(false)
    } finally {
      runtime.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an unchanged partition does not churn the mask view', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    try {
      await runtime.prewarm()
      runtime.setPartition(BOOT_PARTITION)
      expect(adapter.overlays).toHaveLength(1)
      expect(adapter.overlays[0]?.destroyed).toBe(false)
    } finally {
      runtime.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a partition switch without a window creates nothing (next ensureWindow uses the new partition)', async () => {
    const { runtime, adapter, dir } = makeRuntime()
    try {
      runtime.setPartition(USER_PARTITION)
      expect(adapter.overlays).toHaveLength(0)
      await runtime.prewarm()
      expect(adapter.overlays).toHaveLength(1)
      expect(adapter.overlays[0]?.partition).toBe(USER_PARTITION)
    } finally {
      runtime.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
