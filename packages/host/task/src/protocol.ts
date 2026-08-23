/**
 * Same-origin action protocol for the task ledger. Every browser mutation is
 * a versioned, strictly validated discriminated union; the Host re-validates
 * each payload (exact keys, types, enumerations) before touching the ledger.
 * The union contains no command, executable, or shell fields — the task
 * Prompt is data sent to an agent session, never a shell line.
 */
import {
  isTaskPermission, isTaskStatus, type NewTaskInput, type TaskRecord, type TaskStatus, type TaskUpdatePatch,
} from './tasks.ts'

export const TASK_SCHEMA_VERSION = 1 as const
export const TASK_API_PREFIX = '/api/task'

export interface TaskSnapshot {
  schemaVersion: typeof TASK_SCHEMA_VERSION
  revision: number
  tasks: TaskRecord[]
}

/** SSE event frame: revision only, never the task list. */
export interface TaskEventPayload {
  revision: number
}

export type TaskAction =
  | { kind: 'create'; id: string; input: NewTaskInput }
  | { kind: 'update'; taskId: string; patch: TaskUpdatePatch }
  | { kind: 'delete'; taskId: string }
  | { kind: 'move'; taskId: string; status: TaskStatus }
  | { kind: 'archive'; taskId: string }
  | { kind: 'restore'; taskId: string }
  | { kind: 'run'; taskId: string }
  | { kind: 'rerun'; taskId: string }
  | { kind: 'cancel'; taskId: string }

export interface TaskActionEnvelope {
  requestId: string
  action: TaskAction
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function validInput(value: unknown): value is NewTaskInput {
  const input = record(value)
  if (input === undefined || !exactKeys(input, ['title', 'description', 'prompt', 'workspaceId', 'mode', 'permission'])) return false
  if (typeof input.title !== 'string' || input.title === '') return false
  if (typeof input.description !== 'string' || typeof input.prompt !== 'string') return false
  if (!optionalString(input.workspaceId) || !optionalString(input.mode)) return false
  return input.permission === undefined || isTaskPermission(input.permission)
}

function validPatch(value: unknown): value is TaskUpdatePatch {
  const patch = record(value)
  if (patch === undefined || !exactKeys(patch, ['title', 'description', 'prompt', 'workspaceId', 'mode', 'permission'])) return false
  for (const key of ['title', 'description', 'prompt', 'workspaceId', 'mode'] as const) {
    if (!optionalString(patch[key])) return false
  }
  return patch.permission === undefined || isTaskPermission(patch.permission)
}

export function parseActionEnvelope(value: unknown): TaskActionEnvelope | undefined {
  const envelope = record(value)
  if (envelope === undefined || !exactKeys(envelope, ['requestId', 'action'])) return undefined
  if (typeof envelope.requestId !== 'string' || envelope.requestId.trim() === '' || envelope.requestId.length > 256) return undefined
  const action = record(envelope.action)
  if (action === undefined || typeof action.kind !== 'string') return undefined
  const taskId = typeof action.taskId === 'string' && action.taskId !== '' ? action.taskId : undefined
  switch (action.kind) {
    case 'create':
      if (!exactKeys(action, ['kind', 'id', 'input'])) return undefined
      return typeof action.id === 'string' && action.id !== '' && validInput(action.input)
        ? { requestId: envelope.requestId, action: action as unknown as Extract<TaskAction, { kind: 'create' }> }
        : undefined
    case 'update':
      if (!exactKeys(action, ['kind', 'taskId', 'patch'])) return undefined
      return taskId !== undefined && validPatch(action.patch)
        ? { requestId: envelope.requestId, action: action as unknown as Extract<TaskAction, { kind: 'update' }> }
        : undefined
    case 'move':
      if (!exactKeys(action, ['kind', 'taskId', 'status'])) return undefined
      return taskId !== undefined && isTaskStatus(action.status)
        ? { requestId: envelope.requestId, action: action as unknown as Extract<TaskAction, { kind: 'move' }> }
        : undefined
    case 'delete':
    case 'archive':
    case 'restore':
    case 'run':
    case 'rerun':
    case 'cancel':
      if (!exactKeys(action, ['kind', 'taskId'])) return undefined
      return taskId === undefined ? undefined : { requestId: envelope.requestId, action: action as TaskAction }
    default:
      return undefined
  }
}
