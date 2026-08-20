/**
 * Cron view controller: owns the client-side projection of the Host ledger
 * and submits idempotent actions. Framework-free so the whole orchestration
 * is unit-testable with fakes. The Host snapshot is the only confirmed UI
 * state; pending actions are tracked locally only until the Host answers.
 */
import type { JobRecord, NewJobInput, JobUpdatePatch } from '../jobs.ts';
import type { CronEventPayload, CronSchedulerSnapshot } from '../protocol.ts';
import type { CronTransport } from './host-api.ts';
export interface CronViewSnapshot {
    jobs: readonly JobRecord[];
    scheduler: CronSchedulerSnapshot;
    revision: number;
    /** Job ids with an action in flight (button spinners). */
    pendingJobIds: readonly string[];
    transportError?: string;
}
export interface CronControllerDeps {
    transport: CronTransport;
    /** Debounce (ms) for event-hint refetches; defaults to 250. */
    refetchDebounceMs?: number;
    uuid?: () => string;
}
export declare class CronController {
    private snapshot;
    private readonly listeners;
    private readonly transport;
    private readonly refetchDebounceMs;
    private readonly uuid;
    private started;
    private disposed;
    private refetchTimer;
    private unsubscribeTransport;
    constructor(deps: CronControllerDeps);
    start(): void;
    getSnapshot(): CronViewSnapshot;
    subscribe(listener: () => void): () => void;
    create(input: NewJobInput): void;
    update(jobId: string, patch: JobUpdatePatch): void;
    remove(jobId: string): void;
    enable(jobId: string): void;
    disable(jobId: string): void;
    run(jobId: string): void;
    rerun(jobId: string): void;
    /** Re-pull the full snapshot now (used after reconnect/visibility). */
    retryHostSync(): Promise<void>;
    dispose(): void;
    private submit;
    private refresh;
    private install;
    private markPending;
    private scheduleRefetch;
    private notify;
}
export type { CronEventPayload };
