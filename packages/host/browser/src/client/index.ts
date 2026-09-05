import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
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
 * Browser client half: registers the sidebar foot action that wakes the
 * dedicated browser window. The window (created by the host plugin on first
 * agent open) carries its own tab strip and controls; the sidebar button
 * shows it again after a user close.
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
    'browser: sidebar browser wake action',
  )
}
