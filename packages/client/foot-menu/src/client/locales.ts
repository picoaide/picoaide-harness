/**
 * Foot menu client UI copy: zh is the key source, en mirrors the full key set
 * (the same pattern as dsh-account-card / dsh-cron / dsh-connectors locales).
 * The dictionary is registered into the shared locale registry; `t()` resolves
 * the zh key source directly so components stay dependency-free.
 */
export const zh = {
  'footMenu.label': '更多功能',
  'footMenu.labelAttention': '更多功能（有等待处理的事项）',
  'footMenu.attention': 'AI 正在等待你的操作',
  'footMenu.more': '更多',
}

export const en: Record<keyof typeof zh, string> = {
  'footMenu.label': 'More',
  'footMenu.labelAttention': 'More (something is waiting)',
  'footMenu.attention': 'The AI is waiting for you',
  'footMenu.more': 'More',
}

/** Keys of the foot-menu dictionary. */
export type FootMenuKey = keyof typeof zh

const dict = zh as Record<FootMenuKey, string>
const enDict = en as Record<FootMenuKey, string>

/** Active UI locale, kept in sync by the client plugin from ctx.locale. */
let activeLocale: 'zh' | 'en' = 'zh'

/**
 * Adopt the active locale (called by the client plugin; unknown ids fall back
 * to Chinese).
 * @param id - locale id reported by the locale service.
 */
export function setActiveLocale(id: string): void {
  activeLocale = id.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/**
 * Resolve a zh-source key; the `en` mirror is registered for the locale service.
 * @param key - dictionary key (zh text is the key source).
 * @returns localized copy.
 */
export function t(key: FootMenuKey): string {
  return (activeLocale === 'en' ? enDict : dict)[key]
}
