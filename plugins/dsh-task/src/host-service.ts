/**
 * Host task service: composes the ledger, the execution runner, and the
 * 5s settlement poll behind the picoTaskService surface.
 */
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { HostTaskLedger } from './host-ledger.ts'
import { HostExecutionRunner, SessionLaunchError, type SessionSummary } from './host-runner.ts'
import type { TaskRecord } from './tasks.ts'
import type { TaskSnapshot, TaskAction } from './protocol.ts'
import type { PicoTaskService } from './service.ts'

const SESSION_POLL_MS = 5_000

export interface HostTaskServiceOptions {
  ledger?: HostTaskLedger
  runner?: HostExecutionRunner
  pollMs?: number
}

export class HostTaskService implements PicoTaskService {
  readonly ledger: HostTaskLedger
  readonly runner: HostExecutionRunner
  private readonly listeners = new Set<() => void>()
  private readonly pollMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private pollInFlight = false
  private active = true
  private disposed = false

  constructor(api: ApiProxy, options: HostTaskServiceOptions = {}) {
    this.ledger = options.ledger ?? new HostTaskLedger()
    this.runner = options.runner ?? new HostExecutionRunner(api)
    this.pollMs = options.pollMs ?? SESSION_POLL_MS
    this.ledger.subscribe(() => this.emit())
  }

  start(): void {
    if (this.disposed || this.timer !== undefined) return
    this.timer = setInterval(() => { this.schedulePoll() }, this.pollMs)
    this.schedulePoll()
  }

  setActive(active: boolean): void {
    const resumed = !this.active && active
    this.active = active
    if (resumed) this.start()
    if (!active && this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.emit()
  }

  snapshot(): TaskSnapshot {
    const state = this.ledger.state()
    return { schemaVersion: 1, revision: state.revision, tasks: state.tasks }
  }

  getSnapshot(): TaskSnapshot {
    return this.snapshot()
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.ledger.state().tasks.find(task => task.id === taskId)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  apply(requestId: string, action: TaskAction): TaskSnapshot {
    if (!this.active) throw new Error('task board is disabled')
    const result = this.ledger.applyRequest(requestId, action)
    if (result.run !== undefined) this.scheduleLaunch(result.run.task, result.run.execution.id)
    return this.snapshot()
  }

  async runTask(taskId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.active) return { ok: false, error: 'task board is disabled' }
    const task = this.getTask(taskId)
    if (task === undefined) return { ok: false, error: `task not found: ${taskId}` }
    if (task.archivedAt !== undefined) return { ok: false, error: 'task is archived' }
    // The same ledger path as a manual run: idempotent, single launch.
    const result = this.ledger.applyRequest(`internal-run-${crypto.randomUUID()}`, { kind: 'run', taskId })
    if (result.run === undefined) return { ok: false, error: 'task already running' }
    this.scheduleLaunch(result.run.task, result.run.execution.id)
    return { ok: true }
  }

  private async launch(task: TaskRecord, executionId: string): Promise<void> {
    try {
      const sessionId = await this.runner.launch(task)
      this.ledger.attachSession(task.id, executionId, sessionId)
    } catch (error) {
      if (error instanceof SessionLaunchError) {
        this.ledger.attachSession(task.id, executionId, error.sessionId)
      }
      this.ledger.settle(task.id, executionId, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  private scheduleLaunch(task: TaskRecord, executionId: string): void {
    void this.launch(task, executionId).catch(error => {
      console.error('[dsh-task] execution launch settlement failed', error)
    })
  }

  private async pollSessions(): Promise<void> {
    if (this.disposed) return
    if (!this.active && !this.hasOpenExecutions()) return
    const running = await this.runner.listRunning()
    if (running.known) await this.reconcileExecutions(running.items)
  }

  private async reconcileExecutions(sessions: readonly SessionSummary[]): Promise<void> {
    for (const task of this.ledger.state().tasks) {
      for (const execution of task.executions) {
        if (execution.sessionId === undefined || execution.endedAt !== undefined) continue
        try {
          const result = await this.runner.inspect(execution.sessionId, execution.startedAt, sessions)
          if (result.outcome === 'pending') continue
          this.ledger.settle(task.id, execution.id, result.outcome, 'error' in result ? result.error : undefined)
        } catch {
          // A transient inspection failure never settles a running execution.
        }
      }
    }
  }

  private hasOpenExecutions(): boolean {
    return this.ledger.state().tasks.some(task => task.executions.some(execution => execution.endedAt === undefined))
  }

  private schedulePoll(): void {
    if (this.pollInFlight || this.disposed) return
    this.pollInFlight = true
    void this.pollSessions().catch(error => {
      console.error('[dsh-task] session polling failed', error)
    }).finally(() => { this.pollInFlight = false })
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.ledger.dispose()
    this.listeners.clear()
  }
}
