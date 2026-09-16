/**
 * Desktop client UI copy: zh is the key source, en mirrors the full key set
 * (the same pattern as the dsh-connectors / dsh-cron / dsh-enterprise locales).
 *
 * Scope: the desktop-owned client surfaces. Today that is the update badge and
 * its hover text — the other desktop client rows (advanced frame, loop-notify
 * bridge) render no copy of their own.
 *
 * 2026-09-16 i18n：更新徽标此前是**中英混排**——`label` 硬编码中文（`安装 2.7.5`）
 * 而同一对象的 `title` 是英文，所以任何语言下都有一半是错的。整组文案改为走字典。
 */
export const zh = {
  /** 徽标按钮文字：安装包已就绪时显示。 */
  'update.install': '安装 {version}',
  /** 徽标悬停：已下载，可安装。 */
  'update.installTitle': '版本 {version} 已下载 — 点击安装',
  /** 徽标悬停：正在下载。 */
  'update.downloadingTitle': '正在下载 {version}…',
  /** 徽标悬停：有新版本，点击检查。 */
  'update.availableTitle': '版本 {version} 可用 — 点击检查',
  /** 徽标悬停：重试等待中（第 N 次，倒计时）。 */
  'update.retryingIn': '正在重试下载（第 {attempt} 次），{seconds} 秒后继续…',
  /** 徽标悬停：正在下载（第 N 次）。 */
  'update.retryingNow': '正在下载（第 {attempt} 次）…',
}

export const en: Record<keyof typeof zh, string> = {
  'update.install': 'Install {version}',
  'update.installTitle': 'Version {version} is downloaded — click to install',
  'update.downloadingTitle': 'Downloading {version}…',
  'update.availableTitle': 'Version {version} available — click to check',
  'update.retryingIn': 'Retrying download (attempt {attempt}) in {seconds}s…',
  'update.retryingNow': 'Downloading (attempt {attempt})…',
}

export type DesktopClientKey = keyof typeof zh

/** Active UI locale, kept in sync by the client plugin from ctx.locale. */
let activeLocale: 'zh' | 'en' = 'zh'
/** Adopt the active locale (called by the client plugin; unknown ids fall back to Chinese). */
export function setActiveLocale(id: string): void {
  activeLocale = id.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** Translate a key (zh key source; en mirrors the full key set). */
export function t(key: DesktopClientKey, params?: Record<string, string>): string {
  let text: string = (activeLocale === 'en' ? en[key] : zh[key]) as string
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, value)
    }
  }
  return text
}
