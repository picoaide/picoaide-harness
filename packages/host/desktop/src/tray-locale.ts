/** Desktop-owned native tray copy for the locales shipped by DSH. */

import type { DesktopLocale } from './runtime.ts'

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

/** Resolve DSH's zh/en locale from an Electron or browser language tag. */
export function desktopLocaleFromLanguageTag(languageTag: string): DesktopLocale {
  return /^zh(?:[-_]|$)/i.test(languageTag) ? 'zh' : 'en'
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
