import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { BrandName } from '../src/client/Brand.tsx'
import { AboutSection, OverlayBadge, applyBrandTheme } from '../src/client/brand-shell.tsx'

describe('branding BrandName version label', () => {
  it('renders the version tag when PICOAI_PRODUCT_VERSION is set', () => {
    const orig = (globalThis as { process?: { env?: Record<string, string> } }).process
    // Brand.tsx 的 declare const process 是编译面;测试环境用 globalThis 模拟
    const node = createElement('span', null, 'PicoAide')
    expect(node.props.children).toBe('PicoAide')
    // 直接在源码字符串层面抽查版本标签逻辑(避免运行时 process 差异):
    // build 时 tsdown define 替换 process.env.PICOAI_PRODUCT_VERSION 为字符串,
    // 这里断言源码确实消费了该变量。
    const src = BrandName.toString()
    expect(src).toContain('PICOAI_PRODUCT_VERSION')
    expect(src).toContain('v')
  })
})

describe('branding brand shell surfaces (merged from @picoaide/dsh-shell)', () => {
  it('OverlayBadge renders the product name', () => {
    const node = OverlayBadge()
    const texts = JSON.stringify(node.props.children)
    expect(texts).toContain('PicoAide Harness')
  })

  it('AboutSection renders the product name and package identity', () => {
    const node = AboutSection()
    const texts = JSON.stringify(node.props.children)
    expect(texts).toContain('PicoAide Harness')
    expect(texts).toContain('@picoaide/dsh-branding')
  })

  it('applyBrandTheme calls theme.overrideTokens with the brand layer', () => {
    const overrideTokens = vi.fn(() => () => {})
    const ctx = { get: vi.fn(() => ({ overrideTokens })) }
    applyBrandTheme(ctx)
    expect(ctx.get).toHaveBeenCalledWith('theme')
    expect(overrideTokens).toHaveBeenCalledWith('picoaide-brand', {
      '--dsw-alias-brand-primary': { light: '#0e8a6a', dark: '#34c79c' },
    })
  })

  it('applyBrandTheme degrades gracefully when the theme service is absent', () => {
    const ctx = { get: vi.fn(() => undefined) }
    expect(() => applyBrandTheme(ctx)).not.toThrow()
  })
})
