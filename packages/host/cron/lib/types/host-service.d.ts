/**
 * Host cron service: composes the ledger, scheduler, and executor behind the
 * picoCronService surface, owns the browser-visible snapshot/SSE state, and
 * exposes the sibling-plugin registration API.
 */
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy';
import { HostCronLedger } from './host-ledger.ts';
import { HostCronExecutor } from './host-executor.ts';
import { HostCronScheduler } from './host-scheduler.ts';
import { type JobRecord } from './jobs.ts';
import type { CronEventPayload, CronSnapshot, CronAction } from './protocol.ts';
import type { CronJobRegistration, PicoCronService, PicoTaskService } from './service.ts';
export interface HostCronServiceOptions {
    ledger?: HostCronLedger;
    executor?: HostCronExecutor;
    scheduler?: HostCronScheduler;
    /** Live resolver for the optional dsh-task service. */
    taskService?: () => PicoTaskService | undefined;
    now?: () => number;
}
export declare class HostCronService implements PicoCronService {
    readonly ledger: HostCronLedger;
    readonly scheduler: HostCronScheduler;
    private readonly listeners;
    private active;
    private lastEventJson;
    private readonly now;
    /** Current account (gateway username); set by the plugin on session change. */
    private username;
    constructor(api: ApiProxy, options?: HostCronServiceOptions);
    /** Set the current account (gateway username); null when logged out. */
    setUsername(username: string | null): void;
    /** Current account (gateway username). */
    currentUsername(): string | null;
    start(): void;
    setConfiguration(active: boolean, catchUpMissed: boolean): void;
    snapshot(): CronSnapshot;
    /** SSE frame payload; deliberately skips the jobs deep-clone of {@link snapshot}. */
    eventPayload(): CronEventPayload;
    subscribe(listener: () => void): () => void;
    apply(requestId: string, action: CronAction): CronSnapshot;
    registerJob(registration: CronJobRegistration): void;
    unregisterJob(id: string): void;
    listJobs(): JobRecord[];
    getSnapshot(): CronSnapshot;
    private emit;
    dispose(): void;
}
