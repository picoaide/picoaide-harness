import type { HostCronLedger } from './host-ledger.ts';
import { HostCronExecutor } from './host-executor.ts';
import type { JobRecord } from './jobs.ts';
export interface CronSchedulerOptions {
    tickMs?: number;
    now?: () => number;
    /** When true, fire the most recent missed occurrence after a long gap. */
    catchUpMissed?: boolean;
    /** Executability filter: owner-scoped jobs only run while their creating
     * account is the logged-in session (a logged-out board never fires them). */
    visible?: (job: JobRecord) => boolean;
}
export declare class HostCronScheduler {
    private readonly ledger;
    private readonly executor;
    private readonly tickMs;
    private readonly now;
    /** Live toggle: true fires the most recent missed occurrence after a gap. */
    catchUpMissed: boolean;
    private timer;
    private lastTickAt;
    private tickInFlight;
    private disposed;
    private readonly visible;
    constructor(ledger: HostCronLedger, executor: HostCronExecutor, options?: CronSchedulerOptions);
    start(): void;
    /**
     * Stop ticking without disposing: a later `start()` resumes (used by
     * setConfiguration toggling). In-flight executions are left to settle.
     */
    stop(): void;
    private tick;
    /**
     * Catch-up path: for each due job, fire the single most recent matching
     * instant inside the missed window, then roll forward. Bounded: the window
     * scan walks at most 100 matches.
     */
    private catchUp;
    private lastMatchAt;
    /**
     * Execute one job action and settle its execution record (also used for
     * manual run/rerun actions). Resolves when the execution is settled; a
     * settlement failure is contained (never rejects into the tick loop).
     * When the executor reports the spawned session id / prompt, they are
     * attached to the execution record before settling (execution detail).
     */
    fire(job: JobRecord, execution: {
        id: string;
    }): Promise<void>;
    dispose(): void;
}
