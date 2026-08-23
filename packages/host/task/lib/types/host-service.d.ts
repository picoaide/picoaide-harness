/**
 * Host task service: composes the ledger, the execution runner, and the
 * 5s settlement poll behind the picoTaskService surface.
 */
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy';
import { HostTaskLedger } from './host-ledger.ts';
import { HostExecutionRunner } from './host-runner.ts';
import { type TaskRecord } from './tasks.ts';
import type { TaskSnapshot, TaskAction } from './protocol.ts';
import type { PicoTaskService } from './service.ts';
export interface HostTaskServiceOptions {
    ledger?: HostTaskLedger;
    runner?: HostExecutionRunner;
    pollMs?: number;
}
export declare class HostTaskService implements PicoTaskService {
    readonly ledger: HostTaskLedger;
    readonly runner: HostExecutionRunner;
    private readonly listeners;
    private readonly pollMs;
    private timer;
    private pollInFlight;
    private active;
    private disposed;
    /** Current account (gateway username); null when logged out. */
    private username;
    constructor(api: ApiProxy, options?: HostTaskServiceOptions);
    /** Set the current account (gateway username); null when logged out. */
    setUsername(username: string | null): void;
    start(): void;
    setActive(active: boolean): void;
    snapshot(): TaskSnapshot;
    getSnapshot(): TaskSnapshot;
    getTask(taskId: string): TaskRecord | undefined;
    subscribe(listener: () => void): () => void;
    apply(requestId: string, action: TaskAction): TaskSnapshot;
    runTask(taskId: string): Promise<{
        ok: true;
    } | {
        ok: false;
        error: string;
    }>;
    private launch;
    private scheduleLaunch;
    private pollSessions;
    private reconcileExecutions;
    private hasOpenExecutions;
    private schedulePoll;
    private emit;
    dispose(): void;
}
