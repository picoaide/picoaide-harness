import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the slot runtime props into this compilation face.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the layout-owned `sidebar` row and the sidebar foot
// action slot contract into SlotMap.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AccountCard } from './AccountCard.tsx'
import { en, type AccountKey, zh } from './locales.ts'

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

  ctx.effect(
    () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'account-card',
      order: 100,
    }, AccountCard)),
    'account-card: sidebar foot mount',
  )
}
