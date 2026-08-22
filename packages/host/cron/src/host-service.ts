/**
 * Host cron service: composes the ledger, scheduler, and executor behind the
 * picoCronService surface, owns the browser-visible snapshot/SSE state, and
 * exposes the sibling-plugin registration API.
 */
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { HostCronLedger } from './host-ledger.ts'
import { HostCronExecutor } from './host-executor.ts'
import { HostCronScheduler } from './host-scheduler.ts'
import type { JobRecord } from './jobs.ts'
import type { CronEventPayload, CronSnapshot, CronAction } from './protocol.ts'
import type { CronJobRegistration, PicoCronService, PicoTaskService } from './service.ts'

export interface HostCronServiceOptions {
  ledger?: HostCronLedger
  executor?: HostCronExecutor
  scheduler?: HostCronScheduler
  /** Live resolver for the optional dsh-task service. */
  taskService?: () => PicoTaskService | undefined
  now?: () => number
}

export class HostCronService implements PicoCronService {
  readonly ledger: HostCronLedger
  readonly scheduler: HostCronScheduler
  private readonly listeners = new Set<() => void>()
  private active = true
  private lastEventJson = ''
  private readonly now: () => number

  constructor(api: ApiProxy, options: HostCronServiceOptions = {}) {
    this.ledger = options.ledger ?? new HostCronLedger()
    this.now = options.now ?? Date.now
    const executor = options.executor ?? new HostCronExecutor({
      api,
      taskService: options.taskService ?? (() => undefined),
    })
    this.scheduler = options.scheduler ?? new HostCronScheduler(this.ledger, executor, { now: this.now })
    this.ledger.subscribe(() => this.emit())
  }

  start(): void {
    this.scheduler.start()
  }

  setConfiguration(active: boolean, catchUpMissed: boolean): void {
    const resumed = !this.active && active
    this.active = active
    this.scheduler.catchUpMissed = catchUpMissed
    if (resumed) this.scheduler.start()
    if (!active) this.scheduler.stop()
    this.emit()
  }

  snapshot(): CronSnapshot {
    const state = this.ledger.state()
    return {
      schemaVersion: 1,
      revision: state.revision,
      jobs: state.jobs,
      scheduler: state.scheduler,
    }
  }

  /** SSE frame payload; deliberately skips the jobs deep-clone of {@link snapshot}. */
  eventPayload(): CronEventPayload {
    const { revision, scheduler } = this.ledger.summary()
    return { revision, scheduler }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  apply(requestId: string, action: CronAction): CronSnapshot {
    if (!this.active) throw new Error('cron scheduler is disabled')
    const result = this.ledger.applyRequest(requestId, action)
    if (result.run !== undefined) void this.scheduler.fire(result.run.job, result.run.execution)
    if (result.rerun !== undefined) void this.scheduler.fire(result.rerun.job, result.rerun.execution)
    return this.snapshot()
  }

  // picoCronService surface (sibling plugins)

  registerJob(registration: CronJobRegistration): void {
    if (!this.active) throw new Error('cron scheduler is disabled')
    this.ledger.upsertJob(registration)
  }

  unregisterJob(id: string): void {
    // A fresh requestId per call: unregister must not collide with the
    // idempotency cache (a deterministic id would make a second
    // detach→attach→detach cycle a silent no-op).
    this.ledger.applyRequest(`unregister-${crypto.randomUUID()}`, { kind: 'delete', jobId: id })
  }

  listJobs(): JobRecord[] {
    return this.ledger.state().jobs
  }

  getSnapshot(): CronSnapshot {
    return this.snapshot()
  }

  // Internals

  private emit(): void {
    // SSE gating: do not push an empty frame when nothing observable moved.
    const json = JSON.stringify(this.eventPayload())
    if (json === this.lastEventJson) return
    this.lastEventJson = json
    for (const listener of [...this.listeners]) listener()
  }

  dispose(): void {
    this.scheduler.dispose()
    this.ledger.dispose()
    this.listeners.clear()
  }
}
