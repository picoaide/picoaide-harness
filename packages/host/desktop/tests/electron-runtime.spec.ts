import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DesktopShellSpec, DesktopUpdateSource } from '../src/runtime.ts'
import { desktopDiagnosticsPrivacyCopy } from '../src/tray-locale.ts'

/** 下载用例共用的更新源:客户端只从登录的那台服务端取包。 */
const UPDATE_SOURCE: DesktopUpdateSource = {
  manifestURL: 'https://server.test/api/client/v2/updates/manifest',
  expectedChannel: 'official',
}

// 产品版本来自 package.json 单一真值(scripts/version.mjs 同步),测试断言
// 亦应动态读取,避免每次发版都要改测试(曾连续两个版本因硬编码 2.3.0 踩坑)。
const APP_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
).version as string

const diagnostics = vi.hoisted(() => ({ export: vi.fn() }))
const updater = vi.hoisted(() => ({ download: vi.fn() }))
const childProcess = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const listeners = new Map<string, Listener[]>()
  const child = {
    once: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return child
    }),
    off: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, (listeners.get(event) ?? []).filter(candidate => candidate !== listener))
      return child
    }),
    unref: vi.fn(),
  }
  return {
    child,
    emit(event: string, ...args: unknown[]) {
      const current = [...(listeners.get(event) ?? [])]
      listeners.delete(event)
      for (const listener of current) listener(...args)
    },
    reset() { listeners.clear() },
    spawn: vi.fn(() => child),
  }
})

vi.mock('../src/diagnostic-export.ts', () => ({
  exportDesktopDiagnostics: diagnostics.export,
}))

vi.mock('../src/update-download.ts', () => ({
  downloadDesktopUpdate: updater.download,
}))

vi.mock('node:child_process', () => ({ spawn: childProcess.spawn }))

const electron = vi.hoisted(() => {
  const browserWindowOptions: unknown[] = []
  const browserWindowThemeSources: string[] = []
  const browserWindows: BrowserWindow[] = []
  const browserWindowOn = vi.fn()
  const browserWindowOff = vi.fn()
  const loadURL = vi.fn(async (_url: string) => {})
  const menuTemplates: unknown[][] = []
  const notifications: Notification[] = []
  let zoomLevel = 0
  const dialog = {
    showErrorBox: vi.fn(),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
  }
  const appIcon = {
    isEmpty: vi.fn(() => false),
    setTemplateImage: vi.fn(),
  }
  const templateIcon = {
    isEmpty: vi.fn(() => false),
    setTemplateImage: vi.fn(),
  }
  const blueIcon = {
    isEmpty: vi.fn(() => false),
    setTemplateImage: vi.fn(),
  }
  const webContents = {
    getZoomLevel: vi.fn(() => zoomLevel),
    getURL: vi.fn(() => ''),
    on: vi.fn(),
    off: vi.fn(),
    setZoomLevel: vi.fn((level: number) => { zoomLevel = level }),
    setWindowOpenHandler: vi.fn(),
    session: {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      webRequest: {
        onHeadersReceived: vi.fn(),
      },
      cookies: {
        set: vi.fn(async () => {}),
      },
    },
  }
  const nativeTheme = { themeSource: 'system' }

  class BrowserWindow {
    readonly webContents = webContents
    accessibleTitle = ''

    constructor(options: unknown) {
      browserWindowOptions.push(options)
      browserWindowThemeSources.push(nativeTheme.themeSource)
      browserWindows.push(this)
    }

    readonly isDestroyed = vi.fn(() => false)
    readonly isMinimized = vi.fn(() => false)
    readonly restore = vi.fn()
    readonly show = vi.fn()
    readonly focus = vi.fn()
    // 2026-09-16 标题栏双击（macOS）：缩放态与最小化面。
    maximize = vi.fn(() => { this.maximized = true })
    unmaximize = vi.fn(() => { this.maximized = false })
    readonly minimize = vi.fn()
    maximized = false
    fullScreen = false
    readonly isMaximized = vi.fn(() => this.maximized)
    readonly isFullScreen = vi.fn(() => this.fullScreen)
    readonly on = browserWindowOn
    readonly off = browserWindowOff
    readonly once = vi.fn()
    readonly destroy = vi.fn()
    readonly loadURL = loadURL
    readonly removeMenu = vi.fn()
  }

  class Tray {
    readonly image: unknown
    readonly setToolTip = vi.fn()
    readonly setContextMenu = vi.fn()
    readonly on = vi.fn()
    readonly off = vi.fn()
    readonly destroy = vi.fn()

    constructor(image: unknown) {
      this.image = image
      trays.push(this)
    }
  }

  class Notification {
    static readonly isSupported = vi.fn(() => true)
    readonly once = vi.fn()
    readonly show = vi.fn()

    constructor(readonly options: unknown) {
      notifications.push(this)
    }
  }

  const trays: Tray[] = []
  const createFromPath = vi.fn((path: string) => {
    if (path.endsWith('app-icon.png')) return appIcon
    if (path.endsWith('tray-iconTemplate.png')) return templateIcon
    if (path.endsWith('tray-icon-blue.png')) return blueIcon
    throw new Error(`unexpected image path ${path}`)
  })

  // P0-6/D8:宿主在 mount 时用 ipcMain 装渲染进程错误通道;替身必须提供它
  // (否则"忘了在 mock 里跟上 Electron 面"会让整组用例假红)。
  const ipcMain = { on: vi.fn(), removeListener: vi.fn() }

  return {
    ipcMain,
    app: {
      dock: { setIcon: vi.fn() },
      getLocale: vi.fn(() => 'en-US'),
      getPath: vi.fn((name: string) => name === 'crashDumps'
        ? '/tmp/dsh-desktop-user-data/Crashpad'
        : '/tmp/dsh-desktop-user-data'),
      getVersion: vi.fn(() => '43.4.0'),
      isPackaged: false,
      on: vi.fn(),
      off: vi.fn(),
    },
    appIcon,
    blueIcon,
    BrowserWindow,
    browserWindowOptions,
    browserWindowThemeSources,
    browserWindows,
    browserWindowOff,
    browserWindowOn,
    loadURL,
    dialog,
    Menu: {
      buildFromTemplate: vi.fn((template: unknown[]) => {
        menuTemplates.push(template)
        return {}
      }),
    },
    menuTemplates,
    nativeImage: { createFromPath },
    nativeTheme,
    net: { fetch: vi.fn() },
    Notification,
    notifications,
    resetZoomLevel: () => { zoomLevel = 0 },
    shell: {
      openExternal: vi.fn(async () => {}),
      openPath: vi.fn(async () => ''),
      showItemInFolder: vi.fn(),
    },
    // 2026-09-16 标题栏双击：系统偏好读数（缺省 = macOS 默认的"缩放"）。
    systemPreferences: {
      getUserDefault: vi.fn((_key: string, _type: string) => 'Maximize'),
    },
    templateIcon,
    Tray,
    trays,
    webContents,
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  ipcMain: electron.ipcMain,
  dialog: electron.dialog,
  Menu: electron.Menu,
  nativeImage: electron.nativeImage,
  nativeTheme: electron.nativeTheme,
  net: electron.net,
  Notification: electron.Notification,
  shell: electron.shell,
  systemPreferences: electron.systemPreferences,
  Tray: electron.Tray,
}))

