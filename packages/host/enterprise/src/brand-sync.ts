import type { Context } from '@deepseek-ai/cordis'
import { SESSION_CHANGED_EVENT } from './session-service.ts'
import { fetchJSON } from './server-connector/auth.ts'
import type { Session } from './server-connector/config.ts'

/** Client-facing brand configuration (mirrors server /api/client/v2/brand). */
export interface BrandConfig {
  enabled: boolean
  login?: { logo_url?: string; display_name?: string; tagline?: string; welcome?: string }
  client?: { logo_url?: string; display_name?: string; tagline?: string }
  favicon_url?: string
  title?: string
}

/** Default/favorite brand when the server has no custom brand. */
export const DEFAULT_BRAND: BrandConfig = {
  enabled: false,
  login: { display_name: 'PicoAide', tagline: 'Enterprise AI Gateway', welcome: '' },
  client: { display_name: 'PicoAide Harness', tagline: '' },
  title: 'PicoAide Harness',
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Emitted whenever the server brand config changes (login/logout/restore). */
    'pico/brand-changed'(brand: BrandConfig | null): void
  }
}

/** Stable Cordis plugin name. */
export const name = 'brand-sync'

/** Services consumed: session + web server (for the login page brand fetch). */
export const inject = ['picoSession']

/**
 * Sync the server brand on session changes: login → fetch /api/client/v2/brand
 * with the session token; logout → reset to DEFAULT_BRAND. Emits
 * 'pico/brand-changed' so client slots re-render with the server-driven brand.
 *
 * 2026-09: 服务端下发的 logo_url/favicon_url 是相对路径(如
 * /api/client/v2/brand/logo/login,命名空间唯一真源 internal/router)。
 * 客户端面没有到网关的通用反代,<img> 直接用相对路径会打到本地 webServer
 * 而 404 —— 这里解析为绝对 URL(拼 session.serverURL, 保持 https/回环校验)。
 */
function absolutizeURLs(brand: BrandConfig, serverURL: string): BrandConfig {
  const server = serverURL.replace(/\/+$/, '')
  const abs = (u?: string): string | undefined =>
    u === undefined || u === '' ? undefined : u.startsWith('http') ? u : server + u
  // exactOptionalPropertyTypes: 可选属性不可显式置 undefined——
  // 用条件展开保留/删除, 不产生 {attr: undefined}。
  const loginLogo = abs(brand.login?.logo_url)
  const clientLogo = abs(brand.client?.logo_url)
  const favicon = abs(brand.favicon_url)
  return {
    enabled: brand.enabled,
    title: brand.title ?? '',
    ...(brand.login ? { login: { display_name: brand.login.display_name ?? '', tagline: brand.login.tagline ?? '', welcome: brand.login.welcome ?? '', ...(loginLogo !== undefined ? { logo_url: loginLogo } : {}) } } : {}),
    ...(brand.client ? { client: { display_name: brand.client.display_name ?? '', tagline: brand.client.tagline ?? '', ...(clientLogo !== undefined ? { logo_url: clientLogo } : {}) } } : {}),
    ...(favicon !== undefined ? { favicon_url: favicon } : {}),
  }
}

/** 导出供测试: 相对 URL 绝对化(服务端下发 logo_url 的契约, 勿内联)。 */
export const resolveBrandLogoURLs = absolutizeURLs

export function apply(ctx: Context): void {
  const sync = async (session: Session | null): Promise<void> => {
    if (session === null) {
      ctx.emit('pico/brand-changed', null)
      return
    }
    try {
      const brand = await fetchJSON(session.serverURL, '/api/client/v2/brand', { token: session.token })
      ctx.emit('pico/brand-changed', (brand as BrandConfig) ? absolutizeURLs(brand as BrandConfig, session.serverURL) : null)
    } catch {
      // Unreachable server: fall back to default (client keeps local brand).
      ctx.emit('pico/brand-changed', null)
    }
  }

  ctx.on(SESSION_CHANGED_EVENT, (session) => { void sync(session).catch(() => undefined) })
}
