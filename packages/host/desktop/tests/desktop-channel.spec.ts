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
      // 没配 desktop.home_dir / slug → 兜底到 `.picoaide-harness-<渠道 id>`：
      // 兜底**不回落官方目录**（那会与官方客户端共用 token/settings/会话）。
      homeDir: '.picoaide-harness-acme',
      appId: undefined,
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
      homeDir: '.picoaide-harness-acme',
      appId: undefined,
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

  it('scopes the data directory to the channel (never the vendor default)', () => {
    // 2026-09-11:两个渠道共用一个数据根 = 共享登录 token/settings/会话(跨租户),
    // 并互相顶掉 Electron 的单实例锁。三种取值链都要落在**本渠道**的目录上。
    const explicit = parseDesktopChannelProfile(channelValue({
      desktop: { home_dir: '.acme-harness' },
    }))
    expect(explicit?.homeDir).toBe('.acme-harness')

    // 没写 home_dir 时由 slug 小写派生
    const derived = parseDesktopChannelProfile(channelValue({
      desktop: { slug: 'Acme-Harness' },
    }))
    expect(derived?.homeDir).toBe('.acme-harness')

    // 畸形 home_dir 不生效,但**绝不回落官方目录**:换 slug 派生,再退到渠道 id
    for (const bad of ['../escape', '/abs', '.', '.UPPER', 'plain', '', 42]) {
      const profile = parseDesktopChannelProfile(channelValue({ desktop: { home_dir: bad } }))
      expect(profile?.homeDir).toBe('.picoaide-harness-acme')
    }

    // slug 恰好等于官方 slug = "声明我和官方是同一个应用" → 不采纳,退到渠道 id
    const vendorSlug = parseDesktopChannelProfile(channelValue({
      desktop: { slug: 'PicoAide-Harness' },
    }))
    expect(vendorSlug?.homeDir).toBe('.picoaide-harness-acme')
  })

  it('reads the channel app id used as the Windows AppUserModelId', () => {
    // 必须与 electron-builder 写进快捷方式的 app_id 一致,否则渠道客户端的
    // 通知在 Windows 上对不上身份(不弹/不归组);畸形值回落官方。
    const profile = parseDesktopChannelProfile(channelValue({
      desktop: { app_id: 'com.acme.ai' },
    }))
    expect(profile?.appId).toBe('com.acme.ai')
    expect(parseDesktopChannelProfile(channelValue({ desktop: { app_id: 'not an id' } }))?.appId).toBeUndefined()
  })

  /**
   * `desktop.product_name` 是**路径型字段**(Electron userData 目录名,见
   * desktop-user-data.ts),同时又被 electron-builder 用作 mac `.app` 目录名 ——
   * 它是同批字段里唯一没有形状校验的(2026-09-12 审计 P1-13)。畸形值必须被忽略
   * (回落 display_name,再退中性占位),绝不许进路径。
   */
  it.each([
    ['a path traversal', '../../evil'],
    ['the parent directory', '..'],
    ['an embedded separator', 'Acme/../../x'],
    ['a windows separator', 'Acme\\Harness'],
    ['a drive-ish prefix', 'C:Acme'],
    ['a control character', 'Acme\u0000Harness'],
    ['a trailing dot', 'Acme.'],
    ['a newline', 'Acme\nHarness'],
    ['too long', 'A'.repeat(65)],
  ])('ignores a malformed product_name (%s)', (_case, productName) => {
    const profile = parseDesktopChannelProfile(channelValue({ desktop: { product_name: productName } }))
    // 回落链:product_name → identity.display_name(channelValue 里是 'Acme AI')
    expect(profile?.productName).toBe('Acme AI')
    // 绝不许把畸形值带进任何路径型出口。
    expect(String(profile?.productName)).not.toContain('/')
    expect(String(profile?.productName)).not.toContain('\\')
  })

  it('falls back to the neutral placeholder when neither product name is usable', () => {
    // display_name 也是路径型出口的输入(它是 product_name 的回落来源),同样校验;
    // 两个都不合形状时给中性占位 —— 绝不回落到厂商名,也绝不让畸形值进路径。
    const profile = parseDesktopChannelProfile(channelValue({
      identity: { display_name: '../evil' },
      desktop: { product_name: '../evil' },
    }))
    expect(profile?.productName).toBe('Harness')
  })

  it('accepts product names that are safe path segments', () => {
    for (const name of ['Acme Harness', 'Acme AI — 智能助手', 'PicoAide Harness', 'A1']) {
      expect(parseDesktopChannelProfile(channelValue({ desktop: { product_name: name } }))?.productName).toBe(name)
    }
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
