/**
 * Model-facing tools for the task board.
 *
 * The board is currently UI-only (its Host ledger + runner are not reachable
 * from a conversation). These tools let the model create, list, and run
 * tasks directly, sharing the exact same Host ledger and execution runner as
 * the UI — so a model-created task appears on the board, and a model-run
 * task settles through the same poll/reconcile path.
 *
 * The tools are thin adapters over the Host service: they never touch the
 * ledger directly (the service serializes + persists), and they never carry
 * command/shell/executable fields — a task prompt is data sent to an agent
 * session.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { HostTaskService } from './host-service.ts'
import type { NewTaskInput } from './tasks.ts'

function request<T>(payload: T) {
  return { rpcId: `task-tool-${crypto.randomUUID()}` as RpcId, payload }
}

/** Task board tools host entry: registers the tools on the tools registry. */
export function registerTaskTools(ctx: Context, service: HostTaskService): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'workspace_list',
    description: '列出全部项目（工作区）：id、标题、路径。创建任务需要指定项目时先用本工具查询项目 id，再传给 task_create 的 workspaceId。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const response = await ctx.apiProxy.workspace.list(request({}))
      if (!response.result.ok) throw new Error(`${response.result.error.code}: ${response.result.error.message}`)
      return response.result.value.items.map(item => ({
        workspaceId: item.workspaceId,
        title: item.title !== '' ? item.title : item.path,
        path: item.path,
      }))
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'task_create',
    description: '在任务看板创建一个新任务。任务由真实 DSH 智能体会话执行（每次执行新建独立会话，可钉住工作区、agent 预设和权限）。项目（workspaceId）先用 workspace_list 查询；留空则使用当前会话的项目。返回任务 id。',
    parameters: {
      title: { type: 'string', required: true, description: '任务标题（必填，非空）' },
      description: { type: 'string', description: '任务描述' },
      prompt: { type: 'string', description: '执行提示词（发送给智能体的指令）；缺省使用标题' },
      workspaceId: { type: 'string', description: '钉住的项目（工作区）id，用 workspace_list 查询；缺省为当前项目' },
      mode: { type: 'string', description: '钉住的 agent 预设 id；缺省为默认预设' },
      permission: { type: 'string', description: '可选权限预设：read-only / workspace-write / danger-full-access；无人值守（定时/后台）执行请用 danger-full-access（完全访问、执行时不弹授权框）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: `已创建任务 ${(value as { id: string }).id}` }],
    },
    async execute(args) {
      const input: NewTaskInput = {
        title: args.title.trim(),
        description: args.description ?? '',
        prompt: args.prompt !== undefined && args.prompt.trim() !== '' ? args.prompt.trim() : args.title.trim(),
        ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
        ...(args.mode === undefined ? {} : { mode: args.mode }),
        ...(args.permission === undefined ? {} : { permission: args.permission }),
      }
      // Mint the id up front so the canonical result is exact (no
      // time-window guessing).
      const id = `task-${crypto.randomUUID()}`
      service.apply(`tool-${crypto.randomUUID()}`, { kind: 'create', id, input })
      return { id }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'task_list',
    description: '列出任务看板的任务（可选按状态过滤）。返回任务 id、标题、状态、执行历史摘要。',
    parameters: {
      status: { type: 'string', description: '可选状态过滤：todo / doing / done / failed' },
      archived: { type: 'boolean', description: '是否包含归档任务（默认不含）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const tasks = service.getSnapshot().tasks
        .filter(task => (args.archived === true) || task.archivedAt === undefined)
        .filter(task => args.status === undefined || task.status === args.status)
      return tasks.map(task => ({
        id: task.id,
        title: task.title,
        status: task.status,
        executions: task.executions.length,
      }))
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'task_run',
    description: '立即执行一个任务（真实 DSH 智能体会话，经 Host runner 创建会话并发送提示词；执行历史自动回写看板）。任务已运行或不存在时返回错误。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: (value as { started: boolean }).started ? '任务已开始执行' : '任务未能开始' }],
    },
    async execute(args) {
      const result = await service.runTask(args.taskId)
      if (!result.ok) throw new Error(result.error)
      return { started: true }
    },
  })))

  return () => { for (const dispose of disposers) dispose() }
}
