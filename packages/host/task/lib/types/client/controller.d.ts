/**
 * Task view controller: client-side projection of the Host ledger with
 * idempotent action submission. Framework-free so the orchestration is
 * unit-testable with fakes. The Host snapshot is the only confirmed UI
 * state; pending actions are tracked locally until the Host answers.
 */
import type { TaskRecord, TaskStatus, NewTaskInput, TaskUpdatePatch } from '../tasks.ts';
import type { TaskTransport } from './host-api.ts';
export interface TaskViewSnapshot {
    tasks: readonly TaskRecord[];
    revision: number;
    selectedTaskId?: string;
    archiveView: boolean;
    /** Task ids with an action in flight (button spinners). */
    pendingTaskIds: readonly string[];
    transportError?: string;
}
export interface TaskControllerDeps {
    transport: TaskTransport;
    /** Debounce (ms) for event-hint refetches; defaults to 250. */
    refetchDebounceMs?: number;
    uuid?: () => string;
}
export declare class TaskController {
    private snapshot;
    private readonly listeners;
    private readonly transport;
    private readonly refetchDebounceMs;
    private readonly uuid;
    private started;
    private disposed;
    private refetchTimer;
    private unsubscribeTransport;
    /** Optional cron service resolver (set by the client entry when dsh-cron is present). */
    cron?: () => {
        getSnapshot(): unknown;
        registerJob(registration: unknown): void;
        unregisterJob(id: string): void;
        subscribe(listener: () => void): () => void;
    } | undefined;
    /** Opens a session in the shell (used by the execution-session jump). */
    openSession?: (sessionId: string) => void;
    constructor(deps: TaskControllerDeps);
    start(): void;
    getSnapshot(): TaskViewSnapshot;
    subscribe(listener: () => void): () => void;
    create(input: NewTaskInput): void;
    update(taskId: string, patch: TaskUpdatePatch): void;
    remove(taskId: string): void;
    move(taskId: string, status: TaskStatus): void;
    archive(taskId: string): void;
    restore(taskId: string): void;
    run(taskId: string): void;
    rerun(taskId: string): void;
    /** P0-3: cancel a running task (settles open executions as cancelled). */
    cancel(taskId: string): void;
    openTask(taskId: string): void;
    closeTask(): void;
    toggleArchiveView(): void;
    retryHostSync(): Promise<void>;
    dispose(): void;
    private submit;
    private refresh;
    private install;
    private markPending;
    private scheduleRefetch;
    private notify;
}
