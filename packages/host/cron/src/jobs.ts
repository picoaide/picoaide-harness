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
 *
 * v2: only one action kind remains — `agent` (spawn a fresh agent session
 * for a task prompt, optionally pinned to a workspace / agent preset /
 * permission). The legacy `task` (dsh-task board reference) and `prompt`
 * (send a message to an existing session) kinds were removed when the task
 * board was merged into the scheduler.
 */
import { nextRunAtMs } from './cron.ts'

/** Result states of one triggered execution (a trigger record, not an agent turn). */
export type ExecutionResult = 'succeeded' | 'failed' | 'cancelled'

/**
 * One trigger record of a job. v2 carries session-level detail: the agent
 * session spawned for this run, its prompt, and start/end timestamps.
 */
export interface ExecutionRecord {
  /** Stable id (unique per execution, idempotency key). */
  id: string
  /** When the trigger fired (Host clock, ms epoch). */
  triggeredAt: number
  /** The agent session created for this run (attached after launch). */
  sessionId?: string
  /** The full prompt sent to the session (task prompt, never a shell line). */
  prompt?: string
  startedAt?: number
  endedAt?: number
  result?: ExecutionResult
  /** Human-readable failure/cancellation reason. */
  error?: string
}

/**
 * What a triggered job does. The union is closed and versioned by the
 * protocol validator; adding a kind is a schema change, not a config escape.
 * v2: the only kind is `agent` — spawn a fresh agent session and prompt it.
 */
export type CronJobAction = {
  kind: 'agent'
  /** Prompt text sent to the new agent session (queue mode). */
  prompt: string
  /** Pinned workspace; absent = current workspace. */
  workspaceId?: string
  /** Pinned agent preset (from agentPresets.list); absent = composition default. */
  agentPreset?: string
  /** Optional permission preset applied via /permission before the prompt. */
  permission?: string
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
  if (action.kind !== 'agent') return false
  // Exact key set: no command, shell, or executable fields may ride along.
  const allowed = new Set(['kind', 'prompt', 'workspaceId', 'agentPreset', 'permission'])
  if (!Object.keys(action).every(key => allowed.has(key))) return false
  if (typeof action.prompt !== 'string' || action.prompt.trim() === '') return false
  if (action.workspaceId !== undefined && typeof action.workspaceId !== 'string') return false
  if (action.agentPreset !== undefined && typeof action.agentPreset !== 'string') return false
  if (action.permission !== undefined && typeof action.permission !== 'string') return false
  return true
}

/** Create an execution record for a pending trigger. */
export function startExecution(id: string, now: number): ExecutionRecord {
  return { id, triggeredAt: now, startedAt: now }
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
