/**
 * Model-facing `browser_*` tool suite over the embedded browser runtime.
 * This module owns schemas, argument validation, prompt guidance, and
 * presentation; execution delegates to the BrowserRuntime (which owns the
 * view hierarchy, CDP, mutex, and guards).
 * @module @picoaide/dsh-browser
 */
import type { Context } from '@deepseek-ai/cordis';
import type { GenericCallView, JsonValue, ToolResult } from '@deepseek-ai/dsh-tools';
import type { BrowserRuntime } from './runtime.ts';
/**
 * Register the full browser tool suite.
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations; both are effect-scoped and unregister on plugin dispose.
 * @param runtime - the embedded browser runtime (owns tabs, mutex, guards).
 * @param attachments - whether `ctx.attachments` is available (screenshot
 *   needs it); screenshots fail with a clear message otherwise.
 */
export declare function applyBrowserTools(ctx: Context, runtime: BrowserRuntime): void;
/** Present result meta passthrough (kept for future card projections). */
export declare function browserMetaFromResult(meta: unknown): JsonValue | undefined;
/** Present call view helper exported for tests. */
export declare function presentBrowserCall(kind: string, title: string, args: Record<string, unknown>): GenericCallView;
export type { ToolResult };
