import type { Context } from '@deepseek-ai/cordis'
import { SESSION_CHANGED_EVENT } from './session-service.ts'
import { fetchJSON } from './server-connector/auth.ts'
import type { Session } from './server-connector/config.ts'

/** Client-facing brand configuration (mirrors server /api/brand). */
export interface BrandConfig {
  enabled: boolean
  login?: { logo_url?: string; display_name?: string; tagline?: string; welcome?: string }
  client?: { logo_url?: string; display_name?: string; tagline?: string; accent?: string }
  favicon_url?: string
  title?: string
}

/** Default/favorite brand when the server has no custom brand. */
export const DEFAULT_BRAND: BrandConfig = {
  enabled: false,
  login: { display_name: 'PicoAide', tagline: 'Enterprise AI Gateway', welcome: '' },
  client: { display_name: 'PicoAide Harness', tagline: '', accent: '' },
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
 * Sync the server brand on session changes: login → fetch /api/brand with the
 * session token; logout → reset to DEFAULT_BRAND. Emits 'pico/brand-changed'
 * so client slots re-render with the server-driven brand.
 */
export function apply(ctx: Context): void {
  const sync = async (session: Session | null): Promise<void> => {
    if (session === null) {
      ctx.emit('pico/brand-changed', null)
      return
    }
    try {
      const brand = await fetchJSON(session.serverURL, '/api/brand', { token: session.token })
      ctx.emit('pico/brand-changed', (brand as BrandConfig) ?? null)
    } catch {
      // Unreachable server: fall back to default (client keeps local brand).
      ctx.emit('pico/brand-changed', null)
    }
  }

  ctx.on(SESSION_CHANGED_EVENT, (session) => { void sync(session).catch(() => undefined) })
}
