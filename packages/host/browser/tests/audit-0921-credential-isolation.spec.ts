/**
 * §7b 残留收口（2026-09-21，方案 A）的回归锁：**凭据不得住进模型可驱动的 jar**。
 *
 * 决策记录：`docs/decisions/2026-09-21-app-author-data-surface.md` §7b。
 * 前因：`mirrorBrowserAuthCookies` 把应用 session 的 `dsh-auth-*`（BrowserAuth
 * 持有性证明）镜像进 `persist:agent-browser-<user>` —— 也就是 `browser_*` 工具
 * 驱动的那批标签页所在的 cookie jar。于是"持有性证明"对模型形同虚设：它驱动
 * 的标签页**自己就是**一个持票的真页面。
 *
 * 修法（方案 A）：蒙版视图改跑**默认 session**（`mountOverlay` → `createMaskView()`
 * 不传分区），写证明靠那个 jar 里本来就有的应用 cookie；交接链路整块删除。
 *
 * 本文件的四条判据各自独立承重：
 *   ① **适配器**：不传分区 ⇒ `webPreferences` 里**根本没有** `partition` 键
 *      （= Electron 默认 session，与 `createBrowserWindow()` 同 jar）；
 *   ② **适配器**：显式传分区 ⇒ 键在（标签页那条路没有被一起改坏）；
 *   ③ **插件源码**：全包零 cookie API 调用 —— 跨 jar 复制凭据在实现上只能经
 *      `session.cookies.set`，这条断言让"再写一次镜像"当场变红；
 *   ④ **运行期**：蒙版/两个 shell 页都**不在标签注册表**里（宿主 `loadURL` 直接
 *      加载，模型面拿不到它们），而分区权限守卫（原先寄生在交接函数里的安全副作用）
 *      仍照 §16.1 装在该分区上、**没有**装到默认 session 上。
 *
 * 变异验证（在包副本里实跑，见交接报告）：
 *   · 适配器恢复 `partition` 默认值 ⇒ ① 红；
 *   · 源码里塞回 `cookies.set` 镜像 ⇒ ③ 红；
 *   · `sessionForPartition` 改回 `defaultSession`、或去掉守卫安装 ⇒ ④ 红。
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ElectronModuleLike } from '../src/electron-adapter.ts'
import { createRealElectronAdapter } from '../src/electron-adapter.ts'
import type { NativeBrowserWindow, NativeImage, NativeSession, NativeView } from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserStore } from '../src/store.ts'

// ---------------------------------------------------------------- ① ② adapter

interface CapturedView { kind: 'view'; options: Record<string, unknown>; partition?: string }

function makeElectron(captured: CapturedView[]): ElectronModuleLike {
  class FakeWebContentsView {
    webContents = {
      setWindowOpenHandler: () => {},
      session: {},
      on: () => {},
      removeListener: () => {},
      cdp: {},
      loadURL: () => Promise.resolve(),
      getURL: () => '',
      getTitle: () => '',
      isLoading: () => false,
      isDestroyed: () => false,
      close: () => {},
      capturePage: () => Promise.resolve(undefined),
    }
    constructor(options: Record<string, unknown>) { captured.push({ kind: 'view', options }) }
  }
  class FakeBrowserWindow {
    contentView = { addChildView: () => {}, removeChildView: () => {}, children: [] as unknown[] }
    constructor(options: Record<string, unknown>) { captured.push({ kind: 'view', options } as never) }
    setMenuBarVisibility(): void {}
    on(): void {}
    removeListener(): void {}
    show(): void {}
    hide(): void {}
    focus(): void {}
    isDestroyed(): boolean { return false }
    isVisible(): boolean { return false }
    isMinimized(): boolean { return false }
    isFocused(): boolean { return false }
    close(): void {}
    loadURL(): Promise<void> { return Promise.resolve() }
    setTitle(): void {}
    getContentSize(): { width: number; height: number } { return { width: 1100, height: 780 } }
  }
  return {
    WebContentsView: FakeWebContentsView,
    BrowserWindow: FakeBrowserWindow,
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    shell: { openPath: async () => '' },
  } as unknown as ElectronModuleLike
}

/** webPreferences of the last view created through `factory`. */
function prefsOf(captured: CapturedView[]): Record<string, unknown> {
  const entry = captured.at(-1)
  expect(entry, 'factory must create a WebContentsView').toBeDefined()
  return (entry!.options.webPreferences ?? {}) as Record<string, unknown>
}

