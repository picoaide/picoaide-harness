/**
 * Model-facing tools for the cron scheduler.
 *
 * The scheduler is currently UI-only (its Host ledger + executor are not
 * reachable from a conversation). These tools let the model create, list,
 * enable/disable, trigger, and delete scheduled jobs directly, sharing the exact
 * same Host ledger and executor as the UI. A job action is a closed
 * discriminated union — the only kind is `agent` (spawn a fresh agent
 * session for a prompt) — never a command or shell line.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { HostCronService } from './host-service.ts'
import { isValidCron, nextRunAtMs } from './cron.ts'
import { isUsableJobName, jobIsRunning } from './jobs.ts'
import { hostLocaleOf, hostT, type CronHostCopyKey } from './host-copy.ts'

/** Host-side collaborators of the tools. */
export interface CronToolOptions {
  /** Composed permission-preset roster, used to validate `cron_create.permission` (FIX-17). */
  permissions?: () => readonly string[]
}

/** Cron tools host entry: registers the tools on the tools registry. */
export function registerCronTools(ctx: Context, service: HostCronService, options: CronToolOptions = {}): () => void {
  const disposers: Array<() => void> = []
  const permissionNames = (): readonly string[] => options.permissions?.() ?? []
  /**
   * Host copy of THIS message (render payload or thrown error).
   *
   * Resolved per call from the probed `desktopRuntime`: the user can switch
   * language while the app runs, and a tool result is rendered long after the
   * plugin was applied. The tool/parameter DESCRIPTIONS stay Chinese on purpose
   * (model-facing contract, see the module header).
   */
  const copy = (key: CronHostCopyKey, params?: Record<string, string>): string => hostT(hostLocaleOf(ctx), key, params)

  disposers.push(ctx.tools.register(defineTool({
    name: 'cron_create',
    description: '创建定时任务（cron 表达式，5 段：分 时 日 月 周，支持 */n 步进、a-b 范围、逗号列表，日/周 OR 语义）。到点由 Host 进程执行——关闭窗口或浏览器页面后仍会执行。每次执行新建一个智能体会话并发送提示词（可指定工作区、智能体预设和权限）。',
    parameters: {
      name: { type: 'string', required: true, description: '定时任务名称（非空）' },
      cron: { type: 'string', required: true, description: '5 段 cron 表达式，如 0 9 * * *（每天 09:00）' },
      prompt: { type: 'string', required: true, description: '执行时发送给智能体会话的提示词内容（必填，非空）' },
      workspaceId: { type: 'string', description: '要钉住的工作区 id（缺省=当前工作区）' },
      agentPreset: { type: 'string', description: '要使用的智能体预设 id（缺省=部署默认）' },
      permission: { type: 'string', description: '可选权限预设名称；以本机部署配置的 roster 为准（未知名称会被拒绝）' },
      enabled: { type: 'boolean', description: '是否立即启用（默认 false）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: copy('tool.created', { id: (value as { id: string }).id }) }],
    },
    async execute(args) {
      // Hand-check cross-field constraints the DSL does not express.
      if (!isValidCron(args.cron)) throw new Error(copy('tool.invalidCron', { cron: args.cron }))
      if (nextRunAtMs(args.cron, Date.now()) === undefined) throw new Error(copy('tool.cronNoMatch', { cron: args.cron }))
      // The parameter description has always promised a non-empty name; until
      // 2026-09-23 the tool only trimmed it, so `"   "` was stored as `name: ""`
      // — a nameless job card, a nameless session title, while the GUI/protocol
      // face refused the same input (R3-B3 F3 / B-4). Both faces now ask the one
      // predicate in jobs.ts instead of each deciding what "empty" means.
      if (!isUsableJobName(args.name)) throw new Error(copy('tool.nameRequired'))
      if (args.prompt === undefined || args.prompt.trim() === '') throw new Error(copy('tool.promptRequired'))
      // FIX-17: `permission` names a preset of the composed permission service.
      // Free text used to be accepted here and dropped by the executor; now an
      // unknown name is rejected at creation time.
      if (args.permission !== undefined) {
        const roster = permissionNames()
        if (roster.length === 0) throw new Error(copy('tool.permissionUnavailable'))
        if (!roster.includes(args.permission)) {
          throw new Error(copy('tool.unknownPermission', { permission: args.permission, available: roster.join(', ') }))
        }
      }

      const id = `job-${crypto.randomUUID()}`
      service.registerJob({
        id,
        name: args.name.trim(),
        cron: args.cron.trim(),
        action: {
          kind: 'agent',
          prompt: args.prompt.trim(),
          ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
          ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }),
          ...(args.permission === undefined ? {} : { permission: args.permission }),
        },
        enabled: args.enabled ?? false,
      })
      return { id }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'cron_list',
    description: '列出全部定时任务（id、名称、cron、启用状态、下次运行时间、执行历史条数）。',
    parameters: {
      enabledOnly: { type: 'boolean', description: '只列已启用的（默认 false）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      // Owner filter (multi-user isolation): only the current account's jobs
      // may be enumerated via the model-facing tool.
      return service.listVisibleJobs()
        .filter(job => args.enabledOnly !== true || job.enabled)
        .map(job => ({
          id: job.id,
          name: job.name,
          cron: job.cron,
          enabled: job.enabled,
          ...(job.nextRunAt === undefined ? {} : { nextRunAt: job.nextRunAt }),
          executions: job.executions.length,
        }))
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'cron_set_enabled',
    description: '启用或停用一个定时任务（停用后到点不再触发，任务保留）。',
    parameters: {
      jobId: { type: 'string', required: true, description: '定时任务 id' },
      enabled: { type: 'boolean', required: true, description: 'true=启用，false=停用' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as { jobId: string; enabled: boolean }
        return [{
          type: 'text',
          text: copy('tool.setEnabled', { state: copy(v.enabled ? 'tool.enabled' : 'tool.disabled'), jobId: v.jobId }),
        }]
      },
    },
    async execute(args) {
      // Owner pre-check, same contract as cron_run/cron_remove (2026-09-23
      // CR-3): a job this account cannot see is reported as missing. Without
      // it, a nonexistent id reached the ledger, the mutation was a silent
      // no-op and the tool still answered "enabled" (fake success), while a
      // *foreign* id threw the ledger's internal "belongs to another account"
      // string — a cross-account existence oracle and the only tool that
      // answered differently for "not mine" vs "does not exist".
      const before = service.listVisibleJobs().find(job => job.id === args.jobId)
      if (before === undefined) throw new Error(copy('tool.jobMissing', { jobId: args.jobId }))
      // Already in the requested state: report the verified state, do not
      // claim a change that did not happen.
      if (before.enabled === args.enabled) return { jobId: args.jobId, enabled: before.enabled }
      service.apply(`tool-${crypto.randomUUID()}`, { kind: args.enabled ? 'enable' : 'disable', jobId: args.jobId })
      const after = service.listVisibleJobs().find(job => job.id === args.jobId)
      return { jobId: args.jobId, enabled: after?.enabled ?? args.enabled }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'cron_run',
    description: '立即触发一个定时任务（走与到点触发相同的执行路径；任务不存在或已在运行时返回错误）。',
    parameters: {
      jobId: { type: 'string', required: true, description: '定时任务 id' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: copy((value as { started: boolean }).started ? 'tool.triggered' : 'tool.notTriggered'),
      }],
    },
    async execute(args) {
      // Owner filter: the run target must be visible to the current account
      // (a cross-account jobId is treated as "does not exist", not a leak).
      const before = service.listVisibleJobs().find(job => job.id === args.jobId)
      if (before === undefined) throw new Error(copy('tool.jobMissing', { jobId: args.jobId }))
      // The shared "a live run must not lose its record" judgement (CR-2):
      // `jobIsRunning` is the same predicate the ledger's delete guard and the
      // panel button use.
      if (jobIsRunning(before)) {
        throw new Error(copy('tool.jobRunning', { jobId: args.jobId }))
      }
      service.apply(`tool-${crypto.randomUUID()}`, { kind: 'run', jobId: args.jobId })
      return { started: true }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'cron_remove',
    description: '删除一个定时任务（连同它的执行历史，不可恢复）。任务正在执行时拒绝删除——先 cron_set_enabled 停用，或等本次执行结束后再删。',
    parameters: {
      jobId: { type: 'string', required: true, description: '定时任务 id' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: copy('tool.removed', { jobId: (value as { jobId: string }).jobId }),
      }],
    },
    async execute(args) {
      // Owner filter, same contract as cron_run: a job the current account
      // cannot see is reported as missing rather than deleted (the ledger
      // re-checks ownership at apply time as well).
      const before = service.listVisibleJobs().find(job => job.id === args.jobId)
      if (before === undefined) throw new Error(copy('tool.jobMissing', { jobId: args.jobId }))
      // A live execution is not cancelled by deleting its job (`settle()`
      // tolerates the missing record), so the run would keep going while its
      // history disappears. Refuse instead of losing the record silently.
      // The shared "a live run must not lose its record" judgement (CR-2):
      // `jobIsRunning` is the same predicate the ledger's delete guard and the
      // panel button use.
      if (jobIsRunning(before)) {
        throw new Error(copy('tool.jobRunning', { jobId: args.jobId }))
      }
      service.apply(`tool-${crypto.randomUUID()}`, { kind: 'delete', jobId: args.jobId })
      return { jobId: args.jobId, removed: true }
    },
  })))

  return () => { for (const dispose of disposers) dispose() }
}
