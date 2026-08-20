/**
 * Model-facing tools for the task board.
 *
 * The board is currently UI-only (its Host ledger + runner are not reachable
 * from a conversation). These tools let the model create, list, and run
 * tasks directly, sharing the exact same Host ledger and execution runner as
 * the UI — so a model-created task appears on the board, and a model-run
 * task settles through the same poll/reconcile path.
 *
 * The tools are thin adapters over the Host service: they never touch the
 * ledger directly (the service serializes + persists), and they never carry
 * command/shell/executable fields — a task prompt is data sent to an agent
 * session.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { HostTaskService } from './host-service.ts';
/** Task board tools host entry: registers the tools on the tools registry. */
export declare function registerTaskTools(ctx: Context, service: HostTaskService): () => void;
