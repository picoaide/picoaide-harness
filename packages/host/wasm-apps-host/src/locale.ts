/**
 * Host-side UI locale for the copy this plugin renders itself (the "please sign
 * in" / "app unavailable" pages and the local route errors).
 *
 * **权威仍是 `dsh-plugin-desktop/host-locale`**（契约：宿主侧语言来源唯一）。
 * 本文件是它在**本包内**的最小镜像，原因是构建期约束：新包在
 * `scripts/check-workspaces.mjs` 里以 `needs: []` 登记（见
 * `docs/planning/2026-09-19-wasm-client-only-implementation.md` 附录 A），
 * 跨包 import 会把构建顺序绑死。两条规则因此必须一致：
 *
 *  1. 解析顺序 = 探测到的 `desktopRuntime.locale`（用户应用内选择，权威）
 *     → 请求的 `Accept-Language` → 产品默认 `zh`；
 *  2. **按调用解析，禁止模块级冻结**：语言可以在应用运行中改变，而已经打开的
 *     应用页面会被重新加载 —— 任何把首次解析结果钉进模块常量的写法都会让
 *     "切了语言但页面还是旧语言"（本仓已记录两次的 bug 类）。
 *
 * @module @picoaide/dsh-wasm-apps-host/locale
 */

/** Locales the product ships host copy for. */
export type HostLocale = 'zh' | 'en'

/** Product-default host locale (matches the client dictionaries). */
export const DEFAULT_HOST_LOCALE: HostLocale = 'zh'

/**
 * Narrow any runtime value to a shipped host locale, or `undefined`.
 *
 * 前缀匹配让区域子标签继续可用（`zh-CN`/`en_US`）；不支持的值返回
 * `undefined`（而不是默认值），这样调用方还能继续看请求头。
 * @param value - raw runtime or platform language tag.
 * @returns the shipped locale, or undefined.
 */
export function tryNormalizeHostLocale(value: unknown): HostLocale | undefined {
  if (typeof value !== 'string') return undefined
  const primary = value.trim().toLowerCase().split(/[-_]/u)[0] ?? ''
  if (primary === 'en') return 'en'
  if (primary === 'zh') return 'zh'
  return undefined
}

/** Narrow any value to a shipped host locale (defaults to zh). */
export function normalizeHostLocale(value: unknown): HostLocale {
  return tryNormalizeHostLocale(value) ?? DEFAULT_HOST_LOCALE
}

/**
 * First supported locale named by an `Accept-Language` header.
 *
 * 按 q 值排序而不是位置：客户端会发 `*` 与 `q=0` 条目，它们都不能赢。
 * @param header - raw header value (may be absent, null or malformed).
 * @returns a supported locale, or `undefined` when the header names none.
 */
export function preferredLocaleFromAcceptLanguage(
  header: string | null | undefined,
): HostLocale | undefined {
  if (typeof header !== 'string' || header.trim() === '') return undefined
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.split(';')
      const quality = params
        .map(param => param.trim())
        .filter(param => param.startsWith('q='))
        .map(param => Number.parseFloat(param.slice(2)))
        .find(value => Number.isFinite(value))
      return { tag: tag.trim().toLowerCase(), quality: quality ?? 1, index }
    })
    .filter(entry => entry.tag !== '' && entry.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index)
  for (const { tag } of ranked) {
    if (tag === '*') continue
    if (tag === 'zh' || tag.startsWith('zh-') || tag.startsWith('zh_')) return 'zh'
    if (tag === 'en' || tag.startsWith('en-') || tag.startsWith('en_')) return 'en'
  }
  return undefined
}

/**
 * Resolve the host locale: probed runtime → request `Accept-Language` → default.
 *
 * 运行时的值优先于请求头（它承载用户在应用内的显式选择）。探测是**按调用**
 * 做的：launcher 可能比本插件晚装配。
 * @param runtime - probed `desktopRuntime`, or `undefined` when absent.
 * @param acceptLanguage - raw `Accept-Language`, when there is a request.
 * @returns the locale to render host copy in.
 */
export function hostLocaleFrom(
  runtime: { readonly locale?: unknown } | undefined,
  acceptLanguage?: string | null,
): HostLocale {
  const fromRuntime = tryNormalizeHostLocale(runtime?.locale)
  if (fromRuntime !== undefined) return fromRuntime
  return preferredLocaleFromAcceptLanguage(acceptLanguage) ?? DEFAULT_HOST_LOCALE
}

/** Pick the copy for a locale (zh is the source, en mirrors the full set). */
export function hostCopy<T>(locale: HostLocale, zh: T, en: T): T {
  return locale === 'en' ? en : zh
}
