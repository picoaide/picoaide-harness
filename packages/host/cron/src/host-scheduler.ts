/**
 * Host cron scheduler: a fixed-interval tick that fires due jobs exactly
 * once, rolls their next-run instants forward, and never re-runs a missed
 * trigger (unless the composition opts into catch-up for the last missed
 * occurrence). Runs entirely in the Host process, so scheduled jobs execute
 * while every browser page (or the desktop window) is closed.
 *
 * Recovery semantics: on first tick or after a long gap (suspend/restart),
 * due instants are skipped and rolled forward — never queued for replay.
 * With `catchUpMissed` enabled, the single most recent missed occurrence is
 * fired instead of skipped.
 */
import { nextRunAtMs } from './cron.ts'
import type { HostCronLedger } from './host-ledger.ts'
import { HostCronExecutor } from './host-executor.ts'
import type { JobRecord } from './jobs.ts'

const DEFAULT_TICK_MS = 30_000
const RESUME_GAP_MS = DEFAULT_TICK_MS + 15_000

export interface CronSchedulerOptions {
  tickMs?: number
  now?: () => number
  /** When true, fire the most recent missed occurrence after a long gap. */
  catchUpMissed?: boolean
  /** Executability filter: owner-scoped jobs only run while their creating
   * account is the logged-in session (a logged-out board never fires them). */
  visible?: (job: JobRecord) => boolean
}

export class HostCronScheduler {
  private readonly tickMs: number
  private readonly now: () => number
  /** Live toggle: true fires the most recent missed occurrence after a gap. */
  catchUpMissed: boolean
  private timer: ReturnType<typeof setInterval> | undefined
  private lastTickAt: number | undefined
  private tickInFlight = false
  private disposed = false
  private readonly visible: (job: JobRecord) => boolean

  constructor(
    private readonly ledger: HostCronLedger,
    private readonly executor: HostCronExecutor,
    options: CronSchedulerOptions = {},
  ) {
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS
    this.now = options.now ?? Date.now
    this.catchUpMissed = options.catchUpMissed ?? false
    this.visible = options.visible ?? (() => true)
  }

  start(): void {
    if (this.disposed || this.timer !== undefined) return
    this.timer = setInterval(() => { void this.tick(false) }, this.tickMs)
    void this.tick(true)
  }

  /**
   * Stop ticking without disposing: a later `start()` resumes (used by
   * setConfiguration toggling). In-flight executions are left to settle.
   */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private async tick(first: boolean): Promise<void> {
    if (this.disposed || this.tickInFlight) return
    this.tickInFlight = true
    try {
      const now = this.now()
      const recovered = first || (this.lastTickAt !== undefined && now - this.lastTickAt > RESUME_GAP_MS)
      this.lastTickAt = now
      // A successful tick also clears a previously recorded scheduler error
      // (transient failures must not stay visible forever).
      this.ledger.setScheduler({ lastTickAt: now, error: undefined })
      if (recovered) {
        if (this.catchUpMissed && this.lastTickAt !== undefined) {
          this.catchUp(now)
        } else {
          this.ledger.skipMissed(now)
        }
        return
      }
      for (const job of this.ledger.state().jobs) {
        if (!this.visible(job)) continue
        if (!job.enabled || job.nextRunAt === undefined || job.nextRunAt > now) continue
        const opened = this.ledger.openScheduled(job.id, `sched-${crypto.randomUUID()}`, now)
        if (opened !== undefined) void this.fire(opened.job, opened.execution)
      }
    } catch (error) {
      // A ledger write failure (disk full, permission) must never take the
      // whole Host process down: record it visibly and keep ticking.
      console.error('[dsh-cron] scheduler tick failed', error)
      try {
        this.ledger.setScheduler({ error: error instanceof Error ? error.message : String(error) })
      } catch {
        // The error channel itself is broken; nothing more to report.
      }
    } finally {
      this.tickInFlight = false
    }
  }

  /**
   * Catch-up path: for each due job, fire the single most recent matching
   * instant inside the missed window, then roll forward. Bounded: the window
   * scan walks at most 100 matches.
   */
  private catchUp(now: number): void {
    const lastTick = this.lastTickAt ?? now
    for (const job of this.ledger.state().jobs) {
      if (!this.visible(job)) continue
      if (!job.enabled || job.nextRunAt === undefined || job.nextRunAt > now) continue
      const lastMatch = this.lastMatchAt(job, lastTick, now)
      if (lastMatch === undefined) continue
      const opened = this.ledger.openScheduled(job.id, `catchup-${crypto.randomUUID()}`, lastMatch)
      if (opened !== undefined) void this.fire(opened.job, opened.execution)
      // Roll forward past now so the regular path does not re-fire.
      this.ledger.skipMissedFor(job.id, now)
    }
  }

  private lastMatchAt(job: JobRecord, windowStart: number, now: number): number | undefined {
    let cursor = job.nextRunAt ?? windowStart
    let last: number | undefined
    for (let guard = 0; guard < 100; guard += 1) {
      if (cursor > now) break
      last = cursor
      const next = nextRunAtMs(job.cron, cursor)
      if (next === undefined) break
      cursor = next
    }
    return last
  }

  /**
   * Execute one job action and settle its execution record (also used for
   * manual run/rerun actions). Resolves when the execution is settled; a
   * settlement failure is contained (never rejects into the tick loop).
   */
  fire(job: JobRecord, execution: { id: string }): Promise<void> {
    return this.executor.execute(job, execution).then(({ result, error }) => {
      this.ledger.settle(job.id, execution.id, result, error)
    }).catch(error => {
      try {
        this.ledger.settle(job.id, execution.id, 'failed', error instanceof Error ? error.message : String(error))
      } catch (settleError) {
        console.error('[dsh-cron] execution settlement failed', settleError)
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
  }
}
