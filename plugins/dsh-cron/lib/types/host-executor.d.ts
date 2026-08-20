/**
 * Job executor: runs one triggered job action and settles its execution
 * record. Task actions delegate to the optional picoTaskService (dsh-task);
 * prompt actions send a queue-mode prompt to a named session through the
 * Host API proxy. Settling is the Host's job — the browser never writes
 * execution results.
 */
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy';
import type { JobRecord } from './jobs.ts';
import type { PicoTaskService } from './service.ts';
export interface CronExecutorDeps {
    api: ApiProxy;
    /** Resolved per run (the task plugin may (un)load at any time). */
    taskService: () => PicoTaskService | undefined;
}
export declare class HostCronExecutor {
    private readonly deps;
    constructor(deps: CronExecutorDeps);
    /**
     * Execute one job action. Resolves when the execution is settled.
     * @returns the settle result for tests.
     */
    execute(job: JobRecord, _execution: {
        id: string;
    }): Promise<{
        result: 'succeeded' | 'failed';
        error?: string;
    }>;
}
