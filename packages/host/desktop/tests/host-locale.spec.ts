/**
 * Host-side locale resolution.
 *
 * The host face has no `ctx.locale` (that service is client-only), so the
 * language used by the pre-auth pages, the embedded browser window and the
 * host halves' user-visible payloads is resolved here. These cases pin the
 * precedence that keeps the user's explicit in-app choice authoritative while
 * still working where no desktop launcher is composed.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOST_LOCALE,
  HOST_LOCALES,
  hostCopy,
  hostLocaleFrom,
  normalizeHostLocale,
  preferredLocaleFromAcceptLanguage,
  selectHostVariant,
} from '../src/host-locale.ts'

describe('normalizeHostLocale', () => {
  it('maps every English tag shape to en', () => {
    for (const tag of ['en', 'EN', 'en-US', 'en_US', 'en-GB']) {
      expect(normalizeHostLocale(tag), tag).toBe('en')
    }
  })

  it('maps Chinese and anything unrecognized to the product default', () => {
    for (const tag of ['zh', 'zh-CN', 'zh_CN', 'zh-Hans', 'ja', '', 'de-DE']) {
      expect(normalizeHostLocale(tag), tag).toBe(DEFAULT_HOST_LOCALE)
    }
  })

  it('treats a missing or non-string value as the product default', () => {
    expect(normalizeHostLocale(undefined)).toBe(DEFAULT_HOST_LOCALE)
    expect(normalizeHostLocale(null)).toBe(DEFAULT_HOST_LOCALE)
    expect(normalizeHostLocale(42)).toBe(DEFAULT_HOST_LOCALE)
  })
})

describe('preferredLocaleFromAcceptLanguage', () => {
  it('reads a plain header', () => {
    expect(preferredLocaleFromAcceptLanguage('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh')
    expect(preferredLocaleFromAcceptLanguage('en-US,en;q=0.9')).toBe('en')
  })

  it('orders by q-value rather than position', () => {
    expect(preferredLocaleFromAcceptLanguage('en;q=0.3,zh;q=0.9')).toBe('zh')
  })

  it('skips unsupported languages and the any-language wildcard', () => {
    expect(preferredLocaleFromAcceptLanguage('ja,ko;q=0.9')).toBeUndefined()
    expect(preferredLocaleFromAcceptLanguage('*')).toBeUndefined()
    // A wildcard must not shadow a later explicit, supported entry.
    expect(preferredLocaleFromAcceptLanguage('*,zh;q=0.5')).toBe('zh')
    expect(preferredLocaleFromAcceptLanguage('ja,zh;q=0.8')).toBe('zh')
  })

  it('ignores zero-quality entries and malformed input', () => {
    expect(preferredLocaleFromAcceptLanguage('zh;q=0')).toBeUndefined()
    expect(preferredLocaleFromAcceptLanguage('')).toBeUndefined()
    expect(preferredLocaleFromAcceptLanguage(undefined)).toBeUndefined()
    expect(preferredLocaleFromAcceptLanguage('   ')).toBeUndefined()
  })
})

describe('hostLocaleFrom', () => {
  it('prefers the desktop runtime over the request header', () => {
    // The stored in-app choice must beat what the client advertises.
    expect(hostLocaleFrom({ locale: 'en' }, 'zh-CN,zh;q=0.9')).toBe('en')
    expect(hostLocaleFrom({ locale: 'zh' }, 'en-US,en;q=0.9')).toBe('zh')
  })

  it('falls back to the header when the runtime is absent or silent', () => {
    expect(hostLocaleFrom(undefined, 'en-US,en;q=0.9')).toBe('en')
    expect(hostLocaleFrom({}, 'en-US,en;q=0.9')).toBe('en')
    expect(hostLocaleFrom(undefined, 'zh-CN')).toBe('zh')
  })

  it('falls back to the product default when neither source decides', () => {
    expect(hostLocaleFrom(undefined, undefined)).toBe(DEFAULT_HOST_LOCALE)
    expect(hostLocaleFrom({ locale: 42 }, 'ja')).toBe(DEFAULT_HOST_LOCALE)
  })

  it('never leaks an unsupported runtime locale', () => {
    expect(hostLocaleFrom({ locale: 'fr' }, undefined)).toBe(DEFAULT_HOST_LOCALE)
    expect(hostLocaleFrom({ locale: 'zh-Hant' }, undefined)).toBe('zh')
  })
})

describe('copy selection', () => {
  it('selects the matching variant', () => {
    expect(hostCopy('zh', '中文', 'English')).toBe('中文')
    expect(hostCopy('en', '中文', 'English')).toBe('English')
    expect(selectHostVariant('en', { zh: '中文', en: 'English' })).toBe('English')
    expect(selectHostVariant('zh', { zh: '中文', en: 'English' })).toBe('中文')
  })

  it('covers every shipped locale', () => {
    for (const locale of HOST_LOCALES) {
      expect(typeof selectHostVariant(locale, { zh: 1, en: 2 })).toBe('number')
    }
  })
})
