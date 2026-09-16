/**
 * Cron HOST copy: the user-visible strings this package produces in the Host
 * process — the transcript payloads of the cron_* tools, their thrown errors,
 * and the system-prompt announcement.
 *
 * Why this module exists
 * ----------------------
 * The client half has its own dictionary (`src/client/locales.ts`) driven by
 * `ctx.locale`, but Host code cannot reach that service — `ctx.locale` lives in
 * the client face. The shared resolver is `dsh-plugin-desktop/host-locale`:
 * probed `desktopRuntime.locale` (the user's in-app choice) → request
 * `Accept-Language` → `zh`.
 *
 * Locale discipline (2026-09-16 i18n)
 * ----------------------------------
 * Every producer resolves the locale **when it builds the message**, through
 * {@link hostLocaleOf} / {@link hostT} — never in a module-level constant (the
 * root cause is documented in `packages/host/connectors/src/client/status-label.ts`,
 * and `tests/host-copy.spec.ts` here holds the regression that fails if someone
 * freezes it again).
 *
 * Model-facing policy: the cron **tool and parameter descriptions stay Chinese**
 * (they are the model-facing contract, and the browser package handles that
 * policy in parallel). Only what the USER sees — the transcript render payloads
 * and the errors a call throws — follows the locale, plus the plugin
 * announcement (`CRON_GUIDANCE`), whose system-prompt section is rebuilt per
 * assembly.
 *
 * `zh` is the source: its values are byte-identical to the strings this package
 * shipped before translation.
 *
 * @module
 */
import { DEFAULT_HOST_LOCALE, hostCopy as pickHostCopy, hostLocaleFrom, type HostLocale } from 'dsh-plugin-desktop/host-locale'

/** Structural view of a context that can hand out the probed desktop runtime. */
export interface HostCopySource {
  get(name: string): unknown
}

/** Chinese copy — the source language, byte-identical to the pre-i18n strings. */
const zh = {
  // ---- tool results rendered in the transcript ---------------------------
  'tool.created': '已创建定时任务 {id}',
  'tool.enabled': '已启用',
  'tool.disabled': '已停用',
  'tool.setEnabled': '{state}定时任务 {jobId}',
  'tool.triggered': '定时任务已触发',
  'tool.notTriggered': '定时任务未能触发',
  // ---- tool errors the user reads in the transcript ----------------------
  'tool.invalidCron': 'cron 表达式无效: {cron}',
  'tool.cronNoMatch': 'cron 表达式在五年内无匹配时刻: {cron}',
  'tool.promptRequired': '必须提供 prompt（执行时发送给智能体会话的提示词）',
  'tool.permissionUnavailable': '权限预设服务不可用，无法指定 permission',
  'tool.unknownPermission': '未知的权限预设: {permission}（可用：{available}）',
  'tool.jobMissing': '定时任务不存在: {jobId}',
  'tool.jobRunning': '定时任务 {jobId} 已在运行',
  // ---- plugin announcement (system prompt) -------------------------------
  'guidance.plugin': '本机已安装 dsh-cron 插件（PicoAide Harness 的定时任务调度器）：可创建定时任务（cron 表达式，分钟级精度），到点由 Host 进程执行——关闭窗口或浏览器页面后仍会执行；应用完全退出期间错过的触发点默认跳过（可在设置中开启补跑最近一次）；每个定时任务执行时会新建一个智能体会话（可指定工作区、智能体预设与权限），并把任务提示词发给该会话；执行详情（会话、开始/结束时间、结果、错误）记录在任务下可随时查看。模型可直接调用 cron_create / cron_list / cron_set_enabled / cron_run 工具创建、查看、启停和触发定时任务。用户提到「定时任务 / cron / 定时执行」时即指本插件，请据此协作。',
} as const

/** English mirror — every key of {@link zh}, same parameter names. */
const en: Record<keyof typeof zh, string> = {
  'tool.created': 'Created scheduled job {id}',
  'tool.enabled': 'Enabled',
  'tool.disabled': 'Disabled',
  'tool.setEnabled': '{state} scheduled job {jobId}',
  'tool.triggered': 'The scheduled job was triggered',
  'tool.notTriggered': 'The scheduled job could not be triggered',
  'tool.invalidCron': 'invalid cron expression: {cron}',
  'tool.cronNoMatch': 'the cron expression has no matching instant within five years: {cron}',
  'tool.promptRequired': 'prompt is required (the text sent to the agent session when the job runs)',
  'tool.permissionUnavailable': 'The permission preset service is unavailable, so permission cannot be pinned',
  'tool.unknownPermission': 'Unknown permission preset: {permission} (available: {available})',
  'tool.jobMissing': 'Scheduled job not found: {jobId}',
  'tool.jobRunning': 'Scheduled job {jobId} is already running',
  'guidance.plugin': 'This machine has the dsh-cron plugin installed (the scheduled-job scheduler of PicoAide Harness): it can create scheduled jobs (cron expressions, minute-level precision) that the Host process runs when they are due — they still run after the window or the browser page is closed. Triggers missed while the application is completely shut down are skipped by default (catching up the most recent one can be enabled in settings). Each job execution starts a new agent session (a workspace, an agent preset and a permission preset can be pinned) and sends the job prompt to that session; execution details (session, start/end time, result, error) are recorded under the job and can be inspected at any time. The model can call the cron_create / cron_list / cron_set_enabled / cron_run tools directly to create, list, enable/disable and trigger scheduled jobs. When the user mentions "定时任务 / cron / scheduled execution", they mean this plugin — collaborate accordingly.',
}

/** Every host copy key of this package. */
export type CronHostCopyKey = keyof typeof zh

/**
 * Resolve the host locale of a Host context **at call time**.
 *
 * Deliberately a function, never a value: `desktopRuntime.locale` follows the
 * user's in-app language switch, so a cached answer is the bug this module
 * exists to avoid.
 * @param source - the plugin context (or any object with `get`).
 * @returns the locale to render host copy in.
 */
export function hostLocaleOf(source: HostCopySource | undefined): HostLocale {
  let runtime: { readonly locale?: unknown } | undefined
  try {
    runtime = source?.get('desktopRuntime') as { readonly locale?: unknown } | undefined
  } catch {
    runtime = undefined
  }
  return hostLocaleFrom(runtime)
}

/**
 * Translate one host copy key for a locale (zh is the source, en mirrors the
 * full key set). Parameters are `{name}` placeholders.
 */
export function hostT(locale: HostLocale, key: CronHostCopyKey, params?: Record<string, string>): string {
  let text: string = pickHostCopy(locale, zh[key] as string, en[key])
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, value)
  }
  return text
}

/**
 * The plugin announcement for a locale.
 *
 * Also the body of the system-prompt section: `index.ts` registers it as a
 * function so the text is rendered at each prompt assembly from the locale
 * current at that moment.
 */
export function cronGuidance(locale: HostLocale): string {
  return hostT(locale, 'guidance.plugin')
}

/** Product-default host locale, re-exported for callers that need it. */
export { DEFAULT_HOST_LOCALE }
export type { HostLocale }
