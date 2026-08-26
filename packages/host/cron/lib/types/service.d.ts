/**
 * `picoCronService` — the Host service exposing the job ledger / scheduler
 * surface to sibling plugins and the Host half.
 *
 * Runtime identity lives in this package's Host half: the value is provided
 * via `ctx.provide('picoCronService', service)` and consumed through the
 * cordis service name, never through a value import. Consumers pull the type
 * with `import type {} from '@picoaide/dsh-cron'` (type-only, erased at
 * compile time), or spell the same shape locally.
 *
 * v2: the dsh-task bridge (task actions) was removed — the task board was
 * merged into the scheduler as `agent` actions.
 */
import type { JobRecord } from './jobs.ts';
import type { CronSnapshot } from './protocol.ts';
/** A job registration from a sibling plugin (upsert semantics). */
export interface CronJobRegistration {
    id: string;
    name: string;
    cron: string;
    action: JobRecord['action'];
    enabled?: boolean;
}
/** The cron Host service surface. */
export interface PicoCronService {
    /** Register (upsert) a job; used by sibling plugins. */
    registerJob(registration: CronJobRegistration): void;
    /** Remove a job by id (no-op when absent). */
    unregisterJob(id: string): void;
    /** List all jobs (deep copy). */
    listJobs(): JobRecord[];
    /** List jobs visible to the current account (owner-filtered read). */
    listVisibleJobs(): JobRecord[];
    /** Current full snapshot (revision, jobs, scheduler). */
    getSnapshot(): CronSnapshot;
    /** Subscribe to snapshot changes; returns an unsubscribe function. */
    subscribe(listener: () => void): () => void;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Cron scheduler service provided by @picoaide/dsh-cron. */
        picoCronService: PicoCronService;
    }
}
