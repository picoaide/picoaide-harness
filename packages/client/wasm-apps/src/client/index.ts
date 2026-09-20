import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the slot runtime props + SlotMap into this compilation face.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: declares the sidebar foot action slot contract
// (`sidebar.footer.action`) and its `wide` runtime prop.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AppCenterTrigger } from './AppCenterTrigger.tsx'
import { mountAppCenterPanel } from './app-center-surface.tsx'
import { APP_FOREIGN_DEEP_LINK_EVENT, showAppToast } from './app-toast.tsx'
import { en, setActiveLocale, type AppCenterKey, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** App Center surface copy. */
    'app-center': AppCenterKey
  }
}

/** Stable Cordis plugin name for the App Center client half. */
export const name = 'picoaide-wasm-apps-client'

/** Locale namespace owning the App Center copy. */
const LOCALE_NS = 'app-center'

/** Services required: the slot registry (mounting the entry) and locale. */
export const inject = ['slots', 'locale']

/**
 * Register the App Center surfaces: the sidebar foot action that opens the
 * catalog panel. All data comes from the local `/api/pico/apps/wasm` route
 * owned by `@picoaide/dsh-enterprise` — this half never talks to the gateway
 * directly (the employee token lives in the host).
 * @param ctx - browser Cordis context.
 */
export function apply(ctx: ClientContext): void {
  // App Center dictionaries (zh key source, en mirror).
  ctx.effect(() => {
    const off = ctx.locale.register(LOCALE_NS, { zh, en })
    return () => { off() }
  }, 'wasm-apps: client dictionaries')

  // Follow the active locale so the module-level `t()` renders in English when
  // that is the user's choice (the upstream renderer re-renders slot outlets on
  // locale revision changes, so a plain lookup is enough — same as the
  // enterprise/account-card dictionaries).
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
  }, 'wasm-apps: follow active locale')

  // 异渠道深链的一次性提示（§5.3/§19 Q5）：宿主只广播"这条链接属于别的安装"，
  // 文案与渲染在这一半（见 app-toast.tsx 的接缝说明）。
  ctx.effect(
    () => ctx.on(APP_FOREIGN_DEEP_LINK_EVENT, () => { showAppToast({ kind: 'foreign-deep-link' }) }),
    'wasm-apps: foreign deep-link toast',
  )

  // Sidebar foot action: same slot every other user-facing panel uses
  // (capability center / browser / account card), so it is reachable without
  // any layout of its own. Order keeps the app center right below the
  // capability center row.
  ctx.effect(
    () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'wasm-app-center',
      order: 2,
    }, AppCenterTrigger)),
    'wasm-apps: sidebar app center entry',
  )

  // Center-column page: mounted once at plugin boot (the container lives in the
  // conversation column, outside React's tree), so the panel survives sidebar
  // re-layouts. Switching semantics are shared with cron / capability center /
  // connectors — see `@picoaide/dsh-panel-surface`.
  ctx.effect(() => mountAppCenterPanel(), 'wasm-apps: app center surface')
}
