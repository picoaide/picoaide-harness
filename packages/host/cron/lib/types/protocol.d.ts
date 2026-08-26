/**
 * Same-origin action protocol for the cron job ledger.
 *
 * Every browser mutation is a versioned, strictly validated discriminated
 * union. The Host re-validates each payload field (exact keys, types,
 * enumerations) before touching the ledger; there are no command, shell, or
 * executable fields anywhere in the union. The browser never writes
 * scheduler-owned timestamps or execution results.
 */
import { type JobRecord, type NewJobInput, type JobUpdatePatch } from './jobs.ts';
export declare const CRON_SCHEMA_VERSION: 2;
export declare const CRON_API_PREFIX = "/api/cron";
export interface CronSchedulerSnapshot {
    timeZone: string;
    /** Opaque identity of the current Host ledger generation. */
    ledgerId?: string;
    lastTickAt?: number;
    error?: string;
}
export interface CronSnapshot {
    schemaVersion: typeof CRON_SCHEMA_VERSION;
    revision: number;
    jobs: JobRecord[];
    scheduler: CronSchedulerSnapshot;
}
/** SSE event frame: revision/scheduler only, never the job list. */
export interface CronEventPayload {
    revision: number;
    scheduler: CronSchedulerSnapshot;
}
export type CronAction = {
    kind: 'create';
    id: string;
    input: NewJobInput;
} | {
    kind: 'update';
    jobId: string;
    patch: JobUpdatePatch;
} | {
    kind: 'delete';
    jobId: string;
} | {
    kind: 'enable';
    jobId: string;
} | {
    kind: 'disable';
    jobId: string;
}
/** Manual immediate trigger (same executor path as scheduled runs). */
 | {
    kind: 'run';
    jobId: string;
} | {
    kind: 'rerun';
    jobId: string;
};
export interface CronActionEnvelope {
    requestId: string;
    action: CronAction;
}
export declare function parseActionEnvelope(value: unknown): CronActionEnvelope | undefined;
