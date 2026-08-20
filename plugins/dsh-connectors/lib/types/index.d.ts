import type { Context } from '@deepseek-ai/cordis';
import type { ConnectorDef } from './types.ts';
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
    /** Override the CLI download cache directory (tests). */
    cliCacheDir?: string;
}
export declare function apply(ctx: Context, options?: ConnectorsOptions): void;
export type { ConnectorDef, ConnectorState, ConnectorAuthRequest } from './types.ts';
