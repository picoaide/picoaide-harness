/**
 * Host-authoritative cron job ledger.
 *
 * All mutations serialize through {@link HostCronLedger.applyRequest}, which
 * persists the full document (temp file + atomic rename, 0600 on POSIX),
 * bumps the revision monotonically, and dedupes repeated requestIds via a
 * bounded SHA-256 fingerprint cache so Host-restart retries stay idempotent.
 *
 * Design ported from dsh-web-ui (Apache-2.0) packages/dsh-task-board
 * src/host-ledger.ts, adapted to the cron job domain.
 */
import { createHash } from 'node:crypto'
import {
  chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './dsh-home.ts'
import { isValidCron } from './cron.ts'
import {
  createJob, jobVisibleTo, settleExecution, startExecution, updateJob, rollNextRun,
  type ExecutionRecord, type JobRecord,
} from './jobs.ts'
import { CRON_SCHEMA_VERSION, type CronAction, type CronSchedulerSnapshot } from './protocol.ts'

interface PersistedScheduler extends CronSchedulerSnapshot {
  importedSources?: string[]
}

interface PersistedRequest {
  requestId: string
  fingerprint: string
}

interface LedgerDocument {
  schemaVersion: typeof CRON_SCHEMA_VERSION
  revision: number
  jobs: JobRecord[]
  scheduler: PersistedScheduler
  recentRequests: PersistedRequest[]
}

export interface LedgerState {
  revision: number
  jobs: JobRecord[]
  scheduler: CronSchedulerSnapshot
}

/** Result of one applied action. */
export interface ApplyResult {
  state: LedgerState
  /** Set when the action opened a new execution that must be launched. */
  run?: { job: JobRecord; execution: ExecutionRecord }
  /** Set when the action asked to launch an existing settled execution again. */
  rerun?: { job: JobRecord; execution: ExecutionRecord }
}

const MAX_REQUEST_CACHE = 256

/** 保留的执行历史条数上限(审计 2026-08-25 P2-5):executions 曾只增不减,
 * 高频 job 的 ledger.json 无限膨胀且每次 mutate 全量重写。 */
const MAX_EXECUTION_HISTORY = 100

/** A lock file without a parseable owner pid is reclaimed once older than this. */
const STALE_LOCK_AGE_MS = 45_000

interface CachedRequest {
  fingerprint: string
}

function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
}

/** A job record with the nextRunAt optional field stripped (exactOptionalPropertyTypes). */
function withoutNextRun(job: JobRecord): JobRecord {
  const { nextRunAt: _drop, ...rest } = job
  void _drop
  return rest
}

/** Conditionally-shaped nextRunAt seed for object literals. */
function seededNextRun(job: JobRecord, now: number): { nextRunAt: number } | Record<string, never> {
  const next = rollNextRun(job, now)
  return next === undefined ? {} : { nextRunAt: next }
}

function cloneJobs(jobs: readonly JobRecord[]): JobRecord[] {
  return JSON.parse(JSON.stringify(jobs)) as JobRecord[]
}

function hasOpenExecution(job: JobRecord): boolean {
  return job.executions.some(execution => execution.endedAt === undefined)
}

function fingerprintOf(requestId: string, action: CronAction): string {
  return createHash('sha256').update(JSON.stringify({ requestId, action })).digest('hex')
}

/**
 * Open a scheduled run: record a pending execution, roll nextRunAt forward,
 * and remember the trigger time. Returns the opened run, or undefined when
 * the job is disabled/archived/already running or the schedule cannot match.
 */
export function openScheduledRun(job: JobRecord, executionId: string, now: number): { job: JobRecord; execution: ExecutionRecord } | undefined {
  if (!job.enabled) return undefined
  if (hasOpenExecution(job)) return undefined
  const execution = startExecution(executionId, now)
  const nextRunAt = rollNextRun(job, now)
  return {
    job: {
      ...job,
      executions: [...job.executions, execution],
      lastTriggeredAt: now,
      ...(nextRunAt === undefined ? {} : { nextRunAt }),
    },
    execution,
  }
}

/**
 * Host-owned ledger with serialized, idempotent, atomically persisted
 * mutations. One instance per Host process; a file lock guards against a
 * second Host process writing the same DSH home.
 */
