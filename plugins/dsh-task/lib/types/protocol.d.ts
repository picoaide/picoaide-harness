/**
 * Same-origin action protocol for the task ledger. Every browser mutation is
 * a versioned, strictly validated discriminated union; the Host re-validates
 * each payload (exact keys, types, enumerations) before touching the ledger.
 * The union contains no command, executable, or shell fields — the task
 * Prompt is data sent to an agent session, never a shell line.
 */
import { type NewTaskInput, type TaskRecord, type TaskStatus, type TaskUpdatePatch } from './tasks.ts';
export declare const TASK_SCHEMA_VERSION: 1;
export declare const TASK_API_PREFIX = "/api/task";
export interface TaskSnapshot {
    schemaVersion: typeof TASK_SCHEMA_VERSION;
    revision: number;
    tasks: TaskRecord[];
}
/** SSE event frame: revision only, never the task list. */
export interface TaskEventPayload {
    revision: number;
}
export type TaskAction = {
    kind: 'create';
    id: string;
    input: NewTaskInput;
} | {
    kind: 'update';
    taskId: string;
    patch: TaskUpdatePatch;
} | {
    kind: 'delete';
    taskId: string;
} | {
    kind: 'move';
    taskId: string;
    status: TaskStatus;
} | {
    kind: 'archive';
    taskId: string;
} | {
    kind: 'restore';
    taskId: string;
} | {
    kind: 'run';
    taskId: string;
} | {
    kind: 'rerun';
    taskId: string;
};
export interface TaskActionEnvelope {
    requestId: string;
    action: TaskAction;
}
export declare function parseActionEnvelope(value: unknown): TaskActionEnvelope | undefined;