describe('① ② 蒙版默认 session、标签按分区（适配器契约）', () => {
  it('① createMaskView() 不写 partition ⇒ 与浏览器窗口同一个默认 session', () => {
    const captured: CapturedView[] = []
    const adapter = createRealElectronAdapter(makeElectron(captured))
    adapter.createBrowserWindow()
    const windowPrefs = prefsOf(captured)
    adapter.createMaskView()
    const maskPrefs = prefsOf(captured)
    // 蒙版与窗口自身（承载 /browser-shell 的那个 webContents）必须落同一个 jar：
    // 蒙版页的写操作要靠这个 jar 里的 dsh-auth-* 过 requireWriteProof。
    expect('partition' in windowPrefs).toBe(false)
    expect('partition' in maskPrefs).toBe(false)
    // 移分区不能顺手丢掉 2026-08-22 的合成要求（透明蒙版压在页面之上）。
    expect(maskPrefs.transparent).toBe(true)
    expect(maskPrefs.backgroundThrottling).toBe(false)
  })

  it('② createMaskView(partition) 显式分区仍然生效（标签那条路没被一起改坏）', () => {
    const captured: CapturedView[] = []
    const adapter = createRealElectronAdapter(makeElectron(captured))
    const view = adapter.createView('persist:agent-browser-alice')
    expect(prefsOf(captured).partition).toBe('persist:agent-browser-alice')
    expect(view.partition).toBe('persist:agent-browser-alice')
    adapter.createMaskView('persist:agent-browser-alice')
    expect(prefsOf(captured).partition).toBe('persist:agent-browser-alice')
  })
})

// ---------------------------------------------------------------- ③ source

const SRC_DIR = new URL('../src/', import.meta.url)

/** 递归读 src 下所有 .ts（含 client/ 与 vendor/）。 */
function sourceFiles(dir: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts')) out.push({ path, text: readFileSync(path, 'utf8') })
  }
  return out
}

/**
 * 凭据"搬运 API"名单（**tripwire，不是形式化证明**）。
 *
 * 2026-09-21 之前 `mirrorBrowserAuthCookies` 的写法就是
 * `from.cookies.get(...)` + `to.cookies.set(...)`。要再把一把 cookie 搬进模型可驱动
 * 的 jar，实现上只能落到下面某一条：Electron 的 cookie 罐 API（两种访问形态）、
 * 复制源 `defaultSession`、或给请求塞 `Cookie` 头的 `webRequest` 字段。
 *
 * 静态扫描**不能**证明不存在（`session['coo'+'kies']`、动态取值都能绕过）；它承重的是
 * "把删掉的代码照抄回来会当场变红"。真正的保证在行为判据（① ② ④）、标签分区里的
 * cookie 只能由**页面自己的网络活动**写入（而本机目标被导航闸门全面禁止），
 * 以及证明本身是 HMAC 签名（伪造值过不了 `requestRejection`）。
 * （实测：`vi.mock('electron')` 拦不住 `createRequire('electron')` —— 所以这条必须
 * 以源码扫描形态存在，见 mutation M3。）
 */
