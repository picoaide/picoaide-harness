/**
 * Task view controller: client-side projection of the Host ledger with
 * idempotent action submission. Framework-free so the orchestration is
 * unit-testable with fakes. The Host snapshot is the only confirmed UI
 * state; pending actions are tracked locally until the Host answers.
 */
import type { TaskRecord, TaskStatus, NewTaskInput, TaskUpdatePatch } from '../tasks.ts'
import type { TaskAction, TaskSnapshot } from '../protocol.ts'
import type { TaskTransport } from './host-api.ts'

export interface TaskViewSnapshot {
  tasks: readonly TaskRecord[]
  revision: number
  selectedTaskId?: string
  archiveView: boolean
  /** Task ids with an action in flight (button spinners). */
  pendingTaskIds: readonly string[]
  transportError?: string
}

export interface TaskControllerDeps {
  transport: TaskTransport
  /** Debounce (ms) for event-hint refetches; defaults to 250. */
  refetchDebounceMs?: number
  uuid?: () => string
}

export class TaskController {
  private snapshot: TaskViewSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly transport: TaskTransport
  private readonly refetchDebounceMs: number
  private readonly uuid: () => string
  private started = false
  private disposed = false
  private refetchTimer: ReturnType<typeof setTimeout> | undefined
  private unsubscribeTransport: (() => void) | undefined
  /** Optional cron service resolver (set by the client entry when dsh-cron is present). */
  cron?: () => { getSnapshot(): unknown; registerJob(registration: unknown): void; unregisterJob(id: string): void; subscribe(listener: () => void): () => void } | undefined
  /** Opens a session in the shell (used by the execution-session jump). */
  openSession?: (sessionId: string) => void

  constructor(deps: TaskControllerDeps) {
    this.transport = deps.transport
    this.refetchDebounceMs = deps.refetchDebounceMs ?? 250
    this.uuid = deps.uuid ?? (() => crypto.randomUUID())
    this.snapshot = {
      tasks: [],
      revision: 0,
      archiveView: false,
      pendingTaskIds: [],
    }
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.unsubscribeTransport = this.transport.subscribe(() => { this.scheduleRefetch() })
    void this.refresh()
  }

  getSnapshot(): TaskViewSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  create(input: NewTaskInput): void {
    void this.submit({ kind: 'create', id: this.uuid(), input })
  }

  update(taskId: string, patch: TaskUpdatePatch): void {
    void this.submit({ kind: 'update', taskId, patch })
  }

  remove(taskId: string): void {
    void this.submit({ kind: 'delete', taskId })
  }

  move(taskId: string, status: TaskStatus): void {
    void this.submit({ kind: 'move', taskId, status })
  }

  archive(taskId: string): void {
    void this.submit({ kind: 'archive', taskId })
  }

  restore(taskId: string): void {
    void this.submit({ kind: 'restore', taskId })
  }

  run(taskId: string): void {
    void this.submit({ kind: 'run', taskId })
  }

  rerun(taskId: string): void {
    void this.submit({ kind: 'rerun', taskId })
  }

  openTask(taskId: string): void {
    this.snapshot = { ...this.snapshot, selectedTaskId: taskId }
    this.notify()
  }

  closeTask(): void {
    const { selectedTaskId: _drop, ...rest } = this.snapshot
    void _drop
    this.snapshot = rest as TaskViewSnapshot
    this.notify()
  }

  toggleArchiveView(): void {
    this.snapshot = { ...this.snapshot, archiveView: !this.snapshot.archiveView }
    this.notify()
  }

  retryHostSync(): Promise<void> {
    return this.refresh()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.started = false
    if (this.refetchTimer !== undefined) clearTimeout(this.refetchTimer)
    this.unsubscribeTransport?.()
    this.unsubscribeTransport = undefined
    this.listeners.clear()
  }

  private async submit(action: TaskAction): Promise<void> {
    if (this.disposed) return
    const taskId = 'taskId' in action ? action.taskId : undefined
    this.markPending(taskId, true)
    try {
      const snapshot = await this.transport.action(action)
      this.install(snapshot)
    } catch (error) {
      // Keep the error visible (a follow-up refresh would clear it before
      // the user can read it); schedule a delayed resync instead.
      this.snapshot = {
        ...this.snapshot,
        transportError: error instanceof Error ? error.message : String(error),
      }
      this.notify()
      this.scheduleRefetch()
    } finally {
      this.markPending(taskId, false)
    }
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return
    try {
      const snapshot = await this.transport.state()
      // Revision guard: a stale read that started before a newer write must
      // not roll the UI back.
      if (snapshot.revision < this.snapshot.revision) return
      this.install(snapshot)
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        transportError: error instanceof Error ? error.message : String(error),
      }
      this.notify()
    }
  }

  private install(snapshot: TaskSnapshot): void {
    const { transportError: _dropped, ...rest } = this.snapshot
    void _dropped
    this.snapshot = {
      tasks: snapshot.tasks,
      revision: snapshot.revision,
      ...(rest.selectedTaskId === undefined ? {} : { selectedTaskId: rest.selectedTaskId }),
      archiveView: rest.archiveView,
      pendingTaskIds: rest.pendingTaskIds,
    }
    this.notify()
  }

  private markPending(taskId: string | undefined, pending: boolean): void {
    if (taskId === undefined) return
    const set = new Set(this.snapshot.pendingTaskIds)
    if (pending) set.add(taskId)
    else set.delete(taskId)
    this.snapshot = { ...this.snapshot, pendingTaskIds: [...set] }
    this.notify()
  }

  private scheduleRefetch(): void {
    if (this.disposed) return
    if (this.refetchTimer !== undefined) return
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = undefined
      void this.refresh()
    }, this.refetchDebounceMs)
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
