import { describe, expect, it } from 'vitest'
import {
  normalizeDefaultServerURL,
  parseDesktopChannelProfile,
} from '../src/desktop-channel.ts'

/** 一份最小可用的渠道包内容(与服务端 channel.json 同文件)。 */
function channelValue(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: 1,
    channel_id: 'acme',
    identity: { display_name: 'Acme AI' },
    defaults: { server_url: 'https://ai.acme.example.com' },
    ...overrides,
  }
}

describe('desktop channel profile', () => {
  it('reads the channel id, default server and desktop product name', () => {
    expect(parseDesktopChannelProfile(channelValue())).toEqual({
      channelId: 'acme',
      defaultServerURL: 'https://ai.acme.example.com',
      productName: 'Acme AI',
      windowTitle: 'Acme AI',
      // 未配置深链 scheme → 回落官方值(行为不变)
      deepLinkScheme: 'picoaide',
      deepLinkName: 'Acme AI',
      // 只配了 identity.display_name:没有 short_name,登录页名字按服务端同序
      // 回落中性占位(CI 强制每个渠道必须写 short_name,交付构建到不了这里);
      // 短名是提示字段,缺失留空,由消费方回落到显示名。
      brand: {
        channelId: 'acme',
        title: 'Acme AI',
        login: { displayName: 'Harness', shortName: '', tagline: '', welcome: '' },
        client: { displayName: 'Acme AI', shortName: '', tagline: '' },
      },
    })
  })

  it('prefers the desktop section over the identity display name', () => {
    expect(parseDesktopChannelProfile(channelValue({
      desktop: { product_name: 'Acme Assistant', window_title: 'Acme 助手' },
    }))).toEqual({
      channelId: 'acme',
      defaultServerURL: 'https://ai.acme.example.com',
      productName: 'Acme Assistant',
      windowTitle: 'Acme 助手',
      deepLinkScheme: 'picoaide',
      deepLinkName: 'Acme Assistant',
      brand: {
        channelId: 'acme',
        title: 'Acme AI',
        login: { displayName: 'Harness', shortName: '', tagline: '', welcome: '' },
        client: { displayName: 'Acme AI', shortName: '', tagline: '' },
      },
    })
  })

  it('reads the brand copy the login page and client shell render', () => {
    // 登录页在认证之前就渲染品牌区,那会儿问不到服务端 —— 文案只能随包。
    const profile = parseDesktopChannelProfile(channelValue({
      identity: { display_name: 'Acme AI', short_name: 'Acme', tagline: '企业内部平台', title: 'Acme 门户' },
      copy: {
        login_display_name: 'Acme',
        login_tagline: '员工入口',
        login_welcome: '欢迎使用\n请用企业账号登录',
        client_display_name: 'Acme AI',
        client_tagline: '企业助手',
      },
    }))
    expect(profile?.brand).toEqual({
      channelId: 'acme',
      title: 'Acme 门户',
      login: { displayName: 'Acme', shortName: 'Acme', tagline: '员工入口', welcome: '欢迎使用\n请用企业账号登录' },
      client: { displayName: 'Acme AI', shortName: 'Acme', tagline: '企业助手' },
    })
  })

  it('derives the brand name chain in the same order as the server', () => {
    // 与服务端 channel.go 的 applyDefaults 同序:login_display_name → short_name,
    // client_display_name → display_name。顺序错了会出现"登录页一个名、登录后
    // 另一个名"。
    const short = parseDesktopChannelProfile(channelValue({
      identity: { display_name: 'Acme AI', short_name: 'Acme' },
      copy: {},
    }))
    expect(short?.brand.login.displayName).toBe('Acme')
    expect(short?.brand.client.displayName).toBe('Acme AI')
    expect(short?.brand.client.shortName).toBe('Acme')
  })

  it('never falls back to a vendor brand when the channel omits its name', () => {
    // 包里没有品牌内容 = 注入链断了:显示中性占位,而不是厂商名(白标事故)。
    const profile = parseDesktopChannelProfile(channelValue({ identity: {} }))
    expect(profile?.brand.login.displayName).toBe('Harness')
    expect(profile?.brand.client.displayName).toBe('Harness')
    expect(JSON.stringify(profile?.brand)).not.toContain('PicoAide')
  })

  it('ignores a wrong-typed copy block instead of throwing', () => {
    const profile = parseDesktopChannelProfile(channelValue({ copy: 'nope', identity: { display_name: 'Acme AI' } }))
    expect(profile?.brand.client.displayName).toBe('Acme AI')
    expect(profile?.brand.login.displayName).toBe('Harness')
  })

  it('keeps display names non-empty but leaves hint fields empty', () => {
    // displayName 必须有值(渲染位);shortName/tagline 是提示,缺失留空串,
    // 否则消费方无法区分"渠道给的短名"与"中性占位"。
    const profile = parseDesktopChannelProfile(channelValue({ identity: { display_name: 'Acme AI', short_name: 'Acme' } }))
    expect(profile?.brand.client.shortName).toBe('Acme')
    expect(profile?.brand.login.shortName).toBe('Acme')
    const bare = parseDesktopChannelProfile(channelValue({ identity: { display_name: 'Acme AI' } }))
    expect(bare?.brand.client.shortName).toBe('')
    expect(bare?.brand.login.tagline).toBe('')
  })

  it('uses the channel deep-link scheme when configured', () => {
    // 浏览器回调跳回客户端时的确认框里就是它 —— 渠道客户不该看到厂商名。
    const profile = parseDesktopChannelProfile(channelValue({
      desktop: { deep_link_scheme: 'acmeai', deep_link_name: 'Acme AI Link' },
    }))
    expect(profile?.deepLinkScheme).toBe('acmeai')
    expect(profile?.deepLinkName).toBe('Acme AI Link')
  })

  it.each([
    ['uppercase', 'ACME'],
    ['a space', 'acme ai'],
    ['starting with a digit', '1acme'],
    ['empty', ''],
    ['too long', `a${'b'.repeat(40)}`],
  ])('falls back to the official scheme for a malformed one (%s)', (_case, scheme) => {
    const profile = parseDesktopChannelProfile(channelValue({ desktop: { deep_link_scheme: scheme } }))
    expect(profile?.deepLinkScheme).toBe('picoaide')
  })

  it('leaves the server URL unset when the channel config omits it', () => {
    // 未配域名 = 保持原两步登录流程,不是"配了个空地址"。
    const profile = parseDesktopChannelProfile(channelValue({ defaults: {} }))
    expect(profile?.defaultServerURL).toBeUndefined()
  })

  it.each([
    ['a malformed id', channelValue({ channel_id: 'Acme!' })],
    ['a missing id', channelValue({ channel_id: undefined })],
    ['a non-object', 'not an object'],
    ['an array', []],
    ['null', null],
  ])('rejects %s', (_case, value) => {
    expect(parseDesktopChannelProfile(value)).toBeUndefined()
  })

  it.each([
    ['https://ai.acme.example.com', 'https://ai.acme.example.com'],
    ['https://ai.acme.example.com/', 'https://ai.acme.example.com'],
    ['https://ai.acme.example.com///', 'https://ai.acme.example.com'],
    ['https://ai.acme.example.com/picoaide', 'https://ai.acme.example.com/picoaide'],
    // 回环允许 http(本机调试/自签内网)
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['http://localhost:8080', 'http://localhost:8080'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeDefaultServerURL(input)).toBe(expected)
  })

  it.each([
    // 明文指向外部主机 = 把整批客户端降级到明文,必须拒绝
    ['http://ai.acme.example.com'],
    ['ftp://ai.acme.example.com'],
    ['not a url'],
    [''],
    ['   '],
    [undefined],
    [42],
  ])('rejects %s', (input) => {
    expect(normalizeDefaultServerURL(input)).toBeUndefined()
  })
})
