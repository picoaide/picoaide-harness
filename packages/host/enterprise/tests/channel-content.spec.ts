import { describe, expect, it } from 'vitest'
import { parseDesktopChannelProfile } from 'dsh-plugin-desktop/desktop-channel'
import {
  absolutizeChannelAssets,
  asChannelPayload,
  brandChannel,
  channelTitle,
  DEFAULT_CHANNEL,
  mergeChannel,
  NEUTRAL_CHANNEL,
  stripRelativeAssetURLs,
  type ChannelConfig,
} from '../src/channel-content.ts'

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

  it('carries the packaged logo so the UI never falls back to the vendor mark', () => {
    // 随包 logo（组装期内联的 data: URI）：服务端不可达、或服务端还是旧版
    // （没有 /api/client/v2/channel）时，登录页与侧边栏显示的就是它。没有它，
    // 客户端只能回落编译期内置的官方花括号 mark —— 白标客户在登录页看到厂商图形
    // （2026-09-11 在 moka 渠道线上实测到）。
    const content = brandChannel({
      login: { displayName: 'Acme', shortName: 'Acme' },
      client: { displayName: 'Acme AI' },
      logoURL: 'data:image/svg+xml;base64,PHN2Zy8+',
      logoDarkURL: 'data:image/svg+xml;base64,REFSSw==',
    })
    expect(content.login?.logo_url).toBe('data:image/svg+xml;base64,PHN2Zy8+')
    expect(content.login?.logo_url_dark).toBe('data:image/svg+xml;base64,REFSSw==')
    expect(content.client?.logo_url).toBe('data:image/svg+xml;base64,PHN2Zy8+')
  })

  it('omits the logo keys entirely when the channel brings none', () => {
    const content = brandChannel({ login: { displayName: 'Acme' } })
    expect(content.login).not.toHaveProperty('logo_url')
    expect(content.client).not.toHaveProperty('logo_url')
    expect(content.login).not.toHaveProperty('logo_url_dark')
  })

  it('uses the official content only when there is no channel package at all', () => {
    // 本地开发/官方构建:没有渠道包 → 官方内容(与改造前逐字节一致)。
    expect(brandChannel(undefined)).toEqual(DEFAULT_CHANNEL)
  })

  it('treats a materialized empty brand object as "no channel brand"', () => {
    // schemastery 会把未注入的 brand 物化成 `{}` —— 那不是"渠道没写品牌",
    // 而是"根本没注入渠道品牌"。判成渠道会让官方构建改名成中性占位
    // (2026-09-10 实测:官方 E2E 标题变成 "Harness")。
    expect(brandChannel({})).toEqual(DEFAULT_CHANNEL)
  })

  it('gets its neutral fallback from the packaged-brand layer, not from here', () => {
    // 渠道构建里"包里没写品牌"已经由 desktop-channel.ts 落成中性名再注入,
    // 所以这一层只需要逐字段覆盖。用真实解析链验证:只写 channel_id 的包
    // 不会漏出厂商名。
    const bare = parseDesktopChannelProfile({ channel_id: 'acme' })
    expect(bare?.brand.client.displayName).toBe('Harness')
    const mapped = brandChannel(bare?.brand)
    expect(mapped.client?.display_name).toBe('Harness')
    expect(mapped.login?.display_name).toBe('Harness')
    expect(JSON.stringify(mapped)).not.toContain('PicoAide')
  })

  it('treats whitespace-only fields as absent (official base)', () => {
    const out = brandChannel({ title: '   ', login: { displayName: '', tagline: '  ' }, client: { displayName: ' ' } })
    expect(out.login?.display_name).toBe(DEFAULT_CHANNEL.login?.display_name)
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

/**
 * 服务端下发 **叠在** 随包品牌之上。
 *
 * 这条是白标的最后一道防线:服务端那份内容缺字段时(旧服务端、渠道配置没打进
 * 镜像、字段被清空),消费方绝不能回落到内置的**厂商**文案 —— 渠道客户会看到
 * PicoAide,而链路上一处报错都没有。
 */
describe('mergeChannel', () => {
  const packaged = brandChannel({
    title: 'Zephyr AI',
    login: { displayName: 'Zephyr', shortName: 'Zephyr', tagline: '员工统一入口', welcome: '欢迎' },
    client: { displayName: 'Zephyr AI', shortName: 'Zephyr', tagline: '企业内部平台' },
  })

  it('keeps server values when the server supplies them', () => {
    const merged = mergeChannel(packaged, {
      title: 'Zephyr 门户',
      login: { display_name: 'Zephyr 登录' },
      client: { display_name: 'Zephyr 工作台' },
    })
    expect(merged.title).toBe('Zephyr 门户')
    expect(merged.login?.display_name).toBe('Zephyr 登录')
    expect(merged.client?.display_name).toBe('Zephyr 工作台')
  })

  it('fills missing/empty server fields from the packaged brand', () => {
    // 空串与缺失同义:两者都不能让消费方回落内置厂商文案。
    const merged = mergeChannel(packaged, {
      title: '',
      login: { display_name: '', tagline: '', welcome: '' },
      client: { display_name: '', short_name: '', tagline: '' },
    })
    expect(merged.title).toBe('Zephyr AI')
    expect(merged.login?.display_name).toBe('Zephyr')
    expect(merged.client?.short_name).toBe('Zephyr')
    expect(JSON.stringify(merged)).not.toContain('PicoAide')
  })

  it('never drops the server-only asset fields', () => {
    const merged = mergeChannel(packaged, {
      login: { logo_url: 'https://srv/login.svg' },
      client: { logo_url: 'https://srv/client.svg' },
      favicon_url: 'https://srv/favicon.svg',
      accent: '#123456',
    })
    expect(merged.login?.logo_url).toBe('https://srv/login.svg')
    expect(merged.client?.logo_url).toBe('https://srv/client.svg')
    expect(merged.favicon_url).toBe('https://srv/favicon.svg')
    expect(merged.accent).toBe('#123456')
  })

  it('carries the dark logo through too', () => {
    // 服务端配了 assets.logo_dark 才下发 login.logo_url_dark；此前这里的 login
    // 对象只带亮色 logo，暗色那条数据链被静默掐断（2026-09-10 与绝对化同轮发现）。
    const merged = mergeChannel(packaged, {
      login: { logo_url: 'https://srv/login.svg', logo_url_dark: 'https://srv/login-dark.svg' },
    })
    expect(merged.login?.logo_url_dark).toBe('https://srv/login-dark.svg')
  })

  it('does not invent a dark logo when the server has none', () => {
    const merged = mergeChannel(packaged, { login: { logo_url: 'https://srv/login.svg' } })
    expect(merged.login).not.toHaveProperty('logo_url_dark')
  })

  it('is a no-op for the official channel', () => {
    // 官方渠道:base 就是官方内置内容,叠加结果与改造前一致。
    const merged = mergeChannel(DEFAULT_CHANNEL, { title: '', login: {}, client: {} })
    expect(merged.title).toBe(DEFAULT_CHANNEL.title)
    expect(merged.client?.display_name).toBe(DEFAULT_CHANNEL.client?.display_name)
  })
})

describe('channelTitle', () => {
  it('prefers the channel title, then the client name, then the built-in title', () => {
    expect(channelTitle({ title: 'Zephyr 门户' })).toBe('Zephyr 门户')
    expect(channelTitle({ client: { display_name: 'Zephyr AI' } })).toBe('Zephyr AI')
    expect(channelTitle(null)).toBe(DEFAULT_CHANNEL.title)
    expect(channelTitle({ title: '' })).toBe(DEFAULT_CHANNEL.title)
  })
})

/**
 * 载荷结构校验:`/api/pico/channel` 回来的东西**必须像渠道内容**才能进 store。
 *
 * 2026-09-10 实测事故链(E2E 抓到):mock/旧服务端对未知路由回 `{ok:true}`,
 * 客户端把它当渠道内容存下 → 每个品牌字段取不到值 → 侧边栏与窗口标题回落到
 * 内置的**厂商**文案;而链路上零报错(12/13 通过,只有品牌断言红)。
 */
describe('asChannelPayload', () => {
  it('accepts a real channel payload', () => {
    const payload = { title: 'Zephyr AI', login: { display_name: 'Zephyr' }, client: { display_name: 'Zephyr AI' } }
    expect(asChannelPayload(payload)).toEqual(payload)
  })

  it('accepts a payload that carries only the server-only logo fields', () => {
    // logo 也是品牌内容:有它就说明这是渠道端点回的。
    expect(asChannelPayload({ login: { logo_url: '/api/client/v2/channel/logo' } })).toBeDefined()
    expect(asChannelPayload({ client: { logo_url: '/api/client/v2/channel/logo' } })).toBeDefined()
  })

  it('rejects a payload that carries only a favicon (no name, no logo)', () => {
    // 只有 favicon 的载荷没有"名字":采纳它等于把品牌字段留空,消费方照样
    // 回落到内置厂商文案 —— 宁可当作没有,让调用方用随包品牌兜底。
    expect(asChannelPayload({ favicon_url: '/favicon.ico' })).toBeUndefined()
  })

  it.each([
    ['a gateway fallback object', { ok: true }],
    ['an error envelope', { error: { code: 'NOT_FOUND', message: 'not found' } }],
    ['an empty object', {}],
    ['a brand-less but shaped object', { title: '', login: { display_name: '' }, client: { display_name: '' } }],
    ['a string', 'ok'],
    ['an array', []],
    ['null', null],
  ])('rejects %s', (_case, value) => {
    expect(asChannelPayload(value)).toBeUndefined()
  })
})

/**
 * 素材 URL 绝对化/丢弃：**裂图的直接原因就在这一层**（2026-09-10）。
 *
 * 服务端下发的 logo_url/favicon_url 是相对路径（`/api/client/v2/channel/logo`），
 * 而消费它的是 `<img src>` —— 在 Electron 渲染层相对路径会打到**本地** webServer
 * （那里没有服务端命名空间的路由）→ 404 → 界面上就是一张裂图。所以：有服务端地址
 * 就拼成绝对 URL，没有就**丢掉**（让消费方回落到内置品牌图形），绝不把相对地址
 * 交给渲染层。
 */
describe('absolutizeChannelAssets', () => {
  const RELATIVE: ChannelConfig = {
    channel_id: 'acme',
    login: { display_name: 'Acme', tagline: '', welcome: '', logo_url: '/api/client/v2/channel/logo', logo_url_dark: '/api/client/v2/channel/logo-dark' },
    client: { display_name: 'Acme AI', short_name: 'Acme', tagline: '', logo_url: '/api/client/v2/channel/logo' },
    favicon_url: '/api/client/v2/channel/favicon',
    accent: '#2563eb',
  }

  it('resolves every asset URL against the server address', () => {
    const out = absolutizeChannelAssets(RELATIVE, 'https://ai.example.com/')
    expect(out.login?.logo_url).toBe('https://ai.example.com/api/client/v2/channel/logo')
    expect(out.login?.logo_url_dark).toBe('https://ai.example.com/api/client/v2/channel/logo-dark')
    expect(out.client?.logo_url).toBe('https://ai.example.com/api/client/v2/channel/logo')
    expect(out.favicon_url).toBe('https://ai.example.com/api/client/v2/channel/favicon')
  })

  it('keeps the non-URL fields untouched', () => {
    const out = absolutizeChannelAssets(RELATIVE, 'https://ai.example.com')
    expect(out.channel_id).toBe('acme')
    expect(out.client?.short_name).toBe('Acme')
    expect(out.accent).toBe('#2563eb')
  })

  it('leaves already-absolute URLs alone', () => {
    const out = absolutizeChannelAssets(
      { client: { logo_url: 'https://cdn.example.com/logo.svg' } },
      'https://ai.example.com',
    )
    expect(out.client?.logo_url).toBe('https://cdn.example.com/logo.svg')
  })

  it('does not mutate its input', () => {
    const input: ChannelConfig = { client: { logo_url: '/api/logo' } }
    absolutizeChannelAssets(input, 'https://ai.example.com')
    expect(input.client?.logo_url).toBe('/api/logo')
  })

  it('keeps data: URIs untouched (they are complete URLs, not paths)', () => {
    // 随包内联 logo 走的就是 data:：既不能拼服务端地址，也不能当"相对路径"丢掉
    // （丢了等于白标 logo 在播种那一步被抹掉）。
    const out = absolutizeChannelAssets(
      { login: { logo_url: 'data:image/svg+xml;base64,PHN2Zy8+' }, client: { logo_url: 'data:image/svg+xml;base64,PHN2Zy8+' } },
      'https://ai.example.com',
    )
    expect(out.login?.logo_url).toBe('data:image/svg+xml;base64,PHN2Zy8+')
    expect(out.client?.logo_url).toBe('data:image/svg+xml;base64,PHN2Zy8+')
    // 没有服务端地址时同样保留（服务端不可达正是它要顶上的场景）。
    const offline = stripRelativeAssetURLs({ login: { logo_url: 'data:image/svg+xml;base64,PHN2Zy8+' } })
    expect(offline.login?.logo_url).toBe('data:image/svg+xml;base64,PHN2Zy8+')
  })

  it('drops relative URLs when there is no server address to resolve them', () => {
    const out = absolutizeChannelAssets(RELATIVE, '')
    expect(out.login).not.toHaveProperty('logo_url')
    expect(out.login).not.toHaveProperty('logo_url_dark')
    expect(out.client).not.toHaveProperty('logo_url')
    expect(out).not.toHaveProperty('favicon_url')
    // 其余字段照旧（丢了素材不能顺手把白标也丢了）。
    expect(out.client?.short_name).toBe('Acme')
    expect(out.channel_id).toBe('acme')
  })
})

describe('stripRelativeAssetURLs', () => {
  it('removes relative asset URLs but keeps absolute ones', () => {
    const out = stripRelativeAssetURLs({
      login: { logo_url: '/api/client/v2/channel/logo', logo_url_dark: 'https://cdn.example.com/dark.svg' },
      client: { display_name: 'Acme AI', logo_url: '/api/client/v2/channel/logo' },
      favicon_url: '/api/client/v2/channel/favicon',
      accent: '#2563eb',
    })
    expect(out.login).not.toHaveProperty('logo_url')
    expect(out.login?.logo_url_dark).toBe('https://cdn.example.com/dark.svg')
    expect(out.client).not.toHaveProperty('logo_url')
    expect(out.client?.display_name).toBe('Acme AI')
    expect(out).not.toHaveProperty('favicon_url')
  })
})
