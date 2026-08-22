/**
 * Browser transport for the task API: full snapshot bootstrap, idempotent
 * action submission, and SSE change hints. The Host snapshot is the only
 * confirmed UI state.
 */
import type { TaskAction, TaskSnapshot } from '../protocol.ts';
export interface TaskTransport {
    bootstrap(): Promise<TaskSnapshot>;
    state(): Promise<TaskSnapshot>;
    action(action: TaskAction): Promise<TaskSnapshot>;
    subscribe(listener: () => void): () => void;
}
export declare class HttpTaskTransport implements TaskTransport {
    bootstrap(): Promise<TaskSnapshot>;
    state(): Promise<TaskSnapshot>;
    action(action: TaskAction): Promise<TaskSnapshot>;
    subscribe(listener: () => void): () => void;
}
