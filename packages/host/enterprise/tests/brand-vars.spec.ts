import { describe, expect, it } from 'vitest'
import { buildBrandCSSVars, DEFAULT_HERO_HEADLINE, DEFAULT_HERO_TAGLINE } from '../src/client/brand-vars.ts'
import type { BrandConfig } from '../src/brand-sync.ts'

describe('buildBrandCSSVars', () => {
  it('无品牌(未登录/未配置)回退默认 headline/tagline, 值带引号(content 可消费)', () => {
    const vars = buildBrandCSSVars(null)
    expect(vars['--pico-hero-headline']).toBe(JSON.stringify(DEFAULT_HERO_HEADLINE))
    expect(vars['--pico-hero-tagline']).toBe(JSON.stringify(DEFAULT_HERO_TAGLINE))
    // content: var(...) 只认字符串字面量 —— 裸词流会整条声明非法。
    expect(vars['--pico-hero-headline']).toContain('"')
    expect('--dsw-alias-brand-primary' in vars).toBe(false)
  })

  it('enabled=false 等同未配置', () => {
    const vars = buildBrandCSSVars({ enabled: false, client: { display_name: 'Acme', tagline: 'AI', accent: '#123456' } })
    expect(vars['--pico-hero-headline']).toBe(JSON.stringify(DEFAULT_HERO_HEADLINE))
    expect('--dsw-alias-brand-primary' in vars).toBe(false)
  })

  it('启用且配置 display_name/tagline/accent → 使用配置值', () => {
    const brand: BrandConfig = { enabled: true, client: { display_name: 'Acme AI', tagline: 'Enterprise AI', accent: '#111111' } }
    const vars = buildBrandCSSVars(brand)
    expect(vars['--pico-hero-headline']).toBe(JSON.stringify('Acme AI'))
    expect(vars['--pico-hero-tagline']).toBe(JSON.stringify('Enterprise AI'))
    expect(vars['--dsw-alias-brand-primary']).toBe('#111111')
  })

  it('启用但字段为空 → 回退默认', () => {
    const vars = buildBrandCSSVars({ enabled: true, client: { display_name: '', tagline: '', accent: '' } })
    expect(vars['--pico-hero-headline']).toBe(JSON.stringify(DEFAULT_HERO_HEADLINE))
    expect(vars['--pico-hero-tagline']).toBe(JSON.stringify(DEFAULT_HERO_TAGLINE))
  })

  it('accent 为空时不输出颜色键(避免覆盖主题默认色)', () => {
    const vars = buildBrandCSSVars({ enabled: true, client: { display_name: 'Acme', tagline: '', accent: '' } })
    expect('--dsw-alias-brand-primary' in vars).toBe(false)
  })
})
