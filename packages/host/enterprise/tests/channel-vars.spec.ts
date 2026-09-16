import { afterEach, describe, expect, it } from 'vitest'
import { buildChannelCSSVars, defaultHeroTagline, DEFAULT_HERO_HEADLINE } from '../src/client/channel-vars.ts'
import { setActiveLocale } from '../src/client/locales.ts'
import type { ChannelConfig } from '../src/channel-sync.ts'

// 徽章文案按界面语言取（channel-vars.ts 的 defaultHeroTagline）：用例之间必须
// 复位，否则 en 用例会污染后续断言（同 update-status-text.spec.ts 的做法）。
afterEach(() => { setActiveLocale('zh') })

describe('buildChannelCSSVars', () => {
  it('未同步(未登录/不可达)回退默认 headline/tagline, 值带引号(content 可消费)', () => {
    const vars = buildChannelCSSVars(null)
    expect(vars['--pico-hero-headline']).toBe(JSON.stringify(DEFAULT_HERO_HEADLINE))
    expect(vars['--pico-hero-tagline']).toBe(JSON.stringify(defaultHeroTagline()))
    // content: var(...) 只认字符串字面量 —— 裸词流会整条声明非法。
    expect(vars['--pico-hero-headline']).toContain('"')
  })

  it('渠道内容总是生效: 有 client.display_name/tagline 即用(无 enabled 开关)', () => {
    const channel: ChannelConfig = { client: { display_name: 'Acme AI', tagline: 'Enterprise AI' } }
    const vars = buildChannelCSSVars(channel)
    expect(vars['--pico-hero-headline']).toBe(JSON.stringify('Acme AI'))
    expect(vars['--pico-hero-tagline']).toBe(JSON.stringify('Enterprise AI'))
  })

  it('缺 client 段 → 回退默认', () => {
    const vars = buildChannelCSSVars({ title: 'Acme', login: { display_name: 'Acme' } })
    expect(vars['--pico-hero-headline']).toBe(JSON.stringify(DEFAULT_HERO_HEADLINE))
    expect(vars['--pico-hero-tagline']).toBe(JSON.stringify(defaultHeroTagline()))
  })

  it('字段为空 → 回退默认', () => {
    const vars = buildChannelCSSVars({ client: { display_name: '', tagline: '' } })
    expect(vars['--pico-hero-headline']).toBe(JSON.stringify(DEFAULT_HERO_HEADLINE))
    expect(vars['--pico-hero-tagline']).toBe(JSON.stringify(defaultHeroTagline()))
  })

  it('渠道色(accent)已下线: 不再输出任何颜色键', () => {
    const vars = buildChannelCSSVars({ client: { display_name: 'Acme', tagline: '' }, accent: '#2563eb' })
    expect(Object.keys(vars).length).toBe(2)
    expect(vars['--dsw-alias-brand-primary']).toBeUndefined()
  })

  it('英文界面下 hero 徽章兜底是英文（2026-09-16 i18n：首屏可见文案）', () => {
    expect(defaultHeroTagline()).toBe('企业版')
    expect(buildChannelCSSVars(null)['--pico-hero-tagline']).toBe(JSON.stringify('企业版'))
    setActiveLocale('en')
    expect(defaultHeroTagline()).toBe('Enterprise')
    const vars = buildChannelCSSVars({ client: { display_name: '', tagline: '' } })
    expect(vars['--pico-hero-tagline']).toBe(JSON.stringify('Enterprise'))
    expect(vars['--pico-hero-tagline']).not.toContain('企业')
    // 渠道显式配了 tagline 时，语言不改变它（渠道文案优先）。
    expect(buildChannelCSSVars({ client: { display_name: 'Acme', tagline: 'Acme AI' } })['--pico-hero-tagline'])
      .toBe(JSON.stringify('Acme AI'))
  })
})
