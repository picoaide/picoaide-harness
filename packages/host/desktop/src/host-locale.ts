/**
 * Host-side UI locale — the single source for user-visible copy rendered
 * OUTSIDE the DSH client face.
 *
 * `ctx.locale` is a **client-face** service (`@deepseek-ai/dsh-client-locale`
 * exports it from its `./client` entry only), so host plugins cannot reach it.
 * That is why the pre-auth pages, the embedded browser window and the host
 * halves' user-visible payloads had no translation channel at all.
 *
 * The desktop launcher is the only host authority for the language the user
 * actually sees, and it already keeps that value current: the stored DSH
 * preference when set, otherwise the resolved application locale. Plugins read
 * it through the probed `desktopRuntime` service (the same structural probe
 * `desktop-loop-notify` uses), so this module stays free of a hard dependency
 * on the launcher.
 *
 * Two fallbacks keep the helpers usable where no launcher is composed
 * (headless loader smokes, a plain browser deployment of the enterprise face):
 * the request's `Accept-Language`, then {@link DEFAULT_HOST_LOCALE}.
 */

/** Locales the product ships user-visible copy for. */
export type HostLocale = 'zh' | 'en'

/**
 * Product-default host locale. Matches the client dictionaries, whose
 * module-level default is also Chinese (`setActiveLocale` falls back to `zh`
 * for any unknown id).
 */
export const DEFAULT_HOST_LOCALE: HostLocale = 'zh'

/** Locale ids in preference order, for callers that need to enumerate them. */
export const HOST_LOCALES: readonly HostLocale[] = ['zh', 'en']

/**
 * Structural view of the probed desktop runtime.
 *
 * Deliberately not typed against `DesktopRuntime`: the caller probes a service
 * that is absent in headless compositions, and `locale` is narrowed at runtime
 * so a launcher that grows a new id can never leak an unsupported value into
 * copy selection.
 */
export interface LocaleBearingRuntime {
  /** Locale currently used for native contributions (`DesktopRuntime.locale`). */
  readonly locale?: unknown
}

/** Narrow any runtime value to a shipped host locale. */
export function normalizeHostLocale(value: unknown): HostLocale {
  return typeof value === 'string' && value.toLowerCase().startsWith('en') ? 'en' : DEFAULT_HOST_LOCALE
}

/**
 * Resolve the host locale from the probed desktop runtime, then the request's
 * `Accept-Language`, then {@link DEFAULT_HOST_LOCALE}.
 *
 * The runtime wins over the header on purpose: it carries the user's explicit
 * in-app choice, which must beat anything the client advertises.
 * @param runtime - probed `desktopRuntime`, or `undefined` when absent.
 * @param acceptLanguage - raw `Accept-Language` request header, when there is a request.
 * @returns the locale to render host copy in.
 */
export function hostLocaleFrom(
  runtime: LocaleBearingRuntime | undefined,
  acceptLanguage?: string | undefined,
): HostLocale {
  if (typeof runtime?.locale === 'string') return normalizeHostLocale(runtime.locale)
  return preferredLocaleFromAcceptLanguage(acceptLanguage) ?? DEFAULT_HOST_LOCALE
}

/** Pick the copy for a locale (zh is the source, en mirrors the full set). */
export function hostCopy<T>(locale: HostLocale, zh: T, en: T): T {
  return locale === 'en' ? en : zh
}

/**
 * First supported locale named by an `Accept-Language` header.
 *
 * Parses the q-value order rather than trusting positional order, because
 * clients emit `*` and zero-quality entries that must not win. Unsupported
 * languages are skipped so a `ja,zh;q=0.8` client still gets Chinese.
 * @param header - raw header value, possibly absent or malformed.
 * @returns a supported locale, or `undefined` when the header names none.
 */
export function preferredLocaleFromAcceptLanguage(header: string | undefined): HostLocale | undefined {
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
    // `*` accepts anything and therefore decides nothing.
    if (tag === '*') continue
    if (tag === 'zh' || tag.startsWith('zh-') || tag.startsWith('zh_')) return 'zh'
    if (tag === 'en' || tag.startsWith('en-') || tag.startsWith('en_')) return 'en'
  }
  return undefined
}

/**
 * Render one locale's variant of a bilingual template.
 *
 * The injected HTML pages carry their copy inline, so they are built per
 * request from a `{ zh, en }` pair rather than substituted placeholder by
 * placeholder. Keeping the pick here means every host surface resolves the
 * locale the same way.
 * @param locale - active host locale.
 * @param variants - the two renderings.
 * @returns the rendering for `locale`.
 */
export function selectHostVariant<T>(locale: HostLocale, variants: Readonly<Record<HostLocale, T>>): T {
  return variants[locale]
}
