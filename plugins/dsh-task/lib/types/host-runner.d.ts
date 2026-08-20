/**
 * Host execution runner: launches a real DSH agent session for a task and
 * settles the execution from the session log. Ported from dsh-web-ui
 * (Apache-2.0) packages/dsh-task-board src/host-runner.ts.
 *
 * Fail-closed: a missing workspace, a missing/broken agent preset, or a
 * refused /permission command prevents the task prompt from ever being sent.
 * Every run creates a fresh session; settlement watches for the first
 * `turn/end` at or after the run start.
 */
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy';
import type { TaskRecord } from './tasks.ts';
/** One session-list row, extracted from the sessions.list RPC result. */
export type SessionSummary = Extract<Awaited<ReturnType<ApiProxy['sessions']['list']>>['result'], {
    ok: true;
}>['value']['items'][number];
export type ExecutionInspection = {
    outcome: 'pending';
} | {
    outcome: 'succeeded';
} | {
    outcome: 'failed';
    error: string;
} | {
    outcome: 'cancelled';
    error: string;
};
/** A post-create launch failure that still identifies the session to the ledger. */
export declare class SessionLaunchError extends Error {
    readonly sessionId: string;
    constructor(sessionId: string, cause: unknown);
}
export declare class HostExecutionRunner {
    private readonly api;
    constructor(api: ApiProxy);
    launch(task: TaskRecord): Promise<string>;
    listRunning(): Promise<{
        known: true;
        count: number;
        items: SessionSummary[];
    } | {
        known: false;
    }>;
    /**
     * Resolve one execution's outcome from the shared session list (one list
     * RPC per poll tick, not 1 + E).
     */
    inspect(sessionId: string, startedAt?: number, sessions?: readonly SessionSummary[]): Promise<ExecutionInspection>;
}
