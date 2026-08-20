import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { BrowserTrigger } from './BrowserTrigger.tsx'
import { en, type BrowserKey, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Browser client surface copy. */
    browser: BrowserKey
  }
}

/**
 * Browser client half: registers the embedded-browser panel as a sidebar foot
 * action. The panel drives the native WebContentsView through the loopback
 * browser API; the view itself is layered over the panel's placeholder by the
 * host plugin.
 */
export const name = 'pico-browser-client'

const LOCALE_NS = 'browser'

/** Services required: the slot registry for sidebar actions. */
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  // Browser client dictionaries (zh key source, en mirror).
  ctx.effect(() => {
    const off = ctx.locale.register(LOCALE_NS, { zh, en })
    return () => { off() }
  }, 'browser: client dictionaries')
  // Hover feedback matching the skill center trigger (P3-11).
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = '.pico-browser-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }'
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'browser: trigger hover style')

  ctx.effect(
    () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'browser-center',
      order: 1,
    }, BrowserTrigger)),
    'browser: sidebar browser panel action',
  )
}
