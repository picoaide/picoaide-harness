/**
 * 宿主语言解析回归。
 *
 * 关键约束（本仓已记录两次同根因 bug）：**按调用解析，禁止模块级冻结** ——
 * 因此这里除了优先级，还断言"同一个模块实例先 zh 后 en 都正确"，任何把首次
 * 解析结果缓存进模块常量的实现都会红。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOST_LOCALE,
  hostCopy,
  hostLocaleFrom,
  normalizeHostLocale,
  preferredLocaleFromAcceptLanguage,
  tryNormalizeHostLocale,
} from './locale.ts'

describe('host locale', () => {
  it('prefers the probed runtime locale over the request header', () => {
    expect(hostLocaleFrom({ locale: 'en' }, 'zh-CN,zh;q=0.9')).toBe('en')
    expect(hostLocaleFrom({ locale: 'zh' }, 'en-US,en;q=0.9')).toBe('zh')
  })

  it('falls back to Accept-Language, then the product default', () => {
    expect(hostLocaleFrom(undefined, 'en-US,en;q=0.9')).toBe('en')
    expect(hostLocaleFrom({}, 'zh-Hans,zh;q=0.9')).toBe('zh')
    expect(hostLocaleFrom(undefined, undefined)).toBe(DEFAULT_HOST_LOCALE)
    expect(hostLocaleFrom(undefined, null)).toBe(DEFAULT_HOST_LOCALE)
    expect(hostLocaleFrom(undefined, '')).toBe(DEFAULT_HOST_LOCALE)
  })

  it('ignores unsupported runtime locales so the header can still decide', () => {
    expect(tryNormalizeHostLocale('ja')).toBeUndefined()
    expect(tryNormalizeHostLocale(42)).toBeUndefined()
    expect(hostLocaleFrom({ locale: 'ja' }, 'en')).toBe('en')
    expect(normalizeHostLocale('ja')).toBe(DEFAULT_HOST_LOCALE)
  })

  it('ranks Accept-Language by quality, not by position', () => {
    expect(preferredLocaleFromAcceptLanguage('ja,en;q=0.8,zh;q=0.9')).toBe('zh')
    expect(preferredLocaleFromAcceptLanguage('*')).toBeUndefined()
    expect(preferredLocaleFromAcceptLanguage('en;q=0,zh;q=0.5')).toBe('zh')
    expect(preferredLocaleFromAcceptLanguage(undefined)).toBeUndefined()
  })

  it('resolves per call — no module-level freeze', () => {
    const runtime: { locale?: unknown } = { locale: 'zh' }
    expect(hostLocaleFrom(runtime, undefined)).toBe('zh')
    runtime.locale = 'en'
    expect(hostLocaleFrom(runtime, undefined)).toBe('en')
    expect(hostCopy(hostLocaleFrom(runtime), '中文', 'English')).toBe('English')
    runtime.locale = 'zh'
    expect(hostCopy(hostLocaleFrom(runtime), '中文', 'English')).toBe('中文')
  })
})
