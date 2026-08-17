import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings slot contract (settings.section) and the
// slot runtime props into this compilation face.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ConnectorsSection } from './ConnectorsSection.tsx'

/** Stable Cordis plugin name for the connectors client half. */
export const name = 'pico-connectors-client'

/** Services required: the slot registry for settings pages. */
export const inject = ['slots']

/**
 * Register the connectors settings section (mirrors WorkBuddy's connector
 * center): a per-connector card list with connect/disconnect and the auth
 * request surfaces (OAuth redirect, device code, token form).
 * @param ctx - browser Cordis context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.register({
      name: 'settings.section',
      id: 'connectors',
      order: 500,
      label: '连接器',
    }, ConnectorsSection),
    'connectors: settings section',
  )
}
