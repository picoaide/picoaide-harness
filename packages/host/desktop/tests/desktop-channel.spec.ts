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
    })
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
