import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Stable Cordis plugin name for the connectors client half. */
export declare const name = "pico-connectors-client";
/** Services required: the slot registry for settings pages. */
export declare const inject: string[];
/**
 * Register the connectors settings section (mirrors WorkBuddy's connector
 * center): a per-connector card list with connect/disconnect and the auth
 * request surfaces (OAuth redirect, device code, token form).
 * @param ctx - browser Cordis context.
 */
export declare function apply(ctx: ClientContext): void;
