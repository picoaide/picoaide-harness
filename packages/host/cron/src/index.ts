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

// Type-only: declare the enterprise session event so `ctx.on` resolves it.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'pico/session-changed'(session: { username?: string; token?: string; serverURL?: string } | null): void
    // Agent loop status (desktop loop-notify 同源信号): status 'idle' 表示
    // 该会话的 agent 循环完成——cron 用它给等待中的执行记录真实结算。
    'agent/status'(payload: { agent?: { session?: { header?: { id?: unknown } } }, status?: string }): void
  }
}

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 200

export const name = 'pico-cron'

/** Required Host services (cordis inject waiting). */
export const inject = ['systemPrompt', 'apiProxy', 'webServer', 'tools']

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const CRON_GUIDANCE = '本机已安装 dsh-cron 插件（PicoAide Harness 的定时任务调度器）：可创建定时任务（cron 表达式，分钟级精度），到点由 Host 进程执行——关闭窗口或浏览器页面后仍会执行；应用完全退出期间错过的触发点默认跳过（可在设置中开启补跑最近一次）；每个定时任务执行时会新建一个智能体会话（可指定工作区、智能体预设与权限），并把任务提示词发给该会话；执行详情（会话、开始/结束时间、结果、错误）记录在任务下可随时查看。模型可直接调用 cron_create / cron_list / cron_set_enabled / cron_run 工具创建、查看、启停和触发定时任务。用户提到「定时任务 / cron / 定时执行」时即指本插件，请据此协作。'

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
  const host = new HostCronService(ctx.apiProxy, {})
  host.setConfiguration(config.enabled ?? true, config.catchUpMissed ?? false)
  host.start()

  // Current account: stamp new jobs and scope reads. The enterprise session
  // drives it; without the plugin the cron board stays legacy-visible.
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
  // 审计 2026-09: agent 循环完成信号 → 给等待中的 cron 执行记录真实结算
  // (prompt 入队 ≠ 完成)。idle 即 succeeded; 事件缺失时执行记录保持
  // pending, 由引擎恢复回收(host-ledger 重启 reconcile)兜底。
  ctx.on('agent/status', (payload: { agent?: { session?: { header?: { id?: unknown } } }, status?: string }) => {
    const sessionId = payload?.agent?.session?.header?.id
    if (typeof sessionId !== 'string' || typeof payload?.status !== 'string') return
    host.scheduler.onAgentStatus(sessionId, payload.status)
  })

  // The picoCronService surface sibling plugins inject.
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
