import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { type BrowserKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Browser client surface copy. */
        browser: BrowserKey;
    }
}
/**
 * Browser client half: registers the sidebar foot action that wakes the
 * dedicated browser window. The window (created by the host plugin on first
 * agent open) carries its own tab strip and controls; the sidebar button
 * shows it again after a user close.
 */
export declare const name = "pico-browser-client";
/** Services required: the slot registry for sidebar actions. */
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
