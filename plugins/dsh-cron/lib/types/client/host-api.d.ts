/**
 * Browser transport for the cron API: full snapshot bootstrap, idempotent
 * action submission, and SSE change hints. The Host snapshot is the only
 * confirmed UI state; the browser never writes unconfirmed state.
 */
import type { CronAction, CronEventPayload, CronSnapshot } from '../protocol.ts';
export interface CronTransport {
    bootstrap(): Promise<CronSnapshot>;
    state(): Promise<CronSnapshot>;
    action(action: CronAction): Promise<CronSnapshot>;
    subscribe(listener: (event?: CronEventPayload) => void): () => void;
}
export declare class HttpCronTransport implements CronTransport {
    bootstrap(): Promise<CronSnapshot>;
    state(): Promise<CronSnapshot>;
    action(action: CronAction): Promise<CronSnapshot>;
    subscribe(listener: (event?: CronEventPayload) => void): () => void;
}
