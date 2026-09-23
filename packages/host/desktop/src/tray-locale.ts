/** Desktop-owned native tray copy for the locales shipped by DSH. */

import type { DesktopLocale, DesktopPlatform } from './runtime.ts'
import { localeIdToDesktopLocale } from './desktop-locale.ts'

export type DesktopTrayLabelKey =
  | 'checkForUpdates'
  | 'checkingForUpdates'
  | 'downloadingUpdate'
  | 'exportDiagnostics'
  | 'installUpdate'
  | 'openDesktop'
  | 'quit'
  | 'updateAvailable'
  | 'updateReady'

/**
 * 官方渠道产品名：**没有渠道包**时（本地开发）的兜底。
 *
 * 托盘/通知文案里的产品名必须走参数（渠道构建下是渠道自己的名字）——渠道客户
 * 不该在系统托盘里看到厂商名。
 */
const OFFICIAL_PRODUCT_NAME = 'PicoAide Harness'

const labels: Record<DesktopLocale, Record<DesktopTrayLabelKey, (value: string, product: string) => string>> = {
  en: {
    checkForUpdates: () => 'Check for Updates…',
    checkingForUpdates: () => 'Checking for Updates…',
    downloadingUpdate: (version, product) => `Downloading ${product} ${version}…`,
    exportDiagnostics: () => 'Export Diagnostics…',
    installUpdate: (version, product) => `Install ${product} ${version} and Restart…`,
    openDesktop: productName => `Open ${productName}`,
    quit: () => 'Quit',
    updateAvailable: (version, product) => `${product} ${version} Available`,
    updateReady: (version, product) => `${product} ${version} Ready to Install`,
  },
  zh: {
    checkForUpdates: () => '检查更新…',
    checkingForUpdates: () => '正在检查更新…',
    downloadingUpdate: (version, product) => `正在下载 ${product} ${version}…`,
    exportDiagnostics: () => '导出诊断信息…',
    installUpdate: (version, product) => `安装 ${product} ${version} 并重启…`,
    openDesktop: productName => `打开 ${productName}`,
    quit: () => '退出',
    updateAvailable: (version, product) => `${product} ${version} 可用`,
    updateReady: (version, product) => `${product} ${version} 已下载,可安装`,
  },
}

export interface DesktopDiagnosticsPrivacyCopy {
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly confirm: string
  readonly cancel: string
  /** Title of the `showErrorBox` shown when the export itself fails. */
  readonly errorTitle: string
}

const diagnosticsPrivacyCopy: Record<DesktopLocale, DesktopDiagnosticsPrivacyCopy> = {
  en: {
    title: 'Export Diagnostics',
    message: 'Review the diagnostic archive before sharing it.',
    detail: 'The archive contains recent application logs, local crash dumps, and system information. Logs may contain local paths, workspace IDs, and session IDs. Crash dumps may contain fragments of process memory. Authentication credentials are masked in logs when recognized, but you should still review the archive before uploading it publicly.',
    confirm: 'Export',
    cancel: 'Cancel',
    errorTitle: 'Unable to Export Diagnostics',
  },
  zh: {
    title: '导出诊断信息',
    message: '分享诊断包前请先检查其中的内容。',
    detail: '诊断包包含最近的应用日志、本地崩溃转储和系统信息。日志可能包含本地路径、工作区 ID 和会话 ID，崩溃转储可能包含进程内存片段。系统会对日志中可识别的认证凭据进行脱敏，但公开上传前仍应检查诊断包。',
    confirm: '导出',
    cancel: '取消',
    errorTitle: '无法导出诊断信息',
  },
}

/**
 * Resolve DSH's zh/en locale from an Electron or browser language tag.
 *
 * 判定逻辑与"上游 locale 偏好 → 桌面语言"共用一份实现（`desktop-locale.ts`）：
 * 两处各自为政正是 2026-09-16 P2-B2 的根因（界面认 `zh-CN`、托盘只认裸 `zh`）。
 * @param languageTag - Electron/browser language tag.
 * @returns the desktop locale; everything non-zh resolves to `en`.
 */
export function desktopLocaleFromLanguageTag(languageTag: string): DesktopLocale {
  return localeIdToDesktopLocale(languageTag) ?? 'en'
}

/**
 * Resolve one native tray label in the active desktop locale.
 * @param locale - active desktop locale.
 * @param key - label key.
 * @param value - version (or, for `openDesktop`, the product name).
 * @param product - resolved product name（渠道构建下即渠道名）;空值回落官方。
 */
