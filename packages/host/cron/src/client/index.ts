import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
/**
 * Cron plugin client half: registers the sidebar foot trigger and the
 * main-area job center unconditionally, plus two optional faces that exist only
 * where their owning rows do — the scheduled-job tab in the official right
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
// Type-only: the sidebar shell's footer slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: the official right Sidebar's tab registry, seats, and `ctx.sidebarRight`.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Type-only: the keyed slot declaration (settings.plugin.item).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
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
import { CronTrigger } from './CronTrigger.tsx'
import { mountCronPanel } from './panel-mount.tsx'
import { en, t, zh } from './locales.ts'

// Required services only: the right Sidebar's tab registry is NOT here. It is
// provided by the rc.2 `ui-sidebar-right` row, and a hard `inject` on a service
// an optional row provides leaves this fiber pending forever when the row is
// absent — taking the sidebar foot entry, the main-area center, and the settings
// card down with the tab, with no error anywhere (P1-7). The tab is registered
// inside its own `ctx.inject` scope below instead.
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

  // Browser cron face: sibling plugins reach schedules through this client
  // service (the Host half's picoCronService is not visible to the browser).
  // Same HTTP/SSE transport as the job center.
  const browserCron = new HttpBrowserCronService(new HttpCronTransport())
  ctx.effect(() => {
    browserCron.start()
    return () => browserCron.dispose()
  }, 'dsh-cron: browser cron service')
  ctx.provide(BROWSER_CRON_SERVICE, browserCron)

  // Settings card: one staged form over the cron namespace (registered by
  // the Host half; keying on the namespace pairs the two halves). The card's
  // slot (`settings.plugin.item`) is declared by the upstream
  // `ui-settings-plugins` row, which the desktop profile disables on purpose
  // (packages/host/desktop/cordis.patch.yml: the desktop hides the upstream
  // plugins tab), so this card is intentionally invisible on desktop. Probe the
  // declaration instead of waiting on it: `slots.inject` is silent when the
  // declaration never arrives, which reads as a broken render rather than a
  // configured absence. `spec` is the probe — a declared keyed slot is empty
  // until its cards register, so `entries` would not distinguish the two.
  // The declaration precedes this row in every composed roster (the Web
  // bundle's rows come first, this package's insert last), so one probe at
  // apply time sees it whenever the row is enabled.
  const settingsScope = ctx.get('settingsScope') as { bind<S>(spec: SettingsScopeSpec<S>): SettingsScope<S> } | undefined
  if (settingsScope !== undefined && ctx.slots.spec('settings.plugin.item') !== undefined) {
    const scope = settingsScope.bind<CronSettings>({ namespace: CRON_NS })
    const card = new CronSettingsCardController(scope)
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: CRON_NS,
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
  // Session jump: execution detail's "open session" button targets the shell.
  const sessions = ctx.get('sessions') as { open(id: string): void } | undefined
  const openSession = sessions === undefined ? undefined : (id: string) => { sessions.open(id) }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'pico-cron',
    order: -10,
  }, CronTrigger))
  ctx.effect(() => mountCronPanel(controller, workspacesService, api, openSession), 'dsh-cron: main-area center')
  // Scheduled-job tab in the official right Sidebar (rc.2). The type
  // definition carries the chip title and the guide entry, and the body is a
  // keyed registration under the definition's own id. The tab shares the same
  // controller as the sidebar foot entry and the main-area center, so all
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
      guide: [{ order: 30, title: () => t('job.listTitle') }],
    }), 'dsh-cron: right sidebar tab type')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab',
      key: CRON_TAB_ID,
      locale: LOCALE_NS,
      inject: () => tabProps,
    }, CronJobTab)), 'dsh-cron: right sidebar tab body')
  })
}
