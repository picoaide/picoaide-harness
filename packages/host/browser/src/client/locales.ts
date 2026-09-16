/**
 * Browser client UI copy: zh is the key source, en mirrors the full key set.
 */
export const zh = {
  'panel.title': '浏览器',
  /** 用户持有控制权、AI 被挡住时的提示（侧边栏宽度足够时显示短句，全句进 title）。 */
  'panel.waitingShort': 'AI 等待交还',
  'panel.waiting': 'AI 正在等你交还浏览器控制权：打开浏览器窗口点「交给 AI」即可继续',
}

export const en: Record<keyof typeof zh, string> = {
  'panel.title': 'Browser',
  'panel.waitingShort': 'AI waiting',
  'panel.waiting': 'The AI is waiting for you to hand back browser control: open the browser window and click 交给 AI to continue',
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
