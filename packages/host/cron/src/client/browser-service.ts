/**
 * Browser-side cron service face.
 *
 * The Host half of dsh-cron provides `picoCronService` in the Host cordis
 * context, which is invisible to the browser. Sibling plugins that want to
 * drive schedules from the client consume this browser face instead: it
 * wraps the same `/api/cron/*` same-origin transport the job center uses,
 * with the same snapshot-only authority model.
 */
import type { JobRecord } from '../jobs.ts'
import type { CronAction, CronSnapshot } from '../protocol.ts'

/** A job registration from a sibling plugin (upsert semantics). */
export interface CronJobRegistration {
  id: string
  name: string
  cron: string
  action: JobRecord['action']
  enabled?: boolean
}

/** The browser-visible cron service surface (subset of the Host service). */
export interface BrowserCronService {
  registerJob(registration: CronJobRegistration): void
  unregisterJob(id: string): void
  listJobs(): JobRecord[]
  getSnapshot(): CronSnapshot
  subscribe(listener: () => void): () => void
}

/** Structural HTTP/SSE transport (same contract as the job center transport). */
export interface CronBrowserTransport {
  state(): Promise<CronSnapshot>
  action(action: CronAction): Promise<CronSnapshot>
  subscribe(listener: () => void): () => void
}

/** Browser-side implementation of the cron service over the same-origin API. */
export class HttpBrowserCronService implements BrowserCronService {
  private snapshot: CronSnapshot = { schemaVersion: 2, revision: 0, jobs: [], scheduler: { timeZone: 'local' } }
  private readonly listeners = new Set<() => void>()
  private readonly transport: CronBrowserTransport
  private started = false
  private disposed = false
  private unsubscribeTransport: (() => void) | undefined

  constructor(transport: CronBrowserTransport) {
    this.transport = transport
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.unsubscribeTransport = this.transport.subscribe(() => { void this.refresh() })
    void this.refresh()
  }

  registerJob(registration: CronJobRegistration): void {
    const existing = this.snapshot.jobs.find(job => job.id === registration.id)
    if (existing !== undefined) {
      // Upsert: update the existing job (name/cron/action/enabled) instead
      // of create — the Host create path is a no-op for an existing id, so
      // an enable/disable toggle would silently do nothing.
      void this.submit({ kind: 'update', jobId: registration.id, patch: {
        ...(registration.name === undefined ? {} : { name: registration.name }),
        ...(registration.cron === undefined ? {} : { cron: registration.cron }),
        ...(registration.enabled === undefined ? {} : { enabled: registration.enabled }),
      } })
      return
    }
    void this.submit({ kind: 'create', id: registration.id, input: {
      name: registration.name,
      cron: registration.cron,
      action: registration.action,
      ...(registration.enabled === undefined ? {} : { enabled: registration.enabled }),
    } })
  }

  unregisterJob(id: string): void {
    void this.submit({ kind: 'delete', jobId: id })
  }

  listJobs(): JobRecord[] {
    return this.snapshot.jobs
  }

  getSnapshot(): CronSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeTransport?.()
    this.listeners.clear()
  }

  private async submit(action: CronAction): Promise<void> {
    if (this.disposed) return
    try {
      this.snapshot = await this.transport.action(action)
      this.notify()
    } catch (error) {
      console.error('[dsh-cron] browser service action failed', error)
    }
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return
    try {
      const snapshot = await this.transport.state()
      if (snapshot.revision < this.snapshot.revision) return
      this.snapshot = snapshot
      this.notify()
    } catch (error) {
      console.error('[dsh-cron] browser service state refresh failed', error)
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
