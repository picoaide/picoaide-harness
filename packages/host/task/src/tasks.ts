/**
 * Task domain model: durable task records, the status machine, and pure
 * transitions. Adapted from dsh-web-ui (Apache-2.0) packages/dsh-task-board
 * src/core/tasks.ts; scheduling was removed (dsh-cron owns schedules).
 */
import type { ExecutionResult } from './execution.ts'

/** The permission presets a task may pin (upstream dsh-task-board whitelist). */
export const TASK_PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const

export type TaskPermission = typeof TASK_PERMISSIONS[number]

export function isTaskPermission(value: unknown): value is TaskPermission {
  return typeof value === 'string' && (TASK_PERMISSIONS as readonly string[]).includes(value)
}

/** The five board columns. */
export const COLUMNS = [
  { status: 'todo', labelKey: 'board.column.todo' },
  { status: 'doing', labelKey: 'board.column.doing' },
  { status: 'done', labelKey: 'board.column.done' },
  { status: 'failed', labelKey: 'board.column.failed' },
] as const

export type TaskStatus = 'todo' | 'doing' | 'done' | 'failed'

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'todo' || value === 'doing' || value === 'done' || value === 'failed'
}

/** Which statuses may a task move to manually? */
export function canMoveManually(from: TaskStatus, to: TaskStatus): boolean {
  return from !== to
}

/** When an execution starts, the task moves to 'doing'. */
export function withStatus(task: TaskRecord, status: TaskStatus): TaskRecord {
  return { ...task, status, updatedAt: Date.now() }
}

/** One execution record (one agent-session run). */
export interface ExecutionRecord {
  id: string
  /** The agent session created for this run. */
  sessionId?: string
  /** The full prompt (task context + user prompt) sent to the session. */
  prompt?: string
  startedAt: number
  endedAt?: number
  result?: ExecutionResult
  error?: string
}

/** A durable task record. */
export interface TaskRecord {
  id: string
  title: string
  description: string
  /** The prompt sent to the agent session (data, never a shell line). */
  prompt: string
  status: TaskStatus
  /** Pinned workspace; absent = current workspace. */
  workspaceId?: string
  /** Pinned agent preset; absent = default. */
  mode?: string
  /** Optional permission preset applied via /permission before the prompt. */
  permission?: string
  executions: ExecutionRecord[]
  archivedAt?: number
  createdAt: number
  updatedAt: number
  /**
   * Display name of the account that created this task (gateway username).
   * Absent on records persisted before the owner field existed: legacy
   * records keep pre-upgrade semantics (visible to every session). Tasks
   * created after the upgrade are owner-scoped.
   */
  owner?: string
}

/** Input for a new task. */
export interface NewTaskInput {
  title: string
  description: string
  prompt: string
  workspaceId?: string
  mode?: string
  permission?: string
}

/** Patchable fields of an existing task. */
export interface TaskUpdatePatch {
  title?: string
  description?: string
  prompt?: string
  workspaceId?: string
  mode?: string
  permission?: string
}

/** Whether a task is archived. */
export function isArchived(task: TaskRecord): boolean {
  return task.archivedAt !== undefined
}

/** Create a new task record. */
export function createTask(id: string, input: NewTaskInput, now: number, owner?: string): TaskRecord {
  return {
    id,
    title: input.title,
    description: input.description,
    prompt: input.prompt,
    status: 'todo',
    executions: [],
    createdAt: now,
    updatedAt: now,
    ...(owner === undefined || owner.length === 0 ? {} : { owner }),
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.permission === undefined ? {} : { permission: input.permission }),
  }
}

/** Whether a task is visible to (and executable by) the given account. */
export function taskVisibleTo(task: TaskRecord, username: string | null | undefined): boolean {
  // Legacy records (no owner) stay visible to every session; owner-scoped
  // records are visible only to their creating account.
  if (task.owner === undefined) return true
  return username !== undefined && username !== null && username.length > 0 && task.owner === username
}

/** Apply a validated patch (immutable update). */
export function updateTask(task: TaskRecord, patch: TaskUpdatePatch, now: number): TaskRecord {
  return {
    ...task,
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
    ...(patch.workspaceId === undefined ? {} : { workspaceId: patch.workspaceId }),
    ...(patch.mode === undefined ? {} : { mode: patch.mode }),
    ...(patch.permission === undefined ? {} : { permission: patch.permission }),
    updatedAt: now,
  }
}

/** Open a run: append a pending execution and flip the task to 'doing'. */
export function startExecution(
  task: TaskRecord,
  executionId: string,
  now: number,
  prompt?: string,
): { task: TaskRecord; execution: ExecutionRecord } {
  const execution: ExecutionRecord = {
    id: executionId,
    startedAt: now,
    ...(prompt === undefined || prompt === '' ? {} : { prompt }),
  }
  return {
    task: {
      ...task,
      status: 'doing',
      executions: [...task.executions, execution],
      updatedAt: now,
    },
    execution,
  }
}

/** Settle a pending execution (task-board semantics; result can be failed). */
export function settleExecution(
  task: TaskRecord,
  executionId: string,
  result: ExecutionResult,
  now: number,
  error?: string,
): TaskRecord {
  // Already settled executions are never re-settled (the first settlement
  // wins; a later poll/launch race must not flip the outcome).
  const target = task.executions.find(execution => execution.id === executionId)
  if (target === undefined || target.endedAt !== undefined) return task
  return {
    ...task,
    executions: task.executions.map(execution => (
      execution.id === executionId
        ? {
            ...execution,
            endedAt: now,
            result,
            ...(error === undefined ? {} : { error }),
          }
        : execution
    )),
    ...(result === 'succeeded' ? { status: 'done' as TaskStatus } : {}),
    ...(result === 'failed' ? { status: 'failed' as TaskStatus } : {}),
    // A cancelled run (session vanished / host restarted before recording)
    // releases the task back to the todo column so it can run again.
    ...(result === 'cancelled' && task.status === 'doing' ? { status: 'todo' as TaskStatus } : {}),
    updatedAt: now,
  }
}

/** Attach the created session id to a pending execution. */
export function attachSession(task: TaskRecord, executionId: string, sessionId: string): TaskRecord {
  return {
    ...task,
    executions: task.executions.map(execution => (
      execution.id === executionId ? { ...execution, sessionId } : execution
    )),
    updatedAt: Date.now(),
  }
}

/** Archive (or restore) a task. */
export function setArchived(task: TaskRecord, archived: boolean, now: number): TaskRecord {
  return {
    ...task,
    ...(archived ? { archivedAt: now } : {}),
    ...(!archived ? { archivedAt: undefined as never } : {}),
    updatedAt: now,
  }
}

/** Whether the task has an execution still in flight. */
export function hasOpenExecution(task: TaskRecord): boolean {
  return task.executions.some(execution => execution.endedAt === undefined)
}
