/**
 * Browser client UI copy: zh is the key source, en mirrors the full key set.
 *
 * Parameters use the same `{name}` placeholder convention as the sibling
 * packages (`dsh-connectors/src/client/locales.ts`): the sentence names the
 * UI control through a translated key instead of embedding a hard-coded label,
 * so the English sentence names the English button.
 */
export const zh = {
  'panel.title': '浏览器',
  /** 用户持有控制权、AI 被挡住时的提示（侧边栏宽度足够时显示短句，全句进 title）。 */
  'panel.waitingShort': 'AI 等待交还',
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
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, value)
    }
  }
  return text
}
