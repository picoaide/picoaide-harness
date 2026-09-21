/**
 * Browser client UI copy: zh is the key source, en mirrors the full key set.
 *
 * 2026-09-21（底部并道改造 + 对抗审计）：警示态的**可操作文案**由本字典提供，
 * 经条目的 `attentionTitle()` 交给 `@picoaide/dsh-foot-menu`（它只认这个函数出口，
 * 不认识浏览器插件）。通用那句（`footMenu.attention`＝"AI 正在等待你的操作"）是
 * 兜底：只说"在等"，不告诉用户下一步点哪里 —— 这正是审计要求补回来的信息。
 *
 * 占位符沿用兄弟包的 `{name}` 约定（`panel.waiting` 用 `{button}` 引用按钮文案，
 * 于是英文句子里的按钮名也是英文）。
 */
export const zh = {
  'panel.title': '浏览器',
  /** 用户持有控制权、AI 被挡住时的提示（浮层条目上的短句 + 「更多」行上的圆点）。 */
  'panel.waitingShort': 'AI 等待交还',
  /** 警示 tooltip / 无障碍文案：必须说清"下一步做什么"。 */
  'panel.waiting': 'AI 正在等你交还浏览器控制权：打开浏览器窗口点「{button}」即可继续',
  /** 浏览器窗口里交还控制权的那个按钮（`panel.waiting` 用 `{button}` 引用它）。 */
  'button.handBack': '交给 AI',
}

export const en: Record<keyof typeof zh, string> = {
  'panel.title': 'Browser',
  'panel.waitingShort': 'AI waiting',
  'panel.waiting': 'The AI is waiting for you to hand back browser control: open the browser window and click {button} to continue',
  'button.handBack': 'Hand back to AI',
}

export type BrowserKey = keyof typeof zh

/** Active UI locale, kept in sync by the client plugin from ctx.locale. */
let activeLocale: 'zh' | 'en' = 'zh'
/** Adopt the active locale (called by the client plugin; unknown ids fall back to Chinese). */
export function setActiveLocale(id: string): void {
  activeLocale = id.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/**
 * Translate a key (zh key source; en mirrors the full key set).
 * @param key - dictionary key.
 * @param params - `{name}` placeholders to substitute, when the copy has any.
 * @returns the copy for the active locale.
 */
export function t(key: BrowserKey, params?: Record<string, string>): string {
  let text: string = (activeLocale === 'en' ? en[key] : zh[key]) as string
  if (params !== undefined) {
    // ONE pass over the template: a chained `replaceAll` per parameter re-scans
    // the values it just inserted, so a value carrying another key's `{name}`
    // token would be rewritten (2026-09-16 R9 audit; same shape as
    // `manifest-precheck`'s `fill`).
    text = text.replace(/\{(\w+)\}/gu, (match, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : match))
  }
  return text
}
