/**
 * Host loader entry for the dsh-task plugin.
 *
 * The Host owns the task ledger, the execution runner, the settlement poll,
 * and the same-origin API; the browser is an asynchronous view over that
 * service. Function plugin per the upstream contract: `name` / `inject` /
 * `Config` / `apply`, schema-validated config, side effects in `ctx.effect`.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { HostTaskService } from './host-service.ts'
import { makeTaskRoutes } from './host-routes.ts'
import { registerTaskTools } from './tools.ts'

// Type-only: declare the enterprise session event so `ctx.on` resolves it.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'pico/session-changed'(session: { username?: string; token?: string; serverURL?: string } | null): void
  }
}

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 200

export const name = 'pico-task'

/** Required Host services (cordis inject waiting). */
export const inject = ['systemPrompt', 'apiProxy', 'webServer', 'tools']

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const TASK_GUIDANCE = '本机已安装 dsh-task 插件（DSH Desktop 的任务看板）：多列看板管理任务；任务由真实 DSH 智能体会话执行（每次执行新建独立会话，可钉住工作区、agent 预设和权限）；执行结果自动回写看板；可与 dsh-cron 配合定时执行。模型可直接调用 task_create / task_list / task_run 工具创建、查看和执行任务。用户提到「任务看板 / 看板 / 任务」时即指本插件，请据此协作。'

/** Settings namespace of the task plugin (spelled here and in the browser half). */
export const TASK_SETTINGS_NAMESPACE = settingsNamespace('task')

export interface Config {
  /** Master switch for the plugin (host + browser surfaces). */
  enabled?: boolean
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
})

export function apply(ctx: Context, config: Config): void {
  const host = new HostTaskService(ctx.apiProxy)
  host.setActive(config.enabled ?? true)
  host.start()

  // Current account: stamp new tasks and scope reads. The enterprise session
  // drives it; without the plugin the task board stays legacy-visible.
  const currentUser = (): string | null => {
    try {
      const pico = ctx.get('picoSession') as { getSession?: () => { username?: string } | null } | undefined
      return pico?.getSession?.()?.username ?? null
    } catch {
      return null
    }
  }
  host.setUsername(currentUser())
  ctx.on('pico/session-changed', (next: unknown) => {
    host.setUsername((next as { username?: string } | null)?.username ?? null)
  })

  const serviceDisposer = ctx.provide('picoTaskService', host)

  ctx.effect(() => {
    const disposers: Array<() => void> = [serviceDisposer]
    try {
      for (const route of makeTaskRoutes(host)) disposers.push(ctx.webServer.register(route))
      disposers.push(registerTaskTools(ctx, host))
    } catch (error) {
      for (const dispose of disposers) dispose()
      host.dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers) dispose()
      host.dispose()
    }
  }, 'dsh-task: ledger, runner, routes, and tools')

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
    host.setActive(active)
    if (!active) return
    if ((current().announceToAgent ?? true) === false) return
    disposeSection = ctx.systemPrompt.section({
      name: 'plugin:dsh-task',
      order: SECTION_ORDER,
      text: TASK_GUIDANCE,
    })
  }

  installSettingsSection(ctx, TASK_SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => { current = source },
    onChange: sync,
  })

  sync()
}
