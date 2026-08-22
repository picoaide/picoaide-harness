/**
 * `picoCronService` — the Host service sibling plugins (notably dsh-task)
 * use to register scheduled jobs, and the browser-visible state surface.
 *
 * Runtime identity lives in this package's Host half: the value is provided
 * via `ctx.provide('picoCronService', service)` and consumed through the
 * cordis service name, never through a value import. Consumers pull the type
 * with `import type {} from '@picoaide/dsh-cron'` (type-only, erased at
 * compile time), or spell the same shape locally.
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
/**
 * The service a sibling plugin (dsh-task) provides so cron can trigger
 * task executions. Soft dependency: cron probes `ctx.get('picoTaskService')`
 * at run time; when absent, task actions fail with a visible error instead
 * of silently skipping.
 */
export interface PicoTaskService {
    /**
     * Start one task run. The provider owns session creation, prompting, and
     * settlement; this call resolves when the run is durably started (or
     * refused).
     */
    runTask(taskId: string): Promise<{
        ok: true;
    } | {
        ok: false;
        error: string;
    }>;
}
/** The cron Host service surface. */
export interface PicoCronService {
    /** Register (upsert) a job; used by sibling plugins such as dsh-task. */
    registerJob(registration: CronJobRegistration): void;
    /** Remove a job by id (no-op when absent). */
    unregisterJob(id: string): void;
    /** List all jobs (deep copy). */
    listJobs(): JobRecord[];
    /** Current full snapshot (revision, jobs, scheduler). */
    getSnapshot(): CronSnapshot;
    /** Subscribe to snapshot changes; returns an unsubscribe function. */
    subscribe(listener: () => void): () => void;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Cron scheduler service provided by @picoaide/dsh-cron. */
        picoCronService: PicoCronService;
        /**
         * Optional task-runner service provided by @picoaide/dsh-task; cron
         * probes it at run time for `task` actions.
         */
        picoTaskService?: PicoTaskService;
    }
}
