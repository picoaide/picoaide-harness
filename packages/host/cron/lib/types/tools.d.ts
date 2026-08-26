/**
 * Model-facing tools for the cron scheduler.
 *
 * The scheduler is currently UI-only (its Host ledger + executor are not
 * reachable from a conversation). These tools let the model create, list,
 * enable/disable, and trigger scheduled jobs directly, sharing the exact
 * same Host ledger and executor as the UI. A job action is a closed
 * discriminated union — the only kind is `agent` (spawn a fresh agent
 * session for a prompt) — never a command or shell line.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { HostCronService } from './host-service.ts';
/** Cron tools host entry: registers the tools on the tools registry. */
export declare function registerCronTools(ctx: Context, service: HostCronService): () => void;
