import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the slot runtime props into this compilation face.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the layout-owned `sidebar` row and the sidebar foot
// action slot contract into SlotMap.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AccountCard } from './AccountCard.tsx'
import { en, setActiveLocale, type AccountKey, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Account card surface copy. */
    'account-card': AccountKey
  }
}

/** Stable Cordis plugin name for the account card client half. */
export const name = 'picoaide-account-card-client'

/** Locale namespace owning the account card copy. */
const LOCALE_NS = 'account-card'

/** Services required: the slot registry (mounting the card) and locale. */
export const inject = ['slots', 'locale']

/**
 * Register the bottom sidebar account card: it mounts through the
 * `sidebar.footer.action` slot (last, below the sibling foot actions) and
 * portals itself below the Settings seat; the username/logout/balance data
 * all come from the local `/api/pico/*` routes owned by the host half.
 * @param ctx - browser Cordis context.
 */
export function apply(ctx: ClientContext): void {
  // Account card dictionaries (zh key source, en mirror).
  ctx.effect(() => {
    const off = ctx.locale.register(LOCALE_NS, { zh, en })
    return () => { off() }
  }, 'account-card: client dictionaries')

  // Follow the active locale so the module-level `t()` (used by components
  // that do not receive PropsLocale) renders in English when that is the
  // user's choice, instead of always reading the zh key source.
  ctx.effect(() => {
    const locale = ctx.locale as unknown as {
      getLocale?: () => { active?: unknown }
      subscribe?: (listener: () => void) => () => void
    }
    const sync = (): void => {
      try {
        const active = locale.getLocale?.()?.active
        if (typeof active === 'string') setActiveLocale(active)
      } catch { /* keep the last known locale */ }
    }
    sync()
    if (typeof locale.subscribe !== 'function') return () => {}
    return locale.subscribe(sync)
  }, 'follow active locale')

  ctx.effect(
    () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'account-card',
      order: 100,
    }, AccountCard)),
    'account-card: sidebar foot mount',
  )
}
