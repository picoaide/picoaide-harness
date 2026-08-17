import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { ConnectorsList } from './ConnectorsSection.tsx';
/**
 * Connectors client half: exports the connector list surface for the
 * connector center (rendered by the enterprise sidebar panel), and registers
 * one slash command per CONNECTED connector (`/<connector-id>`) so the `/`
 * menu only shows connectors you can act on. Picking an example prompt sends
 * it to the session — the model then calls the connector's injected MCP tools.
 */
export declare const name = "pico-connectors-client";
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
export { ConnectorsList };