export function desktopTrayLabel(
  locale: DesktopLocale,
  key: DesktopTrayLabelKey,
  value = '',
  product = '',
): string {
  return labels[locale][key](value, product === '' ? OFFICIAL_PRODUCT_NAME : product)
}

/** Resolve the native privacy confirmation shown before diagnostics export. */
export function desktopDiagnosticsPrivacyCopy(locale: DesktopLocale): DesktopDiagnosticsPrivacyCopy {
  return diagnosticsPrivacyCopy[locale]
}

/** Platform whose installer hand-off the "update ready" detail has to explain. */
export type DesktopUpdatePlatform = DesktopPlatform

/**
 * Copy for the two native update dialogs.
 *
 * 2026-09-16 i18n：两个对话框原先只有 Linux 的 `detail` 是硬编码中文，而同一对话框的
 * title/message/按钮恒为英文 —— 中文用户看到的是中英混排，英文用户则在 Linux 上撞到
 * 一段中文说明。整段文案（含按钮）改为随 `DesktopRuntime.locale` 走同一张表。
 */
export interface DesktopUpdateDialogCopy {
  /** Title of the "download finished, ready to install" dialog. */
  readonly readyTitle: (product: string) => string
  /** Body of the same dialog. */
  readonly readyMessage: (version: string, product: string) => string
  /** Platform-specific instruction; `product` is only read by the Windows variant. */
  readonly readyDetail: (platform: DesktopUpdatePlatform, installerPath: string, product: string) => string
  /** Title of the "installer handed to the OS" dialog (Linux only). */
  readonly downloadedTitle: (product: string) => string
  /** Body of the same dialog. */
  readonly downloadedMessage: (version: string, product: string) => string
  /** Linux AppImage replacement instruction. */
  readonly downloadedDetail: (installerPath: string) => string
  /** macOS: the disk image opened — how to finish the install. */
  readonly darwinOpenedDetail: (product: string) => string
  /** Windows: confirm restarting into the NSIS installer. */
  readonly winInstallDetail: (product: string) => string
  /** Windows: affirmative button of that dialog. */
  readonly winRestart: string
  /** Windows: negative button of that dialog. */
  readonly winLater: string
  /** Manual "check for updates" failure dialog. */
  readonly checkFailedTitle: (product: string) => string
  readonly checkFailedMessage: (product: string) => string
  readonly checkFailedDetail: string
  /** Manual check: nothing newer. */
  readonly upToDateTitle: (product: string) => string
  readonly upToDateMessage: (product: string) => string
  readonly upToDateDetail: (version: string) => string
  /** Manual check: an update exists but this build cannot download it. */
  readonly availableTitle: (product: string) => string
  readonly availableMessage: (version: string, product: string) => string
  readonly availableDetail: string
  /** Affirmative button label. */
  readonly confirm: string
}

