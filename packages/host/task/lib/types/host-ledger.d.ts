import { type ExecutionRecord, type TaskRecord } from './tasks.ts';
import type { ExecutionResult } from './execution.ts';
import { type TaskAction } from './protocol.ts';
export interface LedgerState {
    revision: number;
    tasks: TaskRecord[];
}
/** Result of one applied action. */
export interface ApplyResult {
    state: LedgerState;
    /** Set when the action opened a new execution that must be launched. */
    run?: {
        task: TaskRecord;
        execution: ExecutionRecord;
    };
    /**
     * Set when the action cancelled open executions: the session ids (if any
     * were recorded) that should be asked to stop.
     */
    cancelled?: string[];
}
export declare class HostTaskLedger {
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
    state(): LedgerState;
    /**
     * Reconcile executions left pending by a crashed Host: a start that was
     * interrupted before the session was recorded (no sessionId, no endedAt)
     * is settled as cancelled so the task is not pinned in 'doing' forever and
     * reruns are allowed again. Never re-fires the interrupted start.
     * P0-3: an execution WITH a sessionId whose session never produced a
     * turn/end (crash before the first turn completed) would otherwise stay
     * 'pending' forever and block every edit/delete/rerun (hasOpenExecution).
     * Age it out: anything older than STALE_EXECUTION_MS settles as cancelled.
     */
    private reconcileInterruptedStarts;
    summary(): {
        revision: number;
    };
    subscribe(listener: () => void): () => void;
    private emit;
    private mutate;
    applyRequest(requestId: string, action: TaskAction): ApplyResult;
    /** Runner-owned: attach the created session id to an execution. */
    attachSession(taskId: string, executionId: string, sessionId: string): void;
    /** Runner-owned: settle an execution with a result (task status follows). */
    settle(taskId: string, executionId: string, result: ExecutionResult, error?: string): void;
    dispose(): void;
}
/**
 * Migrate a task ledger from an older schema version to the current one.
 * 审计 2026-08-25 C-1:旧版本逐级迁移(当前只有 v1;未来在此注册 v1→v2…)。
 */
export declare function migrateTaskLedger(tasks: TaskRecord[], fromVersion: number): TaskRecord[];
