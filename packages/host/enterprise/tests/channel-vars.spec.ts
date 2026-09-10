import { describe, expect, it } from 'vitest'
import { buildChannelCSSVars, DEFAULT_HERO_HEADLINE, DEFAULT_HERO_TAGLINE } from '../src/client/channel-vars.ts'
import type { ChannelConfig } from '../src/channel-sync.ts'

describe('buildChannelCSSVars', () => {
  it('未同步(未登录/不可达)回退默认 headline/tagline, 值带引号(content 可消费)', () => {
    const vars = buildChannelCSSVars(null)
    expect(vars['--pico-hero-headline']).toBe(JSON.stringify(DEFAULT_HERO_HEADLINE))
    expect(vars['--pico-hero-tagline']).toBe(JSON.stringify(DEFAULT_HERO_TAGLINE))
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
    expect(vars['--pico-hero-tagline']).toBe(JSON.stringify(DEFAULT_HERO_TAGLINE))
  })

  it('字段为空 → 回退默认', () => {
    const vars = buildChannelCSSVars({ client: { display_name: '', tagline: '' } })
    expect(vars['--pico-hero-headline']).toBe(JSON.stringify(DEFAULT_HERO_HEADLINE))
    expect(vars['--pico-hero-tagline']).toBe(JSON.stringify(DEFAULT_HERO_TAGLINE))
  })

  it('渠道色(accent)已下线: 不再输出任何颜色键', () => {
    const vars = buildChannelCSSVars({ client: { display_name: 'Acme', tagline: '' }, accent: '#2563eb' })
    expect(Object.keys(vars).length).toBe(2)
    expect(vars['--dsw-alias-brand-primary']).toBeUndefined()
  })
})
