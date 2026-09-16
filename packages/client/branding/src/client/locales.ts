/**
 * Branding client UI copy: zh is the key source, en mirrors the full key set
 * (the same pattern as the sibling client dictionaries).
 *
 * Scope: the About section this plugin registers into `settings.section`.
 *
 * 2026-09-16 i18n：该段此前是**中英混排**——正文是硬编码中文，而 `dt` 标签
 * （`Brand plugin` / `Product version` / `UI surface`）与取值恒为英文。整段改为
 * 走字典，两种语言下都自洽。
 */
export const zh = {
  /** 「关于」段正文。 */
  'about.description': 'PicoAide 品牌与界面壳：品牌图形、主题色、悬浮徽章与关于页面全部经官方 client 插件 slot 注入，无上游代码分支。',
  /** 条目名：品牌插件。 */
  'about.brandPlugin': '品牌插件',
  /** 条目名：产品版本。 */
  'about.productVersion': '产品版本',
  /** 条目名：界面层。 */
  'about.uiSurface': '界面层',
  /** 界面层取值。 */
  'about.uiSurfaceValue': '官方 DeepSeek Harness Web UI（未修改）',
}

export const en: Record<keyof typeof zh, string> = {
  'about.description': 'PicoAide branding and shell: the brand mark, theme colours, overlay badge and About page are all injected through official client-plugin slots — no upstream code forks.',
  'about.brandPlugin': 'Brand plugin',
  'about.productVersion': 'Product version',
  'about.uiSurface': 'UI surface',
  'about.uiSurfaceValue': 'Official DeepSeek Harness web UI (unmodified)',
}

export type BrandingKey = keyof typeof zh

/** Active UI locale, kept in sync by the client plugin from ctx.locale. */
let activeLocale: 'zh' | 'en' = 'zh'
/** Adopt the active locale (called by the client plugin; unknown ids fall back to Chinese). */
export function setActiveLocale(id: string): void {
  activeLocale = id.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** Translate a key (zh key source; en mirrors the full key set). */
export function t(key: BrandingKey, params?: Record<string, string>): string {
  let text: string = (activeLocale === 'en' ? en[key] : zh[key]) as string
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, () => String(value))
    }
  }
  return text
}
