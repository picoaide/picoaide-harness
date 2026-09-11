/** Electron implementation of the launcher-provided desktop runtime capability. */

/**
 * 官方渠道产品名：没有渠道包时（本地开发）的兜底。
 *
 * native 文案（托盘/通知/弹窗/失败页）一律经 `this.productName`，渠道构建下
 * 那里是渠道自己的名字。
 */
const OFFICIAL_PRODUCT_NAME = 'PicoAide Harness'

import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  shell,
  Tray,
} from 'electron'
import { spawn } from 'node:child_process'
import { chmod } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  DesktopNotification,
  DesktopLocale,
  DesktopPlatform,
  DesktopRuntime,
  DesktopShellSpec,
  DesktopThemeSource,
  DesktopTrayItem,
  DesktopTrayItemGroup,
  DesktopTrayItemRegistration,
  DesktopUpdateAdapter,
  DesktopUpdateSource,
  UpdateDownloadProgressSnapshot,
} from './runtime.ts'
import type { RendererBootReport } from './renderer-boot-contract.ts'
import { parseDesktopDeepLink } from './deep-link.ts'
import { DEFAULT_DEEP_LINK_SCHEME } from './desktop-channel.ts'
import { formatDesktopExitCode, type DesktopLogger } from './desktop-logger.ts'
import { exportDesktopDiagnostics } from './diagnostic-export.ts'
import { prepareTrayIcon } from './tray-icons.ts'
import {
  desktopDiagnosticsPrivacyCopy,
  desktopLocaleFromLanguageTag,
  desktopTrayLabel,
} from './tray-locale.ts'
import { downloadDesktopUpdate } from './update-download.ts'
import type { UpdateCheckResult } from './update-checker.ts'
import { desktopWindowOptions } from './window-options.ts'

/** Read the desktop package version instead of Electron's development-app version.
 * @param moduleUrl - module below the package's `src` or `lib` directory.
 * @returns validated desktop product version.
 */
export function desktopProductVersion(moduleUrl: string = import.meta.url): string {
  const value: unknown = JSON.parse(readFileSync(new URL('../package.json', moduleUrl), 'utf8'))
  if (value === null || typeof value !== 'object' || typeof (value as { version?: unknown }).version !== 'string') {
    throw new Error('dsh-plugin-desktop: package.json has no product version')
  }
  return (value as { version: string }).version
}

const PRODUCT_VERSION = desktopProductVersion()
const MIN_ZOOM_LEVEL = -4
const MAX_ZOOM_LEVEL = 4

/**
 * 应用窗口的 CSP（P1-4 起生效；导出仅为让测试钉住指令表 —— 漏一条指令的后果
 * 是运行时静默失效，页面上只表现为"图裂了"）。
 *
 * `img-src` 必须放行 `http:`/`https:`（2026-09-10 实测）：渠道 logo/favicon 由
 * **客户自己的服务器**下发（`/api/client/v2/channel/logo`），其地址在打包期未知，
 * 渲染层拿到的是绝对 URL —— 只写 `'self' data: blob:` 会被这条指令直接拦掉
 * （微实验复现：`violates the following Content Security Policy directive:
 * "img-src 'self' data: blob:"`，`naturalWidth=0`，界面上就是裂图；登录页那张
 * logo 同理，它有 `onerror` 兜底所以只是"看不见"）。这不构成新的外泄面：同一条
 * 策略的 `connect-src` 早已放行 `http: https:`，被注入的脚本本来就能把数据
 * POST 出去，放行图片不增加能力。
 */
export const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'self' data: blob: ws:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http: https:",
].join('; ')

function clampedZoomLevel(level: number): number {
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, level))
}

function isZoomShortcut(input: Electron.Input): 'in' | 'out' | 'reset' | undefined {
  if (input.type !== 'keyDown' || input.alt || (!input.control && !input.meta)) return undefined
  if (input.key === '+' || input.key === '=') return 'in'
  if (input.key === '-' || input.key === '_') return 'out'
  if (input.key === '0') return 'reset'
  return undefined
}

