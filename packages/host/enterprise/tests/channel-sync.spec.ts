import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, resolveChannelLogoURLs, type ChannelConfig } from '../src/channel-sync.ts'
import { brandChannel, DEFAULT_CHANNEL, NEUTRAL_CHANNEL } from '../src/channel-content.ts'
import { SESSION_CHANGED_EVENT } from '../src/session-service.ts'
import type { Session } from '../src/server-connector/config.ts'

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

describe('channel-sync built-in brand (未登录/服务端不可达时的显示内容)', () => {
  /** 最小 Cordis 上下文：只实现 channel-sync 用到的 on/emit。 */
  function ctxWithEvents(): {
    ctx: Context
    emitSession: (session: Session | null) => void
    emitted: unknown[]
  } {
    const sessionListeners = new Set<(session: Session | null) => void>()
    const emitted: unknown[] = []
    const ctx = {
      on: (event: string, listener: (session: Session | null) => void) => {
        expect(event).toBe(SESSION_CHANGED_EVENT)
        sessionListeners.add(listener)
        return () => { sessionListeners.delete(listener) }
      },
      emit: (event: string, payload: unknown) => {
        expect(event).toBe('pico/channel-changed')
        emitted.push(payload)
      },
    } as unknown as Context
    return {
      ctx,
      emitted,
      emitSession: (session) => { for (const l of [...sessionListeners]) l(session) },
    }
  }

  const BRAND = {
    title: 'Acme 门户',
    login: { displayName: 'Acme AI', shortName: 'Acme', tagline: '企业内部平台', welcome: '' },
    client: { displayName: 'Acme AI', shortName: 'Acme', tagline: '' },
  }

  it('emits the packaged channel brand on logout instead of null', async () => {
    // 此前登出发 null,客户端各自回落到硬编码的厂商文案 —— 渠道客户于是看到
    // 厂商名。现在回落的必须是渠道自己的内容。
    const { ctx, emitSession, emitted } = ctxWithEvents()
    apply(ctx, { brand: BRAND })
    emitSession(null)
    await Promise.resolve()
    expect(emitted).toEqual([brandChannel(BRAND)])
    expect(JSON.stringify(emitted)).not.toContain('PicoAide')
  })

  it('keeps the official built-in content when no channel brand is injected', async () => {
    const { ctx, emitSession, emitted } = ctxWithEvents()
    apply(ctx)
    emitSession(null)
    await Promise.resolve()
    expect(emitted).toEqual([DEFAULT_CHANNEL])
  })

  it('uses the neutral content when the injected channel brand is empty', () => {
    // 有渠道包但品牌为空 = 注入链断了:中性占位,绝不冒充官方。
    expect(brandChannel({})).toEqual(NEUTRAL_CHANNEL)
  })

  it('keeps short_name through the logo-URL absolutization', () => {
    // short_name 服务端不下发:它由随包品牌补上。absolutizeURLs 重建 client
    // 对象时丢掉它,侧边栏就会变成另一套兜底名字。
    const out = resolveChannelLogoURLs(
      { client: { display_name: 'Acme AI', short_name: 'Acme', tagline: '' } },
      'https://ai.example.com',
    )
    expect(out.client?.short_name).toBe('Acme')
  })
})
