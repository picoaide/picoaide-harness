import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { type ConnectorsKey } from './locales.ts';
/**
 * Connectors client half: registers the connector center foot action in the
 * sidebar (its modal renders the connector list and drives the auth flows),
 * and registers one slash command per CONNECTED connector (`/<connector-id>`)
 * so the `/` menu only shows connectors you can act on. Picking an example
 * prompt sends it to the session — the model then calls the connector's
 * injected MCP tools.
 */
export declare const name = "pico-connectors-client";
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Connectors client surface copy. */
        connectors: ConnectorsKey;
    }
}
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
