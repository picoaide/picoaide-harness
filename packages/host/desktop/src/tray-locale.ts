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
}

const diagnosticsPrivacyCopy: Record<DesktopLocale, DesktopDiagnosticsPrivacyCopy> = {
  en: {
    title: 'Export Diagnostics',
    message: 'Review the diagnostic archive before sharing it.',
    detail: 'The archive contains recent application logs, local crash dumps, and system information. Logs may contain local paths, workspace IDs, and session IDs. Crash dumps may contain fragments of process memory. Authentication credentials are masked in logs when recognized, but you should still review the archive before uploading it publicly.',
    confirm: 'Export',
    cancel: 'Cancel',
  },
  zh: {
    title: '导出诊断信息',
    message: '分享诊断包前请先检查其中的内容。',
    detail: '诊断包包含最近的应用日志、本地崩溃转储和系统信息。日志可能包含本地路径、工作区 ID 和会话 ID，崩溃转储可能包含进程内存片段。系统会对日志中可识别的认证凭据进行脱敏，但公开上传前仍应检查诊断包。',
    confirm: '导出',
    cancel: '取消',
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
    confirm: '确定',
  },
}

/** Resolve the copy for the native update dialogs. */
export function desktopUpdateDialogCopy(locale: DesktopLocale): DesktopUpdateDialogCopy {
  return updateDialogCopy[locale]
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
