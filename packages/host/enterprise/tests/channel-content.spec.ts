import { describe, expect, it } from 'vitest'
import { parseDesktopChannelProfile } from 'dsh-plugin-desktop/desktop-channel'
import { brandChannel, DEFAULT_CHANNEL, NEUTRAL_CHANNEL } from '../src/channel-content.ts'

/**
 * 渠道包（`channels/<id>/channel.json`）→ 客户端内置兜底内容。
 *
 * 这一层是白标的**接缝**：桌面组装把渠道包解析成品牌（desktop-channel.ts），
 * 再经插件行 config 交给本包的 Host/Client 面。任何一处改口径，这里先红。
 */
describe('brandChannel', () => {
  it('maps a desktop channel profile to the client-facing channel shape', () => {
    const profile = parseDesktopChannelProfile({
      channel_id: 'acme',
      identity: { display_name: 'Acme AI', short_name: 'Acme', title: 'Acme 门户' },
      copy: { login_welcome: '欢迎' },
    })
    expect(brandChannel(profile?.brand)).toEqual({
      title: 'Acme 门户',
      login: { display_name: 'Acme', tagline: '', welcome: '欢迎' },
      client: { display_name: 'Acme AI', short_name: 'Acme', tagline: '' },
    })
  })

  it('falls back from a missing short name to the display name, never to a vendor name', () => {
    // 渠道只配了 display_name 时，侧边栏显示渠道全名而不是中性占位 ——
    // 短名是提示字段，缺失就该回落到显示名。
    const profile = parseDesktopChannelProfile({
      channel_id: 'acme',
      identity: { display_name: 'Acme AI' },
    })
    const out = brandChannel(profile?.brand)
    expect(out.client?.short_name).toBe('Acme AI')
    expect(JSON.stringify(out)).not.toContain('PicoAide')
  })

  it('uses the official content only when there is no channel package at all', () => {
    // 本地开发/官方构建:没有渠道包 → 官方内容(与改造前逐字节一致)。
    expect(brandChannel(undefined)).toEqual(DEFAULT_CHANNEL)
  })

  it('uses the neutral content when a channel package carries no brand', () => {
    // 有渠道包但品牌为空 = 注入链断了:中性占位,绝不冒充官方。
    expect(brandChannel({})).toEqual(NEUTRAL_CHANNEL)
    expect(JSON.stringify(brandChannel({}))).not.toContain('PicoAide')
  })

  it('treats whitespace-only fields as absent', () => {
    const out = brandChannel({ title: '   ', login: { displayName: '', tagline: '  ' }, client: { displayName: ' ' } })
    expect(out.login?.display_name).toBe('Harness')
    expect(out.client?.tagline).toBe('')
  })

  it('outputs only the fields the server response also carries', () => {
    // 形态必须与服务端 GET /api/client/v2/channel 一致:消费方两条路径共用。
    const out = brandChannel({ title: 'Acme', login: { displayName: 'Acme' } })
    expect(Object.keys(out).sort()).toEqual(['client', 'login', 'title'])
    expect(Object.keys(out.login ?? {}).sort()).toEqual(['display_name', 'tagline', 'welcome'])
    expect(Object.keys(out.client ?? {}).sort()).toEqual(['display_name', 'short_name', 'tagline'])
  })
})
