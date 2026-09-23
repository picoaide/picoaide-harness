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
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  shell,
  systemPreferences,
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
  DesktopUpdateTransferBudget,
  UpdateDownloadProgressSnapshot,
} from './runtime.ts'
import type { RendererBootReport } from './renderer-boot-contract.ts'
import { parseDesktopDeepLink } from './deep-link.ts'
import { DEFAULT_DEEP_LINK_SCHEME } from './desktop-channel.ts'
import { formatDesktopExitCode, type DesktopLogger } from './desktop-logger.ts'
import { exportDesktopDiagnostics } from './diagnostic-export.ts'
import { prepareTrayIcon } from './tray-icons.ts'
import {
  desktopCrashPageCopy,
  desktopDiagnosticsPrivacyCopy,
  desktopLocaleFromLanguageTag,
  desktopStartupCopy,
  desktopTrayLabel,
  desktopUpdateDialogCopy,
} from './tray-locale.ts'
import { downloadDesktopUpdate } from './update-download.ts'
import type { UpdateCheckResult } from './update-checker.ts'
import { desktopWindowOptions } from './window-options.ts'
import {
  installRendererErrorCapture,
  reportRendererError,
  setRendererErrorSink,
  type RendererErrorSink,
} from './renderer-error-capture.ts'

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
 *
 * `worker-src` 必须显式放行 `blob:`（2026-09-12 打包版真机复现）：上游 0.1.5 的
 * 附件上传（`@deepseek-ai/dsh-client-file-upload`）在生产路径上只用 **Blob-URL
 * Worker** 传输（`runtime.ts:169-171/249-256`），右栏 PDF 预览同样 `new Worker(blob:…)`。
 * CSP3 的 worker 回退链是 worker-src → child-src → script-src → default-src：
 * `script-src` 一旦声明，`default-src` 里的 `blob:` 就永远轮不到 —— 控制台原文
 * `Creating a worker from 'blob:…' violates … "script-src 'self' 'unsafe-inline'
 * 'unsafe-eval'"; Note that 'worker-src' was not explicitly set, so 'script-src'
 * is used as a fallback`，症状是「图片能发、PDF/zip/txt 附件必失败」。
 * 放行的是 worker **来源**，不放开脚本求值面（`script-src` 未动）。
 */
