import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
/**
 * Cron plugin client half: registers the foot-lane entry (an entry into the
 * `picoFootMenu` registry owned by `@picoaide/dsh-foot-menu`, which owns the one
 * sidebar foot row) and the main-area job center unconditionally, plus two
 * optional faces that exist only where their owning rows do — the scheduled-job
 * tab in the official right
 * Sidebar (rc.2 `ui-sidebar-right`; `sidebarRightTabs` + the keyed
 * `sidebar.right.pane.tab` body seat) and the settings card
 * (`settings.plugin.item` keyed 'cron', declared by `ui-settings-plugins`, which
 * the desktop profile disables). Neither optional row may take the other
 * surfaces down with it.
 *
 * Client discipline: value imports are limited to the platform module table;
 * @deepseek-ai/* and sibling packages enter type-only. Cross-plugin
 * collaboration goes through cordis services and slots only.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SettingsScope, SettingsScopeSpec } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the foot-lane registry contract (`ctx.picoFootMenu`) and its entry
// shape. Never a runtime import: the registry reaches this bundle as a Cordis
// service, not as a module.
import type {} from '@picoaide/dsh-foot-menu/client'
// Type-only: the official right Sidebar's tab registry, seats, and `ctx.sidebarRight`.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Type-only: the Plugins page's `plugins.item` list-slot declaration. Upstream
// 0.1.6-alpha.2 moved the configuration-card contract from `ui-settings-plugins`
// (which only declared the removed keyed `settings.plugin.item`) to the
// `ui-plugin-manager` page, so this activation moved with it.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// The branded Session identity the navigator accepts (compile-time brand, no runtime cost).
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the `ctx.uiWorkspace` Context merge — the navigation owner
// that replaced `ctx.sessions.open()` in 0.1.6-alpha.2.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { CronKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Cron plugin surface copy. */
    cron: CronKey
  }
}

import { CronController } from './controller.ts'
import { HttpCronTransport } from './host-api.ts'
import { HttpBrowserCronService, type BrowserCronService } from './browser-service.ts'
import { CronJobTab } from './CronJobTab.tsx'
import { CronSettingsCard, CronSettingsCardController, type CronSettings } from './CronSettingsCard.tsx'
import { mountCronPanel, openCronPanel } from './panel-mount.tsx'
import { en, setActiveLocale, t, zh } from './locales.ts'

// Required services only: the right Sidebar's tab registry is NOT here. It is
// provided by the rc.2 `ui-sidebar-right` row, and a hard `inject` on a service
// an optional row provides leaves this fiber pending forever when the row is
// absent — taking the foot-lane entry, the main-area center, and the settings
// card down with the tab, with no error anywhere (P1-7). The tab is registered
// inside its own `ctx.inject` scope below instead.
//
// `picoFootMenu` is deliberately NOT here for the same reason: the row that
// provides it (`@picoaide/dsh-foot-menu`) can be disabled by a channel overlay or
// the machine-wide patch, and a hard inject on a never-provided service leaves
// this fiber pending forever with no error — taking the whole plugin (job
// center + settings card + right-Sidebar tab) down with the entry. The entry is
// registered from a child `ctx.inject` scope instead.
export const inject = ['slots', 'settingsScope', 'locale', 'workspaces', 'connection', 'sessions']

/** Settings namespace this card edits (the Host half registers it). */
const CRON_NS = 'cron'

/** Locale namespace this plugin owns. */
const LOCALE_NS = 'cron'

/** Right-Sidebar tab type identity: the definition id (also the body's seat key). */
const CRON_TAB_ID = 'pico:cron'
/** Right-Sidebar tab kind: what `ctx.sidebarRight.openTab` names. */
const CRON_TAB_KIND = 'pico-cron'

/** Cordis service name of the browser cron face (sibling plugins consume). */
const BROWSER_CRON_SERVICE = 'picoCronService'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser cron face provided by the cron plugin's client half. */
    picoCronService: BrowserCronService
  }
}

