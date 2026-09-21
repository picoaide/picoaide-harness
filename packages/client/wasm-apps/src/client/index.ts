import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the slot runtime props + SlotMap into this compilation face.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: declares the sidebar foot action slot contract
// (`sidebar.footer.action`) and its `wide` runtime prop. The App Center's own
// navigation entry lives in the `picoFootMenu` popover now — what still occupies
// the foot slot is the always-mounted toast host.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: the foot-lane registry contract (`ctx.picoFootMenu`). The single
// sidebar foot row belongs to `@picoaide/dsh-foot-menu` and reaches this bundle
// as a Cordis service — never as a module import.
import type {} from '@picoaide/dsh-foot-menu/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AppToastHostMount } from './AppToastHostMount.tsx'
import { mountAppCenterPanel, openAppCenterPanel } from './app-center-surface.tsx'
import { APP_FOREIGN_DEEP_LINK_EVENT, showAppToast } from './app-toast.tsx'
import { en, setActiveLocale, t, type AppCenterKey, zh } from './locales.ts'

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

/** Services required: the slot registry (the toast mount) and locale. `picoFootMenu` is waited on from a child scope. */
export const inject = ['slots', 'locale']

/**
 * Register the App Center surfaces: the foot-lane entry that opens the catalog
 * panel (plus the always-mounted toast host in the sidebar foot slot). All data
 * comes from the local `/api/pico/apps/wasm` route owned by
 * `@picoaide/dsh-enterprise` — this half never talks to the gateway directly
 * (the employee token lives in the host).
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

  // Foot-lane entry: the one `⋯ 更多` row owned by `@picoaide/dsh-foot-menu`
  // collects it. `id: 'apps'` is the panel-surface PanelId (so the row renders
  // `更多 · 应用中心` while the catalog is active) and `order: 2` keeps the app
  // center last, as it was when each plugin owned a full-width row.
  //
  // 登记放在**子 fiber** 里等服务到位，而不是把 `picoFootMenu` 写进 `inject`：
  // 提供它的那一行可以被渠道覆盖层 / `$DSH_HOME/cordis.patch.yml` 禁用，硬 inject
  // 会让整条 fiber 永久 pending（无报错），把应用中心面板与**异渠道深链 toast 的
  // 常驻挂载点**一起带走（P1-7 教训）。只有"登记这一个条目"等它。
  ctx.inject(['picoFootMenu'], (scope: ClientContext) => {
    scope.effect(() => scope.picoFootMenu.add({
      id: 'apps',
      order: 2,
      title: () => t('appCenter.title'),
      activate: openAppCenterPanel,
    }), 'wasm-apps: foot menu entry')
  })

  // Sidebar foot slot: **not a navigation row** — the only thing left here is the
  // always-mounted foreign-deep-link toast host (see AppToastHostMount). It
  // renders no button and takes no layout height, so the bottom lane stays a
  // single `更多` row.
  ctx.effect(
    () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'wasm-app-toast-host',
      order: 2,
    }, AppToastHostMount)),
    'wasm-apps: app toast host mount',
  )

  // Center-column page: mounted once at plugin boot (the container lives in the
  // conversation column, outside React's tree), so the panel survives sidebar
  // re-layouts. Switching semantics are shared with cron / capability center /
  // connectors — see `@picoaide/dsh-panel-surface`.
  ctx.effect(() => mountAppCenterPanel(), 'wasm-apps: app center surface')
}
