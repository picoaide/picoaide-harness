/**
 * Foot menu client UI copy: zh is the key source, en mirrors the full key set
 * (the same pattern as dsh-account-card / dsh-cron / dsh-connectors locales).
 * The dictionary is registered into the shared locale registry; `t()` resolves
 * the zh key source directly so components stay dependency-free.
 */
export const zh = {
  'footMenu.label': '更多功能',
  /**
   * 通用「有等待处理的事项」文案：`attention` 为真、但条目**没给** `attentionTitle`
   * 时的行级可访问名（2026-10-04 核验 P1-② 的回退链第二级）。
   *
   * 档位（holding / waiting）只能由条目自己的 `attentionTitle()` 表达 —— 浏览器那条
   * 两档各有一句，所以 holding 不会被念成"有事项在等"。这条通用文案对"声明了 attention"
   * 的条目仍然准确，且**必须保持有引用点**：desktop 包的 i18n 守卫要求零死键
   * （2026-10-04 §12 收口门禁正是被这条打的）。
   */
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