export function apply(ctx: ClientContext): void {
  // Dictionaries into the shared locale registry (zh key source, en mirror).
  ctx.effect(() => {
    const offZh = ctx.locale.register(LOCALE_NS, { zh, en })
    return () => { offZh() }
  }, 'dsh-cron: dictionaries')

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

  // Browser cron face: sibling plugins reach schedules through this client
  // service (the Host half's picoCronService is not visible to the browser).
  // Same HTTP/SSE transport as the job center.
  const browserCron = new HttpBrowserCronService(new HttpCronTransport())
  ctx.effect(() => {
    browserCron.start()
    return () => browserCron.dispose()
  }, 'dsh-cron: browser cron service')
  ctx.provide(BROWSER_CRON_SERVICE, browserCron)

  // Settings card: one form over the cron namespace (registered by the Host
  // half; the card edits that namespace). Upstream 0.1.6-alpha.2 replaced the
  // old keyed `settings.plugin.item` with the Plugins page's **list** slot
  // `plugins.item`, whose owner contract adds a `view: 'summary' | 'page'`
  // switch. That slot is declared by the upstream `ui-plugin-manager` page,
  // which the desktop profile disables on purpose
  // (packages/host/desktop/cordis.patch.yml: the desktop owns its own panel
  // chrome), so this card is intentionally invisible on desktop. Probe the
  // declaration instead of waiting on it: `slots.inject` is silent when the
  // declaration never arrives, which reads as a broken render rather than a
  // configured absence. `spec` is the probe — a declared list slot is empty
  // until its cards register, so `entries` would not distinguish the two.
  // The declaration precedes this row in every composed roster (the Web
  // bundle's rows come first, this package's insert last), so one probe at
  // apply time sees it whenever the row is enabled.
  const settingsScope = ctx.get('settingsScope') as { bind<S>(spec: SettingsScopeSpec<S>): SettingsScope<S> } | undefined
  if (settingsScope !== undefined && ctx.slots.spec('plugins.item') !== undefined) {
    const scope = settingsScope.bind<CronSettings>({ namespace: CRON_NS })
    const card = new CronSettingsCardController(scope)
    ctx.slots.inject('plugins.item', () => ctx.slots.register({
      name: 'plugins.item',
      id: 'cron',
      order: 40,
      label: () => t('job.listTitle'),
      locale: LOCALE_NS,
      inject: () => card.inject(),
    }, CronSettingsCard))
  }

  // Sidebar foot entry (global, above the connector center and Settings):
  // one controller drives both the main-area center and the panel tab.
  const controller = new CronController({ transport: new HttpCronTransport() })
  ctx.effect(() => {
    controller.start()
    return () => controller.dispose()
  }, 'controller lifecycle')
  const workspacesService = ctx.get('workspaces') as IWorkspaces | undefined
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  const api = connection?.api
  // Session jump: execution detail's "open session" button asks the Workspace
  // navigator to show that Session. 0.1.6-alpha.2 deleted `ctx.sessions.open()`
  // (the session contract now says navigation belongs to the view owners), so
  // the previous `as { open(id) }` cast compiled while the click threw — the
  // cast is gone, the type comes from the declaring package.
  const navigation = ctx.get('uiWorkspace')
  const openSession = navigation === undefined
    ? undefined
    : (id: string) => { navigation.openSession(id as SessionId) }
  // Foot-lane entry (the single `⋯ 更多` row owned by `@picoaide/dsh-foot-menu`):
  // one controller drives both the main-area center and the panel tab.
  // `order: -10` keeps the job center first in the popover, and `id: 'cron'` is
  // the panel-surface PanelId — the foot row reads it to render `更多 · 定时任务`
  // while this panel is active.
  //
  // 登记放在**子 fiber** 里等服务到位，而不是把 `picoFootMenu` 写进本插件的
  // `inject`：那一行可以被渠道覆盖层或 `$DSH_HOME/cordis.patch.yml` 禁用，硬 inject
  // 会让整条 fiber 永久 pending（**没有任何报错**），把任务中心、设置卡片与右栏标签
  // 一起带走（P1-7 的原话）。这里只有"登记这一个条目"等它，其余面貌照常 apply。
  ctx.inject(['picoFootMenu'], (scope: ClientContext) => {
    scope.effect(() => scope.picoFootMenu.add({
      id: 'cron',
      order: -10,
      title: () => t('job.listTitle'),
      activate: openCronPanel,
    }), 'dsh-cron: foot menu entry')
  })
  ctx.effect(() => mountCronPanel(controller, workspacesService, api, openSession), 'dsh-cron: main-area center')
  // Scheduled-job tab in the official right Sidebar (rc.2). The type
  // definition carries the chip title and the guide entry, and the body is a
  // keyed registration under the definition's own id. The tab shares the same
  // controller as the foot-lane entry and the main-area center, so all
  // three surfaces stay in sync; per-session tab state belongs to the Sidebar.
  //
  // This is an optional face: `sidebarRightTabs` comes from the rc.2
  // `ui-sidebar-right` row, so the tab is registered from a child fiber that
  // waits for that service (the `ctx.inject` idiom upstream uses for
  // `modelDirectories` in ui-model-selection) rather than declared as a
  // required service of this plugin — the row may be absent, and the three
  // other surfaces must not depend on it. A child fiber is also order-proof:
  // the tab appears whenever the service does, whichever roster position the
  // provider has. A separate plugin row is not an option here: the client
  // module table maps one `dsh.client` bundle per package
  // (`exports["./client"]`), so a second client plugin would need a second
  // package.
  ctx.inject(['sidebarRightTabs'], (scope: ClientContext) => {
    const tabProps = {
      controller,
      ...(workspacesService === undefined ? {} : { workspaces: workspacesService }),
      ...(api === undefined ? {} : { api }),
      ...(openSession === undefined ? {} : { openSession }),
    }
    scope.effect(() => scope.sidebarRightTabs.register({
      id: CRON_TAB_ID,
      kind: CRON_TAB_KIND,
      title: () => t('job.listTitle'),
      guide: [{ id: CRON_TAB_ID, order: 30, title: () => t('job.listTitle') }],
    }), 'dsh-cron: right sidebar tab type')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab',
      key: CRON_TAB_ID,
      locale: LOCALE_NS,
      inject: () => tabProps,
    }, CronJobTab)), 'dsh-cron: right sidebar tab body')
  })
}
