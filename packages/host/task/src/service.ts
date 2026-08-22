/**
 * `picoTaskService` — the Host service dsh-cron consumes to start scheduled
 * task runs, and the browser-visible task state surface.
 *
 * Runtime identity lives in this package's Host half: provided via
 * `ctx.provide('picoTaskService', service)` and consumed through the cordis
 * service name, never through a value import.
 */
import type { TaskSnapshot } from './protocol.ts'
import type { TaskRecord } from './tasks.ts'

/** The task service surface. */
export interface PicoTaskService {
  /**
   * Start one task run. The provider owns session creation, prompting, and
   * settlement; this call resolves when the run is durably started (or
   * refused).
   */
  runTask(taskId: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Current full snapshot. */
  getSnapshot(): TaskSnapshot
  /** Subscribe to snapshot changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Look up one task (deep copy). */
  getTask(taskId: string): TaskRecord | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Task runner service provided by @picoaide/dsh-task. */
    picoTaskService: PicoTaskService
  }
}
