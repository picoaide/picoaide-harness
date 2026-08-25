import { isValidCron } from './cron.ts';
import { type ExecutionRecord, type JobRecord } from './jobs.ts';
import { type CronAction, type CronSchedulerSnapshot } from './protocol.ts';
export interface LedgerState {
    revision: number;
    jobs: JobRecord[];
    scheduler: CronSchedulerSnapshot;
}
/** Result of one applied action. */
export interface ApplyResult {
    state: LedgerState;
    /** Set when the action opened a new execution that must be launched. */
    run?: {
        job: JobRecord;
        execution: ExecutionRecord;
    };
    /** Set when the action asked to launch an existing settled execution again. */
    rerun?: {
        job: JobRecord;
        execution: ExecutionRecord;
    };
}
/**
 * Open a scheduled run: record a pending execution, roll nextRunAt forward,
 * and remember the trigger time. Returns the opened run, or undefined when
 * the job is disabled/archived/already running or the schedule cannot match.
 */
export declare function openScheduledRun(job: JobRecord, executionId: string, now: number): {
    job: JobRecord;
    execution: ExecutionRecord;
} | undefined;
/**
 * Host-owned ledger with serialized, idempotent, atomically persisted
 * mutations. One instance per Host process; a file lock guards against a
 * second Host process writing the same DSH home.
 */
export declare class HostCronLedger {
    private current;
    private readonly cache;
    private readonly listeners;
    private readonly lockPath;
    private readonly filePath;
    private lockFd;
    private disposed;
    /** Current account (gateway username); null when logged out. */
    private readonly owner;
    constructor(options?: {
        dshHomeDir?: string;
        now?: () => number;
        owner?: () => string | null;
    });
    private readonly now;
    private acquireLock;
    /** Reclaim a lock file whose recorded owner pid is no longer alive. */
    private reclaimStaleLock;
    private load;
    private persist;
    private pruneCache;
    state(): LedgerState;
    /**
     * Reconcile executions left pending by a crashed Host: a pending execution
     * has no in-flight session evidence (the ledger cannot observe sessions),
     * so it is settled as cancelled and its job's nextRunAt is rolled forward
     * past `now` so the job can trigger again. Never re-fires a start that was
     * interrupted before the session was recorded.
     */
    private reconcileInterruptedStarts;
    /** Lightweight summary for SSE frames (no deep clone of the job list). */
    summary(): {
        revision: number;
        scheduler: CronSchedulerSnapshot;
    };
    subscribe(listener: () => void): () => void;
    private emit;
    private mutate;
    /**
     * Apply one browser/UI action with idempotency. Returns the new snapshot
     * and, when a run was opened, the run to launch.
     */
    applyRequest(requestId: string, action: CronAction): ApplyResult;
    /** Scheduler-owned: record a tick time (persisted, revision-bumped). */
    setScheduler(patch: Omit<Partial<CronSchedulerSnapshot>, 'error'> & {
        error?: string | undefined;
    }): void;
    /** Scheduler-owned: settle an execution with a result. Prunes old history. */
    settle(jobId: string, executionId: string, result: 'succeeded' | 'failed' | 'cancelled', error?: string): void;
    /** Scheduler-owned: roll every enabled job's nextRunAt past `now` (missed runs are skipped). */
    skipMissed(now: number): void;
    /** Scheduler-owned: roll one job's nextRunAt past `now` (post catch-up). */
    skipMissedFor(jobId: string, now: number): void;
    /** Scheduler-owned: open a due scheduled run (no-op when running/disabled/not due). */
    openScheduled(jobId: string, executionId: string, now: number): {
        job: JobRecord;
        execution: ExecutionRecord;
    } | undefined;
    /**
     * Service-owned upsert (used by sibling plugins via picoCronService).
     * Preserves execution history; re-seeds nextRunAt when the cron changed or
     * the job just became enabled.
     */
    upsertJob(registration: {
        id: string;
        name: string;
        cron: string;
        action: JobRecord['action'];
        enabled?: boolean;
    }): void;
    dispose(): void;
}
/** Validate a cron expression against the shared parser (UI and Host agree). */
export declare function validateCron(expr: string): boolean;
/**
 * Migrate a ledger's jobs from an older schema version to the current one.
 * 审计 2026-08-25 C-1:此前 schema 版本不匹配 = 清空数据。现在旧版本走
 * 逐级迁移;新版本必须在此注册(从 fromVersion 逐级到当前)。当前只有
 * v1;未来字段/枚举变更时在此加 v1→v2、v2→v3 … 并同步 bump 常量。
 */
export declare function migrateCronLedger(jobs: JobRecord[], fromVersion: number): JobRecord[];
export { isValidCron };
