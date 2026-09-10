import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandChannel, DEFAULT_CHANNEL, type BrandConfig, type ChannelConfig } from './channel-content.ts'
import { SESSION_CHANGED_EVENT } from './session-service.ts'
import { fetchJSON } from './server-connector/auth.ts'
import type { Session } from './server-connector/config.ts'

// 类型与内置值住在 channel-content.ts（纯数据，客户端面也能值导入）；
// 这里**转出**它们，保持 `@picoaide/dsh-enterprise/channel-sync` 这个既有入口
// 的对外形状不变（消费方与测试都在用）。
export { brandChannel, DEFAULT_CHANNEL, type BrandConfig, type ChannelConfig }

export interface Config {
  brand?: BrandConfig
}

/** 组装期注入的品牌文案（`profile.ts` 从渠道包读取后写入本行 config）。 */
export const Config: z<Config> = z.object({
  brand: z.object({
    title: z.string(),
    login: z.object({
      displayName: z.string(),
      shortName: z.string(),
      tagline: z.string(),
      welcome: z.string(),
    }),
    client: z.object({
      displayName: z.string(),
      shortName: z.string(),
      tagline: z.string(),
    }),
  }),
})

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Emitted whenever the server channel config changes (login/logout/restore). */
    'pico/channel-changed'(channel: ChannelConfig | null): void
  }
}

/** Stable Cordis plugin name. */
export const name = 'channel-sync'

/** Services consumed: session + web server (for the login page channel fetch). */
export const inject = ['picoSession']

/**
 * Sync the server channel content on session changes: login → fetch
 * /api/client/v2/channel with the session token; logout → reset to
 * DEFAULT_CHANNEL. Emits 'pico/channel-changed' so client slots re-render with
 * the server-driven channel content.
 *
 * 2026-09: 服务端下发的 logo_url/favicon_url 是相对路径(如
 * /api/client/v2/channel/logo,命名空间唯一真源 internal/router)。
 * 客户端面没有到网关的通用反代,<img> 直接用相对路径会打到本地 webServer
 * 而 404 —— 这里解析为绝对 URL(拼 session.serverURL, 保持 https/回环校验)。
 */
function absolutizeURLs(channel: ChannelConfig, serverURL: string): ChannelConfig {
  // 2026-09-06 CodeQL js/polynomial-redos:尾部斜杠剥离改为无正则形式
  // (原 /\/+$/ 被保守标为多项式回溯;while 循环语义等价)。
  let server = serverURL
  while (server.endsWith('/')) server = server.slice(0, -1)
  const abs = (u?: string): string | undefined =>
    u === undefined || u === '' ? undefined : u.startsWith('http') ? u : server + u
  // exactOptionalPropertyTypes: 可选属性不可显式置 undefined——
  // 用条件展开保留/删除, 不产生 {attr: undefined}。
  const loginLogo = abs(channel.login?.logo_url)
  const clientLogo = abs(channel.client?.logo_url)
  const favicon = abs(channel.favicon_url)
  return {
    ...(channel.channel_id !== undefined ? { channel_id: channel.channel_id } : {}),
    title: channel.title ?? '',
    ...(channel.login ? { login: { display_name: channel.login.display_name ?? '', tagline: channel.login.tagline ?? '', welcome: channel.login.welcome ?? '', ...(loginLogo !== undefined ? { logo_url: loginLogo } : {}) } } : {}),
    // short_name 必须原样带过去:侧边栏用它,而它**不来自服务端**
    // (服务端没有这个字段),是随包品牌补进去的 —— 这里丢掉就等于白标丢失。
    ...(channel.client ? { client: { display_name: channel.client.display_name ?? '', ...(channel.client.short_name !== undefined ? { short_name: channel.client.short_name } : {}), tagline: channel.client.tagline ?? '', ...(clientLogo !== undefined ? { logo_url: clientLogo } : {}) } } : {}),
    ...(favicon !== undefined ? { favicon_url: favicon } : {}),
    ...(channel.accent !== undefined ? { accent: channel.accent } : {}),
  }
}

/** 导出供测试: 相对 URL 绝对化(服务端下发 logo_url 的契约, 勿内联)。 */
export const resolveChannelLogoURLs = absolutizeURLs

export function apply(ctx: Context, config: Config = {}): void {
  // 随包品牌(渠道构建下由 profile.ts 从 channel.json 注入)是**未登录/服务端
  // 不可达**时的显示内容。此前这两种情况发 null,客户端各自回落到硬编码的官方
  // 文案 —— 渠道客户于是看到厂商名。现在回落的是"本渠道"内容:官方构建下
  // brandChannel(undefined) 与 DEFAULT_CHANNEL 逐字段等值,行为不变。
  const builtIn = config.brand === undefined ? DEFAULT_CHANNEL : brandChannel(config.brand)

  const sync = async (session: Session | null): Promise<void> => {
    if (session === null) {
      ctx.emit('pico/channel-changed', builtIn)
      return
    }
    try {
      const channel = await fetchJSON(session.serverURL, '/api/client/v2/channel', { token: session.token })
      ctx.emit('pico/channel-changed', (channel as ChannelConfig) ? absolutizeURLs(channel as ChannelConfig, session.serverURL) : builtIn)
    } catch {
      // Unreachable server: keep the packaged brand (never the vendor's).
      ctx.emit('pico/channel-changed', builtIn)
    }
  }

  ctx.on(SESSION_CHANGED_EVENT, (session) => { void sync(session).catch(() => undefined) })
}
