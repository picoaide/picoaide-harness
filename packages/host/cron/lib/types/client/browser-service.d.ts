/**
 * Browser-side cron service face.
 *
 * The Host half of dsh-cron provides `picoCronService` in the Host cordis
 * context, which is invisible to the browser. Sibling plugins that want to
 * drive schedules from the client (dsh-task's per-task schedule section)
 * consume this browser face instead: it wraps the same `/api/cron/*`
 * same-origin transport the job center uses, with the same snapshot-only
 * authority model.
 */
import type { JobRecord } from '../jobs.ts';
import type { CronAction, CronSnapshot } from '../protocol.ts';
/** A job registration from a sibling plugin (upsert semantics). */
export interface CronJobRegistration {
    id: string;
    name: string;
    cron: string;
    action: JobRecord['action'];
    enabled?: boolean;
}
/** The browser-visible cron service surface (subset of the Host service). */
export interface BrowserCronService {
    registerJob(registration: CronJobRegistration): void;
    unregisterJob(id: string): void;
    listJobs(): JobRecord[];
    getSnapshot(): CronSnapshot;
    subscribe(listener: () => void): () => void;
}
/** Structural HTTP/SSE transport (same contract as the job center transport). */
export interface CronBrowserTransport {
    state(): Promise<CronSnapshot>;
    action(action: CronAction): Promise<CronSnapshot>;
    subscribe(listener: () => void): () => void;
}
/** Browser-side implementation of the cron service over the same-origin API. */
export declare class HttpBrowserCronService implements BrowserCronService {
    private snapshot;
    private readonly listeners;
    private readonly transport;
    private started;
    private disposed;
    private unsubscribeTransport;
    constructor(transport: CronBrowserTransport);
    start(): void;
    registerJob(registration: CronJobRegistration): void;
    unregisterJob(id: string): void;
    listJobs(): JobRecord[];
    getSnapshot(): CronSnapshot;
    subscribe(listener: () => void): () => void;
    dispose(): void;
    private submit;
    private refresh;
    private notify;
}
