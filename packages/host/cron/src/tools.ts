/**
 * Model-facing tools for the cron scheduler.
 *
 * The scheduler is currently UI-only (its Host ledger + executor are not
 * reachable from a conversation). These tools let the model create, list,
 * enable/disable, and trigger scheduled jobs directly, sharing the exact
 * same Host ledger and executor as the UI. A job action is a closed
 * discriminated union (run a dsh-task task / send a message) — never a
 * command or shell line.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { HostCronService } from './host-service.ts'
import { isValidCron, nextRunAtMs } from './cron.ts'

/** Cron tools host entry: registers the tools on the tools registry. */
export function registerCronTools(ctx: Context, service: HostCronService): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'cron_create',
    description: '创建定时任务（cron 表达式，5 段：分 时 日 月 周，支持 */n 步进、a-b 范围、逗号列表，日/周 OR 语义）。到点由 Host 进程执行——关闭窗口或浏览器页面后仍会执行。动作二选一：执行看板任务（taskId）或向指定会话发送消息（sessionId+text）。',
    parameters: {
      name: { type: 'string', required: true, description: '定时任务名称（非空）' },
      cron: { type: 'string', required: true, description: '5 段 cron 表达式，如 0 9 * * *（每天 09:00）' },
      taskId: { type: 'string', description: '要执行的看板任务 id（与 sessionId+text 二选一）；用 task_list 查询（任务创建时可用 workspace_list 选择项目）' },
      sessionId: { type: 'string', description: '要发送消息的目标会话 id（与 taskId 二选一）' },
      text: { type: 'string', description: '要发送的消息内容（sessionId 模式必填）' },
      enabled: { type: 'boolean', description: '是否立即启用（默认 false）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: `已创建定时任务 ${(value as { id: string }).id}` }],
    },
    async execute(args) {
      // Hand-check cross-field constraints the DSL does not express.
      if (!isValidCron(args.cron)) throw new Error(`cron 表达式无效: ${args.cron}`)
      if (nextRunAtMs(args.cron, Date.now()) === undefined) throw new Error(`cron 表达式在五年内无匹配时刻: ${args.cron}`)
      const hasTask = args.taskId !== undefined && args.taskId !== ''
      const hasPrompt = args.sessionId !== undefined && args.sessionId !== ''
      if (hasTask === hasPrompt) throw new Error('必须且只能提供 taskId 或 sessionId+text 之一')
      if (hasPrompt && (args.text === undefined || args.text === '')) throw new Error('sessionId 模式必须提供 text')

      const id = `job-${crypto.randomUUID()}`
      service.registerJob({
        id,
        name: args.name.trim(),
        cron: args.cron.trim(),
        action: hasTask
          ? { kind: 'task', taskId: args.taskId! }
          : { kind: 'prompt', sessionId: args.sessionId!, text: args.text! },
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
        return [{ type: 'text', text: `${v.enabled ? '已启用' : '已停用'}定时任务 ${v.jobId}` }]
      },
    },
    async execute(args) {
      service.apply(`tool-${crypto.randomUUID()}`, { kind: args.enabled ? 'enable' : 'disable', jobId: args.jobId })
      return { jobId: args.jobId, enabled: args.enabled }
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
      render: (_args, value) => [{ type: 'text', text: (value as { started: boolean }).started ? '定时任务已触发' : '定时任务未能触发' }],
    },
    async execute(args) {
      // Owner filter: the run target must be visible to the current account
      // (a cross-account jobId is treated as "does not exist", not a leak).
      const before = service.listVisibleJobs().find(job => job.id === args.jobId)
      if (before === undefined) throw new Error(`定时任务不存在: ${args.jobId}`)
      if (before.executions.some(execution => execution.endedAt === undefined)) {
        throw new Error(`定时任务 ${args.jobId} 已在运行`)
      }
      service.apply(`tool-${crypto.randomUUID()}`, { kind: 'run', jobId: args.jobId })
      return { started: true }
    },
  })))

  return () => { for (const dispose of disposers) dispose() }
}
