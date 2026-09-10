import { describe, expect, it } from 'vitest'
import { resolveChannelLogoURLs, type ChannelConfig } from '../src/channel-sync.ts'

describe('resolveChannelLogoURLs', () => {
  const channel: ChannelConfig = {
    channel_id: 'official',
    login: { logo_url: '/api/client/v2/channel/logo', display_name: 'Acme', tagline: '', welcome: '' },
    client: { logo_url: '/api/client/v2/channel/logo', display_name: 'Acme AI', tagline: '' },
    favicon_url: '/api/client/v2/channel/logo',
    title: 'Acme',
    accent: '#2563eb',
  }

  it('resolves relative logo URLs to absolute against the server URL', () => {
    const out = resolveChannelLogoURLs(channel, 'https://ai.example.com')
    expect(out.login?.logo_url).toBe('https://ai.example.com/api/client/v2/channel/logo')
    expect(out.client?.logo_url).toBe('https://ai.example.com/api/client/v2/channel/logo')
    expect(out.favicon_url).toBe('https://ai.example.com/api/client/v2/channel/logo')
  })

  it('trims trailing slashes from the server URL (no //path)', () => {
    const out = resolveChannelLogoURLs(channel, 'https://ai.example.com/')
    expect(out.client?.logo_url).toBe('https://ai.example.com/api/client/v2/channel/logo')
  })

  it('keeps absolute URLs untouched (defensive)', () => {
    const out = resolveChannelLogoURLs(
      { ...channel, client: { ...channel.client!, logo_url: 'https://cdn.example.com/logo.png' } },
      'https://ai.example.com',
    )
    expect(out.client?.logo_url).toBe('https://cdn.example.com/logo.png')
  })

  it('leaves empty/absent URLs alone', () => {
    const out = resolveChannelLogoURLs({ ...channel, login: { display_name: '', tagline: '', welcome: '' } }, 'https://ai.example.com')
    expect(out.login?.logo_url).toBeUndefined()
  })

  it('carries the non-URL channel fields (channel_id/accent) through unchanged', () => {
    // 渠道内容总是生效:没有 enabled 开关,未配置的项只是缺失。
    const out = resolveChannelLogoURLs(channel, 'https://ai.example.com')
    expect(out.channel_id).toBe('official')
    expect(out.accent).toBe('#2563eb')
    expect(out).not.toHaveProperty('enabled')
  })

  it('accepts a payload where every optional field is absent', () => {
    const out = resolveChannelLogoURLs({}, 'https://ai.example.com')
    expect(out).toEqual({ title: '' })
  })
})