/** Native adapter used by the PicoAide Harness launcher and owned by its Cordis shell plugin. */
export class ElectronDesktopRuntime implements DesktopRuntime {
  readonly platform: DesktopPlatform
  readonly updates: DesktopUpdateAdapter = {
    get isPackaged() { return app.isPackaged },
    get canDownload() { return app.isPackaged },
    get currentVersion() { return PRODUCT_VERSION },
    get statePath() { return join(app.getPath('userData'), 'updates', 'state.json') },
    request: (url, init) => net.fetch(url, init),
    confirmDownload: version => this.confirmUpdateDownload(version),
    showManualCheckResult: result => this.showManualUpdateCheckResult(result),
    downloadAndOpen: (version, source, signal, onProgress) => this.downloadAndOpenUpdate(version, source, signal, onProgress),
    notify: notification => { this.showNotification(notification) },
  }

  private window: BrowserWindow | undefined
  private currentLocale: DesktopLocale = 'en'
  private tray: Tray | undefined
  private scheduled: DesktopShellSpec | undefined
  private mountTask: Promise<void> | undefined
  private release: (() => Promise<void>) | undefined
  private quitting = false
  private readonly trayItems = new Map<symbol, DesktopTrayItem>()
  private diagnosticExport: Promise<void> | undefined
  private directoryPickTask: Promise<string | null> | undefined
  private rendererBootReported = false
  /** Deep-link handler installed by the desktop-shell plugin (auth callback). */
  private deepLinkHandler: ((url: string) => void) | undefined
  /** Links received while no handler was installed yet (startup race). */
  private readonly pendingDeepLinks: string[] = []
  /** Session-open handler installed by the desktop-shell plugin (notification click). */
  private sessionOpenHandler: ((sessionId: string) => void) | undefined

  /**
   * Product name for native menus, trays, and update notifications.
   *
   * 渠道构建下由 profile 组装置为渠道产品名；未调度/未渠道化时回落官方名。
   */
  get productName(): string {
    return this.scheduled?.productName ?? OFFICIAL_PRODUCT_NAME
  }

  constructor(
    private readonly restart: () => Promise<void>,
    private readonly onRendererBoot: (report: RendererBootReport) => void = () => {},
    private readonly logger: DesktopLogger | undefined = undefined,
    /**
     * 本安装的深链 scheme（渠道包决定，由 main.ts 传入）。
     *
     * **必须显式传**：渠道客户端的 scheme 是客户自己的（如 `mokahr-harness`），
     * 缺省官方值会把渠道深链在 `receiveDeepLink` 的严格闸门直接丢掉 —— 浏览器
     * SSO 回调永远进不来，而日志只有一行 malformed（2026-09-11 真机复现）。
     */
    private readonly deepLinkScheme: string = DEFAULT_DEEP_LINK_SCHEME,
  ) {
    if (process.platform !== 'darwin' && process.platform !== 'win32' && process.platform !== 'linux') {
      throw new Error(`dsh-plugin-desktop: unsupported Electron platform ${process.platform}`)
    }
    this.platform = process.platform
  }

  /** Log an Electron-scope error to the sink, falling back to stderr without a logger. */
  private logError(message: string): void {
    if (this.logger !== undefined) this.logger.error(message)
    else process.stderr.write(`${message}\n`)
  }

  /** @inheritdoc */
  get locale(): DesktopLocale {
    return this.currentLocale
  }

  /** @inheritdoc */
  schedule(spec: DesktopShellSpec): () => Promise<void> {
    if (this.scheduled !== undefined || this.mountTask !== undefined) {
      throw new Error('dsh-plugin-desktop: a native shell generation is already registered')
    }
    this.scheduled = spec
    let disposed = false
    return async () => {
      if (disposed) return
      disposed = true
      try {
        await this.mountTask
      } finally {
        try {
          await this.release?.()
        } finally {
          this.release = undefined
          this.mountTask = undefined
          if (this.scheduled === spec) {
            this.scheduled = undefined
          }
        }
      }
    }
  }

  /** @inheritdoc */
  mountScheduled(beforeInteractive?: () => void): Promise<void> {
    const spec = this.scheduled
    if (spec === undefined) {
      return Promise.reject(new Error('dsh-plugin-desktop: the Cordis shell plugin did not register a window'))
    }
    this.mountTask ??= this.mount(spec, beforeInteractive).then((release) => { this.release = release })
    return this.mountTask
  }

