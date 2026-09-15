/**
 * Browser client UI copy: zh is the key source, en mirrors the full key set.
 */
export const zh = {
  'panel.title': '浏览器',
}

export const en: Record<keyof typeof zh, string> = {
  'panel.title': 'Browser',
}

export type BrowserKey = keyof typeof zh

/** Active UI locale, kept in sync by the client plugin from ctx.locale. */
let activeLocale: 'zh' | 'en' = 'zh'
/** Adopt the active locale (called by the client plugin; unknown ids fall back to Chinese). */
export function setActiveLocale(id: string): void {
  activeLocale = id.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** Translate a key (zh key source; en mirrors the full key set). */
export function t(key: BrowserKey): string {
  return (activeLocale === 'en' ? en[key] : zh[key]) as string
}