const spec: DesktopShellSpec = {
  width: 1280,
  height: 840,
  minWidth: 900,
  minHeight: 640,
  url: 'http://127.0.0.1:43120/',
  productName: 'PicoAide Harness',
  windowTitle: 'PicoAide Harness',
  iconPath: '/tmp/app-icon.png',
  trayIcons: {
    templatePath: '/tmp/tray-iconTemplate.png',
    bluePath: '/tmp/tray-icon-blue.png',
  },
  readLocalePreference: vi.fn(() => undefined),
  readThemeSource: vi.fn(() => 'system' as const),
  requestQuit: () => {},
}

/**
 * 窗口 CSP 的**已批准能力集**（T-03，2026-09-23 审计）。
 *
 * 这是"渲染进程允许拥有哪些能力"的显式声明，故意与 `src/electron-runtime.ts`
 * 里的常量**分开写**：改 CSP 的人必须在这里再过一次（而不是把测试跟着改）。
 */
const APPROVED_CSP_CAPABILITIES: Record<string, readonly string[]> = {
  'default-src': ["'self'", 'data:', 'blob:', 'ws:'],
  // 只允许本地脚本 + 上游构建产物内联/求值；**不得**加任何网络源
  // （`https:`/任意主机 = 从任意 HTTPS 源加载并求值脚本）。
  'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
  // 2026-09-12 P0：CSP3 的 worker 回退链是 worker-src→child-src→script-src→
  // default-src，必须**显式**声明，否则 Blob-URL Worker（附件上传/右栏 PDF 预览）必失败。
  'worker-src': ["'self'", 'blob:'],
  'style-src': ["'self'", "'unsafe-inline'"],
  // 白标渠道的 logo/favicon 由客户自己的服务器下发 ⇒ 必须放行 http/https 图源。
  'img-src': ["'self'", 'data:', 'blob:', 'http:', 'https:'],
  'font-src': ["'self'", 'data:'],
  // 出站必须**显式**声明：少了它出站就受 default-src 支配，改一处会静默放开另一处。
  'connect-src': ["'self'", 'ws:', 'wss:', 'http:', 'https:'],
}

/** 匹配"网络源/通配源"；脚本类指令里出现即视为能力放宽。 */
const CSP_NETWORK_SOURCE = /^(?:https?|wss?|ftp):|\*/u

/**
 * 把 CSP 解析成「指令 → 源列表」再按**能力**判定（不再用 `toContain` 子串）。
 *
 * 为什么必须升级：2026-09-23 审计实测三种真实放宽**全部通过**旧的子串断言 ——
 *   1. `script-src …` 追加 ` https: blob:`（任意 HTTPS 源加载/求值脚本）；
 *   2. 追加 `frame-src *` / `object-src *`（任意 iframe / 插件对象）；
 *   3. 删除整条 `connect-src`（当时没有任何断言钉它）。
 * 根因是 `toContain` 只是**前缀**匹配，且完全没覆盖"新增指令"这个方向。这里的判据：
 *   · 指令集合**显式枚举**（多一条/少一条即红，逼一次审查）；
 *   · 每条指令的源集合**全等**（不是前缀、也不是"至少包含"）；
 *   · 任何指令都不得出现通配 `*`，脚本/worker 指令不得出现任何网络源。
 * @param csp - 响应头里那条 Content-Security-Policy。
 */
function assertContentSecurityPolicyCapabilities(csp: string): void {
  const directives = new Map<string, string[]>()
  for (const part of csp.split(';')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const [name, ...sources] = trimmed.split(/\s+/u)
    if (name === undefined) continue
    expect(directives.has(name), `CSP 指令重复声明：${name}`).toBe(false)
    directives.set(name, sources)
  }
  const sorted = (values: readonly string[]): string[] => [...values].sort()
  expect([...directives.keys()].sort(), 'CSP 指令集合变化必须显式审查（新增指令即红）')
    .toEqual(Object.keys(APPROVED_CSP_CAPABILITIES).sort())
  for (const [name, approved] of Object.entries(APPROVED_CSP_CAPABILITIES)) {
    const sources = directives.get(name)
    expect(sources, `CSP 缺少指令 ${name}`).toBeDefined()
    expect(sorted(sources ?? []), `${name} 的源集合与已批准能力不一致`).toEqual(sorted(approved))
    expect(sources, `${name} 不得包含通配源 *`).not.toContain('*')
  }
  for (const name of ['script-src', 'worker-src']) {
    for (const source of directives.get(name) ?? []) {
      expect(
        CSP_NETWORK_SOURCE.test(source),
        `${name} 不得包含网络源 ${source}（任意 HTTPS 源加载/求值脚本 = 远程代码执行面）`,
      ).toBe(false)
    }
  }
}

/** 装上窗口，返回真正注入到响应头里的那条 CSP（CSP 放宽用例共用）。 */
async function appliedContentSecurityPolicy(): Promise<string> {
  const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
  const runtime = new ElectronDesktopRuntime(async () => {})
  const release = runtime.schedule(spec)
  await runtime.mountScheduled()
  const listener = electron.webContents.session.webRequest.onHeadersReceived.mock.calls[0]?.[0] as
    | ((details: { url: string }, cb: (response: { responseHeaders?: Record<string, string[]> }) => void) => void)
    | undefined
  expect(listener, 'mount 必须安装 CSP 响应头处理器').toBeDefined()
  let headers: Record<string, string[]> | undefined
  listener!({ url: 'http://127.0.0.1:43120/' }, (response) => { headers = response.responseHeaders })
  await release()
  const csp = headers?.['Content-Security-Policy']?.[0]
  expect(csp, '受控 URL 必须拿到 CSP 响应头').toBeDefined()
  return csp!
}