  /** @inheritdoc */
  show(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  /** Whether the mounted native window currently holds keyboard focus. */
  isFocused(): boolean {
    const window = this.window
    return window !== undefined && !window.isDestroyed() && window.isFocused()
  }

  /** @inheritdoc */
  async pickDirectory(): Promise<string | null> {
    if (this.platform !== 'win32') {
      throw new Error(`dsh-plugin-desktop: native workspace picker is unavailable on ${this.platform}`)
    }
    if (this.directoryPickTask !== undefined) return await this.directoryPickTask
    // 审计 2026-08-30 (CodeQL js/missing-await): task 是 Promise 但此处故意不
    // await——保存到 directoryPickTask 做「单飞」去重(并发调用共享同一 picker),
    // finally 里比较的是 Promise 引用而非结果, 与 await 无关, 非 bug。
    const task: Promise<string | null> = this.showDirectoryPicker()
    this.directoryPickTask = task
    try {
      return await task
    } finally {
      if (this.directoryPickTask === task) this.directoryPickTask = undefined
    }
  }

  private async showDirectoryPicker(): Promise<string | null> {
    const options: Electron.OpenDialogOptions = {
      title: this.currentLocale === 'zh' ? '选择工作区目录' : 'Select Workspace Directory',
      properties: ['openDirectory', 'dontAddToRecent'],
    }
    const window = this.window
    const result = window === undefined || window.isDestroyed()
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options)
    return result.canceled ? null : result.filePaths[0] ?? null
  }

  /** @inheritdoc */
  registerTrayItem(item: DesktopTrayItem): DesktopTrayItemRegistration {
    const key = Symbol()
    this.trayItems.set(key, item)
    this.rebuildTrayMenu()
    let active = true
    return {
      refresh: () => {
        if (active) this.rebuildTrayMenu()
      },
      dispose: () => {
        if (!active) return
        active = false
        this.trayItems.delete(key)
        this.rebuildTrayMenu()
      },
    }
  }

  /** @inheritdoc */
  exportDiagnostics(): Promise<void> {
    if (this.diagnosticExport !== undefined) return this.diagnosticExport
    const operation = this.performDiagnosticExport().finally(() => {
      if (this.diagnosticExport === operation) this.diagnosticExport = undefined
    })
    this.diagnosticExport = operation
    return operation
  }

