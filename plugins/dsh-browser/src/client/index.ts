import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { BrowserTrigger } from './BrowserTrigger.tsx'

/**
 * Browser client half: registers the embedded-browser panel as a sidebar foot
 * action. The panel drives the native WebContentsView through the loopback
 * browser API; the view itself is layered over the panel's placeholder by the
 * host plugin.
 */
export const name = 'pico-browser-client'

/** Services required: the slot registry for sidebar actions. */
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'browser-center',
      order: 1,
    }, BrowserTrigger)),
    'browser: sidebar browser panel action',
  )
}
