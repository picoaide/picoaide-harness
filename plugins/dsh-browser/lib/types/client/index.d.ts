import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/**
 * Browser client half: registers the embedded-browser panel as a sidebar foot
 * action. The panel drives the native WebContentsView through the loopback
 * browser API; the view itself is layered over the panel's placeholder by the
 * host plugin.
 */
export declare const name = "pico-browser-client";
/** Services required: the slot registry for sidebar actions. */
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
