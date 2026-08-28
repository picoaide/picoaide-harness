import type { Context } from '@deepseek-ai/cordis';
import type { ConnectorDef } from './types.ts';
declare module '@deepseek-ai/cordis' {
    interface Events {
        'pico/session-changed'(session: {
            username?: string;
            token?: string;
            serverURL?: string;
        } | null): void;
    }
}
/**
 * Connector framework (mirrors WorkBuddy's connector service):
 * a registry of connector definitions, per-connector auth orchestration
 * (oauth redirect / device-code poll / token form / cli / server-side),
 * local token persistence, and dynamic MCP registration through
 * `ctx.plugin` once a connector connects.
 *
 * Exposes a loopback HTTP API consumed by the client settings UI:
 *   GET  /api/pico/connectors                -> list with states
 *   POST /api/pico/connectors/:id/connect    -> start auth flow
 *   POST /api/pico/connectors/:id/auth-submit-> token form values
 *   GET  /api/pico/connectors/:id/state      -> poll status + pending request
 *   POST /api/pico/connectors/:id/disconnect -> stop and forget
 */
export declare const name = "pico-connectors";
export declare const inject: string[];
export interface ConnectorsOptions {
    /** Extra connector definitions to register. */
    connectors?: ConnectorDef[];
    /** Override the token store directory (tests). */
    storeBaseDir?: string;
}
/** Server connector catalog item (bootstrap `connectors[]`). */
export interface ServerConnectorItem {
    id: string;
    name: string;
    description: string;
    auth_mode: string;
    definition: string;
}
/**
 * Parse the server-issued connector catalog into ConnectorDef[]: the catalog
 * row wins for id/name/description/authMode; the definition JSON contributes
 * the auth/tokenFields/examples/mcp payload. Invalid entries are dropped so a
 * single bad row never blanks the whole catalog.
 */
export declare function parseServerConnectors(items: ServerConnectorItem[]): ConnectorDef[];
export declare function apply(ctx: Context, options?: ConnectorsOptions): void;
export type { ConnectorDef, ConnectorState, ConnectorAuthRequest } from './types.ts';
