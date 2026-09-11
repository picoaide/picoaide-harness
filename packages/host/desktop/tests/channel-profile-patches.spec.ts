import { describe, expect, it } from 'vitest'
import { parseDesktopChannelProfile } from '../src/desktop-channel.ts'
import { channelProfilePatches } from '../src/profile.ts'

/**
 * 渠道包 → 插件行 config 的**注入链**（白标的接缝）。
 *
 * 单独钉这一层是因为它同时决定三件事，任何一处漏掉都是"渠道客户看到厂商品牌"
 * 或"客户端连不上自家服务端"：登录页要能在认证前显示渠道品牌、客户端界面要有
 * 随包兜底、连接器 OAuth 的同意页要用渠道名。
 */
const ALL_ROWS = new Set(['picoaide-auth-gate', 'picoaide-channel-sync', 'pico-connectors', 'picoaide-session'])

/** 一份完整的渠道包内容（与服务端镜像读的是同一个文件）。 */
function acmeProfile(): ReturnType<typeof parseDesktopChannelProfile> {
  return parseDesktopChannelProfile({
    schema: 1,
    channel_id: 'acme',
    identity: { display_name: 'Acme AI', short_name: 'Acme', tagline: '企业内部平台' },
    copy: { login_display_name: 'Acme', client_display_name: 'Acme AI' },
    defaults: { server_url: 'https://ai.acme.example.com' },
    desktop: { product_name: 'Acme AI', deep_link_scheme: 'acmeai' },
  })
}

function configOf(patches: Array<Record<string, unknown>>, id: string): Record<string, unknown> {
  const patch = patches.find(candidate => candidate.id === id)
  expect(patch, `patch for ${id} must exist`).toBeDefined()
  return patch!.config as Record<string, unknown>
}

describe('channel package → row config', () => {
  it('injects nothing when there is no channel package (official unchanged)', () => {
    // 本地开发/官方构建:一个 patch 都不加,行为与渠道化改造前逐字节一致。
    expect(channelProfilePatches(undefined, ALL_ROWS)).toEqual([])
  })

  it('carries the server URL and the brand to the login gate in one patch', () => {
    // 同一行只能 patch 一次:分成两条时后一条会整体覆盖前一条的 config。
    const patches = channelProfilePatches(acmeProfile(), ALL_ROWS)
    expect(patches.filter(p => p.id === 'picoaide-auth-gate')).toHaveLength(1)
    expect(configOf(patches, 'picoaide-auth-gate')).toEqual({
      defaultServer: 'https://ai.acme.example.com',
      brand: {
        channelId: 'acme',
        title: 'Acme AI',
        login: { displayName: 'Acme', shortName: 'Acme', tagline: '企业内部平台', welcome: '' },
        client: { displayName: 'Acme AI', shortName: 'Acme', tagline: '企业内部平台' },
      },
    })
  })

  it('carries the same brand to the client shell row', () => {
    const patches = channelProfilePatches(acmeProfile(), ALL_ROWS)
    expect(configOf(patches, 'picoaide-channel-sync')).toEqual({
      brand: configOf(patches, 'picoaide-auth-gate').brand,
    })
  })

  it('names the connector client after the channel product, never the vendor', () => {
    const patches = channelProfilePatches(acmeProfile(), ALL_ROWS)
    expect(configOf(patches, 'pico-connectors')).toEqual({ clientName: 'Acme AI Connector' })
    expect(JSON.stringify(patches)).not.toContain('PicoAide')
  })

  it('injects the deep-link scheme into the session row (channel SSO callback)', () => {
    // 渠道客户端的浏览器 SSO 回调用的是客户自己的 scheme（如 acmeai）。
    // 会话服务**不能**自己读随包 channel.json（enterprise 的 lib 是 tsdown 内联
    // 产物，那条相对路径在包里不存在），scheme 只能由桌面壳在组装期注入。
    expect(configOf(channelProfilePatches(acmeProfile(), ALL_ROWS), 'picoaide-session'))
      .toEqual({ deepLinkScheme: 'acmeai' })

    // 渠道包没配 scheme → 官方值（与 electron-builder protocols / 服务端 OIDC 同序）
    const bare = parseDesktopChannelProfile({ channel_id: 'acme', identity: { display_name: 'Acme AI' } })
    expect(configOf(channelProfilePatches(bare, ALL_ROWS), 'picoaide-session'))
      .toEqual({ deepLinkScheme: 'picoaide' })
  })

  it('omits the server URL but still injects the brand when the channel has none', () => {
    // 没配域名 = 保持两步登录(不是"配了个空地址");品牌仍然必须随包。
    const profile = parseDesktopChannelProfile({
      channel_id: 'acme',
      identity: { display_name: 'Acme AI', short_name: 'Acme' },
    })
    const gate = configOf(channelProfilePatches(profile, ALL_ROWS), 'picoaide-auth-gate')
    expect(gate).not.toHaveProperty('defaultServer')
    expect(gate.brand).toBeDefined()
  })

  it('carries the packaged logo to both brand consumers', () => {
    // 随包 logo 必须在 auth-gate（登录页）与 channel-sync（客户端界面）两份 config
    // 里都到位：只有一处有 = 另一个界面在服务端不可达时又回到官方兜底图形。
    const profile = parseDesktopChannelProfile({
      schema: 1,
      channel_id: 'acme',
      identity: { display_name: 'Acme AI', short_name: 'Acme' },
      assets: { logo_inline: 'data:image/svg+xml;base64,PHN2Zy8+', logo_dark_inline: 'data:image/svg+xml;base64,PHN2Zy8+' },
      desktop: { deep_link_scheme: 'acmeai' },
    })
    const patches = channelProfilePatches(profile, ALL_ROWS)
    for (const id of ['picoaide-auth-gate', 'picoaide-channel-sync']) {
      const brand = configOf(patches, id).brand as Record<string, unknown>
      expect(brand.logoURL).toBe('data:image/svg+xml;base64,PHN2Zy8+')
      expect(brand.logoDarkURL).toBe('data:image/svg+xml;base64,PHN2Zy8+')
    }
  })

  it('ignores a non-data logo (a channel package must not steer requests at will)', () => {
    const profile = parseDesktopChannelProfile({
      schema: 1,
      channel_id: 'acme',
      identity: { display_name: 'Acme AI' },
      assets: { logo_inline: 'https://tracker.example.com/pixel.svg' },
      desktop: { deep_link_scheme: 'acmeai' },
    })
    const brand = configOf(channelProfilePatches(profile, ALL_ROWS), 'picoaide-channel-sync').brand as Record<string, unknown>
    expect(brand).not.toHaveProperty('logoURL')
  })

  it('skips rows the profile does not have', () => {
    // web 组装没有 auth-gate/channel-sync 行:注入不存在的行会被 loader 拒绝。
    const patches = channelProfilePatches(acmeProfile(), new Set(['pico-connectors']))
    expect(patches.map(p => p.id)).toEqual(['pico-connectors'])
  })

  it('never emits a vendor brand for a channel package without brand copy', () => {
    // 渠道包存在但品牌为空 = 注入链断了:中性占位(不是厂商名)。
    const profile = parseDesktopChannelProfile({ channel_id: 'acme', desktop: { product_name: '' } })
    const brand = configOf(channelProfilePatches(profile, ALL_ROWS), 'picoaide-auth-gate').brand
    expect(JSON.stringify(brand)).not.toContain('PicoAide')
    expect((brand as { client: { displayName: string } }).client.displayName).toBe('Harness')
  })
})