const CREDENTIAL_TRANSPORT_TRIPWIRES: Array<{ label: string; pattern: RegExp }> = [
  // 属性访问形态：`x.cookies`（点号**后面紧贴** `cookies`，避免把散文里的
  // "incl. cookies" 这类句子当命中 —— tools.ts 的工具描述里就有）。
  { label: 'session.cookies.*', pattern: /[\w$)\]]\s*\.cookies\b/u },
  { label: "session['cookies']", pattern: /\[\s*['"]cookies['"]\s*\]/u },
  { label: 'defaultSession（复制源）', pattern: /\bdefaultSession\b/u },
  { label: 'webRequest.onBeforeSendHeaders', pattern: /\bonBeforeSendHeaders\b/u },
  { label: 'Cookie 头注入（requestHeaders）', pattern: /\brequestHeaders\b/u },
]

describe('③ 插件源码里不存在任何 cookie 搬运通道', () => {
  it('③ 五条搬运 API 在 src 下一个都不出现', () => {
    const files = sourceFiles(SRC_DIR.pathname)
    expect(files.length, '判据必须真的扫到源码（空扫描 = 假绿）').toBeGreaterThan(10)
    for (const { label, pattern } of CREDENTIAL_TRANSPORT_TRIPWIRES) {
      const offenders = files
        .filter(file => pattern.test(file.text))
        .map(file => file.path.replace(SRC_DIR.pathname, 'src/'))
      expect(offenders, `搬运 API「${label}」不得出现在插件源码里`).toEqual([])
    }
  })

  it('③ 交接模块（实现与自测）都已删除（不能悄悄回来）', () => {
    expect(existsSync(new URL('../src/cookie-handoff.ts', import.meta.url).pathname)).toBe(false)
    expect(existsSync(new URL('../tests/cookie-handoff.spec.ts', import.meta.url).pathname)).toBe(false)
  })
})

// ---------------------------------------------------------------- ④ runtime

class MockTransport implements CdpTransport {
  isAttached(): boolean { return false }
  attach(): void {}
  detach(): void {}
  sendCommand(): Promise<unknown> { return Promise.resolve({}) }
  on(): void {}
  removeListener(): void {}
}

class MockSession implements NativeSession {
  readonly label: string
  permissionRequest = vi.fn()
  permissionCheck = vi.fn()
  constructor(label: string) { this.label = label }
  clearStorageData = vi.fn(async () => {})
  clearCache = vi.fn(async () => {})
  setPermissionRequestHandler = this.permissionRequest
  setPermissionCheckHandler = this.permissionCheck
  on(): void {}
  removeListener(): void {}
}

class MockView implements NativeView {
  readonly partition: string | undefined
  readonly session: MockSession
  url = ''
  destroyed = false
  constructor(partition: string | undefined, session: MockSession) {
    this.partition = partition
    this.session = session
  }
  attach(): void {}
  setBounds(): void {}
  setVisible(): void {}
  detach(): void {}
  moveToTop(): void {}
  destroy(): void { this.destroyed = true }
  get webContents(): never {
    return {
      cdp: new MockTransport(),
      loadURL: async (u: string) => { this.url = u },
      downloadURL: () => {},
      goBack: () => {}, goForward: () => {}, reload: () => {},
      capturePage: async (): Promise<NativeImage> => { throw new Error('unused') },
      getURL: () => this.url, getTitle: () => '', isLoading: () => false,
      on: () => {}, removeListener: () => {},
      session: this.session,
      setWindowOpenHandler: () => {},
      close: () => {}, isDestroyed: () => false,
    } as never
  }
}

/** 记录"壳窗口 loadURL 过什么"——用来证明 shell 页不是标签。 */
class MockAdapter {
  readonly partitionSession = new MockSession('partition')
  readonly defaultSession = new MockSession('default')
  readonly views: MockView[] = []
  readonly overlays: MockView[] = []
  readonly loadedByWindow: string[] = []
  readonly sessionLookups: string[] = []
  createView(partition?: string): NativeView {
    const view = new MockView(partition, this.partitionSession)
    this.views.push(view)
    return view
  }
  createMaskView(partition?: string): NativeView {
    const view = new MockView(partition, partition === undefined ? this.defaultSession : this.partitionSession)
    this.overlays.push(view)
    return view
  }
  createBrowserWindow(): NativeBrowserWindow {
    return {
      loadURL: async (url: string) => { this.loadedByWindow.push(url) },
      show: () => {}, hide: () => {}, focus: () => {},
      isVisible: () => false, isDestroyed: () => false, close: () => {},
      setTitle: () => {},
      getContentSize: () => ({ width: 1100, height: 780 }),
      contentView: { addChildView: () => {}, removeChildView: () => {} },
      onResize: () => () => {}, onClosed: () => () => {}, focusPage: () => {},
    } as never
  }
  getSession(partition: string): NativeSession {
    this.sessionLookups.push(partition)
    return this.partitionSession
  }
}

const SHELL = 'http://127.0.0.1:45678'
const dirs: string[] = []
function cleanup(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

function makeRuntime(adapter = new MockAdapter()): { runtime: BrowserRuntime; adapter: MockAdapter } {
  const dir = join(process.cwd(), 'tests', `.cred-iso-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  const runtime = new BrowserRuntime(adapter as never, {}, undefined, 'persist:agent-browser-alice', {
    store: new BrowserStore({ dir }),
  })
  runtime.setShellOrigin(SHELL)
  return { runtime, adapter }
}

describe('④ 模型面拿不到蒙版/shell 页；分区守卫仍在、默认 session 不受牵连', () => {
  it('④ shell 页由宿主 loadURL 加载，不是标签；蒙版也不在标签注册表里', async () => {
    const { runtime, adapter } = makeRuntime()
    try {
      await runtime.prewarm()
      expect(adapter.loadedByWindow).toEqual([`${SHELL}/browser-shell`])
      // 蒙版页是第二个 WebContentsView（自己的 loadURL），同样不是标签。
      expect(adapter.overlays).toHaveLength(1)
      expect(runtime.listTabs()).toHaveLength(0)
      await runtime.open('https://a.example')
      const tabs = runtime.listTabs()
      expect(tabs).toHaveLength(1)
      expect(tabs[0]?.url).toBe('https://a.example')
      // 两个宿主页面都不在标签台账里（模型只能驱动标签）。
      expect(tabs.some(tab => tab.url.includes('/browser-'))).toBe(false)
    } finally {
      runtime.dispose()
      cleanup()
    }
  })

  it('④ 分区权限守卫仍装在该分区上（原先寄生在交接函数里的副作用没丢）', () => {
    const { runtime, adapter } = makeRuntime()
    try {
      const partition = 'persist:agent-browser-bob'
      const session = runtime.sessionForPartition(partition)
      expect(adapter.sessionLookups).toEqual([partition])
      expect(session).toBe(adapter.partitionSession)
      runtime.ensurePartitionGuard(session!)
      // 两个 handler 都要装：Electron 缺 check handler 时默认放行 camera/mic
      // （2026-09-11 同类缺陷）。
      expect(adapter.partitionSession.permissionRequest).toHaveBeenCalledTimes(1)
      expect(adapter.partitionSession.permissionCheck).toHaveBeenCalledTimes(1)
      // 幂等：重复安装不再调用（分区级 WeakSet，§16.1）。
      runtime.ensurePartitionGuard(session!)
      expect(adapter.partitionSession.permissionCheck).toHaveBeenCalledTimes(1)
      // 蒙版搬进默认 session **不能**顺手把默认 session 的权限全禁掉 ——
      // 那是主应用窗口所在的那个 jar。
      expect(adapter.defaultSession.permissionRequest).not.toHaveBeenCalled()
      expect(adapter.defaultSession.permissionCheck).not.toHaveBeenCalled()
    } finally {
      runtime.dispose()
      cleanup()
    }
  })

  it('④ index.ts 的接线：开机与切账号都装守卫，且不再有交接表', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    // 2026-09-21：分区名带服务端哈希（§7.2/R2S-8），两处调用随之多一个参数 ——
    // 断言按调用**函数**判（而不是逐字钉旧签名），否则合法的签名演进会把接线判据
    // 一起打红。参数本身由 tests/partition-parity.spec.ts 对拍。
    expect(source).toMatch(/ensureBrowserPartitionGuard\(currentUser\(\), currentServerHash\(\)\)/)
    expect(source).toMatch(/ensureBrowserPartitionGuard\(user, serverHash\)/)
    expect(source).not.toContain('startCookieHandoff')
    expect(source).not.toContain('CookieHandoff')
  })
})
