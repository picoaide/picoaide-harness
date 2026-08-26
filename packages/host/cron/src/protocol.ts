/**
 * Same-origin action protocol for the cron job ledger.
 *
 * Every browser mutation is a versioned, strictly validated discriminated
 * union. The Host re-validates each payload field (exact keys, types,
 * enumerations) before touching the ledger; there are no command, shell, or
 * executable fields anywhere in the union. The browser never writes
 * scheduler-owned timestamps or execution results.
 */
import { isCronJobAction, type JobRecord, type NewJobInput, type JobUpdatePatch } from './jobs.ts'
import { isValidCron, nextRunAtMs } from './cron.ts'

export const CRON_SCHEMA_VERSION = 2 as const
export const CRON_API_PREFIX = '/api/cron'

export interface CronSchedulerSnapshot {
  timeZone: string
  /** Opaque identity of the current Host ledger generation. */
  ledgerId?: string
  lastTickAt?: number
  error?: string
}

export interface CronSnapshot {
  schemaVersion: typeof CRON_SCHEMA_VERSION
  revision: number
  jobs: JobRecord[]
  scheduler: CronSchedulerSnapshot
}

/** SSE event frame: revision/scheduler only, never the job list. */
export interface CronEventPayload {
  revision: number
  scheduler: CronSchedulerSnapshot
}

export type CronAction =
  | { kind: 'create'; id: string; input: NewJobInput }
  | { kind: 'update'; jobId: string; patch: JobUpdatePatch }
  | { kind: 'delete'; jobId: string }
  | { kind: 'enable'; jobId: string }
  | { kind: 'disable'; jobId: string }
  /** Manual immediate trigger (same executor path as scheduled runs). */
  | { kind: 'run'; jobId: string }
  | { kind: 'rerun'; jobId: string }

export interface CronActionEnvelope {
  requestId: string
  action: CronAction
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

/**
 * Host-side cron validation: the expression must parse AND have a reachable
 * next instant within the five-year horizon (a calendar-impossible schedule
 * such as `0 0 30 2 *` would otherwise produce a silently inert job).
 */
function validCron(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false
  if (!isValidCron(value)) return false
  return nextRunAtMs(value, Date.now()) !== undefined
}

function validInput(value: unknown): value is NewJobInput {
  const input = record(value)
  if (input === undefined || !exactKeys(input, ['name', 'cron', 'action', 'enabled'])) return false
  if (typeof input.name !== 'string' || input.name === '') return false
  if (!validCron(input.cron)) return false
  if (!optionalBoolean(input.enabled)) return false
  return isCronJobAction(input.action)
}

function validPatch(value: unknown): value is JobUpdatePatch {
  const patch = record(value)
  if (patch === undefined || !exactKeys(patch, ['name', 'cron', 'enabled'])) return false
  if (patch.name !== undefined && (typeof patch.name !== 'string' || patch.name === '')) return false
  if (patch.cron !== undefined && !validCron(patch.cron)) return false
  return optionalBoolean(patch.enabled)
}

export function parseActionEnvelope(value: unknown): CronActionEnvelope | undefined {
  const envelope = record(value)
  if (envelope === undefined || !exactKeys(envelope, ['requestId', 'action'])) return undefined
  if (typeof envelope.requestId !== 'string' || envelope.requestId.trim() === '' || envelope.requestId.length > 256) return undefined
  const action = record(envelope.action)
  if (action === undefined || typeof action.kind !== 'string') return undefined
  const jobId = typeof action.jobId === 'string' && action.jobId !== '' ? action.jobId : undefined
  switch (action.kind) {
    case 'create':
      if (!exactKeys(action, ['kind', 'id', 'input'])) return undefined
      return typeof action.id === 'string' && action.id !== '' && validInput(action.input)
        ? { requestId: envelope.requestId, action: action as unknown as Extract<CronAction, { kind: 'create' }> }
        : undefined
    case 'update':
      if (!exactKeys(action, ['kind', 'jobId', 'patch'])) return undefined
      return jobId !== undefined && validPatch(action.patch)
        ? { requestId: envelope.requestId, action: action as unknown as Extract<CronAction, { kind: 'update' }> }
        : undefined
    case 'delete':
    case 'enable':
    case 'disable':
    case 'run':
    case 'rerun':
      if (!exactKeys(action, ['kind', 'jobId'])) return undefined
      return jobId === undefined ? undefined : { requestId: envelope.requestId, action: action as CronAction }
    default:
      return undefined
  }
}
