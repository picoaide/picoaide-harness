/**
 * Host loader entry for the dsh-cron plugin.
 *
 * The Host owns the job ledger, the cron scheduler, the executor, and the
 * same-origin API. The browser is an asynchronous view over that service.
 * Following the upstream plugin contract (docs/cordis-tutorial), this is a
 * function plugin: named exports `name` / `inject` / `Config` / `apply`, no
 * default export, schema-validated config, and all side effects wrapped in
 * `ctx.effect` so HMR/unload unwinds them.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import { HostCronService } from './host-service.ts'
import { makeCronRoutes } from './host-routes.ts'
import { registerCronTools } from './tools.ts'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 200

export const name = 'pico-cron'

/** Required Host services (cordis inject waiting). */
export const inject = ['systemPrompt', 'apiProxy', 'webServer', 'tools']

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const CRON_GUIDANCE = '本机已安装 dsh-cron 插件（DSH Desktop 的定时任务调度器）：可创建定时任务（cron 表达式，分钟级精度），到点由 Host 进程执行——关闭窗口或浏览器页面后仍会执行；应用完全退出期间错过的触发点默认跳过（可在设置中开启补跑最近一次）；定时任务可执行 dsh-task 插件的任务，或向指定会话发送 prompt。模型可直接调用 cron_create / cron_list / cron_set_enabled / cron_run 工具创建、查看、启停和触发定时任务。用户提到「定时任务 / cron / 定时执行」时即指本插件，请据此协作。'

/** Settings namespace of the cron plugin (spelled here and in the browser half). */
export const CRON_SETTINGS_NAMESPACE = settingsNamespace('cron')

export interface Config {
  /** Master switch for the scheduler (host + browser surfaces). */
  enabled?: boolean
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean
  /**
   * When true, a restart or long suspension fires the single most recent
   * missed occurrence per due job instead of skipping it. Default: skip.
   */
  catchUpMissed?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  catchUpMissed: z.boolean().default(false),
})

/**
 * Register the cron Host service, routes, and announcement section. The
 * service is re-judged whenever the settings source changes, so a settings
 * edit takes effect without a restart.
 */
export function apply(ctx: Context, config: Config): void {
  const host = new HostCronService(ctx.apiProxy, {
    taskService: () => ctx.get('picoTaskService'),
  })
  host.setConfiguration(config.enabled ?? true, config.catchUpMissed ?? false)
  host.start()

  // The picoCronService surface sibling plugins (dsh-task) inject.
  const serviceDisposer = ctx.provide('picoCronService', host)

  ctx.effect(() => {
    const disposers: Array<() => void> = [serviceDisposer]
    try {
      for (const route of makeCronRoutes(host)) disposers.push(ctx.webServer.register(route))
      disposers.push(registerCronTools(ctx, host))
    } catch (error) {
      for (const dispose of disposers) dispose()
      host.dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers) dispose()
      host.dispose()
    }
  }, 'dsh-cron: ledger, scheduler, and routes')

  // Live config source: the settings section once served, the composition
  // entry otherwise.
  let current: () => Config = () => config ?? {}
  let disposeSection: (() => void) | undefined

  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    const active = current().enabled ?? true
    host.setConfiguration(active, current().catchUpMissed ?? false)
    if (!active) return
    if ((current().announceToAgent ?? true) === false) return
    disposeSection = ctx.systemPrompt.section({
      name: 'plugin:dsh-cron',
      order: SECTION_ORDER,
      text: CRON_GUIDANCE,
    })
  }

  installSettingsSection(ctx, CRON_SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => { current = source },
    onChange: sync,
  })

  sync()
}