describe('Electron compatibility runtime', () => {
  beforeEach(() => {
    electron.ipcMain.on.mockClear()
    electron.ipcMain.removeListener.mockClear()
    electron.app.isPackaged = false
    electron.browserWindowOptions.length = 0
    electron.browserWindowThemeSources.length = 0
    electron.browserWindows.length = 0
    electron.trays.length = 0
    electron.menuTemplates.length = 0
    electron.notifications.length = 0
    childProcess.reset()
    vi.clearAllMocks()
    updater.download.mockReset()
    diagnostics.export.mockReset()
    electron.loadURL.mockReset()
    electron.loadURL.mockResolvedValue(undefined)
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    electron.shell.openPath.mockResolvedValue('')
    electron.nativeTheme.themeSource = 'system'
    electron.resetZoomLevel()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('performTitleBarDoubleClick（macOS 标题栏双击）', () => {
    /** 装好窗口后返回 runtime 与假窗口（`platform` 由 process.platform 决定）。 */
    async function mounted(): Promise<{ runtime: import('../src/electron-runtime.ts').ElectronDesktopRuntime, window: InstanceType<typeof electron.BrowserWindow> }> {
      const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
      const runtime = new ElectronDesktopRuntime(async () => {})
      runtime.schedule(spec)
      await runtime.mountScheduled()
      return { runtime, window: electron.browserWindows.at(-1)! }
    }

    it('偏好 = 缩放：未缩放时缩放、已缩放时还原', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
      electron.systemPreferences.getUserDefault.mockReturnValue('Maximize')
      const { runtime, window } = await mounted()

      runtime.performTitleBarDoubleClick()
      expect(window.maximize).toHaveBeenCalledOnce()

      window.maximized = true
      runtime.performTitleBarDoubleClick()
      expect(window.unmaximize).toHaveBeenCalledOnce()
      expect(window.minimize).not.toHaveBeenCalled()
    })

    it('偏好 = 最小化：最小化而不是缩放', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
      electron.systemPreferences.getUserDefault.mockReturnValue('Minimize')
      const { runtime, window } = await mounted()

      runtime.performTitleBarDoubleClick()

      expect(window.minimize).toHaveBeenCalledOnce()
      expect(window.maximize).not.toHaveBeenCalled()
    })

    it('偏好 = 无动作 / 全屏中：什么都不做', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
      electron.systemPreferences.getUserDefault.mockReturnValue('None')
      const { runtime, window } = await mounted()
      runtime.performTitleBarDoubleClick()
      expect(window.maximize).not.toHaveBeenCalled()
      expect(window.minimize).not.toHaveBeenCalled()

      electron.systemPreferences.getUserDefault.mockReturnValue('Maximize')
      window.fullScreen = true
      runtime.performTitleBarDoubleClick()
      expect(window.maximize).not.toHaveBeenCalled()
    })

    it('非 macOS 平台是 no-op', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      electron.systemPreferences.getUserDefault.mockReturnValue('Maximize')
      const { runtime, window } = await mounted()

      runtime.performTitleBarDoubleClick()

      expect(window.maximize).not.toHaveBeenCalled()
      expect(window.minimize).not.toHaveBeenCalled()
    })
  })

  it('uses the native macOS advanced frame, Dock icon, and template tray image', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    electron.nativeTheme.themeSource = 'system'
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    expect(electron.browserWindowOptions).toHaveLength(0)
    await runtime.mountScheduled()

    expect(electron.browserWindowOptions).toHaveLength(1)
    const options = electron.browserWindowOptions[0]
    expect(options).toEqual(expect.objectContaining({
      title: '',
      width: 1280,
      height: 840,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // 该用例的 electron 替身 isPackaged=false（开发态）⇒ DevTools 保持可用；
        // 发布态关闭由 tests/window-options.spec.ts 的专作用例钉住。
        devTools: true,
        // P0-6/D8:沙箱 preload 承载渲染进程错误转发;缺了它渲染采集静默失效。
        preload: expect.stringContaining('preload/renderer-error.cjs'),
      },
      titleBarStyle: 'hiddenInset',
      transparent: true,
      vibrancy: 'sidebar',
    }))
    expect(options).not.toHaveProperty('autoHideMenuBar')
    expect(electron.browserWindows[0]?.accessibleTitle).toBe('PicoAide Harness')
    expect(spec.readThemeSource).toHaveBeenCalled()
    expect(electron.nativeTheme.themeSource).toBe('system')
    expect(electron.browserWindows[0]?.removeMenu).not.toHaveBeenCalled()
    expect(electron.app.dock.setIcon).toHaveBeenCalledWith(electron.appIcon)
    expect(electron.templateIcon.setTemplateImage).toHaveBeenCalledWith(true)
    expect(electron.trays[0]?.image).toBe(electron.templateIcon)
    expect(electron.menuTemplates.some(template => template.some(
      item => (item as { label?: string }).label === 'Switch to Advanced Mode',
    ))).toBe(false)

    const titleListener = electron.browserWindowOn.mock.calls.find(([event]) => event === 'page-title-updated')?.[1]
    expect(titleListener).toEqual(expect.any(Function))
    const titleEvent = { preventDefault: vi.fn() }
    titleListener(titleEvent)
    expect(titleEvent.preventDefault).toHaveBeenCalledOnce()

    await release()
    expect(electron.browserWindowOff).toHaveBeenCalledWith('page-title-updated', titleListener)
    expect(electron.trays[0]?.off).toHaveBeenCalledWith('click', expect.any(Function))
  })

  it('uses the Windows caption, hidden menu bar, removed menu, and fixed blue tray image', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    expect(electron.browserWindowOptions[0]).toEqual(expect.objectContaining({
      title: 'PicoAide Harness',
      autoHideMenuBar: true,
    }))
    expect(electron.browserWindows[0]?.accessibleTitle).toBe('PicoAide Harness')
    expect(electron.browserWindows[0]?.removeMenu).toHaveBeenCalledOnce()
    expect(electron.app.dock.setIcon).not.toHaveBeenCalled()
    expect(electron.trays[0]?.image).toBe(electron.blueIcon)
    expect(electron.templateIcon.setTemplateImage).not.toHaveBeenCalled()

    await release()
    expect(electron.trays[0]?.off).toHaveBeenCalledWith('click', expect.any(Function))
  })

  it('opens one parented Windows folder chooser and returns its selected path', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['C:\\Work'] })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    await expect(runtime.pickDirectory()).resolves.toBe('C:\\Work')
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(
      electron.browserWindows[0],
      {
        title: 'Select Workspace Directory',
        properties: ['openDirectory', 'dontAddToRecent'],
      },
    )

    await release()
  })

  it('logs renderer crashes with the Windows exception code', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const logger = { error: vi.fn(), errorCause: vi.fn() }
    const runtime = new ElectronDesktopRuntime(async () => {}, undefined, logger)
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    const gone = electron.browserWindows[0]?.webContents.on.mock.calls
      .find(([event]) => event === 'render-process-gone')?.[1]
    expect(gone).toEqual(expect.any(Function))
    gone({}, { reason: 'crashed', exitCode: -1073741819 })

    expect(logger.error).toHaveBeenCalledWith(
      'dsh-plugin-desktop: renderer process gone (reason: crashed, exitCode: -1073741819 / 0xc0000005)',
    )
    await release()
  })

  it('crash fallback shows the error page and never bounces back to the app URL (P1-12)', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    const gone = electron.browserWindows[0]?.webContents.on.mock.calls
      .find(([event]) => event === 'render-process-gone')?.[1]
    expect(gone).toEqual(expect.any(Function))
    electron.webContents.getURL.mockReturnValue('http://127.0.0.1:43120/')
    // mountScheduled already loaded the app URL; count only crash-driven loads.
    electron.loadURL.mockClear()

    // First crash: reload the app URL once (the documented single retry).
    gone({}, { reason: 'crashed', exitCode: 1 })
    await vi.waitFor(() => { expect(electron.loadURL).toHaveBeenCalledTimes(1) })
    expect(electron.loadURL).toHaveBeenLastCalledWith('http://127.0.0.1:43120/')

    // Second crash: the error page with an explicit retry button.
    gone({}, { reason: 'crashed', exitCode: 1 })
    await vi.waitFor(() => { expect(electron.loadURL).toHaveBeenCalledTimes(2) })
    const errorPage = String(electron.loadURL.mock.calls[1]?.[0])
    expect(errorPage.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    const html = decodeURIComponent(errorPage.slice('data:text/html;charset=utf-8,'.length))
    expect(html).toContain('id="retry"')
    expect(html).toContain('http://127.0.0.1:43120/')

    // No did-finish-load auto-navigation: a deterministic crash must not loop.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(electron.loadURL).toHaveBeenCalledTimes(2)
    await release()
  })

  it('starts from the saved locale and rebuilds native tray commands when it changes', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const readLocalePreference = vi.fn(() => 'zh' as const)
    const release = runtime.schedule({ ...spec, readLocalePreference })

    await runtime.mountScheduled()
    expect(readLocalePreference).toHaveBeenCalledOnce()
    expect(runtime.locale).toBe('zh')
    expect((electron.menuTemplates.at(-1) as Array<{ label?: string }>).map(item => item.label))
      .toEqual(expect.arrayContaining([
        '打开 PicoAide Harness',
        '退出',
      ]))

    runtime.setLocalePreference('en')
    expect(runtime.locale).toBe('en')
    expect((electron.menuTemplates.at(-1) as Array<{ label?: string }>).map(item => item.label))
      .toEqual(expect.arrayContaining([
        'Open PicoAide Harness',
        'Quit',
      ]))

    electron.app.getLocale.mockReturnValueOnce('zh-CN')
    runtime.setLocalePreference(undefined)
    expect(runtime.locale).toBe('zh')
    expect((electron.menuTemplates.at(-1) as Array<{ label?: string }>).map(item => item.label))
      .toEqual(expect.arrayContaining([
        '打开 PicoAide Harness',
        '退出',
      ]))

    await release()
  })

  it('handles desktop zoom shortcuts without relying on the native menu', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const zoomListener = electron.webContents.on.mock.calls
      .find(([event]) => event === 'before-input-event')?.[1]
    expect(zoomListener).toEqual(expect.any(Function))

    const zoomIn = { preventDefault: vi.fn() }
    zoomListener(zoomIn, { type: 'keyDown', control: true, key: '=' })
    expect(zoomIn.preventDefault).toHaveBeenCalledOnce()
    expect(electron.webContents.setZoomLevel).toHaveBeenLastCalledWith(1)

    const zoomInRelease = { preventDefault: vi.fn() }
    zoomListener(zoomInRelease, { type: 'keyUp', control: true, key: '=' })
    expect(zoomInRelease.preventDefault).not.toHaveBeenCalled()
    expect(electron.webContents.setZoomLevel).toHaveBeenCalledTimes(1)

    const zoomOut = { preventDefault: vi.fn() }
    zoomListener(zoomOut, { type: 'keyDown', control: true, key: '-' })
    expect(zoomOut.preventDefault).toHaveBeenCalledOnce()
    expect(electron.webContents.setZoomLevel).toHaveBeenLastCalledWith(0)

    const zoomReset = { preventDefault: vi.fn() }
    zoomListener(zoomReset, { type: 'keyDown', control: true, key: '0' })
    expect(zoomReset.preventDefault).toHaveBeenCalledOnce()
    expect(electron.webContents.setZoomLevel).toHaveBeenLastCalledWith(0)

    const plainPlus = { preventDefault: vi.fn() }
    zoomListener(plainPlus, { type: 'keyDown', key: '=' })
    expect(plainPlus.preventDefault).not.toHaveBeenCalled()

    await release()
    expect(electron.webContents.off).toHaveBeenCalledWith('before-input-event', zoomListener)
  })

  it('does not mount a registration disposed before Host boot settles', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await release()

    await expect(runtime.mountScheduled()).rejects.toThrow(
      'the Cordis shell plugin did not register a window',
    )
    expect(electron.browserWindowOptions).toHaveLength(0)
  })

  it('keeps tray commands unavailable until the Web surface loads and startup commits', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    let finishLoad!: () => void
    electron.loadURL.mockImplementationOnce(() => new Promise<void>((resolve) => { finishLoad = resolve }))
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    const beforeInteractive = vi.fn(() => {
      expect(electron.trays).toHaveLength(1)
    })

    const mounted = runtime.mountScheduled(beforeInteractive)
    await vi.waitFor(() => { expect(electron.loadURL).toHaveBeenCalledOnce() })
    expect(electron.trays).toHaveLength(0)
    expect(beforeInteractive).not.toHaveBeenCalled()

    finishLoad()
    await mounted
    expect(beforeInteractive).toHaveBeenCalledOnce()
    expect(electron.trays).toHaveLength(1)

    await release()
  })

  it('rebuilds ordered effect-scoped tray contributions without replacing native commands', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const later = runtime.registerTrayItem({
      group: 'tools',
      order: 20,
      label: () => 'Later Tool',
      invoke: vi.fn(),
    })
    let statusLabel = 'Check for Updates…'
    const status = runtime.registerTrayItem({
      group: 'status',
      order: 10,
      label: () => statusLabel,
      enabled: () => false,
      invoke: vi.fn(),
    })
    const earlier = runtime.registerTrayItem({
      group: 'tools',
      order: 10,
      label: () => 'Earlier Tool',
      invoke: vi.fn(),
    })
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const labels = (electron.menuTemplates.at(-1) as Array<{ label?: string }>).map(item => item.label)
    expect(labels).toEqual([
      'Open PicoAide Harness', undefined,
      'Earlier Tool', 'Later Tool', undefined,
      'Check for Updates…', undefined,
      'Quit',
    ])
    expect(electron.menuTemplates.at(-1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Check for Updates…', enabled: false }),
    ]))

    statusLabel = 'Version 2.1.0 Available'
    status.refresh()
    expect(electron.menuTemplates.at(-1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Version 2.1.0 Available', enabled: false }),
    ]))

    earlier.dispose()
    later.dispose()
    status.dispose()
    expect(electron.menuTemplates.at(-1)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Earlier Tool' }),
    ]))

    await release()
  })

  it('renders contributed radio submenus in their own profile section', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const invoke = vi.fn()
    const runtime = new ElectronDesktopRuntime(async () => {})
    runtime.registerTrayItem({
      group: 'profiles',
      order: 10,
      label: () => 'Profile: desktop',
      invoke: () => {},
      submenu: () => [{
        label: () => 'web',
        type: 'radio',
        checked: () => false,
        enabled: () => true,
        invoke,
      }],
    })
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const profile = (electron.menuTemplates.at(-1) as Array<{
      label?: string
      submenu?: Array<{ label?: string, type?: string, checked?: boolean, click?: () => void }>
    }>).find(item => item.label === 'Profile: desktop')
    expect(profile?.submenu).toEqual([
      expect.objectContaining({ label: 'web', type: 'radio', checked: false }),
    ])
    profile?.submenu?.[0]?.click?.()
    await vi.waitFor(() => { expect(invoke).toHaveBeenCalledOnce() })

    await release()
  })

  it('coalesces concurrent diagnostic exports and reveals the completed archive', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    let finishExport: ((path: string) => void) | undefined
    diagnostics.export.mockReturnValue(new Promise(resolve => { finishExport = resolve }))

    const first = runtime.exportDiagnostics()
    const second = runtime.exportDiagnostics()
    finishExport?.('C:\\Users\\Example\\diagnostics.zip')
    await Promise.all([first, second])

    expect(diagnostics.export).toHaveBeenCalledOnce()
    expect(diagnostics.export).toHaveBeenCalledWith(
      '/tmp/dsh-desktop-user-data',
      {
        appVersion: APP_VERSION,
        crashDumpsDir: '/tmp/dsh-desktop-user-data/Crashpad',
      },
    )
    expect(electron.shell.showItemInFolder).toHaveBeenCalledOnce()
    expect(electron.shell.showItemInFolder).toHaveBeenCalledWith('C:\\Users\\Example\\diagnostics.zip')
  })

  it('does not export diagnostics when the privacy confirmation is cancelled', async () => {
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})

    await expect(runtime.exportDiagnostics()).resolves.toBeUndefined()

    expect(diagnostics.export).not.toHaveBeenCalled()
    expect(electron.shell.showItemInFolder).not.toHaveBeenCalled()
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      cancelId: 1,
      defaultId: 1,
      buttons: ['Export', 'Cancel'],
      detail: expect.stringContaining('local paths, workspace IDs, and session IDs'),
    }))
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining('process memory'),
    }))
  })

  it('localizes the diagnostics privacy confirmation', async () => {
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    runtime.setLocalePreference('zh')

    await runtime.exportDiagnostics()

    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      buttons: ['导出', '取消'],
      detail: expect.stringContaining('本地路径、工作区 ID 和会话 ID'),
    }))
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining('进程内存'),
    }))
  })

  it('shows a native error when diagnostic export fails', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    // Pin the ZH title: asserting the English one would be indistinguishable
    // from the pre-i18n hard-coded literal (2026-09-16 R3 audit).
    runtime.setLocalePreference('zh')
    diagnostics.export
      .mockRejectedValueOnce(new Error('disk is full'))
      .mockResolvedValueOnce('C:\\Users\\Example\\diagnostics-retry.zip')

    await expect(runtime.exportDiagnostics()).resolves.toBeUndefined()
    await expect(runtime.exportDiagnostics()).resolves.toBeUndefined()

    expect(diagnostics.export).toHaveBeenCalledTimes(2)
    expect(electron.shell.showItemInFolder)
      .toHaveBeenCalledWith('C:\\Users\\Example\\diagnostics-retry.zip')
    // The error box follows the app language like the privacy dialog above it
    // (2026-09-16 R2 audit). The Chinese form is asserted on purpose: the English
    // one equals the old hard-coded literal, so it cannot detect a revert.
    expect(desktopDiagnosticsPrivacyCopy('zh').errorTitle).toBe('无法导出诊断信息')
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      desktopDiagnosticsPrivacyCopy('zh').errorTitle,
      'disk is full',
    )
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('failed to export diagnostics: disk is full'))
  })

  it('shows native recovery when the renderer Loader reports a failed plugin', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const onRendererBoot = vi.fn()
    const runtime = new ElectronDesktopRuntime(async () => {}, onRendererBoot)
    const report = {
      status: 'failed' as const,
      plugins: ['dsh-vision-router'],
      error: 'keyed slot "tool.call.toolview" already has an entry for key "vision_crop" at priority 0',
    }

    runtime.reportRendererBoot(report)
    await vi.waitFor(() => { expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce() })
    runtime.reportRendererBoot({ status: 'healthy' })

    expect(onRendererBoot).toHaveBeenCalledWith(report)
    expect(onRendererBoot).toHaveBeenCalledOnce()
    expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      title: 'Plugin Recovery',
      message: 'PicoAide Harness could not load all plugins.',
      detail: expect.stringContaining('dsh-vision-router'),
      buttons: ['Restart PicoAide Harness', 'Dismiss'],
    }))
    const recoveryCalls = electron.dialog.showMessageBox.mock.calls as unknown as Array<[{ detail?: string }]>
    expect(recoveryCalls[0]?.[0].detail).toContain('vision_crop')
  })

  it('localizes both plugin-recovery fallback fragments (2026-09-17 S05-3 audit)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')

    // 分支一：Loader settlement 失败但没给 error（boot-health.ts:31-33 的真实形状）。
    const missingError = new ElectronDesktopRuntime(async () => {})
    missingError.setLocalePreference('zh')
    missingError.reportRendererBoot({ status: 'failed', plugins: ['dsh-vision-router'] })
    await vi.waitFor(() => { expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1) })

    // 分支二：Loader 报了 error，但没有任何条目停在非 ACTIVE 态（plugins 为空）。
    const missingPlugins = new ElectronDesktopRuntime(async () => {})
    missingPlugins.setLocalePreference('zh')
    missingPlugins.reportRendererBoot({ status: 'failed', plugins: [], error: 'boom' })
    await vi.waitFor(() => { expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2) })

    const recoveryCalls = electron.dialog.showMessageBox.mock.calls as unknown as Array<[{ title?: string, detail?: string }]>
    expect(recoveryCalls[0]?.[0].title).toBe('插件恢复')
    expect(recoveryCalls[0]?.[0].detail).toContain('客户端 Loader 未提供错误信息。')
    expect(recoveryCalls[1]?.[0].detail).toContain('未知客户端插件')
    // 中文详情里不得再出现任何硬编码英文兜底片段（这两句曾以三元分支字面量
    // 的形式留在 electron-runtime 里）。
    for (const call of recoveryCalls) {
      expect(call[0].detail).not.toContain('The client Loader did not provide an error message.')
      expect(call[0].detail).not.toContain('Unknown client plugin')
    }
  })

  it('commits a healthy renderer without showing recovery', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const onRendererBoot = vi.fn()
    const runtime = new ElectronDesktopRuntime(async () => {}, onRendererBoot)

    runtime.reportRendererBoot({ status: 'healthy' })

    expect(onRendererBoot).toHaveBeenCalledWith({ status: 'healthy' })
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('requests an orderly restart from plugin recovery', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const restart = vi.fn(async () => {})
    const runtime = new ElectronDesktopRuntime(restart)

    runtime.reportRendererBoot({ status: 'failed', plugins: ['dsh-vision-router'] })
    await vi.waitFor(() => { expect(restart).toHaveBeenCalledOnce() })
  })

  it('uses Electron networking and confirmation-gated macOS update handoff', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const response = Response.json({ version: '2.1.0' })
    electron.net.fetch.mockResolvedValueOnce(response)
    updater.download.mockResolvedValueOnce('/tmp/DSH-Desktop-2.1.0-mac.dmg')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})

    await expect(runtime.updates.request('https://api.github.com/repos/picoaide/picoaide-harness/releases/latest', { method: 'GET' }))
      .resolves.toBe(response)
    expect(runtime.updates).toMatchObject({
      isPackaged: false,
      canDownload: false,
      currentVersion: APP_VERSION,
      statePath: join('/tmp/dsh-desktop-user-data', 'updates', 'state.json'),
    })
    electron.app.isPackaged = true
    expect(runtime.updates).toMatchObject({ isPackaged: true, canDownload: true })

    await runtime.updates.showManualCheckResult({
      status: 'up-to-date',
      currentVersion: '2.0.0',
      latestVersion: '2.0.0',
    })
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'PicoAide Harness Is Up to Date',
      detail: 'Installed version: 2.0.0',
      buttons: ['OK'],
    }))

    await runtime.updates.showManualCheckResult(null)
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'Unable to Check for Updates',
      buttons: ['OK'],
    }))

    // 下载与安装是两个动作:下载只落地文件,完成后才通报一次"可安装"。
    const controller = new AbortController()
    await expect(runtime.updates.downloadUpdate('2.1.0', UPDATE_SOURCE, controller.signal))
      .resolves.toBe('/tmp/DSH-Desktop-2.1.0-mac.dmg')
    expect(updater.download).toHaveBeenCalledWith({
      platform: 'darwin',
      version: '2.1.0',
      // 更新源随下载请求一并传下去:客户端只从登录的那台服务端取包
      // (2026-09-10 定案),清单地址与期望渠道都由会话推导。
      manifestURL: UPDATE_SOURCE.manifestURL,
      expectedChannel: UPDATE_SOURCE.expectedChannel,
      userDataPath: '/tmp/dsh-desktop-user-data',
      request: expect.any(Function),
      signal: controller.signal,
    })
    await runtime.updates.announceUpdateReady('2.1.0', '/tmp/DSH-Desktop-2.1.0-mac.dmg')
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'PicoAide Harness Update Ready',
      buttons: ['OK'],
    }))
    expect(electron.shell.openPath).not.toHaveBeenCalled()

    await runtime.updates.installUpdate('2.1.0', '/tmp/DSH-Desktop-2.1.0-mac.dmg')
    expect(electron.shell.openPath).toHaveBeenCalledWith('/tmp/DSH-Desktop-2.1.0-mac.dmg')
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'PicoAide Harness Update Downloaded',
      buttons: ['OK'],
    }))

    runtime.updates.notify({
      title: 'Profile Recovered',
      body: 'Reopened the last-known-good profile.',
    })
    const notification = electron.notifications[0]
    expect(notification?.options).toEqual({
      title: 'Profile Recovered',
      body: 'Reopened the last-known-good profile.',
    })
    expect(notification?.show).toHaveBeenCalledOnce()
    expect(notification?.once).not.toHaveBeenCalled()
  })

  it('forwards a notification click to the session-open handler and focuses the window', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const open = vi.fn()
    runtime.setSessionOpenRequestHandler(open)

    runtime.updates.notify({
      title: 'Task finished',
      body: 'Session "x" finished.',
      sessionId: 'session-x',
    })
    const notification = electron.notifications[0]
    expect(notification?.once).toHaveBeenCalledWith('click', expect.any(Function))
    const click = notification?.once.mock.calls[0]?.[1] as (() => void) | undefined
    click?.()
    expect(open).toHaveBeenCalledWith('session-x')
  })

  it('never opens a session for a notification without a session id', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const open = vi.fn()
    runtime.setSessionOpenRequestHandler(open)

    runtime.updates.notify({
      title: 'Info',
      body: 'Just an update.',
    })
    const notification = electron.notifications[0]
    expect(notification?.once).not.toHaveBeenCalled()
  })

  it('starts the downloaded Windows installer before requesting orderly exit', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    updater.download.mockResolvedValueOnce('C:\\Updates\\DSH-Desktop-2.1.0-windows.exe')
    const requestQuit = vi.fn()
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    runtime.schedule({ ...spec, requestQuit })

    await runtime.updates.downloadUpdate('2.1.0', UPDATE_SOURCE, new AbortController().signal)
    const pending = runtime.updates.installUpdate('2.1.0', 'C:\\Updates\\DSH-Desktop-2.1.0-windows.exe')
    await vi.waitFor(() => { expect(childProcess.spawn).toHaveBeenCalledOnce() })
    expect(childProcess.spawn).toHaveBeenCalledWith(
      'C:\\Updates\\DSH-Desktop-2.1.0-windows.exe',
      ['--updated', '--force-run'],
      {
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: false,
      },
    )
    expect(requestQuit).not.toHaveBeenCalled()
    childProcess.emit('spawn')
    await pending

    expect(childProcess.child.unref).toHaveBeenCalledOnce()
    expect(requestQuit).toHaveBeenCalledWith(0)
  })

  it('does not exit when the downloaded Windows installer fails to spawn', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    updater.download.mockResolvedValueOnce('C:\\Updates\\DSH-Desktop-2.1.0-windows.exe')
    const requestQuit = vi.fn()
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    runtime.schedule({ ...spec, requestQuit })

    await runtime.updates.downloadUpdate('2.1.0', UPDATE_SOURCE, new AbortController().signal)
    const pending = runtime.updates.installUpdate('2.1.0', 'C:\\Updates\\DSH-Desktop-2.1.0-windows.exe')
    await vi.waitFor(() => { expect(childProcess.spawn).toHaveBeenCalledOnce() })
    childProcess.emit('error', new Error('blocked'))

    await expect(pending).rejects.toThrow('blocked')
    expect(childProcess.child.unref).not.toHaveBeenCalled()
    expect(requestQuit).not.toHaveBeenCalled()
  })

  it('keeps a downloaded Windows installer idle when installation is deferred', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    updater.download.mockResolvedValueOnce('C:\\Updates\\DSH-Desktop-2.1.0-windows.exe')
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})

    await runtime.updates.downloadUpdate('2.1.0', UPDATE_SOURCE, new AbortController().signal)
    await runtime.updates.installUpdate('2.1.0', 'C:\\Updates\\DSH-Desktop-2.1.0-windows.exe')

    expect(childProcess.spawn).not.toHaveBeenCalled()
  })

  it('rejects a macOS handoff when the operating system cannot open the DMG', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    updater.download.mockResolvedValueOnce('/tmp/DSH-Desktop-2.1.0-mac.dmg')
    electron.shell.openPath.mockResolvedValueOnce('Launch Services rejected the image')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})

    await expect(runtime.updates.installUpdate('2.1.0', '/tmp/DSH-Desktop-2.1.0-mac.dmg'))
      .rejects.toThrow('Launch Services rejected the image')
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('does not reach the installer handoff when the download is cancelled', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    updater.download.mockImplementationOnce(async (options: { signal?: AbortSignal }) => {
      const signal = options.signal
      return await new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('cancelled', 'AbortError'))
        }, { once: true })
      })
    })
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const controller = new AbortController()

    const pending = runtime.updates.downloadUpdate('2.1.0', UPDATE_SOURCE, controller.signal)
    await vi.waitFor(() => { expect(updater.download).toHaveBeenCalledOnce() })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    // 取消发生在下载阶段:既不打开 DMG,也不弹"已下载完成"。
    expect(electron.shell.openPath).not.toHaveBeenCalled()
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('uses advanced macOS material options with the fixed shell presentation', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    electron.nativeTheme.themeSource = 'light'
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const readThemeSource = vi.fn(() => 'dark' as const)
    const release = runtime.schedule({ ...spec, readThemeSource })

    runtime.setThemeSource('system')
    expect(electron.nativeTheme.themeSource).toBe('light')
    await runtime.mountScheduled()

    expect(readThemeSource).toHaveBeenCalledOnce()
    expect(electron.browserWindowThemeSources).toEqual(['dark'])
    expect(electron.nativeTheme.themeSource).toBe('dark')
    expect(electron.browserWindowOptions[0]).toEqual(expect.objectContaining({
      titleBarStyle: 'hiddenInset',
      transparent: true,
      vibrancy: 'sidebar',
    }))
    expect(electron.menuTemplates.some(template => template.some(
      item => (item as { label?: string }).label === 'Switch to Compatibility Mode',
    ))).toBe(false)

    runtime.setThemeSource('system')
    expect(electron.nativeTheme.themeSource).toBe('system')
    await release()
    expect(electron.nativeTheme.themeSource).toBe('system')
    runtime.setThemeSource('dark')
    expect(electron.nativeTheme.themeSource).toBe('system')
  })

  it('queues picoaide:// deep links before the handler is installed, then flushes', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const links: string[] = []
    // 未安装 handler 时收到的链接入队
    runtime.receiveDeepLink('picoaide://auth?token=early')
    runtime.receiveDeepLink('picoaide://auth?token=early2')
    expect(links).toEqual([])
    // 安装 handler → 冲刷全部排队链接
    runtime.setDeepLinkHandler((url) => links.push(url))
    expect(links).toEqual(['picoaide://auth?token=early', 'picoaide://auth?token=early2'])
    // 后续链接直接投递
    runtime.receiveDeepLink('picoaide://auth?token=later')
    expect(links).toContain('picoaide://auth?token=later')
  })

  it('drops deep links that are not allow-listed picoaide:// actions (P2-62)', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const links: string[] = []
    runtime.receiveDeepLink('picoaide://evil?token=stolen')
    runtime.receiveDeepLink('https://auth?token=stolen')
    runtime.receiveDeepLink('picoaide://')
    runtime.receiveDeepLink('not a url')
    runtime.setDeepLinkHandler((url) => links.push(url))
    // Nothing queued before the handler: every candidate was rejected.
    expect(links).toEqual([])
    runtime.receiveDeepLink('picoaide://auth?token=ok')
    expect(links).toEqual(['picoaide://auth?token=ok'])
  })

  it('does not re-deliver a deep link after the handler is replaced', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const first: string[] = []
    const second: string[] = []
    runtime.setDeepLinkHandler((url) => first.push(url))
    runtime.receiveDeepLink('picoaide://auth?token=a')
    expect(first).toEqual(['picoaide://auth?token=a'])
    runtime.setDeepLinkHandler((url) => second.push(url))
    runtime.receiveDeepLink('picoaide://auth?token=b')
    expect(first).toEqual(['picoaide://auth?token=a'])
    expect(second).toEqual(['picoaide://auth?token=b'])
  })

  it('lets the window load channel logos served by the customer gateway (img-src)', async () => {
    // 2026-09-10 实测：渠道 logo/favicon 由客户自己的服务器下发，渲染层拿到的是
    // 跨源绝对 URL。`img-src 'self' data: blob:` 会把它直接拦掉（微实验复现
    // `violates the following Content Security Policy directive: "img-src 'self'
    // data: blob:"`，naturalWidth=0）—— 界面上就是"品牌图裂了"，而服务端一切正常。
    // 这条测试钉住**能力集**（T-03，2026-09-23：旧版只 `toContain` 子串，三种真实
    // 放宽全部通过），避免有人"顺手收紧 CSP"时白标再次静默失效。
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    const listener = electron.webContents.session.webRequest.onHeadersReceived.mock.calls[0]?.[0] as
      | ((details: { url: string }, cb: (response: { responseHeaders?: Record<string, string[]> }) => void) => void)
      | undefined
    expect(listener, 'mount 必须安装 CSP 响应头处理器').toBeDefined()

    let headers: Record<string, string[]> | undefined
    listener!({ url: 'http://127.0.0.1:43120/' }, (response) => { headers = response.responseHeaders })
    const csp = headers?.['Content-Security-Policy']?.[0]
    expect(csp).toBeDefined()
    // 能力级主判据：指令集合显式枚举 + 每条源集合全等 + 脚本类指令零网络源。
    assertContentSecurityPolicyCapabilities(csp!)
    // 保留"能力为什么必须在这儿"的正向锚（判据失败时能直接看出动机）：
    // 白标渠道图源必须放行 http/https；Blob-URL Worker 必须放行；脚本仍限本地。
    expect(csp).toContain("img-src 'self' data: blob: http: https:")
    expect(csp).toContain("worker-src 'self' blob:")
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
    expect(csp).toContain("default-src 'self' data: blob: ws:")

    // 非 http(s)/file 协议不注入 CSP（与改动前一致：原样放行，不加头）。
    let other: { responseHeaders?: Record<string, string[]> } | undefined
    listener!({ url: 'data:text/html,x' }, (response) => { other = response })
    expect(other?.responseHeaders?.['Content-Security-Policy']).toBeUndefined()

    await release()
  })

  it.each([
    [
      "script-src 追加 https: blob:（允许从任意 HTTPS 源加载/求值脚本）",
      (csp: string) => csp.replace(
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:",
      ),
    ],
    [
      '追加 frame-src * / object-src *（任意 iframe / 插件对象）',
      (csp: string) => `${csp}; frame-src *; object-src *`,
    ],
    [
      '删除 connect-src（出站改由 default-src 支配，且没有任何断言钉它）',
      (csp: string) => csp.split('; ').filter(part => !part.startsWith('connect-src')).join('; '),
    ],
  ])('能力级判据拒绝放宽：%s', async (_label, loosen) => {
    // 判据本身必须能被打坏（旧 `toContain` 做不到的那一半）：先用真实 CSP 证明
    // 判据绿，再对同一份 CSP 施加三种真实放宽，逐一必须红。
    const csp = await appliedContentSecurityPolicy()
    expect(() => assertContentSecurityPolicyCapabilities(csp)).not.toThrow()
    const loosened = loosen(csp)
    expect(loosened, '放宽函数没有改变 CSP —— 用例会空转').not.toBe(csp)
    expect(
      () => assertContentSecurityPolicyCapabilities(loosened),
      `放宽后的 CSP 必须被判据拒绝：${loosened}`,
    ).toThrow()
  })

  it('grants the clipboard permission to the app UI document only (2026-09-14 复制按钮 P0)', async () => {
    // 聊天区所有「复制」按钮（消息操作栏 / 代码块 / diff / 终端输出 / JSON 树）都走
    // `navigator.clipboard.writeText`。P1-4 的一刀切 false 让写入被判
    // `NotAllowedError: Write permission denied` —— 按钮既不进剪贴板也不显示
    // "已复制"的勾，现场表现就是"点复制没反应"。
    //
    // Electron 43 对**同一句 writeText** 按调用路径报**两个不同的权限名**
    // （43.4.0 最小探针 temp/perm-probe/main4.cjs 实测）：
    //   · 脚本 / 自动化调用（无用户手势）→ `clipboard-read`
    //   · 用户真按在按钮上（有用户手势）  → `clipboard-sanitized-write`
    // 只放行其一会造成"探针绿、真人点不动"（beta.2 的真实事故）：本用例因此对
    // **两个权限名**都断言放行，另外钉住来源 / 框架层级 / 其它权限三条闸。
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()

    const request = electron.webContents.session.setPermissionRequestHandler.mock.calls[0]?.[0] as
      | ((wc: unknown, permission: string, cb: (granted: boolean) => void, details?: unknown) => void)
      | undefined
    const check = electron.webContents.session.setPermissionCheckHandler.mock.calls[0]?.[0] as
      | ((wc: unknown, permission: string, origin: string, details?: unknown) => boolean)
      | undefined
    expect(request, 'mount 必须安装权限请求处理器').toBeDefined()
    expect(check, 'mount 必须安装权限检查处理器').toBeDefined()

    const grantedByRequest = (permission: string, details: unknown): boolean => {
      let granted: boolean | undefined
      request!(undefined, permission, (value) => { granted = value }, details)
      return granted === true
    }

    // 应用自己的文档（主框架）→ 两个权限名都放行：
    //  · clipboard-read             —— 脚本路径（实测 writeText/readText 无手势时走它）
    //  · clipboard-sanitized-write  —— 用户真点按钮的路径（少了它现场就是"点了没反应"）
    expect(grantedByRequest('clipboard-read', { isMainFrame: true, requestingUrl: 'http://127.0.0.1:43120/' })).toBe(true)
    expect(grantedByRequest('clipboard-sanitized-write', { isMainFrame: true, requestingUrl: 'http://127.0.0.1:43120/' })).toBe(true)
    // 检查通道给的是 embeddingOrigin（实测 requestingUrl 为空）：两条通道口径一致。
    expect(check!(undefined, 'clipboard-read', '', { isMainFrame: true, embeddingOrigin: 'http://127.0.0.1:43120/' })).toBe(true)
    expect(check!(undefined, 'clipboard-sanitized-write', '', { isMainFrame: true, embeddingOrigin: 'http://127.0.0.1:43120/' })).toBe(true)

    // 收紧的部分不能被顺手放开：来源、框架层级、权限名三道闸都要成立。
    for (const permission of ['clipboard-read', 'clipboard-sanitized-write']) {
      expect(grantedByRequest(permission, { isMainFrame: true, requestingUrl: 'https://evil.example/' })).toBe(false)
      expect(grantedByRequest(permission, { isMainFrame: false, requestingUrl: 'http://127.0.0.1:43120/' })).toBe(false)
      expect(grantedByRequest(permission, {})).toBe(false)
      expect(grantedByRequest(permission, undefined)).toBe(false)
    }
    expect(grantedByRequest('media', { isMainFrame: true, requestingUrl: 'http://127.0.0.1:43120/' })).toBe(false)
    expect(grantedByRequest('geolocation', { isMainFrame: true, requestingUrl: 'http://127.0.0.1:43120/' })).toBe(false)
    expect(grantedByRequest('display-capture', { isMainFrame: true, requestingUrl: 'http://127.0.0.1:43120/' })).toBe(false)
    expect(check!(undefined, 'media', '', { isMainFrame: true, embeddingOrigin: 'http://127.0.0.1:43120/' })).toBe(false)
    expect(check!(undefined, 'clipboard-read', '', { isMainFrame: true, embeddingOrigin: 'https://evil.example/' })).toBe(false)

    await release()
  })

  it('validates deep links against the channel scheme, not the vendor default', async () => {
    // 2026-09-11 真机复现：渠道构建（scheme=acmeai/probeharness 之类）的
    // 浏览器 SSO 回调在 shell 的严格闸门被当成畸形链接丢掉，因为 receiveDeepLink
    // 用的是模块缺省 `picoaide`。scheme 必须由 main.ts 传进来。
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const logger = { error: vi.fn(), errorCause: vi.fn() }
    const delivered: string[] = []

    const channelRuntime = new ElectronDesktopRuntime(async () => {}, undefined, logger, 'acmebrand')
    channelRuntime.setDeepLinkHandler(url => delivered.push(url))
    channelRuntime.receiveDeepLink('acmebrand://auth?token=t&server=' + encodeURIComponent('https://acme.example') + '&user=alice')
    expect(delivered).toHaveLength(1)
    expect(logger.error).not.toHaveBeenCalled()

    // 官方缺省（没注入）时同一个链接进不来 —— 缺陷形态本身。
    const officialRuntime = new ElectronDesktopRuntime(async () => {}, undefined, logger)
    officialRuntime.setDeepLinkHandler(url => delivered.push(url))
    officialRuntime.receiveDeepLink('acmebrand://auth?token=t&server=' + encodeURIComponent('https://acme.example') + '&user=alice')
    expect(delivered).toHaveLength(1)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ignoring malformed deep link'))
  })
})

