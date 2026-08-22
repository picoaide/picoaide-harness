/** Result states of one triggered execution (a trigger record, not an agent turn). */
export type ExecutionResult = 'succeeded' | 'failed' | 'cancelled';
/** One trigger record of a job. */
export interface ExecutionRecord {
    /** Stable id (unique per execution, idempotency key). */
    id: string;
    /** When the trigger fired (Host clock, ms epoch). */
    triggeredAt: number;
    /** When the execution settled; undefined while pending. */
    endedAt?: number;
    result?: ExecutionResult;
    /** Human-readable failure/cancellation reason. */
    error?: string;
}
/**
 * What a triggered job does. The union is closed and versioned by the
 * protocol validator; adding a kind is a schema change, not a config escape.
 */
export type CronJobAction = {
    kind: 'task';
    /** A task id owned by the dsh-task plugin (resolved at run time). */
    taskId: string;
} | {
    kind: 'prompt';
    /** Target session; required — a prompt action always names a session. */
    sessionId: string;
    /** Prompt text sent to the session (queue mode). */
    text: string;
};
/** A durable scheduled job record. */
export interface JobRecord {
    id: string;
    name: string;
    /** 5-field cron expression (validated by core/cron.ts). */
    cron: string;
    action: CronJobAction;
    enabled: boolean;
    /** Next matching instant (Host local time), rolled by the scheduler. */
    nextRunAt?: number;
    /** Last successful trigger time (ms epoch). */
    lastTriggeredAt?: number;
    /** Trigger records, newest last. */
    executions: ExecutionRecord[];
    createdAt: number;
    updatedAt: number;
}
/** Fields a client may set when creating a job. */
export interface NewJobInput {
    name: string;
    cron: string;
    action: CronJobAction;
    enabled?: boolean;
}
/** Fields a client may patch on an existing job. */
export interface JobUpdatePatch {
    name?: string;
    cron?: string;
    enabled?: boolean;
}
export declare function isExecutionResult(value: unknown): value is ExecutionResult;
export declare function isCronJobAction(value: unknown): value is CronJobAction;
/** Create an execution record for a pending trigger. */
export declare function startExecution(id: string, now: number): ExecutionRecord;
/** Settle a pending execution with a result and optional error. */
export declare function settleExecution(execution: ExecutionRecord, result: ExecutionResult, now: number, error?: string): ExecutionRecord;
/** Build a new job record from validated input. */
export declare function createJob(id: string, input: NewJobInput, now: number): JobRecord;
/** Apply a validated patch to an existing job record (immutable update). */
export declare function updateJob(job: JobRecord, patch: JobUpdatePatch, now: number): JobRecord;
/**
 * Roll the job's next-run instant strictly past `fromMs`. When the job has
 * no nextRunAt yet (freshly created or just re-enabled), seed it from
 * `fromMs`.
 */
export declare function rollNextRun(job: JobRecord, fromMs: number): number | undefined;
