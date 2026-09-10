import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { absolutizeChannelAssets, brandChannel, DEFAULT_CHANNEL, mergeChannel, type BrandConfig, type ChannelConfig } from './channel-content.ts'
import { subscribeSession } from './session-service.ts'
import { fetchJSON } from './server-connector/auth.ts'
import type { Session } from './server-connector/config.ts'

// 类型与内置值住在 channel-content.ts（纯数据，客户端面也能值导入）；
// 这里**转出**它们，保持 `@picoaide/dsh-enterprise/channel-sync` 这个既有入口
// 的对外形状不变（消费方与测试都在用）。
export { brandChannel, DEFAULT_CHANNEL, mergeChannel, type BrandConfig, type ChannelConfig }

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
  // 单一实现见 channel-content.ts 的 absolutizeChannelAssets:同一份口径被
  // 本地端点(/api/pico/channel)与这里共用,避免"两处各拼一次、其中一处漏字段"
  // (2026-09-10:该函数此前重建 client 对象时丢掉了 logo_url_dark)。
  return absolutizeChannelAssets(channel, serverURL)
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
      // 服务端内容**叠在**随包品牌之上:服务端缺的字段由随包品牌补齐,消费方
      // 就不会回落到内置的厂商文案(渠道构建下那是白标事故)。
      ctx.emit('pico/channel-changed', (channel as ChannelConfig)
        ? mergeChannel(builtIn, absolutizeURLs(channel as ChannelConfig, session.serverURL))
        : builtIn)
    } catch {
      // Unreachable server: keep the packaged brand (never the vendor's).
      ctx.emit('pico/channel-changed', builtIn)
    }
  }

  // subscribeSession 而不是裸 ctx.on：恢复型启动（重启后带着有效会话）下首个
  // 会话事件可能早于本插件 apply，裸订阅会整个漏掉它 —— 服务端驱动的渠道内容
  // （绝对化的 logo、改过的名称/主题色）要等到下次登录才生效（2026-09-10 实测：
  // 侧边栏品牌图裂着，重新登录就好了）。
  subscribeSession(ctx, (session) => { void sync(session).catch(() => undefined) })}