const updateDialogCopy: Record<DesktopLocale, DesktopUpdateDialogCopy> = {
  en: {
    readyTitle: product => `${product} Update Ready`,
    readyMessage: (version, product) => `${product} ${version} is downloaded and ready to install.`,
    readyDetail: (platform, installerPath, product) => platform === 'linux'
      ? `The new AppImage has been downloaded to: ${installerPath}\n\nChoose Install Update in the app or the tray menu, then quit and replace the current AppImage with that file.`
      : platform === 'darwin'
        ? 'The disk image will open when you install. Choose Install Update in the app or the tray menu to continue.'
        : `Choose Install Update in the app or the tray menu to restart ${product} and run the installer.`,
    downloadedTitle: product => `${product} Update Downloaded`,
    downloadedMessage: (version, product) => `${product} ${version} is ready to install.`,
    downloadedDetail: installerPath =>
      `The new AppImage has been downloaded to: ${installerPath}\n\nQuit this application, replace the current AppImage with that file, then run it again.`,
    darwinOpenedDetail: product => `The disk image has opened. Replace ${product} in Applications, then reopen it.`,
    winInstallDetail: product => `Restart ${product} and run the installer now?`,
    winRestart: 'Restart and Install',
    winLater: 'Later',
    checkFailedTitle: () => 'Unable to Check for Updates',
    checkFailedMessage: product => `${product} could not check for updates.`,
    checkFailedDetail: 'Please try again later.',
    upToDateTitle: product => `${product} Is Up to Date`,
    upToDateMessage: product => `No newer version of ${product} is available.`,
    upToDateDetail: version => `Installed version: ${version}`,
    availableTitle: product => `${product} Update Available`,
    availableMessage: (version, product) => `${product} ${version} is available.`,
    availableDetail: 'Installer downloads are unavailable in this build.',
    confirm: 'OK',
  },
  zh: {
    readyTitle: product => `${product} 更新已就绪`,
    readyMessage: (version, product) => `${product} ${version} 已下载完成，可以安装。`,
    readyDetail: (platform, installerPath, product) => platform === 'linux'
      ? `新版本 AppImage 已下载到: ${installerPath}\n\n在界面或托盘里点「安装更新」后,关闭本程序并用该文件替换当前 AppImage。`
      : platform === 'darwin'
        ? '安装时会打开磁盘映像。请在应用内或托盘菜单中选择「安装更新」继续。'
        : `请在应用内或托盘菜单中选择「安装更新」，以重启 ${product} 并运行安装程序。`,
    downloadedTitle: product => `${product} 更新已下载`,
    downloadedMessage: (version, product) => `${product} ${version} 已可安装。`,
    downloadedDetail: installerPath =>
      `新版本 AppImage 已下载到: ${installerPath}\n\n请关闭本程序, 用该文件替换当前 AppImage 后重新运行。`,
    darwinOpenedDetail: product => `磁盘映像已打开。请用新版本替换「应用程序」里的 ${product}，然后重新打开。`,
    winInstallDetail: product => `现在重启 ${product} 并运行安装程序吗？`,
    winRestart: '重启并安装',
    winLater: '稍后',
    checkFailedTitle: () => '无法检查更新',
    checkFailedMessage: product => `${product} 无法检查更新。`,
    checkFailedDetail: '请稍后重试。',
    upToDateTitle: product => `${product} 已是最新版本`,
    upToDateMessage: product => `没有比 ${product} 更新的版本。`,
    upToDateDetail: version => `当前版本：${version}`,
    availableTitle: product => `${product} 有可用更新`,
    availableMessage: (version, product) => `${product} ${version} 已可用。`,
    availableDetail: '此构建不提供安装包下载。',
    confirm: '确定',
  },
}

/** Resolve the copy for the native update dialogs. */
export function desktopUpdateDialogCopy(locale: DesktopLocale): DesktopUpdateDialogCopy {
  return updateDialogCopy[locale]
}

/**
 * Copy for the remaining user-visible native surfaces (2026-09-16 R9 audit).
 *
 * The i18n pass localized the update flow and the crash page but left the plugin
 * recovery dialog and the two startup notifications hard-coded English, even
 * though the tray entries that lead to them are localized.
 */
export interface DesktopStartupCopy {
  /** Plugin-recovery dialog (a client plugin failed to load). */
  readonly pluginRecoveryTitle: string
  readonly pluginRecoveryMessage: (product: string) => string
  readonly pluginRecoveryDetail: (plugins: string, error: string, product: string) => string
  readonly pluginRecoveryRestart: (product: string) => string
  readonly pluginRecoveryDismiss: string
  /**
   * `pluginRecoveryDetail` 的两段兜底文案（2026-09-17 S05-3 审计）。
   *
   * 这两句此前以**三元分支的字面量**形式留在 electron-runtime 里：本地化扫描
   * 只看对象属性的写法，看不到分支里的英文，于是中文用户拿到的是
   * 「加载失败的插件: Unknown client plugin / The client Loader did not
   * provide an error message.」这种中英混排详情 —— 与同一次本地化修的正是
   * 同一个弹窗。兜底句必须和模板同源，否则下次仍会漏。
   */
  readonly unknownPlugin: string
  readonly loaderErrorMissing: string
  /** Notification: an optional UI plugin of the profile is not installed. */
  readonly skippedPluginTitle: string
  readonly skippedPluginBody: (name: string, suffix: string) => string
  /** Notification: a configured path sits on a volume that may break sandboxing. */
  readonly volumeTitle: string
  readonly volumeBody: (label: string) => string
  /**
   * 致命启动失败的原生错误面（B-02，2026-09-23 审计）。
   *
   * 这一段必须存在且被真正调用：`startup-rows.ts` 的模块注释一直自称致命路径会弹
   * "恢复对话框"，而实现里只有 `errorCause` + 退出 —— 打包 GUI 上等于双击没反应。
   */
  readonly fatalBootTitle: (product: string) => string
  readonly fatalBootMessage: (product: string) => string
  readonly fatalBootDetail: (reason: string, logDirectory: string) => string
  readonly fatalBootOpenLogs: string
  readonly fatalBootRetry: string
  readonly fatalBootQuit: string
}

