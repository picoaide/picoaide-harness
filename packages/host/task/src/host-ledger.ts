/**
 * Host-authoritative task ledger. All mutations serialize through
 * {@link HostTaskLedger.applyRequest}: full-document atomic persistence
 * (temp + rename, 0600), monotonic revision, and request-id idempotency via
 * a bounded SHA-256 fingerprint cache. Design ported from dsh-web-ui
 * (Apache-2.0) packages/dsh-task-board src/host-ledger.ts.
 */
import { createHash } from 'node:crypto'
import {
  chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './dsh-home.ts'
import {
  attachSession, createTask, hasOpenExecution, setArchived, settleExecution,
  startExecution, taskVisibleTo, updateTask, withStatus,
  type ExecutionRecord, type TaskRecord,
} from './tasks.ts'
import { buildTaskPrompt } from './task-prompt.ts'
import type { ExecutionResult } from './execution.ts'
import { TASK_SCHEMA_VERSION, type TaskAction } from './protocol.ts'

interface PersistedRequest {
  requestId: string
  fingerprint: string
}

interface LedgerDocument {
  schemaVersion: typeof TASK_SCHEMA_VERSION
  revision: number
  tasks: TaskRecord[]
  recentRequests: PersistedRequest[]
}

export interface LedgerState {
  revision: number
  tasks: TaskRecord[]
}

/** Result of one applied action. */
export interface ApplyResult {
  state: LedgerState
  /** Set when the action opened a new execution that must be launched. */
  run?: { task: TaskRecord; execution: ExecutionRecord }
  /**
   * Set when the action cancelled open executions: the session ids (if any
   * were recorded) that should be asked to stop.
   */
  cancelled?: string[]
}

const MAX_REQUEST_CACHE = 256

/** 保留的执行历史条数上限(审计 2026-08-25 P2-5)。 */
const MAX_EXECUTION_HISTORY = 100

/** A lock file without a parseable owner pid is reclaimed once older than this. */
const STALE_LOCK_AGE_MS = 45_000

/**
 * P0-3: an execution left open long enough without any settlement (crash
 * before the first turn completed, or a vanished session) is stale. On Host
 * restart it is settled as cancelled so the task never pins 'doing' forever.
 */
const STALE_EXECUTION_MS = 6 * 60 * 60 * 1000 // 6 hours

interface CachedRequest {
  fingerprint: string
}

function cloneTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
  return JSON.parse(JSON.stringify(tasks)) as TaskRecord[]
}

function fingerprintOf(requestId: string, action: TaskAction): string {
  return createHash('sha256').update(JSON.stringify({ requestId, action })).digest('hex')
}

