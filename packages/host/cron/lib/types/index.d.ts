/**
 * Host loader entry for the dsh-cron plugin.
 *
 * The Host owns the job ledger, the cron scheduler, the executor, and the
 * same-origin API. The browser is an asynchronous view over that service.
 * Following the upstream plugin contract (docs/cordis-tutorial), this is a
 * function plugin: named exports `name` / `inject` / `Config` / `apply`, no
 * default export, schema-validated config, and all side effects wrapped in
 * `ctx.effect` so HMR/unload unwinds them.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
declare module '@deepseek-ai/cordis' {
    interface Events {
        'pico/session-changed'(session: {
            username?: string;
            token?: string;
            serverURL?: string;
        } | null): void;
    }
}
export declare const name = "pico-cron";
/** Required Host services (cordis inject waiting). */
export declare const inject: string[];
/** Model-facing announcement: plugin presence, capabilities, and limits. */
export declare const CRON_GUIDANCE = "\u672C\u673A\u5DF2\u5B89\u88C5 dsh-cron \u63D2\u4EF6\uFF08DSH Desktop \u7684\u5B9A\u65F6\u4EFB\u52A1\u8C03\u5EA6\u5668\uFF09\uFF1A\u53EF\u521B\u5EFA\u5B9A\u65F6\u4EFB\u52A1\uFF08cron \u8868\u8FBE\u5F0F\uFF0C\u5206\u949F\u7EA7\u7CBE\u5EA6\uFF09\uFF0C\u5230\u70B9\u7531 Host \u8FDB\u7A0B\u6267\u884C\u2014\u2014\u5173\u95ED\u7A97\u53E3\u6216\u6D4F\u89C8\u5668\u9875\u9762\u540E\u4ECD\u4F1A\u6267\u884C\uFF1B\u5E94\u7528\u5B8C\u5168\u9000\u51FA\u671F\u95F4\u9519\u8FC7\u7684\u89E6\u53D1\u70B9\u9ED8\u8BA4\u8DF3\u8FC7\uFF08\u53EF\u5728\u8BBE\u7F6E\u4E2D\u5F00\u542F\u8865\u8DD1\u6700\u8FD1\u4E00\u6B21\uFF09\uFF1B\u5B9A\u65F6\u4EFB\u52A1\u53EF\u6267\u884C dsh-task \u63D2\u4EF6\u7684\u4EFB\u52A1\uFF0C\u6216\u5411\u6307\u5B9A\u4F1A\u8BDD\u53D1\u9001 prompt\u3002\u6A21\u578B\u53EF\u76F4\u63A5\u8C03\u7528 cron_create / cron_list / cron_set_enabled / cron_run \u5DE5\u5177\u521B\u5EFA\u3001\u67E5\u770B\u3001\u542F\u505C\u548C\u89E6\u53D1\u5B9A\u65F6\u4EFB\u52A1\u3002\u7528\u6237\u63D0\u5230\u300C\u5B9A\u65F6\u4EFB\u52A1 / cron / \u5B9A\u65F6\u6267\u884C\u300D\u65F6\u5373\u6307\u672C\u63D2\u4EF6\uFF0C\u8BF7\u636E\u6B64\u534F\u4F5C\u3002";
/** Settings namespace of the cron plugin (spelled here and in the browser half). */
export declare const CRON_SETTINGS_NAMESPACE: import("@deepseek-ai/dsh-settings").SettingsNamespace;
export interface Config {
    /** Master switch for the scheduler (host + browser surfaces). */
    enabled?: boolean;
    /** When true (default), a system-prompt section announces the plugin. */
    announceToAgent?: boolean;
    /**
     * When true, a restart or long suspension fires the single most recent
     * missed occurrence per due job instead of skipping it. Default: skip.
     */
    catchUpMissed?: boolean;
}
export declare const Config: z<Config>;
/**
 * Register the cron Host service, routes, and announcement section. The
 * service is re-judged whenever the settings source changes, so a settings
 * edit takes effect without a restart.
 */
export declare function apply(ctx: Context, config: Config): void;