export class HostCronLedger {
  private current: LedgerState
  private readonly cache = new Map<string, CachedRequest>()
  private readonly listeners = new Set<() => void>()
  private readonly lockPath: string
  private readonly filePath: string
  private lockFd: number | undefined
  private disposed = false
  /** Current account (gateway username); null when logged out. */
  private readonly owner: () => string | null

  constructor(options: { dshHomeDir?: string; now?: () => number; owner?: () => string | null } = {}) {
    const home = options.dshHomeDir ?? dshHome()
    const dir = join(home, 'cron')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.filePath = join(dir, 'ledger.json')
    this.lockPath = join(dir, 'ledger.lock')
    this.now = options.now ?? Date.now
    this.owner = options.owner ?? (() => null)
    this.acquireLock()
    this.current = this.load()
  }

  private readonly now: () => number

  private acquireLock(): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.lockPath, 'wx', 0o600)
        this.lockFd = fd
        writeFileSync(fd, `${process.pid}\n`)
        // fsync before the lock is considered held: a crash right after
        // open('wx') would otherwise leave an empty lock that later stale
        // recovery must guess about.
        fsyncSync(fd)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') {
          // Any other failure (EACCES/EMFILE) must fail closed: running
          // without the lock would let two Hosts write the same ledger.
          throw new Error(`dsh-cron: cannot acquire ledger lock: ${String(error)}`)
        }
        if (attempt === 1) {
          throw new Error('dsh-cron: another Host process owns the cron ledger (ledger.lock exists and its owner is alive)')
        }
        // Stale-lock recovery: a crashed Host leaves the lock behind. Read
        // the owner pid; when the process is gone, reclaim the lock.
        if (this.reclaimStaleLock()) continue
        throw new Error('dsh-cron: another Host process owns the cron ledger (ledger.lock exists and its owner is alive)')
      }
    }
    throw new Error('dsh-cron: cannot acquire ledger lock')
  }

  /** Reclaim a lock file whose recorded owner pid is no longer alive. */
  private reclaimStaleLock(): boolean {
    try {
      const raw = readFileSync(this.lockPath, 'utf8').trim()
      const pid = Number(raw)
      if (!Number.isInteger(pid) || pid <= 0) {
        // An empty/garbage lock file means the previous Host crashed between
        // open('wx') and writing the pid. Treat it as stale once it is older
        // than a full tick cycle (a live owner would have written its pid
        // immediately after creating the file).
        const mtime = statSync(this.lockPath).mtimeMs
        if (Date.now() - mtime > STALE_LOCK_AGE_MS) {
          unlinkSync(this.lockPath)
          return true
        }
        return false
      }
      try {
        process.kill(pid, 0)
        return false // Owner is alive.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return false // Alive but not ours.
        // ESRCH: no such process — stale.
      }
      unlinkSync(this.lockPath)
      return true
    } catch {
      return false
    }
  }

  private load(): LedgerState {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch {
      return { revision: 0, jobs: [], scheduler: { timeZone: timeZone(), ledgerId: crypto.randomUUID() } }
    }
    try {
      const parsed = JSON.parse(raw) as LedgerDocument
      if (typeof parsed.schemaVersion !== 'number' || !Array.isArray(parsed.jobs)) {
        throw new Error('unexpected schema')
      }
      let jobs = parsed.jobs
      // Schema 迁移(审计 2026-08-25 C-1):此前把「schema 版本不匹配」当损坏
      // 处理 → rename .corrupt + 清空全部数据,且无迁移路径;任何未来字段
      // 变更都会静默抹掉用户全部定时任务。现在区分:
      // - 当前版本 → 直接读;
      // - 已知旧版本 → 逐级 migrate(新版本必须在此注册);
      // - 高于当前(未知未来) → 保守拒绝(不破坏数据,报错而非清空)。
      if (parsed.schemaVersion < CRON_SCHEMA_VERSION) {
        jobs = migrateCronLedger(jobs, parsed.schemaVersion)
      } else if (parsed.schemaVersion > CRON_SCHEMA_VERSION) {
        throw new Error(`ledger schema v${String(parsed.schemaVersion)} is newer than supported v${CRON_SCHEMA_VERSION}`)
      }
      const state: LedgerState = {
        revision: parsed.revision,
        jobs,
        scheduler: {
          timeZone: parsed.scheduler?.timeZone ?? timeZone(),
          ...(parsed.scheduler?.ledgerId === undefined ? {} : { ledgerId: parsed.scheduler.ledgerId }),
          ...(parsed.scheduler?.lastTickAt === undefined ? {} : { lastTickAt: parsed.scheduler.lastTickAt }),
          ...(parsed.scheduler?.error === undefined ? {} : { error: parsed.scheduler.error }),
        },
      }
      // Restore the idempotency cache from the persisted request log so a
      // retried requestId after a Host restart is still recognized.
      for (const entry of Array.isArray(parsed.recentRequests) ? parsed.recentRequests : []) {
        if (typeof entry?.requestId === 'string' && typeof entry?.fingerprint === 'string') {
          this.cache.set(entry.requestId, { fingerprint: entry.fingerprint })
        }
      }
      this.reconcileInterruptedStarts(state, this.now())
      return state
    } catch (error) {
      // Corrupt or newer-than-supported ledger: isolate the bytes and start
      // empty (loudly visible via the scheduler error field), never overwrite
      // the original file. 审计 2026-08-25 C-1:只有真正的损坏/未来版本才
      // 触发 .corrupt;可迁移旧版本已在上面的 migrate 路径处理。
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
      } catch {
        // Best effort.
      }
      return {
        revision: 0,
        jobs: [],
        scheduler: {
          timeZone: timeZone(),
          ledgerId: crypto.randomUUID(),
          error: 'ledger was corrupt or too new and reset',
        },
      }
    }
  }

  private persist(): void {
    const document: LedgerDocument = {
      schemaVersion: CRON_SCHEMA_VERSION,
      revision: this.current.revision,
      jobs: this.current.jobs,
      scheduler: this.current.scheduler,
      recentRequests: [...this.cache.entries()].map(([requestId, entry]) => ({
        requestId,
        fingerprint: entry.fingerprint,
      })),
    }
    const tmp = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeFileSync(fd, JSON.stringify(document))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.filePath)
    this.pruneCache()
  }

  private pruneCache(): void {
    while (this.cache.size > MAX_REQUEST_CACHE) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  state(): LedgerState {
    return {
      revision: this.current.revision,
      jobs: cloneJobs(this.current.jobs),
      scheduler: { ...this.current.scheduler },
    }
  }

  /**
   * Reconcile executions left pending by a crashed Host: a pending execution
   * has no in-flight session evidence (the ledger cannot observe sessions),
   * so it is settled as cancelled and its job's nextRunAt is rolled forward
   * past `now` so the job can trigger again. Never re-fires a start that was
   * interrupted before the session was recorded.
   */
  private reconcileInterruptedStarts(state: LedgerState, now: number): void {
    for (const job of state.jobs) {
      const pending = job.executions.find(execution => execution.endedAt === undefined)
      if (pending === undefined) continue
      const settled = settleExecution(pending, 'cancelled', now, 'host restarted before the execution settled')
      job.executions = job.executions.map(execution => execution.id === pending.id ? settled : execution)
      // Roll forward only when the schedule is already due: a nextRunAt in
      // the future was set when the run opened and must be preserved, or the
      // very next trigger would be silently skipped.
      if (job.nextRunAt !== undefined && job.nextRunAt <= now) {
        const nextRunAt = rollNextRun(job, now)
        if (nextRunAt === undefined) delete job.nextRunAt
        else job.nextRunAt = nextRunAt
      }
    }
  }

  /** Lightweight summary for SSE frames (no deep clone of the job list). */
  summary(): { revision: number; scheduler: CronSchedulerSnapshot } {
    return { revision: this.current.revision, scheduler: { ...this.current.scheduler } }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private mutate(mutator: (state: LedgerState) => boolean): void {
    if (!mutator(this.current)) return
    this.current.revision += 1
    this.persist()
    this.emit()
  }

  /**
   * Apply one browser/UI action with idempotency. Returns the new snapshot
   * and, when a run was opened, the run to launch.
   */
  applyRequest(requestId: string, action: CronAction): ApplyResult {
    const fingerprint = fingerprintOf(requestId, action)
    const cached = this.cache.get(requestId)
    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprint) {
        // The same requestId was already applied with a different payload:
        // a client bug or a forged retry. Refuse loudly instead of silently
        // dropping the mutation.
        throw new Error(`dsh-cron: request id was reused with a different action: ${requestId}`)
      }
      // Duplicate request: the original mutation already happened; re-answer
      // with the current state (a rerun in flight is not re-opened).
      return { state: this.state() }
    }
    this.cache.set(requestId, { fingerprint })

    // Owner enforcement for target actions: an owner-scoped job may only be
    // mutated by its creating account. Legacy (owner-less) jobs stay
    // reachable by everyone — the pre-upgrade behavior.
    const targetAction = action.kind === 'update' || action.kind === 'delete' || action.kind === 'enable'
      || action.kind === 'disable' || action.kind === 'run' || action.kind === 'rerun'
      ? action : undefined
    if (targetAction !== undefined) {
      const target = this.current.jobs.find(job => job.id === targetAction.jobId)
      if (target !== undefined && !jobVisibleTo(target, this.owner())) {
        throw new Error(`dsh-cron: job ${targetAction.jobId} belongs to another account`)
      }
    }

    let opened: { job: JobRecord; execution: ExecutionRecord } | undefined
    let rerun: { job: JobRecord; execution: ExecutionRecord } | undefined

    this.mutate((state) => {
      switch (action.kind) {
        case 'create': {
          const existing = state.jobs.find(job => job.id === action.id)
          if (existing !== undefined) return false
          const job = createJob(action.id, action.input, this.now(), this.owner() ?? undefined)
          if (job.enabled) {
            const seeded = rollNextRun(job, this.now())
            if (seeded !== undefined) job.nextRunAt = seeded
          }
          state.jobs.push(job)
          return true
        }
        case 'update': {
          const index = state.jobs.findIndex(job => job.id === action.jobId)
          if (index < 0) return false
          const job = state.jobs[index]!
          const next: JobRecord = updateJob(job, action.patch, this.now())
          // Re-seed nextRunAt when the cron changed or the job was just
          // enabled: the scheduler re-derives it from the current time.
          if (action.patch.cron !== undefined && action.patch.cron !== job.cron) {
            const seeded = rollNextRun(withoutNextRun(next), this.now())
            if (seeded !== undefined) next.nextRunAt = seeded
          } else if (action.patch.enabled === true && job.nextRunAt === undefined) {
            const seeded = rollNextRun(withoutNextRun(next), this.now())
            if (seeded !== undefined) next.nextRunAt = seeded
          }
          state.jobs[index] = next
          return true
        }
        case 'delete': {
          const before = state.jobs.length
          state.jobs = state.jobs.filter(job => job.id !== action.jobId)
          return state.jobs.length !== before
        }
        case 'enable': {
          const index = state.jobs.findIndex(job => job.id === action.jobId)
          if (index < 0) return false
          const job = state.jobs[index]!
          if (job.enabled) return false
          const next: JobRecord = {
            ...job,
            enabled: true,
            ...(job.nextRunAt === undefined ? seededNextRun(job, this.now()) : {}),
            updatedAt: this.now(),
          }
          state.jobs[index] = next
          return true
        }
        case 'disable': {
          const index = state.jobs.findIndex(job => job.id === action.jobId)
          if (index < 0) return false
          const job = state.jobs[index]!
          if (!job.enabled) return false
          state.jobs[index] = { ...job, enabled: false, updatedAt: this.now() }
          return true
        }
        case 'run': {
          const index = state.jobs.findIndex(job => job.id === action.jobId)
          if (index < 0) return false
          const job = state.jobs[index]!
          if (hasOpenExecution(job)) return false
          const execution = startExecution(`run-${crypto.randomUUID()}`, this.now())
          const next: JobRecord = {
            ...job,
            executions: [...job.executions, execution],
            lastTriggeredAt: this.now(),
          }
          state.jobs[index] = next
          opened = { job: next, execution }
          return true
        }
        case 'rerun': {
          const index = state.jobs.findIndex(job => job.id === action.jobId)
          if (index < 0) return false
          const job = state.jobs[index]!
          if (hasOpenExecution(job)) return false
          const execution = startExecution(`rerun-${crypto.randomUUID()}`, this.now())
          const next: JobRecord = {
            ...job,
            executions: [...job.executions, execution],
            lastTriggeredAt: this.now(),
          }
          state.jobs[index] = next
          rerun = { job: next, execution }
          return true
        }
        default:
          return false
      }
    })

    return {
      state: this.state(),
      ...(opened === undefined ? {} : { run: opened }),
      ...(rerun === undefined ? {} : { rerun }),
    }
  }

  /** Scheduler-owned: record a tick time (persisted, revision-bumped). */
  setScheduler(patch: Omit<Partial<CronSchedulerSnapshot>, 'error'> & { error?: string | undefined }): void {
    this.mutate((state) => {
      // `error: undefined` explicitly clears a previously recorded error.
      const { error, ...rest } = patch
      state.scheduler = { ...state.scheduler, ...rest }
      if ('error' in patch && error === undefined) delete state.scheduler.error
      else if (error !== undefined) state.scheduler.error = error
      return true
    })
  }

  /** Scheduler-owned: settle an execution with a result. Prunes old history. */
  settle(jobId: string, executionId: string, result: 'succeeded' | 'failed' | 'cancelled', error?: string): void {
    this.mutate((state) => {
      const job = state.jobs.find(candidate => candidate.id === jobId)
      if (job === undefined) return false
      const index = job.executions.findIndex(execution => execution.id === executionId)
      if (index < 0) return false
      const settled = settleExecution(job.executions[index]!, result, this.now(), error)
      job.executions[index] = settled
      // 裁剪执行的旧历史(审计 2026-08-25 P2-5):只保留最近 N 条。
      if (job.executions.length > MAX_EXECUTION_HISTORY) {
        job.executions = job.executions.slice(job.executions.length - MAX_EXECUTION_HISTORY)
      }
      return true
    })
  }

  /** Scheduler-owned: attach the spawned session id to a pending execution. */
  attachSession(jobId: string, executionId: string, sessionId: string): void {
    this.mutate((state) => {
      const job = state.jobs.find(candidate => candidate.id === jobId)
      if (job === undefined) return false
      const index = job.executions.findIndex(execution => execution.id === executionId)
      if (index < 0) return false
      const execution = job.executions[index]!
      if (execution.endedAt !== undefined) return false
      job.executions[index] = { ...execution, sessionId }
      return true
    })
  }

  /** Scheduler-owned: attach the prompt text to a pending execution. */
  attachPrompt(jobId: string, executionId: string, prompt: string): void {
    this.mutate((state) => {
      const job = state.jobs.find(candidate => candidate.id === jobId)
      if (job === undefined) return false
      const index = job.executions.findIndex(execution => execution.id === executionId)
      if (index < 0) return false
      const execution = job.executions[index]!
      if (execution.endedAt !== undefined) return false
      job.executions[index] = { ...execution, prompt }
      return true
    })
  }

  /** Scheduler-owned: roll every enabled job's nextRunAt past `now` (missed runs are skipped). */
  skipMissed(now: number): void {
    this.mutate((state) => {
      let changed = false
      for (const job of state.jobs) {
        if (!job.enabled || job.nextRunAt === undefined || job.nextRunAt > now) continue
        const nextRunAt = rollNextRun(job, now)
        if (nextRunAt === undefined) {
          delete job.nextRunAt
        } else {
          job.nextRunAt = nextRunAt
        }
        changed = true
      }
      return changed
    })
  }

  /** Scheduler-owned: roll one job's nextRunAt past `now` (post catch-up). */
  skipMissedFor(jobId: string, now: number): void {
    this.mutate((state) => {
      const job = state.jobs.find(candidate => candidate.id === jobId)
      if (job === undefined || !job.enabled || job.nextRunAt === undefined || job.nextRunAt > now) return false
      const nextRunAt = rollNextRun(job, now)
      if (nextRunAt === undefined) {
        delete job.nextRunAt
      } else {
        job.nextRunAt = nextRunAt
      }
      return true
    })
  }

  /** Scheduler-owned: open a due scheduled run (no-op when running/disabled/not due). */
  openScheduled(jobId: string, executionId: string, now: number): { job: JobRecord; execution: ExecutionRecord } | undefined {
    let opened: { job: JobRecord; execution: ExecutionRecord } | undefined
    this.mutate((state) => {
      const index = state.jobs.findIndex(candidate => candidate.id === jobId)
      if (index < 0) return false
      const result = openScheduledRun(state.jobs[index]!, executionId, now)
      if (result === undefined) return false
      // Persist the rolled-forward job (new execution + next nextRunAt).
      state.jobs[index] = result.job
      opened = result
      return true
    })
    return opened
  }

  /**
   * Service-owned upsert (used by sibling plugins via picoCronService).
   * Preserves execution history; re-seeds nextRunAt when the cron changed or
   * the job just became enabled.
   */
  upsertJob(registration: { id: string; name: string; cron: string; action: JobRecord['action']; enabled?: boolean }): void {
    const owner = this.owner()
    this.mutate((state) => {
      const index = state.jobs.findIndex(job => job.id === registration.id)
      const now = this.now()
      if (index < 0) {
        const job = createJob(registration.id, {
          name: registration.name,
          cron: registration.cron,
          action: registration.action,
          ...(registration.enabled === undefined ? {} : { enabled: registration.enabled }),
        }, now, owner ?? undefined)
        if (job.enabled) {
          const seeded = rollNextRun(job, now)
          if (seeded !== undefined) job.nextRunAt = seeded
        }
        state.jobs.push(job)
        return true
      }
      const job = state.jobs[index]!
      const cronChanged = registration.cron !== job.cron
      const next: JobRecord = {
        ...job,
        name: registration.name,
        cron: registration.cron,
        action: registration.action,
        enabled: registration.enabled ?? job.enabled,
        updatedAt: now,
      }
      if (cronChanged) {
        const seeded = rollNextRun(withoutNextRun(next), now)
        if (seeded !== undefined) next.nextRunAt = seeded
      } else if (next.enabled && job.nextRunAt === undefined) {
        const seeded = rollNextRun(withoutNextRun(next), now)
        if (seeded !== undefined) next.nextRunAt = seeded
      }
      state.jobs[index] = next
      return true
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    if (this.lockFd !== undefined) {
      try {
        closeSync(this.lockFd)
        // Only remove the lock we still own: if the file was replaced while
        // held (edge), deleting it would release someone else's lock.
        const raw = readFileSync(this.lockPath, 'utf8').trim()
        if (raw === `${process.pid}`) unlinkSync(this.lockPath)
      } catch {
        // Best effort.
      }
      this.lockFd = undefined
    }
  }
}

/** Validate a cron expression against the shared parser (UI and Host agree). */
export function validateCron(expr: string): boolean {
  return isValidCron(expr)
}

/**
 * Migrate a ledger's jobs from an older schema version to the current one.
 * 审计 2026-08-25 C-1:此前 schema 版本不匹配 = 清空数据。现在旧版本走
 * 逐级迁移;新版本必须在此注册(从 fromVersion 逐级到当前)。
 *
 * v1 → v2(任务看板合并):v1 的动作是 task(taskId 引用 dsh-task 看板任务)
 * 或 prompt(sessionId+text 向既有会话发消息)。dsh-task 插件已删除,看板
 * 任务不复存在,无法解析到智能体+提示词:这类记录与新域模型不兼容,按
 * 用户确认的迁移策略丢弃(原 leder 数据文件仍在,可手工恢复)。v2 动作
 * 只有 agent(prompt 必填,可选 workspaceId/agentPreset/permission)。
 */
export function migrateCronLedger(jobs: JobRecord[], fromVersion: number): JobRecord[] {
  let current = jobs
  if (fromVersion <= 1) {
    current = current
      .filter(job => job.action?.kind === 'agent')
      .map(job => {
        // Strip v1-only execution fields that v2 no longer names (defensive;
        // v1 executions never carried sessionId/prompt).
        const executions = Array.isArray(job.executions)
          ? job.executions.filter(execution => {
            return execution !== null && typeof execution === 'object'
              && typeof (execution as { id?: unknown }).id === 'string'
          })
          : []
        return { ...job, executions }
      })
  }
  void fromVersion
  return current
}

export { isValidCron }
