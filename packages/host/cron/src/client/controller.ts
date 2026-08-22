/**
 * Cron view controller: owns the client-side projection of the Host ledger
 * and submits idempotent actions. Framework-free so the whole orchestration
 * is unit-testable with fakes. The Host snapshot is the only confirmed UI
 * state; pending actions are tracked locally only until the Host answers.
 */
import type { JobRecord, NewJobInput, JobUpdatePatch } from '../jobs.ts'
import type { CronAction, CronEventPayload, CronSnapshot, CronSchedulerSnapshot } from '../protocol.ts'
import type { CronTransport } from './host-api.ts'

export interface CronViewSnapshot {
  jobs: readonly JobRecord[]
  scheduler: CronSchedulerSnapshot
  revision: number
  /** Job ids with an action in flight (button spinners). */
  pendingJobIds: readonly string[]
  transportError?: string
}

export interface CronControllerDeps {
  transport: CronTransport
  /** Debounce (ms) for event-hint refetches; defaults to 250. */
  refetchDebounceMs?: number
  uuid?: () => string
}

export class CronController {
  private snapshot: CronViewSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly transport: CronTransport
  private readonly refetchDebounceMs: number
  private readonly uuid: () => string
  private started = false
  private disposed = false
  private refetchTimer: ReturnType<typeof setTimeout> | undefined
  private unsubscribeTransport: (() => void) | undefined

  constructor(deps: CronControllerDeps) {
    this.transport = deps.transport
    this.refetchDebounceMs = deps.refetchDebounceMs ?? 250
    this.uuid = deps.uuid ?? (() => crypto.randomUUID())
    this.snapshot = {
      jobs: [],
      scheduler: { timeZone: 'local' },
      revision: 0,
      pendingJobIds: [],
    }
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.unsubscribeTransport = this.transport.subscribe(() => { this.scheduleRefetch() })
    void this.refresh()
  }

  getSnapshot(): CronViewSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  create(input: NewJobInput): void {
    void this.submit({ kind: 'create', id: this.uuid(), input })
  }

  update(jobId: string, patch: JobUpdatePatch): void {
    void this.submit({ kind: 'update', jobId, patch })
  }

  remove(jobId: string): void {
    void this.submit({ kind: 'delete', jobId })
  }

  enable(jobId: string): void {
    void this.submit({ kind: 'enable', jobId })
  }

  disable(jobId: string): void {
    void this.submit({ kind: 'disable', jobId })
  }

  run(jobId: string): void {
    void this.submit({ kind: 'run', jobId })
  }

  rerun(jobId: string): void {
    void this.submit({ kind: 'rerun', jobId })
  }

  /** Re-pull the full snapshot now (used after reconnect/visibility). */
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

  private async submit(action: CronAction): Promise<void> {
    if (this.disposed) return
    const jobId = 'jobId' in action ? action.jobId : undefined
    this.markPending(jobId, true)
    try {
      const snapshot = await this.transport.action(action)
      this.install(snapshot)
    } catch (error) {
      // Keep the error visible (a follow-up refresh would clear it before
      // the user can read it); schedule a delayed resync and let the user
      // retry explicitly via the error banner.
      this.snapshot = {
        ...this.snapshot,
        transportError: error instanceof Error ? error.message : String(error),
      }
      this.notify()
      this.scheduleRefetch()
    } finally {
      this.markPending(jobId, false)
    }
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return
    try {
      const snapshot = await this.transport.state()
      // Revision guard: a stale read that started before a newer write must
      // not roll the UI back (the Host snapshot is the only authority).
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

  private install(snapshot: CronSnapshot): void {
    // A successful install clears any transport error: build the snapshot
    // without the optional field (exactOptionalPropertyTypes forbids
    // assigning undefined).
    const { transportError: _dropped, ...rest } = this.snapshot
    void _dropped
    this.snapshot = {
      jobs: snapshot.jobs,
      scheduler: snapshot.scheduler,
      revision: snapshot.revision,
      pendingJobIds: rest.pendingJobIds,
    }
    this.notify()
  }

  private markPending(jobId: string | undefined, pending: boolean): void {
    if (jobId === undefined) return
    const set = new Set(this.snapshot.pendingJobIds)
    if (pending) set.add(jobId)
    else set.delete(jobId)
    this.snapshot = { ...this.snapshot, pendingJobIds: [...set] }
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

export type { CronEventPayload }
