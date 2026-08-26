/** Result states of one triggered execution (a trigger record, not an agent turn). */
export type ExecutionResult = 'succeeded' | 'failed' | 'cancelled';
/**
 * One trigger record of a job. v2 carries session-level detail: the agent
 * session spawned for this run, its prompt, and start/end timestamps.
 */
export interface ExecutionRecord {
    /** Stable id (unique per execution, idempotency key). */
    id: string;
    /** When the trigger fired (Host clock, ms epoch). */
    triggeredAt: number;
    /** The agent session created for this run (attached after launch). */
    sessionId?: string;
    /** The full prompt sent to the session (task prompt, never a shell line). */
    prompt?: string;
    startedAt?: number;
    endedAt?: number;
    result?: ExecutionResult;
    /** Human-readable failure/cancellation reason. */
    error?: string;
}
/**
 * What a triggered job does. The union is closed and versioned by the
 * protocol validator; adding a kind is a schema change, not a config escape.
 * v2: the only kind is `agent` — spawn a fresh agent session and prompt it.
 */
export type CronJobAction = {
    kind: 'agent';
    /** Prompt text sent to the new agent session (queue mode). */
    prompt: string;
    /** Pinned workspace; absent = current workspace. */
    workspaceId?: string;
    /** Pinned agent preset (from agentPresets.list); absent = composition default. */
    agentPreset?: string;
    /** Optional permission preset applied via /permission before the prompt. */
    permission?: string;
};
/** A durable scheduled job record. */
export interface JobRecord {
    id: string;
    name: string;
    /** 5-field cron expression (validated by core/cron.ts). */
    cron: string;
    action: CronJobAction;
    enabled: boolean;
    /**
     * Display name of the account that created this job (gateway username).
     * Absent on records persisted before the owner field existed: those keep
     * their pre-upgrade semantics (executable by whoever is logged in) and are
     * returned to every session for visibility. Jobs created after the upgrade
     * are owner-scoped: only the same account can see/execute them.
     */
    owner?: string;
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
export declare function createJob(id: string, input: NewJobInput, now: number, owner?: string): JobRecord;
/** Whether a job is visible to (and executable by) the given account. */
export declare function jobVisibleTo(job: JobRecord, username: string | null | undefined): boolean;
/** Apply a validated patch to an existing job record (immutable update). */
export declare function updateJob(job: JobRecord, patch: JobUpdatePatch, now: number): JobRecord;
/**
 * Roll the job's next-run instant strictly past `fromMs`. When the job has
 * no nextRunAt yet (freshly created or just re-enabled), seed it from
 * `fromMs`.
 */
export declare function rollNextRun(job: JobRecord, fromMs: number): number | undefined;
