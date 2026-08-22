/**
 * Host loader entry for the dsh-task plugin.
 *
 * The Host owns the task ledger, the execution runner, the settlement poll,
 * and the same-origin API; the browser is an asynchronous view over that
 * service. Function plugin per the upstream contract: `name` / `inject` /
 * `Config` / `apply`, schema-validated config, side effects in `ctx.effect`.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "pico-task";
/** Required Host services (cordis inject waiting). */
export declare const inject: string[];
/** Model-facing announcement: plugin presence, capabilities, and limits. */
export declare const TASK_GUIDANCE = "\u672C\u673A\u5DF2\u5B89\u88C5 dsh-task \u63D2\u4EF6\uFF08DSH Desktop \u7684\u4EFB\u52A1\u770B\u677F\uFF09\uFF1A\u591A\u5217\u770B\u677F\u7BA1\u7406\u4EFB\u52A1\uFF1B\u4EFB\u52A1\u7531\u771F\u5B9E DSH \u667A\u80FD\u4F53\u4F1A\u8BDD\u6267\u884C\uFF08\u6BCF\u6B21\u6267\u884C\u65B0\u5EFA\u72EC\u7ACB\u4F1A\u8BDD\uFF0C\u53EF\u9489\u4F4F\u5DE5\u4F5C\u533A\u3001agent \u9884\u8BBE\u548C\u6743\u9650\uFF09\uFF1B\u6267\u884C\u7ED3\u679C\u81EA\u52A8\u56DE\u5199\u770B\u677F\uFF1B\u53EF\u4E0E dsh-cron \u914D\u5408\u5B9A\u65F6\u6267\u884C\u3002\u6A21\u578B\u53EF\u76F4\u63A5\u8C03\u7528 task_create / task_list / task_run \u5DE5\u5177\u521B\u5EFA\u3001\u67E5\u770B\u548C\u6267\u884C\u4EFB\u52A1\u3002\u7528\u6237\u63D0\u5230\u300C\u4EFB\u52A1\u770B\u677F / \u770B\u677F / \u4EFB\u52A1\u300D\u65F6\u5373\u6307\u672C\u63D2\u4EF6\uFF0C\u8BF7\u636E\u6B64\u534F\u4F5C\u3002";
/** Settings namespace of the task plugin (spelled here and in the browser half). */
export declare const TASK_SETTINGS_NAMESPACE: import("@deepseek-ai/dsh-settings").SettingsNamespace;
export interface Config {
    /** Master switch for the plugin (host + browser surfaces). */
    enabled?: boolean;
    /** When true (default), a system-prompt section announces the plugin. */
    announceToAgent?: boolean;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
