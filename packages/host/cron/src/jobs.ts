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
import { nextRunAtMsWithGaps, type WallClockGap } from './cron.ts'

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

/**
 * Roster used to validate a job action (FIX-17). The `permission` field names
 * a preset of the composed permission service (`ctx.permissionPresets.names`);
 * it was free text before, so every typo was accepted and then silently
 * dropped by the executor.
 */
export interface CronActionOptions {
  /**
   * Known permission preset names. When provided — even as an empty array — a
   * pinned `permission` must be a member. Omitted only by callers that do not
   * know the roster (shape-only validation).
   */
  permissions?: readonly string[]
}

/** Fields a client may patch on an existing job. */
export interface JobUpdatePatch {
  name?: string
  cron?: string
  enabled?: boolean
}

/**
 * Whether a job name is usable (2026-09-23 R3-B3 F3 / B-4).
 *
 * ONE judgement for every surface that accepts a name: the browser action
 * protocol (`validInput` / `validPatch` in protocol.ts) and the model-facing
 * `cron_create` tool. The empty string and whitespace-only both count as
 * missing — the tool used to `trim()` a blank name and store `''`, so the job
 * card, `cron_list`, and the session title the job spawns were all nameless
 * while the GUI refused the very same input.
 */
export function isUsableJobName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function isCronJobAction(value: unknown, options: CronActionOptions = {}): value is CronJobAction {
  if (typeof value !== 'object' || value === null) return false
  const action = value as Record<string, unknown>
  if (action.kind !== 'agent') return false
  // Exact key set: no command, shell, or executable fields may ride along.
  const allowed = new Set(['kind', 'prompt', 'workspaceId', 'agentPreset', 'permission'])
  if (!Object.keys(action).every(key => allowed.has(key))) return false
  if (typeof action.prompt !== 'string' || action.prompt.trim() === '') return false
  if (action.workspaceId !== undefined && typeof action.workspaceId !== 'string') return false
  if (action.agentPreset !== undefined && typeof action.agentPreset !== 'string') return false
  if (action.permission !== undefined) {
    if (typeof action.permission !== 'string' || action.permission.trim() === '') return false
    // Enum member of the composed preset roster (FIX-17): an unknown name is a
    // rejected job, never a job that quietly runs without its permission.
    if (options.permissions !== undefined && !options.permissions.includes(action.permission)) return false
  }
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

/**
 * Canonical account key for job ownership (2026-09-23 CR-7).
 *
 * The identity the enterprise session hands the Host is the **typed login
 * string** (`server-connector/auth.ts` builds `Session.username` from the login
 * form field), while the server resolves accounts with `lower(username) =
 * lower(?)` and returns the canonical spelling only in the login response —
 * which the client ignores. Using the raw text as the owner key splits one
 * account into two keys (`Alice` vs `alice`): after signing in with a different
 * spelling the account no longer sees its own jobs **and the scheduler stops
 * running them**, while the records stay on disk.
 *
 * Normalising to the server's own uniqueness rule (trim + lower) keeps a single
 * key per account. It is deliberately a *comparison-and-stamp* rule instead of a
 * destructive rewrite: records stamped before this change keep matching without
 * a migration, so no data can be lost by skipping it (`load()` converges the
 * stored spelling on the next successful write).
 */
export function normalizeOwner(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const key = value.trim().toLowerCase()
  return key === '' ? undefined : key
}

/** Build a new job record from validated input. The owner is stamped in its canonical form. */
export function createJob(id: string, input: NewJobInput, now: number, owner?: string): JobRecord {
  const key = normalizeOwner(owner)
  return {
    id,
    name: input.name,
    cron: input.cron,
    action: input.action,
    enabled: input.enabled ?? false,
    ...(key === undefined ? {} : { owner: key }),
    executions: [],
    createdAt: now,
    updatedAt: now,
  }
}

/** Whether a job is visible to (and executable by) the given account. */
export function jobVisibleTo(job: JobRecord, username: string | null | undefined): boolean {
  // Legacy records (no owner) stay visible to every session; owner-scoped
  // records are visible only to their creating account. The comparison runs on
  // the canonical key (CR-7), so a record stamped with `Alice` still matches
  // the same account typed as `alice`.
  const owner = normalizeOwner(job.owner)
  if (owner === undefined) return true
  return normalizeOwner(username) === owner
}

/**
 * Whether the job has a run that has not settled yet.
 *
 * The single judgement behind "a live run must not lose its record"
 * (2026-09-23 CR-2): the ledger refuses to delete such a job, the agent tools
 * report it, and the panel disables its delete button. Deleting does not cancel
 * the spawned session, and settling a deleted job's execution can only drop the
 * record (session id, prompt, timings, result) — so the delete is refused while
 * the run is live.
 */
export function jobIsRunning(job: Pick<JobRecord, 'executions'>): boolean {
  return job.executions.some(execution => execution.endedAt === undefined)
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

/** One roll-forward: the new instant plus the occurrences the roll skipped (DST gaps). */
export interface NextRunRoll {
  at: number | undefined
  gaps: readonly WallClockGap[]
}

/**
 * Roll the job's next-run instant strictly past `fromMs`. When the job has
 * no nextRunAt yet (freshly created or just re-enabled), seed it from
 * `fromMs`.
 */
export function rollNextRun(job: JobRecord, fromMs: number): number | undefined {
  return rollNextRunWithGaps(job, fromMs).at
}

/**
 * Same roll as {@link rollNextRun}, and additionally reports every wall-clock
 * occurrence the roll walked past because that local time does not exist in
 * the host timezone (2026-09-23 R3-B3 F2 / B-5). The ledger records them, so a
 * DST gap shows up as "this occurrence was skipped" instead of as a job that
 * silently did not run for a day.
 *
 * The scan base is the same one `rollNextRun` uses: an existing `nextRunAt`
 * acts as a floor, so a roll can never fire or skip an occurrence twice.
 */
export function rollNextRunWithGaps(job: JobRecord, fromMs: number): NextRunRoll {
  const base = job.nextRunAt === undefined ? fromMs : Math.max(job.nextRunAt, fromMs)
  return nextRunAtMsWithGaps(job.cron, base)
}
