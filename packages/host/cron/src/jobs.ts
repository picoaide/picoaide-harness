/**
 * Cron job domain model: the durable record shape, the action discriminated
 * union, and the pure state transitions. Shared by the Host ledger, the
 * scheduler, the executor, and the browser view.
 *
 * A job is an independent scheduled unit. The scheduler owns the "when"
 * (cron + next-run roll-forward), the executor owns the "what" (the action).
 * Actions are a closed discriminated union with no command, executable, or
 * shell fields: the prompt text is data sent to an agent session, never a
 * shell line.
 */
import { nextRunAtMs } from './cron.ts'

/** Result states of one triggered execution (a trigger record, not an agent turn). */
export type ExecutionResult = 'succeeded' | 'failed' | 'cancelled'

/** One trigger record of a job. */
export interface ExecutionRecord {
  /** Stable id (unique per execution, idempotency key). */
  id: string
  /** When the trigger fired (Host clock, ms epoch). */
  triggeredAt: number
  /** When the execution settled; undefined while pending. */
  endedAt?: number
  result?: ExecutionResult
  /** Human-readable failure/cancellation reason. */
  error?: string
}

/**
 * What a triggered job does. The union is closed and versioned by the
 * protocol validator; adding a kind is a schema change, not a config escape.
 */
export type CronJobAction =
  | {
    kind: 'task'
    /** A task id owned by the dsh-task plugin (resolved at run time). */
    taskId: string
  }
  | {
    kind: 'prompt'
    /** Target session; required — a prompt action always names a session. */
    sessionId: string
    /** Prompt text sent to the session (queue mode). */
    text: string
  }

/** A durable scheduled job record. */
export interface JobRecord {
  id: string
  name: string
  /** 5-field cron expression (validated by core/cron.ts). */
  cron: string
  action: CronJobAction
  enabled: boolean
  /**
   * Display name of the account that created this job (gateway username).
   * Absent on records persisted before the owner field existed: those keep
   * their pre-upgrade semantics (executable by whoever is logged in) and are
   * returned to every session for visibility. Jobs created after the upgrade
   * are owner-scoped: only the same account can see/execute them.
   */
  owner?: string
  /** Next matching instant (Host local time), rolled by the scheduler. */
  nextRunAt?: number
  /** Last successful trigger time (ms epoch). */
  lastTriggeredAt?: number
  /** Trigger records, newest last. */
  executions: ExecutionRecord[]
  createdAt: number
  updatedAt: number
}

/** Fields a client may set when creating a job. */
export interface NewJobInput {
  name: string
  cron: string
  action: CronJobAction
  enabled?: boolean
}

/** Fields a client may patch on an existing job. */
export interface JobUpdatePatch {
  name?: string
  cron?: string
  enabled?: boolean
}

export function isExecutionResult(value: unknown): value is ExecutionResult {
  return value === 'succeeded' || value === 'failed' || value === 'cancelled'
}

export function isCronJobAction(value: unknown): value is CronJobAction {
  if (typeof value !== 'object' || value === null) return false
  const action = value as Record<string, unknown>
  const keys = Object.keys(action)
  if (action.kind === 'task') {
    // Exact key set: no command, shell, or executable fields may ride along.
    if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('taskId')) return false
    return typeof action.taskId === 'string' && action.taskId !== ''
  }
  if (action.kind === 'prompt') {
    if (keys.length !== 3 || !keys.includes('kind') || !keys.includes('sessionId') || !keys.includes('text')) return false
    return typeof action.sessionId === 'string' && action.sessionId !== ''
      && typeof action.text === 'string' && action.text !== ''
  }
  return false
}

/** Create an execution record for a pending trigger. */
export function startExecution(id: string, now: number): ExecutionRecord {
  return { id, triggeredAt: now }
}

/** Settle a pending execution with a result and optional error. */
export function settleExecution(
  execution: ExecutionRecord,
  result: ExecutionResult,
  now: number,
  error?: string,
): ExecutionRecord {
  return {
    ...execution,
    endedAt: now,
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
  }
}

/** Build a new job record from validated input. */
export function createJob(id: string, input: NewJobInput, now: number, owner?: string): JobRecord {
  return {
    id,
    name: input.name,
    cron: input.cron,
    action: input.action,
    enabled: input.enabled ?? false,
    ...(owner === undefined || owner.length === 0 ? {} : { owner }),
    executions: [],
    createdAt: now,
    updatedAt: now,
  }
}

/** Whether a job is visible to (and executable by) the given account. */
export function jobVisibleTo(job: JobRecord, username: string | null | undefined): boolean {
  // Legacy records (no owner) stay visible to every session; owner-scoped
  // records are visible only to their creating account.
  if (job.owner === undefined) return true
  return username !== undefined && username !== null && username.length > 0 && job.owner === username
}

/** Apply a validated patch to an existing job record (immutable update). */
export function updateJob(job: JobRecord, patch: JobUpdatePatch, now: number): JobRecord {
  return {
    ...job,
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.cron === undefined ? {} : { cron: patch.cron }),
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    updatedAt: now,
  }
}

/**
 * Roll the job's next-run instant strictly past `fromMs`. When the job has
 * no nextRunAt yet (freshly created or just re-enabled), seed it from
 * `fromMs`.
 */
export function rollNextRun(job: JobRecord, fromMs: number): number | undefined {
  const base = job.nextRunAt === undefined ? fromMs : Math.max(job.nextRunAt, fromMs)
  return nextRunAtMs(job.cron, base)
}