export const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'self' data: blob: ws:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "worker-src 'self' blob:",
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
    get userDataPath() { return app.getPath('userData') },
    get statePath() { return join(app.getPath('userData'), 'updates', 'state.json') },
    request: (url, init) => net.fetch(url, init),
    showManualCheckResult: result => this.showManualUpdateCheckResult(result),
    downloadUpdate: (version, source, signal, onProgress, budget) =>
      this.downloadUpdate(version, source, signal, onProgress, budget),
    announceUpdateReady: (version, path) => this.announceUpdateReady(version, path),
    installUpdate: (version, path) => this.installUpdate(version, path),
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
  /** Renderer error IPC listener disposer (installed once, at first window mount). */
  private disposeRendererErrorCapture: (() => void) | undefined

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
     * **必须显式传**：渠道客户端的 scheme 是客户自己的（如 `acmeai`），
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

  /**
   * macOS 标题栏双击：按**系统偏好**缩放或最小化窗口。
   *
   * 为什么应用要自己做（2026-09-16 用户报"左边无法双击扩大或缩小窗口"）：
   * 我们用 `titleBarStyle: 'hiddenInset'` + 自绘的 `-webkit-app-region: drag` 拖拽条，
   * 而 Electron **不会**为自定义拖拽区补原生双击行为（electron#16385，维护者给的
   * 结论就是"应用自己实现"，官方 recipe 即下面这套 `AppleActionOnDoubleClick`）。
   * 系统偏好有三个取值（系统设置 → 桌面与程序坞 → 双击窗口的标题栏以）：
   * `Maximize`（缩放，默认）/ `Minimize` / `None`；读不到时按默认的缩放走。
   */
  performTitleBarDoubleClick(): void {
    if (this.platform !== 'darwin') return
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    // 全屏时系统自己接管双击，别在这里再切一次状态。
    if (window.isFullScreen()) return
    let action = 'Maximize'
    try {
      action = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string')
    } catch {
      // 读不到偏好（老系统/受限环境）⇒ 保持系统默认语义：缩放。
    }
    if (action === 'None') return
    if (action === 'Minimize') {
      window.minimize()
      return
    }
    // 'Maximize' 与任何未知取值：切换"缩放"状态（不是全屏）。
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
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
  setRendererErrorSink(sink: RendererErrorSink): () => void {
    return setRendererErrorSink(sink)
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
    // 产品名取自 profile 组装配置（渠道构建下即渠道自己的名字）—— 失败弹窗
    // 是渠道客户最可能看到的"厂商品牌露出"位置之一。
    const product = this.productName
    const copy = desktopStartupCopy(this.currentLocale)
    // 兜底句也必须走 copy（2026-09-17 S05-3 审计）：这里曾硬编码英文，中文
    // 界面的详情因此中英混排（localize 扫描看不到三元分支里的字面量）。
    const plugins = report.plugins.length === 0
      ? copy.unknownPlugin
      : report.plugins.map(plugin => `- ${plugin}`).join('\n')
    const error = report.error === undefined ? copy.loaderErrorMissing : report.error
    const result = await dialog.showMessageBox({
      type: 'error',
      title: copy.pluginRecoveryTitle,
      message: copy.pluginRecoveryMessage(product),
      detail: copy.pluginRecoveryDetail(plugins, error, product),
      buttons: [copy.pluginRecoveryRestart(product), copy.pluginRecoveryDismiss],
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

  /** Report one user-triggered check without exposing network or response details. */
  private async showManualUpdateCheckResult(result: UpdateCheckResult | null): Promise<void> {
    // 这一组对话框由托盘里已本地化的「检查更新…」触发，整段文案（含按钮）跟着
    // 当前语言走（2026-09-16 R9 审计：此前恒英文）。
    const copy = desktopUpdateDialogCopy(this.currentLocale)
    if (result === null) {
      await dialog.showMessageBox({
        type: 'warning',
        title: copy.checkFailedTitle(this.productName),
        message: copy.checkFailedMessage(this.productName),
        detail: copy.checkFailedDetail,
        buttons: [copy.confirm],
        defaultId: 0,
        noLink: true,
      })
      return
    }

    if (result.status === 'up-to-date') {
      await dialog.showMessageBox({
        type: 'info',
        title: copy.upToDateTitle(this.productName),
        message: copy.upToDateMessage(this.productName),
        detail: copy.upToDateDetail(result.currentVersion),
        buttons: [copy.confirm],
        defaultId: 0,
        noLink: true,
      })
      return
    }

    await dialog.showMessageBox({
      type: 'info',
      title: copy.availableTitle(this.productName),
      message: copy.availableMessage(result.latestVersion, this.productName),
      detail: copy.availableDetail,
      buttons: [copy.confirm],
      defaultId: 0,
      noLink: true,
    })
  }

  /**
   * Download one available installer into private storage and stop there.
   *
   * 后台静默下载走的就是这条路径:它不弹任何对话框、不打开任何东西,因此下载
   * 不会打断用户;失败与重试由协调器负责(重试时续传)。
   * @param version - canonical version the downloaded installer must match.
   * @param source - update source (manifest URL + server-declared channel).
   * @param signal - caller-owned cancellation.
   * @param onProgress - optional byte-progress callback while streaming.
   * @returns absolute path of the completed, verified installer.
   */
  private async downloadUpdate(
    version: string,
    source: DesktopUpdateSource,
    signal: AbortSignal,
    onProgress?: (progress: UpdateDownloadProgressSnapshot) => void,
    budget?: DesktopUpdateTransferBudget,
  ): Promise<string> {
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
      // B-08:停滞/总预算由更新插件按设置下发;缺省时下载器用自己的常量。
      ...(budget === undefined ? {} : { stallTimeoutMs: budget.stallTimeoutMs, totalTimeoutMs: budget.totalTimeoutMs }),
    })
    signal.throwIfAborted()
    if (this.platform === 'linux') {
      // AppImage 无静默自安装:先给出可执行位,安装提示里让用户直接替换。
      try { await chmod(artifactPath, 0o755) } catch { /* 非致命:安装路径仍可用 */ }
    }
    return artifactPath
  }

  /**
   * Tell the user once that a version finished downloading.
   *
   * 只通报"已下载好、可以装了",不安装、不退出:后台下载因此永远不会在用户
   * 不知情时重启应用;真正的安装动作由用户在界面/托盘里点出来。
   * @param version - canonical version whose installer is ready.
   * @param installerPath - absolute path of the verified installer.
   */
  private async announceUpdateReady(version: string, installerPath: string): Promise<void> {
    // 整段文案（含按钮）随当前语言走:此前只有 Linux 的 detail 是中文,而同一
    // 对话框的 title/message/按钮恒为英文(2026-09-16 i18n)。
    const copy = desktopUpdateDialogCopy(this.currentLocale)
    await dialog.showMessageBox({
      type: 'info',
      title: copy.readyTitle(this.productName),
      message: copy.readyMessage(version, this.productName),
      detail: copy.readyDetail(this.platform, installerPath, this.productName),
      buttons: [copy.confirm],
      defaultId: 0,
      noLink: true,
    })
  }

  /**
   * Hand an already-downloaded installer to the platform installation flow.
   *
   * Windows 启动下载好的 NSIS 安装包并退出;macOS 打开 DMG 让用户拖进
   * Applications;Linux 只能提示用户手动替换 AppImage。
   * @param version - canonical version being installed.
   * @param installerPath - absolute path of the verified installer.
   */
  private async installUpdate(version: string, installerPath: string): Promise<void> {
    if (this.platform === 'linux') {
      const copy = desktopUpdateDialogCopy(this.currentLocale)
      await dialog.showMessageBox({
        type: 'info',
        title: copy.downloadedTitle(this.productName),
        message: copy.downloadedMessage(version, this.productName),
        detail: copy.downloadedDetail(installerPath),
        buttons: [copy.confirm],
        defaultId: 0,
        noLink: true,
      })
      return
    }

    if (this.platform === 'darwin') {
      const copy = desktopUpdateDialogCopy(this.currentLocale)
      const openError = await shell.openPath(installerPath)
      if (openError !== '') throw new Error(`dsh-plugin-desktop: failed to open update disk image: ${openError}`)
      await dialog.showMessageBox({
        type: 'info',
        title: copy.downloadedTitle(this.productName),
        message: copy.downloadedMessage(version, this.productName),
        detail: copy.darwinOpenedDetail(this.productName),
        buttons: [copy.confirm],
        defaultId: 0,
        noLink: true,
      })
      return
    }

    const copy = desktopUpdateDialogCopy(this.currentLocale)
    const result = await dialog.showMessageBox({
      type: 'info',
      title: copy.downloadedTitle(this.productName),
      message: copy.downloadedMessage(version, this.productName),
      detail: copy.winInstallDetail(this.productName),
      buttons: [copy.winRestart, copy.winLater],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (result.response !== 0) return

    const spec = this.scheduled
    if (spec === undefined) throw new Error('dsh-plugin-desktop: no active shell can exit for update installation')
    await this.launchWindowsUpdateInstaller(installerPath)
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
      // User-visible native surface: same table as the privacy confirmation
      // (2026-09-16 R2 audit — this one was still hard-coded English).
      dialog.showErrorBox(desktopDiagnosticsPrivacyCopy(this.currentLocale).errorTitle, error.message)
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
    // P0-6/D8:渲染进程错误通道的监听在**创建窗口之前**装好,避免窗口刚起来
    // 就抛错而通道还没就绪(preload 是同步执行的,窗口一 mount 就可能发)。
    // 幂等:重复 mount(重启/多代 shell)只装一次。
    if (this.disposeRendererErrorCapture === undefined) {
      this.disposeRendererErrorCapture = installRendererErrorCapture(ipcMain)
    }
    // 发布版关掉 DevTools（`app.isPackaged` 为准，开发态保持可用）——
    // e2e/探针走 `--remote-debugging-port` 的 Chromium CDP，不依赖它。
    const window = new BrowserWindow(desktopWindowOptions(spec, icon, this.platform, app.isPackaged))
    // P1-4: deny every renderer permission request by default. Electron
    // auto-grants camera/mic/geolocation etc. when no handler is set, which
    // an untrusted web surface must never receive. The embedded browser
    // (dsh-browser) manages its own partition and permission policy.
    //
    // 例外（2026-09-14 现场 P0，两轮才修对）：**本应用自己的文档**需要剪贴板权限，
    // 聊天区所有「复制」按钮（消息操作栏、代码块、diff、终端输出、JSON 树）都走
    // `navigator.clipboard.writeText`。
    //
    // Electron 43 对**同一句 writeText** 按调用路径报**两个不同的权限名**
    // （最小探针 temp/perm-probe/main4.cjs 实测）：
    //   · 脚本 / 自动化调用（无用户手势）→ `clipboard-read`
    //   · 用户真按在按钮上（有用户手势）  → `clipboard-sanitized-write`
    // 第一版只放行了 `clipboard-read`：结果"探针绿、真人点不动"——CDP/脚本写入
    // 成功，用户点复制仍被判 `NotAllowedError: Write permission denied`（2026-09-14
    // 真机端到端复现，temp/real-e2e-probe.mjs 的插桩日志逐字抓到）。两个权限名
    // 必须都放行。
    //
    // 放行范围仍严格限定为**本安装回环源的顶层文档**（request 通道读
    // details.requestingUrl，check 通道实测为空、读 details.embeddingOrigin，
    // 两者 isMainFrame 必须为 true）；其余权限、其它来源与内嵌浏览器分区维持拒绝。
    const APP_CLIPBOARD_PERMISSIONS: ReadonlySet<string> = new Set([
      'clipboard-read',
      'clipboard-sanitized-write',
    ])
    const isAppDocument = (url: unknown): boolean => {
      if (typeof url !== 'string' || url.length === 0) return false
      try {
        return new URL(url).origin === origin
      } catch {
        return false
      }
    }
    const clipboardForAppUi = (details: { isMainFrame?: boolean, requestingUrl?: string, embeddingOrigin?: string } | undefined): boolean => {
      if (details?.isMainFrame !== true) return false
      // 请求路径给 requestingUrl；检查路径给 embeddingOrigin（实测 requestingUrl 为空）。
      const candidate = typeof details.requestingUrl === 'string' && details.requestingUrl.length > 0
        ? details.requestingUrl
        : details.embeddingOrigin
      return isAppDocument(candidate)
    }
    window.webContents.session.setPermissionRequestHandler((_wc, permission, callback, details) => {
      callback(APP_CLIPBOARD_PERMISSIONS.has(permission) && clipboardForAppUi(details))
    })
    window.webContents.session.setPermissionCheckHandler((_wc, permission, _origin, details) =>
      APP_CLIPBOARD_PERMISSIONS.has(permission) && clipboardForAppUi(details))
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
      // P0-6/D8:渲染进程崩溃也要进错误上报(reason/exitCode 作为 tag)。
      // 无 sink(未登录/未启用上报/无头组合)时静默丢弃。
      reportRendererError({ type: 'render-process-gone', reason: details.reason, exitCode: details.exitCode })
      // P1-3: a crashed renderer must not leave a dead white window. Retry
      // the load once; if the reload also fails, show a native error surface
      // with a manual reload entry instead of silently logging.
      if (details.reason !== 'clean-exit' && details.reason !== 'killed') {
        void reloadOrShowCrashFallback(
          { log: (message) => this.logError(message), productName: this.productName, locale: this.currentLocale },
          window,
        )
      }
    })
    // B-01（2026-09-23 审计 P1，真机 Electron 44.4.3 复现）：**子框架**加载失败
    // 也会派发 `did-fail-load`，而第 5 参 `isMainFrame` 才是"顶层文档"的判据
    // （`electron.d.ts` 的签名是 `(event, errorCode, errorDescription,
    // validatedURL, isMainFrame, frameProcessId, frameRoutingId)`）。
    //
    // 不区分框架的后果（探针 `probe-did-fail-load-subframe.cjs` 实测
    // `did-fail-load code=-312 … isMainFrame=false`）：一次 iframe 失败就让**整个
    // 界面**重新加载（丢掉草稿/视图状态），第二次把界面换成崩溃回退页 ——
    // 触发面真实存在（右栏 HTML 预览就是 `<iframe src=blob:…>`）。
    // 因此子框架失败只记一行日志（带 validatedURL 供排障），绝不进恢复路径。
    //
    // 第 5 参做防御性判空：只认严格 `true` 才走恢复 —— 旧/新 Electron 少给参数时
    // 宁可少一次自动恢复（用户仍可从托盘重开），也不能让 iframe 掀掉整窗。
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      const target = typeof validatedURL === 'string' ? validatedURL : ''
      if (isMainFrame !== true) {
        this.logError(
          `dsh-plugin-desktop: subframe failed to load (${errorCode}: ${errorDescription}) ${target}`,
        )
        return
      }
      // P1-3: a failed main-frame navigation (not abort) offers a recovery UI.
      if (errorCode === -3 /* ABORTED - expected during navigation */) return
      this.logError(
        `dsh-plugin-desktop: renderer failed to load (${errorCode}: ${errorDescription}) ${target}`,
      )
      void reloadOrShowCrashFallback(
        { log: (message) => this.logError(message), productName: this.productName, locale: this.currentLocale },
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
 *
 * B-03（2026-09-23 审计 P1）：`render-process-gone` 与 `did-fail-load` **共用一个
 * 一次性的"重试一次"闩锁，而且不串行**。渲染进程崩溃时 Electron 会**同时**派发
 * 两个事件（进程级 + 导航级），于是两次 `loadURL` 并发：错误页与 reload 谁后完成
 * 谁说了算，用户可能看到"reload 成功了却出现错误页"，而且闩锁被提前耗尽，
 * 下一次真实崩溃直接进错误页（探针实测两次导航并发）。
 *
 * 现在的形态是**单飞 + 状态机**（每个窗口一份）：
 *   `idle` --事件--> `retrying` --成功--> `reloaded`（重试额度用掉，之后只显示错误页）
 *                                 \--失败--> `failed`  （之后只显示错误页）
 * 任何在 `retrying` 期间到达的事件**加入同一个 Promise**，不再发起第二次导航。
 * "至多重试一次、之后只显示错误页"因此是构造上成立的，而不是靠时序侥幸。
 */
export type CrashRecoveryPhase = 'idle' | 'retrying' | 'reloaded' | 'failed'

/** One window's crash-recovery bookkeeping. */
interface CrashRecoveryState {
  /** Where the window's one-shot recovery stands. */
  phase: CrashRecoveryPhase
  /** Recovery currently running: concurrent events join it instead of navigating. */
  pending: Promise<void> | undefined
}

const crashRecoveryStates = new WeakMap<BrowserWindow, CrashRecoveryState>()

/** Read (or create) one window's recovery state. */
function crashRecoveryState(window: BrowserWindow): CrashRecoveryState {
  let state = crashRecoveryStates.get(window)
  if (state === undefined) {
    state = { phase: 'idle', pending: undefined }
    crashRecoveryStates.set(window, state)
  }
  return state
}

/** Embed a URL in an inline `<script>`: JSON-escaped and `<` neutralized so a
 * page URL containing `</script>` cannot break out of the block. */
function inlineScriptUrl(url: string): string {
  return JSON.stringify(url).replace(/</gu, '\\u003c')
}

/** Escape text for an HTML text position (the failure page's `<title>`). */
function escapeHtmlText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

/**
 * Serialize renderer recovery for one window (B-03).
 *
 * 两个事件源（`render-process-gone` / `did-fail-load`）只能经这一个入口：
 * 第一个事件发起恢复，其余事件**加入同一个 Promise**。恢复结束后 `phase` 不是
 * `idle`，后续事件一律只走错误页。
 * @param runtime - logging + localized copy surface.
 * @param window - window whose renderer failed.
 * @returns a promise settling when this recovery round finished.
 */
function reloadOrShowCrashFallback(
  runtime: { log(message: string): void; productName: string; locale: DesktopLocale },
  window: BrowserWindow,
): Promise<void> {
  if (window.isDestroyed()) return Promise.resolve()
  const state = crashRecoveryState(window)
  if (state.pending !== undefined) {
    runtime.log('dsh-plugin-desktop: renderer recovery already in flight; joining it instead of navigating again')
    return state.pending
  }
  const settled = recoverRenderer(runtime, window, state)
  state.pending = settled
  return settled
}

/** 本轮导航已经定下（reload 成功 / 错误页已发出）⇒ 解除单飞。 */
function releaseCrashRecovery(state: CrashRecoveryState): void {
  state.pending = undefined
}

/** One recovery round: the single automatic reload, then the error page. */
async function recoverRenderer(
  runtime: { log(message: string): void; productName: string; locale: DesktopLocale },
  window: BrowserWindow,
  state: CrashRecoveryState,
): Promise<void> {
  if (window.isDestroyed()) return
  if (state.phase === 'idle') {
    state.phase = 'retrying'
    // The retry target is captured **before** the reload: a concurrent event that
    // joins this round must not retarget the navigation.
    const retryTarget = currentAppURL(window)
    if (retryTarget !== '') {
      try {
        await window.loadURL(retryTarget)
        state.phase = 'reloaded'
        // 同步解除单飞（不放在 `Promise.finally` 里）：`finally` 会晚一个微任务，
        // 而"reload 已完成、下一个事件才到达"必须算**新的一轮**（重试额度已用尽
        // ⇒ 直接错误页），不能被上一轮的单飞吞掉。
        releaseCrashRecovery(state)
        return
      } catch {
        runtime.log('dsh-plugin-desktop: the automatic reload after a renderer failure did not complete')
      }
    }
    state.phase = 'failed'
  }
  try {
    await showCrashFallbackPage(runtime, window)
  } finally {
    releaseCrashRecovery(state)
  }
}

/** Current `http(s)` document URL, or `''` when the window has none. */
function currentAppURL(window: BrowserWindow): string {
  if (window.isDestroyed()) return ''
  const current = window.webContents.getURL()
  return current.startsWith('http') ? current : ''
}

/** Load the in-window failure page with an explicit retry button. */
async function showCrashFallbackPage(
  runtime: { log(message: string): void; productName: string; locale: DesktopLocale },
  window: BrowserWindow,
): Promise<void> {
  if (window.isDestroyed()) return
  try {
    const retryTarget = currentAppURL(window)
    const retryScript = retryTarget === ''
      ? ''
      : `<script>document.getElementById('retry').addEventListener('click',function(){location.href=${inlineScriptUrl(retryTarget)}})</script>`
    // 失败页是窗口标题的来源（页面 <title> 会盖掉 BrowserWindow 的 title），
    // 所以它同样必须是渠道自己的产品名。
    //
    // 颜色：这是 `data:text/html` **独立文档**，拿不到客户端的设计 token，所以用
    // 写死色 + `prefers-color-scheme`（桌面壳设了 `nativeTheme.themeSource`，
    // 该媒体查询会跟随应用内的主题选择，而不是只看系统）。2026-09-16 暗色审计：
    // 原先只有亮色一套，暗色主题下会闪一整页刺眼白。
    // 文案随当前语言走（2026-09-16 i18n）：这是 `data:text/html` 独立文档，
    // 拿不到客户端字典，所以与托盘/对话框文案同源放在 `tray-locale.ts`。
    const copy = desktopCrashPageCopy(runtime.locale)
    const errorPage = `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html><html lang="${copy.lang}"><head><meta charset="utf-8"><title>${escapeHtmlText(runtime.productName)}</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f6f8;color-scheme:light dark}.card{text-align:center;max-width:420px;padding:32px}h1{font-size:18px;color:#1a1d24}p{color:#616267;font-size:14px}button{margin-top:12px;padding:8px 18px;border:1px solid #2563eb;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer}@media (prefers-color-scheme: dark){body{background:#151517}h1{color:#f9fafb}p{color:#9ca3af}}</style></head><body><div class="card"><h1>${escapeHtmlText(copy.heading)}</h1><p>${escapeHtmlText(copy.body)}</p><button id="retry"${retryTarget === '' ? ' disabled' : ''}>${escapeHtmlText(copy.retry)}</button></div>${retryScript}</body></html>`)}`
    await window.loadURL(errorPage)
  } catch {
    runtime.log('dsh-plugin-desktop: crash fallback page failed to load')
  }
}
