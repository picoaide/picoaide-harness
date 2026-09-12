import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
/**
 * Cron plugin client half: registers the settings card (settings.plugin.item
 * keyed 'cron'), the sidebar foot trigger, the main-area job center, and the
 * scheduled-job tab in the official right Sidebar (rc.2 `sidebarRightTabs` +
 * the keyed `sidebar.right.pane.tab` body seat).
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

export const inject = ['slots', 'settingsScope', 'locale', 'workspaces', 'connection', 'sessions', 'sidebarRightTabs']

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
  // the Host half; keying on the namespace pairs the two halves).
  const settingsScope = ctx.get('settingsScope') as { bind<S>(spec: SettingsScopeSpec<S>): SettingsScope<S> } | undefined
  if (settingsScope !== undefined) {
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
  // Scheduled-job tab in the official right Sidebar (rc.2): the type
  // definition carries the chip title and the guide entry, and the body is a
  // keyed registration under the definition's own id. The tab shares the same
  // controller as the sidebar foot entry and the main-area center, so all
  // three surfaces stay in sync; per-session tab state belongs to the Sidebar.
  const tabProps = {
    controller,
    ...(workspacesService === undefined ? {} : { workspaces: workspacesService }),
    ...(api === undefined ? {} : { api }),
    ...(openSession === undefined ? {} : { openSession }),
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: CRON_TAB_ID,
    kind: CRON_TAB_KIND,
    title: () => t('job.listTitle'),
    guide: [{ order: 30, title: () => t('job.listTitle') }],
  }), 'dsh-cron: right sidebar tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: CRON_TAB_ID,
    locale: LOCALE_NS,
    inject: () => tabProps,
  }, CronJobTab)), 'dsh-cron: right sidebar tab body')
}