const startupCopy: Record<DesktopLocale, DesktopStartupCopy> = {
  en: {
    pluginRecoveryTitle: 'Plugin Recovery',
    pluginRecoveryMessage: product => `${product} could not load all plugins.`,
    pluginRecoveryDetail: (plugins, error, product) =>
      `Failed plugins:\n${plugins}\n\n${error}\n\nRestart ${product} after resolving the failing plugin.`,
    pluginRecoveryRestart: product => `Restart ${product}`,
    pluginRecoveryDismiss: 'Dismiss',
    unknownPlugin: 'Unknown client plugin',
    loaderErrorMissing: 'The client Loader did not provide an error message.',
    skippedPluginTitle: 'Skipped Unavailable UI Plugin',
    skippedPluginBody: (name, suffix) => `${name} is not installed in this profile${suffix}.`,
    volumeTitle: 'Storage May Be Unsupported',
    volumeBody: label => `${label} is on a volume that may break sandboxed commands or plugin installs.`,
    fatalBootTitle: product => `${product} could not start`,
    fatalBootMessage: product => `${product} failed to start and was closed.`,
    fatalBootDetail: (reason, logDirectory) =>
      `${reason}\n\nLogs: ${logDirectory}\n\n`
      + 'Open the log folder to see the full error, then choose Retry. If it keeps failing, quit and report the log.',
    fatalBootOpenLogs: 'Open Logs',
    fatalBootRetry: 'Retry',
    fatalBootQuit: 'Quit',
  },
  zh: {
    pluginRecoveryTitle: '插件恢复',
    pluginRecoveryMessage: product => `${product} 未能加载全部插件。`,
    pluginRecoveryDetail: (plugins, error, product) =>
      `加载失败的插件:\n${plugins}\n\n${error}\n\n请先处理失败的插件，然后重启 ${product}。`,
    pluginRecoveryRestart: product => `重启 ${product}`,
    pluginRecoveryDismiss: '忽略',
    unknownPlugin: '未知客户端插件',
    loaderErrorMissing: '客户端 Loader 未提供错误信息。',
    skippedPluginTitle: '已跳过不可用的界面插件',
    // suffix 以「 等 N 个」开头，必须插在动词前（插在句尾会变成
    // 「foo 未安装在此配置中 等 2 个。」—— 2026-09-16 R2 审计）。
    skippedPluginBody: (name, suffix) => `${name}${suffix}未安装在此配置中。`,
    volumeTitle: '存储位置可能不受支持',
    volumeBody: label => `${label} 所在的卷可能导致沙箱命令或插件安装失败。`,
    fatalBootTitle: product => `${product} 无法启动`,
    fatalBootMessage: product => `${product} 启动失败，已关闭。`,
    fatalBootDetail: (reason, logDirectory) =>
      `${reason}\n\n日志目录：${logDirectory}\n\n`
      + '可点「打开日志」查看完整错误，处理后点「重试」；若持续失败请退出并把日志反馈给我们。',
    fatalBootOpenLogs: '打开日志',
    fatalBootRetry: '重试',
    fatalBootQuit: '退出',
  },
}

/** Resolve the copy for the remaining native surfaces. */
export function desktopStartupCopy(locale: DesktopLocale): DesktopStartupCopy {
  return startupCopy[locale]
}

/**
 * Copy for the renderer crash-fallback page.
 *
 * The page carries its own inline `<style>` and is loaded as a `data:` URL, so
 * it cannot reach the client dictionaries; its copy lives here with the rest of
 * the desktop-owned native strings.
 */
export interface DesktopCrashPageCopy {
  /** `<html lang>` for the page. */
  readonly lang: string
  /** Page heading. */
  readonly heading: string
  /** Explanation under the heading. */
  readonly body: string
  /** Retry button label. */
  readonly retry: string
}

const crashPageCopy: Record<DesktopLocale, DesktopCrashPageCopy> = {
  en: {
    lang: 'en',
    heading: 'Failed to load the interface',
    body: 'The renderer process could not load. Use the button below to retry; if it keeps failing, quit from the system tray and start the application again.',
    retry: 'Reload',
  },
  zh: {
    lang: 'zh-CN',
    heading: '界面加载失败',
    body: '渲染进程未能正常加载。可以点击下方按钮重试；若持续失败，请从系统托盘退出后重新启动应用。',
    retry: '重新加载',
  },
}

/** Resolve the copy for the renderer crash-fallback page. */
export function desktopCrashPageCopy(locale: DesktopLocale): DesktopCrashPageCopy {
  return crashPageCopy[locale]
}
