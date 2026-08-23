/**
 * Task domain model: durable task records, the status machine, and pure
 * transitions. Adapted from dsh-web-ui (Apache-2.0) packages/dsh-task-board
 * src/core/tasks.ts; scheduling was removed (dsh-cron owns schedules).
 */
import type { ExecutionResult } from './execution.ts';
/** The permission presets a task may pin (upstream dsh-task-board whitelist). */
export declare const TASK_PERMISSIONS: readonly ["read-only", "workspace-write", "danger-full-access"];
export type TaskPermission = typeof TASK_PERMISSIONS[number];
export declare function isTaskPermission(value: unknown): value is TaskPermission;
/** The five board columns. */
export declare const COLUMNS: readonly [{
    readonly status: "todo";
    readonly labelKey: "board.column.todo";
}, {
    readonly status: "doing";
    readonly labelKey: "board.column.doing";
}, {
    readonly status: "done";
    readonly labelKey: "board.column.done";
}, {
    readonly status: "failed";
    readonly labelKey: "board.column.failed";
}];
export type TaskStatus = 'todo' | 'doing' | 'done' | 'failed';
export declare function isTaskStatus(value: unknown): value is TaskStatus;
/** Which statuses may a task move to manually? */
export declare function canMoveManually(from: TaskStatus, to: TaskStatus): boolean;
/** When an execution starts, the task moves to 'doing'. */
export declare function withStatus(task: TaskRecord, status: TaskStatus): TaskRecord;
/** One execution record (one agent-session run). */
export interface ExecutionRecord {
    id: string;
    /** The agent session created for this run. */
    sessionId?: string;
    /** The full prompt (task context + user prompt) sent to the session. */
    prompt?: string;
    startedAt: number;
    endedAt?: number;
    result?: ExecutionResult;
    error?: string;
}
/** A durable task record. */
export interface TaskRecord {
    id: string;
    title: string;
    description: string;
    /** The prompt sent to the agent session (data, never a shell line). */
    prompt: string;
    status: TaskStatus;
    /** Pinned workspace; absent = current workspace. */
    workspaceId?: string;
    /** Pinned agent preset; absent = default. */
    mode?: string;
    /** Optional permission preset applied via /permission before the prompt. */
    permission?: string;
    executions: ExecutionRecord[];
    archivedAt?: number;
    createdAt: number;
    updatedAt: number;
    /**
     * Display name of the account that created this task (gateway username).
     * Absent on records persisted before the owner field existed: legacy
     * records keep pre-upgrade semantics (visible to every session). Tasks
     * created after the upgrade are owner-scoped.
     */
    owner?: string;
}
/** Input for a new task. */
export interface NewTaskInput {
    title: string;
    description: string;
    prompt: string;
    workspaceId?: string;
    mode?: string;
    permission?: string;
}
/** Patchable fields of an existing task. */
export interface TaskUpdatePatch {
    title?: string;
    description?: string;
    prompt?: string;
    workspaceId?: string;
    mode?: string;
    permission?: string;
}
/** Whether a task is archived. */
export declare function isArchived(task: TaskRecord): boolean;
/** Create a new task record. */
export declare function createTask(id: string, input: NewTaskInput, now: number, owner?: string): TaskRecord;
/** Whether a task is visible to (and executable by) the given account. */
export declare function taskVisibleTo(task: TaskRecord, username: string | null | undefined): boolean;
/** Apply a validated patch (immutable update). */
export declare function updateTask(task: TaskRecord, patch: TaskUpdatePatch, now: number): TaskRecord;
/** Open a run: append a pending execution and flip the task to 'doing'. */
export declare function startExecution(task: TaskRecord, executionId: string, now: number, prompt?: string): {
    task: TaskRecord;
    execution: ExecutionRecord;
};
/** Settle a pending execution (task-board semantics; result can be failed). */
export declare function settleExecution(task: TaskRecord, executionId: string, result: ExecutionResult, now: number, error?: string): TaskRecord;
/** Attach the created session id to a pending execution. */
export declare function attachSession(task: TaskRecord, executionId: string, sessionId: string): TaskRecord;
/** Archive (or restore) a task. */
export declare function setArchived(task: TaskRecord, archived: boolean, now: number): TaskRecord;
/** Whether the task has an execution still in flight. */
export declare function hasOpenExecution(task: TaskRecord): boolean;
