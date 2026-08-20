/**
 * Cron plugin client half: registers the settings card (settings.plugin.item
 * keyed 'cron') and, when dsh-better-sidebar is present, the scheduled-job
 * center tab. The sidebar dependency is soft: `ctx.inject(['betterSidebar'])`
 * mounts a child fiber only while the service exists, so the plugin works in
 * compositions without the sidebar and the tab unregisters on service loss.
 *
 * Client discipline: value imports are limited to the platform module table;
 * @deepseek-ai/* and sibling packages enter type-only. Cross-plugin
 * collaboration goes through cordis services and slots only.
 */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientContext, SettingsScope, SettingsScopeSpec } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the sidebar shell's footer slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
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
import { en, zh } from './locales.ts'
import type { BetterSidebarService } from './sidebar-face.ts'

export const inject = ['slots', 'settingsScope', 'locale']

/** Settings namespace this card edits (the Host half registers it). */
const CRON_NS = 'cron'

/** Locale namespace this plugin owns. */
const LOCALE_NS = 'cron'

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

  // Browser cron face: sibling plugins (dsh-task) reach schedules through
  // this client service (the Host half's picoCronService is not visible to
  // the browser). Same HTTP/SSE transport as the job center.
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
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'pico-cron',
    order: -10,
  }, CronTrigger))
  ctx.effect(() => mountCronPanel(controller), 'dsh-cron: main-area center')
  // Scheduled-job center tab in the better-sidebar: a child fiber that lives
  // exactly as long as the service. The tab shares the same controller as
  // the sidebar entry, so both surfaces stay in sync.
  ctx.inject(['betterSidebar'], (childCtx: Context) => {
    const service = childCtx.get('betterSidebar') as BetterSidebarService | undefined
    if (service === undefined) return
    const disposeTab = service.registerTab({
      id: 'pico:cron',
      title: () => zh['job.listTitle'],
      order: 30,
      component: () => createElement(CronJobTab, { controller }),
    })
    childCtx.effect(() => () => { disposeTab() }, 'dsh-cron: better-sidebar tab')
  })
}