export class HostTaskLedger {
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
    const dir = join(home, 'task')
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
          // Any other failure must fail closed: running without the lock
          // would let two Hosts write the same ledger.
          throw new Error(`dsh-task: cannot acquire ledger lock: ${String(error)}`)
        }
        if (attempt === 1) {
          throw new Error('dsh-task: another Host process owns the task ledger (ledger.lock exists and its owner is alive)')
        }
        // Stale-lock recovery: a crashed Host leaves the lock behind. Read
        // the owner pid; when the process is gone, reclaim the lock.
        if (this.reclaimStaleLock()) continue
        throw new Error('dsh-task: another Host process owns the task ledger (ledger.lock exists and its owner is alive)')
      }
    }
    throw new Error('dsh-task: cannot acquire ledger lock')
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
      return { revision: 0, tasks: [] }
    }
    try {
      const parsed = JSON.parse(raw) as LedgerDocument
      if (typeof parsed.schemaVersion !== 'number' || !Array.isArray(parsed.tasks)) {
        throw new Error('unexpected schema')
      }
      let tasks = parsed.tasks
      // Schema 迁移(审计 2026-08-25 C-1):旧版本逐级迁移,当前版本直读,
      // 高于当前的未来版本保守拒绝(改 .corrupt 而非清空)。
      if (parsed.schemaVersion < TASK_SCHEMA_VERSION) {
        tasks = migrateTaskLedger(tasks, parsed.schemaVersion)
      } else if (parsed.schemaVersion > TASK_SCHEMA_VERSION) {
        throw new Error(`task ledger schema v${String(parsed.schemaVersion)} is newer than supported v${TASK_SCHEMA_VERSION}`)
      }
      const state: LedgerState = { revision: parsed.revision, tasks }
      // Restore the idempotency cache from the persisted request log so a
      // retried requestId after a Host restart is still recognized.
      for (const entry of Array.isArray(parsed.recentRequests) ? parsed.recentRequests : []) {
        if (typeof entry?.requestId === 'string' && typeof entry?.fingerprint === 'string') {
          this.cache.set(entry.requestId, { fingerprint: entry.fingerprint })
        }
      }
      this.reconcileInterruptedStarts(state)
      return state
    } catch {
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
      } catch {
        // Best effort.
      }
      return { revision: 0, tasks: [] }
    }
  }

  private persist(): void {
    const document: LedgerDocument = {
      schemaVersion: TASK_SCHEMA_VERSION,
      revision: this.current.revision,
      tasks: this.current.tasks,
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
    while (this.cache.size > MAX_REQUEST_CACHE) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  state(): LedgerState {
    return { revision: this.current.revision, tasks: cloneTasks(this.current.tasks) }
  }

  /**
   * Reconcile executions left pending by a crashed Host: a start that was
   * interrupted before the session was recorded (no sessionId, no endedAt)
   * is settled as cancelled so the task is not pinned in 'doing' forever and
   * reruns are allowed again. Never re-fires the interrupted start.
   * P0-3: an execution WITH a sessionId whose session never produced a
   * turn/end (crash before the first turn completed) would otherwise stay
   * 'pending' forever and block every edit/delete/rerun (hasOpenExecution).
   * Age it out: anything older than STALE_EXECUTION_MS settles as cancelled.
   */
  private reconcileInterruptedStarts(state: LedgerState): void {
    const now = this.now()
    state.tasks = state.tasks.map(task => {
      const open = task.executions.filter(execution => execution.endedAt === undefined)
      let next = task
      for (const execution of open) {
        if (execution.sessionId === undefined) {
          next = settleExecution(next, execution.id, 'cancelled', now, 'host restarted before the execution session was recorded')
        } else if (execution.startedAt > 0 && now - execution.startedAt > STALE_EXECUTION_MS) {
          next = settleExecution(next, execution.id, 'cancelled', now, '执行超时未完成（可能已损坏），已自动取消')
        }
      }
      return next
    })
  }

  summary(): { revision: number } {
    return { revision: this.current.revision }
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

  applyRequest(requestId: string, action: TaskAction): ApplyResult {
    const fingerprint = fingerprintOf(requestId, action)
    const cached = this.cache.get(requestId)
    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprint) {
        // The same requestId was already applied with a different payload:
        // a client bug or a forged retry. Refuse loudly.
        throw new Error(`dsh-task: request id was reused with a different action: ${requestId}`)
      }
      return { state: this.state() }
    }
    this.cache.set(requestId, { fingerprint })

    // Owner enforcement for target actions: an owner-scoped task may only be
    // mutated by its creating account. Legacy (owner-less) tasks stay
    // reachable by everyone — the pre-upgrade behavior.
    const targetAction = action.kind === 'update' || action.kind === 'delete' || action.kind === 'move'
      || action.kind === 'archive' || action.kind === 'restore' || action.kind === 'run'
      || action.kind === 'rerun' || action.kind === 'cancel'
      ? action : undefined
    if (targetAction !== undefined) {
      const target = this.current.tasks.find(task => task.id === targetAction.taskId)
      if (target !== undefined && !taskVisibleTo(target, this.owner())) {
        throw new Error(`dsh-task: task ${targetAction.taskId} belongs to another account`)
      }
    }

    let opened: { task: TaskRecord; execution: ExecutionRecord } | undefined
    let cancelled: string[] | undefined

    this.mutate((state) => {
      switch (action.kind) {
        case 'create': {
          const existing = state.tasks.find(task => task.id === action.id)
          if (existing !== undefined) return false
          state.tasks.push(createTask(action.id, action.input, this.now(), this.owner() ?? undefined))
          return true
        }
        case 'update': {
          const index = state.tasks.findIndex(task => task.id === action.taskId)
          if (index < 0) return false
          const task = state.tasks[index]!
          // Running tasks are immutable while an execution is in flight;
          // archived tasks are read-only.
          if (hasOpenExecution(task) || task.archivedAt !== undefined) return false
          state.tasks[index] = updateTask(task, action.patch, this.now())
          return true
        }
        case 'delete': {
          const index = state.tasks.findIndex(task => task.id === action.taskId)
          if (index < 0) return false
          const task = state.tasks[index]!
          // Deleting a running task would orphan its session with no
          // settlement path (reconcile only walks surviving tasks).
          if (hasOpenExecution(task)) return false
          state.tasks.splice(index, 1)
          return true
        }
        case 'move': {
          const index = state.tasks.findIndex(task => task.id === action.taskId)
          if (index < 0) return false
          const task = state.tasks[index]!
          if (task.status === action.status) return false
          // A running task's column is owned by its execution settlement;
          // archived tasks are read-only.
          if (hasOpenExecution(task) || task.archivedAt !== undefined) return false
          state.tasks[index] = withStatus(task, action.status)
          return true
        }
        case 'archive': {
          const index = state.tasks.findIndex(task => task.id === action.taskId)
          if (index < 0) return false
          const task = state.tasks[index]!
          if (hasOpenExecution(task)) return false
          state.tasks[index] = setArchived(task, true, this.now())
          return true
        }
        case 'restore': {
          const index = state.tasks.findIndex(task => task.id === action.taskId)
          if (index < 0) return false
          state.tasks[index] = setArchived(state.tasks[index]!, false, this.now())
          return true
        }
        case 'run':
        case 'rerun': {
          const index = state.tasks.findIndex(task => task.id === action.taskId)
          if (index < 0) return false
          const task = state.tasks[index]!
          if (task.archivedAt !== undefined || hasOpenExecution(task)) return false
          const result = startExecution(task, `${action.kind}-${crypto.randomUUID()}`, this.now(), buildTaskPrompt(task))
          state.tasks[index] = result.task
          opened = result
          return true
        }
        case 'cancel': {
          // P0-3: a running task must be cancelable. Settle every open
          // execution as cancelled (the task returns to 'todo' so it can run
          // again); the host service aborts the guest session separately.
          const index = state.tasks.findIndex(task => task.id === action.taskId)
          if (index < 0) return false
          const task = state.tasks[index]!
          const open = task.executions.filter(execution => execution.endedAt === undefined)
          if (open.length === 0) return false
          const now = this.now()
          let next = task
          const cancelledSessions: string[] = []
          for (const execution of open) {
            if (execution.sessionId !== undefined) cancelledSessions.push(execution.sessionId)
            next = settleExecution(next, execution.id, 'cancelled', now, '用户取消了任务')
          }
          state.tasks[index] = next
          cancelled = cancelledSessions
          return true
        }
        default:
          return false
      }
    })

    return {
      state: this.state(),
      ...(opened === undefined ? {} : { run: opened }),
      ...(cancelled === undefined || cancelled.length === 0 ? {} : { cancelled }),
    }
  }

  /** Runner-owned: attach the created session id to an execution. */
  attachSession(taskId: string, executionId: string, sessionId: string): void {
    this.mutate((state) => {
      const index = state.tasks.findIndex(task => task.id === taskId)
      if (index < 0) return false
      state.tasks[index] = attachSession(state.tasks[index]!, executionId, sessionId)
      return true
    })
  }

  /** Runner-owned: settle an execution with a result (task status follows). */
  settle(taskId: string, executionId: string, result: ExecutionResult, error?: string): void {
    this.mutate((state) => {
      const index = state.tasks.findIndex(task => task.id === taskId)
      if (index < 0) return false
      const task = state.tasks[index]!
      const next = settleExecution(task, executionId, result, this.now(), error)
      // 裁剪执行历史(审计 2026-08-25 P2-5):只保留最近 N 条,防 ledger 膨胀。
      if (next.executions.length > MAX_EXECUTION_HISTORY) {
        next.executions = next.executions.slice(next.executions.length - MAX_EXECUTION_HISTORY)
      }
      state.tasks[index] = next
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

/**
 * Migrate a task ledger from an older schema version to the current one.
 * 审计 2026-08-25 C-1:旧版本逐级迁移(当前只有 v1;未来在此注册 v1→v2…)。
 */
export function migrateTaskLedger(tasks: TaskRecord[], fromVersion: number): TaskRecord[] {
  let current = tasks
  // v1 → v2 占位:未来字段变更在此逐字段修正。
  void fromVersion
  return current
}
