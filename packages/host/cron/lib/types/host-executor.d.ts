/**
 * Job executor: runs one triggered job action and settles its execution
 * record. The only action kind is `agent`: create a fresh agent session
 * (optionally pinned to a workspace / agent preset / permission), send the
 * task prompt, and settle the run. Launch semantics mirror the former
 * dsh-task host runner (real DSH agent session; settlement is the Host's
 * duty — the browser never writes execution results).
 */
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy';
import type { JobRecord } from './jobs.ts';
export interface CronExecutorDeps {
    api: ApiProxy;
}
export declare class HostCronExecutor {
    private readonly deps;
    constructor(deps: CronExecutorDeps);
    /**
     * Execute one job action. Resolves when the execution is settled (the
     * caller records sessionId/prompt onto the execution record via the
     * returned launch info; a session that was created then failed to launch
     * is reported through `error` so the ledger can settle as failed).
     */
    execute(job: JobRecord): Promise<{
        result: 'succeeded' | 'failed';
        error?: string;
        sessionId?: string;
        prompt?: string;
    }>;
}
