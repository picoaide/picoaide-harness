/**
 * 2026-09-15 审计 BUG-07：金额格式化必须跟随**界面**语言。
 *
 * 旧实现 `new Intl.NumberFormat(undefined, …)` 跟随的是运行时/系统 locale，
 * 于是「系统英文 + 界面中文」的用户会看到 `CN¥1,234.50`。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { formatMoney } from './client/money.ts'
import { activeLocaleTag, setActiveLocale } from './client/locales.ts'

afterEach(() => { setActiveLocale('zh') })

describe('2026-09-15 BUG-07：金额格式跟随界面语言', () => {
  it('activeLocaleTag 与界面语言一致（BCP-47 标签）', () => {
    setActiveLocale('zh-CN')
    expect(activeLocaleTag()).toBe('zh-CN')
    setActiveLocale('en-US')
    expect(activeLocaleTag()).toBe('en-US')
    // 未知语言回落中文（与 t() 同口径）
    setActiveLocale('fr-FR')
    expect(activeLocaleTag()).toBe('zh-CN')
  })

  it('formatMoney 用界面 locale：中文 ¥、英文 CN¥', () => {
    setActiveLocale('zh')
    expect(formatMoney(1234.5)).toBe('¥1,234.50')
    setActiveLocale('en')
    expect(formatMoney(1234.5)).toBe('CN¥1,234.50')
  })
})