  private async performDiagnosticExport(): Promise<void> {
    const copy = desktopDiagnosticsPrivacyCopy(this.locale)
    try {
      const confirmation = await dialog.showMessageBox({
        type: 'warning',
        title: copy.title,
        message: copy.message,
        detail: copy.detail,
        buttons: [copy.confirm, copy.cancel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      if (confirmation.response !== 0) return
      const path = await exportDesktopDiagnostics(app.getPath('userData'), {
        appVersion: PRODUCT_VERSION,
        crashDumpsDir: app.getPath('crashDumps'),
      })
      shell.showItemInFolder(path)
    } catch (cause) {
      this.reportDiagnosticExportError(cause)
    }
  }

  /** @inheritdoc */
  reportRendererBoot(report: RendererBootReport): void {
    if (this.rendererBootReported) return
    this.rendererBootReported = true
    try {
      this.onRendererBoot(report)
    } catch (cause) {
      this.logError(`dsh-plugin-desktop: failed to persist renderer boot health: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    if (report.status === 'failed') {
      void this.showRendererBootRecovery(report).catch((cause: unknown) => {
        this.logError(`dsh-plugin-desktop: failed to show plugin recovery: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
    }
  }

  /** @inheritdoc */
  setLocalePreference(preference: DesktopLocale | undefined): void {
    const locale = preference ?? desktopLocaleFromLanguageTag(app.getLocale())
    if (locale === this.currentLocale) return
    this.currentLocale = locale
    this.rebuildTrayMenu()
  }

  /** @inheritdoc */
  setThemeSource(source: DesktopThemeSource): void {
    if (this.window !== undefined) {
      nativeTheme.themeSource = source
    }
  }

  /** @inheritdoc */
  async requestRestart(): Promise<void> {
    await this.restart()
  }

  /** @inheritdoc */
  prepareToQuit(): void {
    this.quitting = true
  }

  /** @inheritdoc */
  setDeepLinkHandler(handler: (url: string) => void): void {
    this.deepLinkHandler = handler
    // Flush links that arrived before the handler was installed:
    // macOS open-url can fire before app.whenReady; second-instance argv
    // arrives while the first instance is still booting. Do not drop them.
    for (const url of this.pendingDeepLinks.splice(0)) {
      try {
        handler(url)
      } catch (cause) {
        this.logError(`dsh-plugin-desktop: deep link handler failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
  }

  /**
   * Receive a `picoaide://` deep link: validate it against the allow-list
   * (P2-62), then deliver to the installed handler — or queue it when the
   * profile tree has not mounted yet.
   */
  receiveDeepLink(url: string): void {
    // scheme 必须用**本安装**的那个（渠道包决定）：用缺省官方值会把渠道
    // 深链判成 malformed，浏览器 SSO 回调在闸门处静默消失。
    const parsed = parseDesktopDeepLink(url, this.deepLinkScheme)
    if (parsed === null) {
      // Strict gate: a merely prefix-matching string must not reach Host
      // consumers (the enterprise auth callback trusts the event).
      this.logError(`dsh-plugin-desktop: ignoring malformed deep link: ${url.slice(0, 200)}`)
      return
    }
    if (this.deepLinkHandler !== undefined) {
      try {
        this.deepLinkHandler(parsed.url)
      } catch (cause) {
        this.logError(`dsh-plugin-desktop: deep link handler failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
      return
    }
    // Startup race: profile plugins (enterprise deep-link listener) are not
    // mounted yet. Keep the link; setDeepLinkHandler flushes on install.
    this.pendingDeepLinks.push(parsed.url)
  }

  /** @inheritdoc */
  setSessionOpenRequestHandler(handler: (sessionId: string) => void): void {
    this.sessionOpenHandler = handler
  }

  /** Deliver a notification-click session request, focusing the window first. */
  private requestSessionOpen(sessionId: string): void {
    this.show()
    try {
      this.sessionOpenHandler?.(sessionId)
    } catch (cause) {
      this.logError(`dsh-plugin-desktop: session open handler failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  private async showRendererBootRecovery(report: Extract<RendererBootReport, { status: 'failed' }>): Promise<void> {
    const plugins = report.plugins.length === 0
      ? 'Unknown client plugin'
      : report.plugins.map(plugin => `- ${plugin}`).join('\n')
    const error = report.error === undefined ? 'The client Loader did not provide an error message.' : report.error
    // 产品名取自 profile 组装配置（渠道构建下即渠道自己的名字）—— 失败弹窗
    // 是渠道客户最可能看到的"厂商品牌露出"位置之一。
    const product = this.productName
    const result = await dialog.showMessageBox({
      type: 'error',
      title: 'Plugin Recovery',
      message: `${product} could not load all plugins.`,
      detail: `Failed plugins:\n${plugins}\n\n${error}\n\nRestart ${product} after resolving the failing plugin.`,
      buttons: [`Restart ${product}`, 'Dismiss'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (result.response === 0) await this.requestRestart()
  }

  private contributedTrayItems(group: DesktopTrayItemGroup): Electron.MenuItemConstructorOptions[] {
    return [...this.trayItems.values()]
      .filter(item => item.group === group)
      .sort((left, right) => left.order - right.order)
      .map((item): Electron.MenuItemConstructorOptions => {
        const common = {
          label: item.label(),
          enabled: item.enabled?.() ?? true,
        }
        if (item.submenu !== undefined) {
          return {
            ...common,
            submenu: item.submenu().map(command => ({
              label: command.label(),
              enabled: command.enabled?.() ?? true,
              ...(command.type === undefined ? {} : { type: command.type }),
              ...(command.checked === undefined ? {} : { checked: command.checked() }),
              click: this.trayCommand(() => command.invoke()),
            })),
          }
        }
        return {
          ...common,
          click: this.trayCommand(() => item.invoke()),
        }
      })
  }

  /** Contain asynchronous contribution failures outside Electron menu callbacks. */
  private trayCommand(invoke: () => void | Promise<void>): () => void {
    return () => {
      void Promise.resolve().then(invoke).catch((cause: unknown) => {
        this.logError(`dsh-plugin-desktop: tray command failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
    }
  }

  private showNotification(notification: DesktopNotification): void {
    if (!Notification.isSupported()) return
    const nativeNotification = new Notification({
      title: notification.title,
      body: notification.body,
    })
    if (notification.sessionId !== undefined) {
      nativeNotification.once('click', () => {
        this.requestSessionOpen(notification.sessionId!)
      })
    }
    nativeNotification.show()
  }

  /** Ask before making the fixed download endpoint's counted request. */
  private async confirmUpdateDownload(version: string): Promise<boolean> {
    const result = await dialog.showMessageBox({
      type: 'info',
      title: `${this.productName} Update Available`,
      message: `${this.productName} ${version} is available.`,
      detail: 'Download this update now?',
      buttons: ['Download', 'Later'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return result.response === 0
  }

  /** Report one user-triggered check without exposing network or response details. */
  private async showManualUpdateCheckResult(result: UpdateCheckResult | null): Promise<void> {
    if (result === null) {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Unable to Check for Updates',
        message: `${this.productName} could not check for updates.`,
        detail: 'Please try again later.',
        buttons: ['OK'],
        defaultId: 0,
        noLink: true,
      })
      return
    }

    if (result.status === 'up-to-date') {
      await dialog.showMessageBox({
        type: 'info',
        title: `${this.productName} Is Up to Date`,
        message: `No newer version of ${this.productName} is available.`,
        detail: `Installed version: ${result.currentVersion}`,
        buttons: ['OK'],
        defaultId: 0,
        noLink: true,
      })
      return
    }

    await dialog.showMessageBox({
      type: 'info',
      title: `${this.productName} Update Available`,
      message: `${this.productName} ${result.latestVersion} is available.`,
      detail: 'Installer downloads are unavailable in this build.',
      buttons: ['OK'],
      defaultId: 0,
      noLink: true,
    })
  }

  /** Download a confirmed installer and hand it to the native installation flow. */
  private async downloadAndOpenUpdate(
    version: string,
    source: DesktopUpdateSource,
    signal: AbortSignal,
    onProgress?: (progress: UpdateDownloadProgressSnapshot) => void,
  ): Promise<void> {
    if (this.platform !== 'darwin' && this.platform !== 'win32' && this.platform !== 'linux') {
      throw new Error(`dsh-plugin-desktop: updates are unavailable on ${this.platform}`)
    }
    const artifactPath = await downloadDesktopUpdate({
      platform: this.platform,
      version,
      manifestURL: source.manifestURL,
      userDataPath: app.getPath('userData'),
      request: (url, init) => net.fetch(url, init),
      signal,
      ...(source.expectedChannel === undefined ? {} : { expectedChannel: source.expectedChannel }),
      ...(onProgress === undefined ? {} : { onProgress }),
    })
    signal.throwIfAborted()

    if (this.platform === 'linux') {
      // AppImage 无静默自安装:下载完 chmod +x 并提示用户替换运行。
      try { await chmod(artifactPath, 0o755) } catch { /* 非致命:提示仍展示 */ }
      signal.throwIfAborted()
      await dialog.showMessageBox({
        type: 'info',
        title: `${this.productName} Update Downloaded`,
        message: `${this.productName} ${version} is ready to install.`,
        detail: `新版本 AppImage 已下载到: ${artifactPath}\n\n请关闭本程序, 用该文件替换当前 AppImage 后重新运行。`,
        buttons: ['OK'],
        defaultId: 0,
        noLink: true,
      })
      return
    }

    if (this.platform === 'darwin') {
      const openError = await shell.openPath(artifactPath)
      if (openError !== '') throw new Error(`dsh-plugin-desktop: failed to open update disk image: ${openError}`)
      signal.throwIfAborted()
      await dialog.showMessageBox({
        type: 'info',
        title: `${this.productName} Update Downloaded`,
        message: `${this.productName} ${version} is ready to install.`,
        detail: `The disk image has opened. Replace ${this.productName} in Applications, then reopen it.`,
        buttons: ['OK'],
        defaultId: 0,
        noLink: true,
      })
      return
    }

    const result = await dialog.showMessageBox({
      type: 'info',
      title: `${this.productName} Update Downloaded`,
      message: `${this.productName} ${version} is ready to install.`,
      detail: `Restart ${this.productName} and run the installer now?`,
      buttons: ['Restart and Install', 'Later'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (result.response !== 0) return

    const spec = this.scheduled
    if (spec === undefined) throw new Error('dsh-plugin-desktop: no active shell can exit for update installation')
    signal.throwIfAborted()
    await this.launchWindowsUpdateInstaller(artifactPath)
    this.quitting = true
    spec.requestQuit(0)
  }

  /** Start the downloaded NSIS installer before releasing the current process. */
  private async launchWindowsUpdateInstaller(installerPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(installerPath, ['--updated', '--force-run'], {
          detached: true,
          stdio: 'ignore',
          shell: false,
          windowsHide: false,
        })
      } catch (cause) {
        reject(cause)
        return
      }
      const fail = (cause: Error): void => { reject(cause) }
      child.once('error', fail)
      child.once('spawn', () => {
        child.off('error', fail)
        child.once('error', cause => {
          this.logError(`dsh-plugin-desktop: update installer failed after launch: ${cause.message}`)
        })
        child.unref()
        resolve()
      })
    })
  }

  /** Keep diagnostic export failures visible in a packaged GUI process. */
  private reportDiagnosticExportError(cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    this.logError(`dsh-plugin-desktop: failed to export diagnostics: ${error.message}`)
    try {
      dialog.showErrorBox('Unable to Export Diagnostics', error.message)
    } catch (dialogCause) {
      this.logError(`dsh-plugin-desktop: failed to show diagnostics error: ${dialogCause instanceof Error ? dialogCause.message : String(dialogCause)}`)
    }
  }

  private rebuildTrayMenu(): void {
    const tray = this.tray
    const spec = this.scheduled
    if (tray === undefined || spec === undefined) return

    const show = (): void => { this.show() }
    const tools = this.contributedTrayItems('tools')
    const profiles = this.contributedTrayItems('profiles')
    const status = this.contributedTrayItems('status')
    const template: Electron.MenuItemConstructorOptions[] = [
          { label: desktopTrayLabel(this.locale, 'openDesktop', spec.productName), click: show },
    ]
    if (tools.length > 0) template.push({ type: 'separator' }, ...tools)
    if (profiles.length > 0) template.push({ type: 'separator' }, ...profiles)
    if (status.length > 0) template.push({ type: 'separator' }, ...status)
    template.push(
      { type: 'separator' },
      { label: desktopTrayLabel(this.locale, 'quit'), click: () => { spec.requestQuit(0) } },
    )
    tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  private async mount(
    spec: DesktopShellSpec,
    beforeInteractive: (() => void) | undefined,
  ): Promise<() => Promise<void>> {
    this.setLocalePreference(spec.readLocalePreference())
    const icon = nativeImage.createFromPath(spec.iconPath)
    if (icon.isEmpty()) {
      throw new Error(`dsh-plugin-desktop: failed to load application icon ${spec.iconPath}`)
    }
    if (this.platform === 'darwin') app.dock?.setIcon(icon)
    const origin = new URL(spec.url).origin
    nativeTheme.themeSource = spec.readThemeSource()
    const window = new BrowserWindow(desktopWindowOptions(spec, icon, this.platform))
    // P1-4: deny every renderer permission request by default. Electron
    // auto-grants camera/mic/geolocation etc. when no handler is set, which
    // an untrusted web surface must never receive. The embedded browser
    // (dsh-browser) manages its own partition and permission policy.
    window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false)
    })
    window.webContents.session.setPermissionCheckHandler(() => false)
    // P1-4: a Content-Security-Policy for the app surface. The DSH web bundle
    // is fully local (no CDN/external scripts); the strict policy keeps any
    // injected content from reaching out. The embedded browser partition is
    // separate and unaffected.
    const cspOnHeaders = (
      details: Electron.OnHeadersReceivedListenerDetails,
      callback: (response: { responseHeaders?: Record<string, string[]> }) => void,
    ): void => {
      const url = details.url
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') {
          callback({})
          return
        }
      } catch {
        callback({})
        return
      }
      const headers = { ...details.responseHeaders }
      headers['Content-Security-Policy'] = [APP_CONTENT_SECURITY_POLICY]
      callback({ responseHeaders: headers })
    }
    window.webContents.session.webRequest.onHeadersReceived(cspOnHeaders)
    window.accessibleTitle = spec.windowTitle
    if (this.platform === 'win32') window.removeMenu()
    this.window = window

    const show = (): void => { this.show() }
    const close = (event: Electron.Event): void => {
      if (this.quitting) return
      event.preventDefault()
      window.hide()
    }
    const preserveBlankTitle = (event: Electron.Event): void => { event.preventDefault() }
    const handleZoomShortcut = (event: Electron.Event, input: Electron.Input): void => {
      const action = isZoomShortcut(input)
      if (action === undefined) return
      event.preventDefault()
      if (action === 'reset') {
        window.webContents.setZoomLevel(0)
        return
      }
      const step = action === 'in' ? 1 : -1
      window.webContents.setZoomLevel(clampedZoomLevel(window.webContents.getZoomLevel() + step))
    }
    const navigate = (event: Electron.Event<{ url: string }>): void => {
      let targetOrigin: string | undefined
      try {
        targetOrigin = new URL(event.url).origin
      } catch {
        targetOrigin = undefined
      }
      if (targetOrigin !== origin) event.preventDefault()
    }

    app.on('activate', show)
    window.on('close', close)
    window.on('page-title-updated', preserveBlankTitle)
    window.webContents.on('before-input-event', handleZoomShortcut)
    window.webContents.on('will-frame-navigate', navigate)
    window.webContents.on('will-redirect', navigate)
    window.webContents.on('render-process-gone', (_event, details) => {
      this.logError(`dsh-plugin-desktop: renderer process gone (reason: ${details.reason}, exitCode: ${formatDesktopExitCode(details.exitCode)})`)
      // P1-3: a crashed renderer must not leave a dead white window. Retry
      // the load once; if the reload also fails, show a native error surface
      // with a manual reload entry instead of silently logging.
      if (details.reason !== 'clean-exit' && details.reason !== 'killed') {
        void reloadOrShowCrashFallback(
          { log: (message) => this.logError(message), productName: this.productName },
          window,
        )
      }
    })
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      // P1-3: a failed navigation (not abort) offers a recovery UI.
      if (errorCode === -3 /* ABORTED - expected during navigation */) return
      this.logError(`dsh-plugin-desktop: renderer failed to load (${errorCode}: ${errorDescription})`)
      void reloadOrShowCrashFallback(
        { log: (message) => this.logError(message), productName: this.productName },
        window,
      )
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url)
        if (target.protocol === 'https:' || target.protocol === 'http:' || target.protocol === 'mailto:') {
          void shell.openExternal(target.href).catch((cause: unknown) => {
            this.logError(`dsh-plugin-desktop: failed to open external link: ${cause instanceof Error ? cause.message : String(cause)}`)
          })
        }
      } catch {
        // A malformed target is rejected with the same deny result.
      }
      return { action: 'deny' }
    })

    window.once('ready-to-show', show)
    let tray: Tray | undefined
    try {
      // Upstream 0.1.2: the index token exchange clears the query string (and
      // the auth-gate login page is reached through that clean redirect), so
      // the desktop shell marker travels in a cookie set before the first
      // load — the client half reads it synchronously from document.cookie.
      await window.webContents.session.cookies.set({
        url: new URL(spec.url).origin,
        name: 'dsh-desktop-env',
        value: encodeURIComponent(`dsh-desktop-mode=advanced&dsh-desktop-platform=${this.platform}`),
      })
      await window.loadURL(spec.url)
      tray = new Tray(prepareTrayIcon(spec.trayIcons, this.platform))
      this.tray = tray
      tray.setToolTip(spec.productName)
      this.rebuildTrayMenu()
      tray.on('click', show)
      beforeInteractive?.()
    } catch (cause) {
      app.off('activate', show)
      window.off('page-title-updated', preserveBlankTitle)
      window.webContents.off('before-input-event', handleZoomShortcut)
      tray?.off('click', show)
      tray?.destroy()
      window.destroy()
      this.tray = undefined
      this.window = undefined
      throw cause
    }

    // 审计 2026-08-30 (CodeQL js/unneeded-defensive-code): 到达此处的 tray
    // 必为已成功构造的 Tray(失败会走 catch 抛出), 防御判断恒 false——删除。
    const mountedTray = tray!

    let released = false
    return async () => {
      if (released) return
      released = true
      app.off('activate', show)
      window.off('close', close)
      window.off('page-title-updated', preserveBlankTitle)
      window.webContents.off('before-input-event', handleZoomShortcut)
      window.webContents.off('will-frame-navigate', navigate)
      window.webContents.off('will-redirect', navigate)
      mountedTray.off('click', show)
      mountedTray.destroy()
      if (!window.isDestroyed()) window.destroy()
      if (this.tray === mountedTray) this.tray = undefined
      if (this.window === window) this.window = undefined
    }
  }
}

/**
 * P1-3 / P1-12: renderer crash / load-failure fallback. Reload once; if the
 * reload also fails (or the process is gone a second time), show an in-window
 * error page with a manual reload button so the user is never stuck on a
 * dead white window.
 *
 * The fallback page must NEVER auto-navigate back to the app URL: the old
 * `did-finish-load` handler reloaded the app immediately after the error page
 * rendered, so a deterministic crash looped error-page → app → crash forever
 * (the per-window flag only suppressed the *reload*, not the bounce back).
 * The button now navigates explicitly, which re-enters the normal crash path
 * (one reload, then the error page again) without a loop.
 */
const crashRetried = new WeakMap<BrowserWindow, boolean>()

/** Embed a URL in an inline `<script>`: JSON-escaped and `<` neutralized so a
 * page URL containing `</script>` cannot break out of the block. */
function inlineScriptUrl(url: string): string {
  return JSON.stringify(url).replace(/</gu, '\\u003c')
}

/** Escape text for an HTML text position (the failure page's `<title>`). */
function escapeHtmlText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

async function reloadOrShowCrashFallback(
  runtime: { log(message: string): void; productName: string },
  window: BrowserWindow,
): Promise<void> {
  if (window.isDestroyed()) return
  const retried = crashRetried.get(window) ?? false
  if (!retried) {
    crashRetried.set(window, true)
    try {
      await window.loadURL(window.webContents.getURL())
      return
    } catch {
      // fall through to the error page
    }
  }
  try {
    const current = window.webContents.getURL()
    const retryTarget = current.startsWith('http') ? current : ''
    const retryScript = retryTarget === ''
      ? ''
      : `<script>document.getElementById('retry').addEventListener('click',function(){location.href=${inlineScriptUrl(retryTarget)}})</script>`
    // 失败页是窗口标题的来源（页面 <title> 会盖掉 BrowserWindow 的 title），
    // 所以它同样必须是渠道自己的产品名。
    const errorPage = `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtmlText(runtime.productName)}</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f6f8}.card{text-align:center;max-width:420px;padding:32px}h1{font-size:18px;color:#1a1d24}p{color:#616267;font-size:14px}button{margin-top:12px;padding:8px 18px;border:1px solid #2563eb;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer}</style></head><body><div class="card"><h1>界面加载失败</h1><p>渲染进程未能正常加载。可以点击下方按钮重试；若持续失败，请从系统托盘退出后重新启动应用。</p><button id="retry"${retryTarget === '' ? ' disabled' : ''}>重新加载</button></div>${retryScript}</body></html>`)}`
    await window.loadURL(errorPage)
  } catch {
    runtime.log('dsh-plugin-desktop: crash fallback page failed to load')
  }
}
