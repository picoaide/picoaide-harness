/**
 * Task plugin client half: registers the sidebar foot entry, the settings
 * card (settings.plugin.item keyed 'task'), the main-area board mount, and
 * the better-sidebar board tab. The cron service is optional: when present,
 * task details gain the scheduled-run section.
 *
 * Client discipline: value imports limited to the platform module table;
 * @deepseek-ai/* and sibling packages enter type-only. Cross-plugin
 * collaboration goes through cordis services and slots only.
 */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientContext, IWorkspaces, SettingsScope, SettingsScopeSpec } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the sidebar shell's footer slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: the keyed slot declaration (settings.plugin.item).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { TaskKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Task plugin surface copy. */
    task: TaskKey
  }
}

import { TaskController } from './controller.ts'
import { HttpTaskTransport } from './host-api.ts'
import { TaskBoard } from './TaskBoard.tsx'
import { TaskSettingsCard, TaskSettingsCardController, type TaskSettings } from './TaskSettingsCard.tsx'
import { TaskTrigger } from './TaskTrigger.tsx'
import { mountTaskBoard } from './board-mount.tsx'
import { en, zh } from './locales.ts'
import type { BetterSidebarService } from './sidebar-face.ts'
import type { CronServiceFace } from './TaskDetail.tsx'

export const inject = ['slots', 'settingsScope', 'locale', 'workspaces', 'sessions']

/** Settings namespace this card edits (the Host half registers it). */
const TASK_NS = 'task'

/** Locale namespace this plugin owns. */
const LOCALE_NS = 'task'

export function apply(ctx: ClientContext): void {
  // Dictionaries into the shared locale registry (zh key source, en mirror).
  ctx.effect(() => {
    const offZh = ctx.locale.register(LOCALE_NS, { zh, en })
    return () => { offZh() }
  }, 'dsh-task: dictionaries')

  // Settings card: one staged form over the task namespace.
  const settingsScope = ctx.get('settingsScope') as { bind<S>(spec: SettingsScopeSpec<S>): SettingsScope<S> } | undefined
  if (settingsScope !== undefined) {
    const scope = settingsScope.bind<TaskSettings>({ namespace: TASK_NS })
    const card = new TaskSettingsCardController(scope)
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: TASK_NS,
      locale: LOCALE_NS,
      inject: () => card.inject(),
    }, TaskSettingsCard))
  }

  // Optional cron service (dsh-cron): drives the task-detail schedule section.
  const cron = ctx.get('picoCronService') as CronServiceFace | undefined

  // Sidebar foot entry (global, above the connector center and Settings).
  const sessions = ctx.get('sessions') as { open(id: string): void } | undefined
  const workspacesService = ctx.get('workspaces') as IWorkspaces | undefined
  const controller = new TaskController({ transport: new HttpTaskTransport() })
  if (sessions !== undefined) controller.openSession = id => sessions.open(id as never)
  ctx.effect(() => {
    controller.start()
    return () => controller.dispose()
  }, 'controller lifecycle')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'pico-task',
    order: -5,
  }, TaskTrigger))
  ctx.effect(() => mountTaskBoard(controller, workspacesService), 'dsh-task: main-area board')

  // Board tab in the better-sidebar (soft dependency, child fiber).
  ctx.inject(['betterSidebar'], (childCtx: Context) => {
    const service = childCtx.get('betterSidebar') as BetterSidebarService | undefined
    if (service === undefined) return
    const disposeTab = service.registerTab({
      id: 'pico:task-board',
      title: () => zh['entry.label'],
      order: 20,
      component: () => createElement(TaskBoard, {
        controller,
        ...(workspacesService === undefined ? {} : { workspaces: workspacesService }),
      }),
    })
    childCtx.effect(() => () => { disposeTab() }, 'dsh-task: better-sidebar board tab')
  })

  // The cron service may arrive after this plugin (cordis injection order is
  // unconstrained); a child fiber reacts to its availability and forwards it
  // into the board via the controller.
  const cronRef: { current: CronServiceFace | undefined } = { current: cron }
  ctx.inject(['picoCronService'], (childCtx: Context) => {
    cronRef.current = childCtx.get('picoCronService') as CronServiceFace | undefined
    childCtx.effect(() => () => { cronRef.current = undefined }, 'dsh-task: cron face')
  })
  controller.cron = () => cronRef.current
}
