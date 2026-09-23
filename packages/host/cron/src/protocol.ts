/**
 * Same-origin action protocol for the cron job ledger.
 *
 * Every browser mutation is a versioned, strictly validated discriminated
 * union. The Host re-validates each payload field (exact keys, types,
 * enumerations) before touching the ledger; there are no command, shell, or
 * executable fields anywhere in the union. The browser never writes
 * scheduler-owned timestamps or execution results.
 */
import { isCronJobAction, isUsableJobName, type CronActionOptions, type JobRecord, type NewJobInput, type JobUpdatePatch } from './jobs.ts'
import { isValidCron, nextRunAtMs } from './cron.ts'

export const CRON_SCHEMA_VERSION = 2 as const
export const CRON_API_PREFIX = '/api/cron'

/**
 * Why an occurrence never fired.
 *
 * - `dst-gap`: its local wall clock does not exist (spring-forward), so the
 *   scheduler rolled past it and it can never fire (2026-09-23 R3-B3 F2).
 * - `missed`: it came due while nothing was scheduling (the app was closed or
 *   suspended, or the job was not visible to the running session) and the
 *   recovery policy rolls such occurrences forward instead of replaying them
 *   (2026-09-23 R4-B-9). Records written before this field existed are all DST
 *   gaps, so an absent reason reads as `dst-gap`.
 */
export type SkipReason = 'dst-gap' | 'missed'

/**
 * One occurrence the scheduler rolled past without firing.
 *
 * The skip itself is correct — a local time that does not exist cannot fire,
 * and a trigger missed while the app was closed is never replayed — but it used
 * to be invisible: the job simply did not run. This record is what the panel
 * and `GET /api/cron/state` show, so a user can tell "the 02:30 run was skipped
 * because 02:30 did not exist" or "the 09:00 run was missed because the app was
 * closed" from "the scheduler is broken".
 */
export interface SkippedOccurrence {
  /** Job the occurrence belonged to. */
  jobId: string
  /** Job name when the skip was recorded (so the notice needs no join). */
  name: string
  /** Why it never fired; absent = a pre-`reason` DST-gap record. */
  reason?: SkipReason
  /** Wall clock the occurrence asked for (or the missing local time), as `YYYY-MM-DD HH:MM`. */
  wallClock: string
  /** IANA timezone the skip was computed in (the scheduler's timezone). */
  timeZone: string
  /** The instant the occurrence was due at (a DST gap: the instant it normalized forward to). */
  normalizedTo: number
  /** When the roll observed the skip (Host clock, ms epoch). */
  detectedAt: number
}

export interface CronSchedulerSnapshot {
  timeZone: string
  /** Opaque identity of the current Host ledger generation. */
  ledgerId?: string
  lastTickAt?: number
  error?: string
  /**
   * Set when the Host could not read its ledger at startup (a non-ENOENT errno,
   * or a corrupt file whose bytes could not be isolated): reads answer from an
   * empty in-memory state and **every write is refused**, so the stored jobs are
   * never overwritten. The panel renders this as its own notice instead of the
   * "corrupt and reset" one (2026-09-23 CR-1).
   */
  readOnly?: boolean
  /**
   * Most recent occurrences the scheduler rolled past without firing — DST
   * spring-forward gaps (the local time does not exist) and triggers missed
   * while nothing was scheduling — oldest first, bounded. Each entry carries
   * its {@link SkippedOccurrence.reason}. The panel shows the latest one while
   * it is fresh; `GET /api/cron/state` and the SSE frames carry the list itself
   * (2026-09-23 R3-B3 F2 / B-5, extended by R4-B-9).
   */
  skippedOccurrences?: SkippedOccurrence[]
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
 * next instant inside the per-schedule scan horizon — eight years for the
 * plain forms, forty-one when the day/weekday AND branch is in play (see
 * `horizonDays` in cron.ts). A calendar-impossible schedule such as
 * `0 0 30 2 *` would otherwise produce a silently inert job.
 */
function validCron(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false
  if (!isValidCron(value)) return false
  return nextRunAtMs(value, Date.now()) !== undefined
}

function validInput(value: unknown, options: CronActionOptions): value is NewJobInput {
  const input = record(value)
  if (input === undefined || !exactKeys(input, ['name', 'cron', 'action', 'enabled'])) return false
  // Name and cron share their judgement with the model-facing tool
  // (`isUsableJobName` / `validCron`) instead of each surface re-deciding what
  // "non-empty" means (2026-09-23 R3-B3 F3 / B-4).
  if (!isUsableJobName(input.name)) return false
  if (!validCron(input.cron)) return false
  if (!optionalBoolean(input.enabled)) return false
  return isCronJobAction(input.action, options)
}

function validPatch(value: unknown): value is JobUpdatePatch {
  const patch = record(value)
  if (patch === undefined || !exactKeys(patch, ['name', 'cron', 'enabled'])) return false
  if (patch.name !== undefined && !isUsableJobName(patch.name)) return false
  if (patch.cron !== undefined && !validCron(patch.cron)) return false
  return optionalBoolean(patch.enabled)
}

export function parseActionEnvelope(value: unknown, options: CronActionOptions = {}): CronActionEnvelope | undefined {
  const envelope = record(value)
  if (envelope === undefined || !exactKeys(envelope, ['requestId', 'action'])) return undefined
  if (typeof envelope.requestId !== 'string' || envelope.requestId.trim() === '' || envelope.requestId.length > 256) return undefined
  const action = record(envelope.action)
  if (action === undefined || typeof action.kind !== 'string') return undefined
  const jobId = typeof action.jobId === 'string' && action.jobId !== '' ? action.jobId : undefined
  switch (action.kind) {
    case 'create':
      if (!exactKeys(action, ['kind', 'id', 'input'])) return undefined
      return typeof action.id === 'string' && action.id !== '' && validInput(action.input, options)
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
