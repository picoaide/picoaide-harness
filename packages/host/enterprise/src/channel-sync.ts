import type { Context } from '@deepseek-ai/cordis'
import { SESSION_CHANGED_EVENT } from './session-service.ts'
import { fetchJSON } from './server-connector/auth.ts'
import type { Session } from './server-connector/config.ts'

/**
 * Client-facing channel configuration (mirrors the server
 * `GET /api/client/v2/channel` payload). 渠道内容总是生效——没有开关字段,
 * 每个字段都可能缺失(渠道未配置该项), 消费方沿用 `?? ''` + 内置兜底。
 */
export interface ChannelConfig {
  channel_id?: string
  title?: string
  login?: { logo_url?: string; display_name?: string; tagline?: string; welcome?: string }
  client?: { logo_url?: string; display_name?: string; tagline?: string }
  favicon_url?: string
  accent?: string
}

/** Built-in channel content used when the server has none (未登录/不可达). */
export const DEFAULT_CHANNEL: ChannelConfig = {
  login: { display_name: 'PicoAide', tagline: 'Enterprise AI Gateway', welcome: '' },
  client: { display_name: 'PicoAide Harness', tagline: '' },
  title: 'PicoAide Harness',
}

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
    ...(channel.client ? { client: { display_name: channel.client.display_name ?? '', tagline: channel.client.tagline ?? '', ...(clientLogo !== undefined ? { logo_url: clientLogo } : {}) } } : {}),
    ...(favicon !== undefined ? { favicon_url: favicon } : {}),
    ...(channel.accent !== undefined ? { accent: channel.accent } : {}),
  }
}

/** 导出供测试: 相对 URL 绝对化(服务端下发 logo_url 的契约, 勿内联)。 */
export const resolveChannelLogoURLs = absolutizeURLs

export function apply(ctx: Context): void {
  const sync = async (session: Session | null): Promise<void> => {
    if (session === null) {
      ctx.emit('pico/channel-changed', null)
      return
    }
    try {
      const channel = await fetchJSON(session.serverURL, '/api/client/v2/channel', { token: session.token })
      ctx.emit('pico/channel-changed', (channel as ChannelConfig) ? absolutizeURLs(channel as ChannelConfig, session.serverURL) : null)
    } catch {
      // Unreachable server: fall back to default (client keeps the built-in channel content).
      ctx.emit('pico/channel-changed', null)
    }
  }

  ctx.on(SESSION_CHANGED_EVENT, (session) => { void sync(session).catch(() => undefined) })
}