/**
 * B-01 / B-03（2026-09-23 独立审计 P1，真机 Electron 44.4.3 复现）。
 *
 * 两个缺陷共用一个入口：`render-process-gone` 与 `did-fail-load` 都进崩溃回退。
 *  · B-01：`did-fail-load` 不检查第 5 参 `isMainFrame` ⇒ 一次 **iframe** 失败
 *    （右栏 HTML 预览就是 `<iframe src=blob:…>`）就整窗 reload、第二次换成错误页。
 *  · B-03：两条路径共用一个一次性闩锁且不串行 ⇒ 崩溃时两个事件并发两次 `loadURL`，
 *    "至多重试一次"从未成立。
 *
 * 判据必须能区分主/子框架，且必须能证伪"并发只发一次导航"。
 */
describe('崩溃回退：框架判据 + 串行化（B-01/B-03）', () => {
  /** 挂好窗口、清掉 mount 自己那次 loadURL，并取出两个事件的处理器。 */
  async function mounted(): Promise<{
    release: () => Promise<void>
    logger: { error: ReturnType<typeof vi.fn>, errorCause: ReturnType<typeof vi.fn> }
    didFailLoad: (...args: unknown[]) => void
    gone: (...args: unknown[]) => void
    window: InstanceType<typeof electron.BrowserWindow>
  }> {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const logger = { error: vi.fn(), errorCause: vi.fn() }
    const runtime = new ElectronDesktopRuntime(async () => {}, undefined, logger)
    const release = runtime.schedule(spec)
    await runtime.mountScheduled()
    const window = electron.browserWindows.at(-1)!
    const handler = (event: string): ((...args: unknown[]) => void) => {
      // `webContents` 是**跨窗口共享**的替身：早先 mount 注册的处理器仍留在
      // mock.calls 里（find 会拿到第一个窗口的闭包 = 拿错窗口的状态机），所以取最后一个。
      const found = window.webContents.on.mock.calls.filter(([name]) => name === event).at(-1)?.[1] as
        | ((...args: unknown[]) => void)
        | undefined
      expect(found, `mount 必须安装 ${event} 处理器`).toBeDefined()
      return found!
    }
    electron.webContents.getURL.mockReturnValue('http://127.0.0.1:43120/')
    // mountScheduled 已经 load 过应用 URL：只数崩溃驱动的导航。
    electron.loadURL.mockClear()
    return { release, logger, didFailLoad: handler('did-fail-load'), gone: handler('render-process-gone'), window }
  }

  it('子框架加载失败只记日志，绝不 reload 整窗（B-01）', async () => {
    const { release, logger, didFailLoad } = await mounted()

    // Electron 的签名是 (event, errorCode, errorDescription, validatedURL, isMainFrame, …)：
    // 真机探针 probe-did-fail-load-subframe.cjs 实测子框架失败为 isMainFrame=false。
    didFailLoad({}, -312, 'ERR_UNSUPPORTED', 'blob:http://127.0.0.1:43120/dead-frame', false)
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(electron.loadURL, '子框架失败不得触发任何导航').not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('subframe failed to load'))
    // 日志必须带 validatedURL：否则线上只有一句"某处失败了"。
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('blob:http://127.0.0.1:43120/dead-frame'))
    await release()
  })

  it('主框架失败仍然走一次自动恢复；缺第 5 参时按"不确定"处理（B-01 反向对照）', async () => {
    const { release, didFailLoad } = await mounted()

    didFailLoad({}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://127.0.0.1:43120/', true)
    await vi.waitFor(() => { expect(electron.loadURL).toHaveBeenCalledTimes(1) })
    expect(electron.loadURL).toHaveBeenLastCalledWith('http://127.0.0.1:43120/')
    await release()

    // 防御性判空：旧/新 Electron 少给第 5 参时**不**自动恢复（宁可少一次自动重试，
    // 也不能让未知来源的失败掀掉整窗）。
    const second = await mounted()
    second.didFailLoad({}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://127.0.0.1:43120/')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(electron.loadURL).not.toHaveBeenCalled()
    await second.release()
  })

  it('崩溃与加载失败并发时只发一次导航，之后只显示错误页（B-03）', async () => {
    const { release, logger, gone, didFailLoad } = await mounted()

    // 渲染进程崩溃时 Electron 会**同时**派发进程级与导航级两个事件。
    gone({}, { reason: 'crashed', exitCode: 1 })
    didFailLoad({}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://127.0.0.1:43120/', true)
    await new Promise(resolve => setTimeout(resolve, 40))

    expect(electron.loadURL, '并发事件必须合并成一次 reload').toHaveBeenCalledTimes(1)
    expect(electron.loadURL).toHaveBeenLastCalledWith('http://127.0.0.1:43120/')
    // 串行化是显式的（日志可证），不是靠"恰好没并发"。
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('recovery already in flight'))

    // 第三次事件：重试额度已用尽 ⇒ 只显示错误页，绝不再次 reload 应用 URL。
    gone({}, { reason: 'crashed', exitCode: 1 })
    await vi.waitFor(() => { expect(electron.loadURL).toHaveBeenCalledTimes(2) })
    expect(String(electron.loadURL.mock.calls[1]?.[0])).toContain('data:text/html')
    await release()
  })
})
