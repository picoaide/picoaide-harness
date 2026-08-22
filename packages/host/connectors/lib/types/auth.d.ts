import type { ConnectorAuthRequest, ConnectorDef, TokenField } from './types.ts';
import type { ConnectorCredential } from './store.ts';
import type { CliRuntime } from './cli-runtime.ts';
/**
 * Auth orchestration, mirroring WorkBuddy's connector flow:
 * authStart → (open authorize URL | show verification URL + code | show token
 * form) → poll status (1.5s interval, 300s timeout) → done.
 *
 * UI interaction is pushed through `onRequest`; the flow resolves with the
 * credential patch to persist (or rejects on timeout/cancel).
 */
export interface AuthRunOptions {
    onRequest: (request: ConnectorAuthRequest) => void;
    /** Abort the flow (user cancelled). */
    signal: AbortSignal;
    /** Override token URL/redirect host for tests. */
    tokenUrlOverride?: string;
    /** Loopback host for the OAuth callback. */
    callbackHost?: string;
    /** Pre-connect settings already collected from the user. */
    fields?: Record<string, string>;
    /** Download-on-demand CLI resolver (dws / beisen-cli). */
    cli?: CliRuntime;
}
/**
 * Device-flow probes: connectors whose poll is provider-specific (e.g. the
 * sales-easy clawId poll) register a probe under their connector id; the
 * framework surfaces the authorize URL through onRequest and awaits the probe.
 */
export type DeviceProbe = (def: ConnectorDef, options: AuthRunOptions) => Promise<Partial<ConnectorCredential>>;
export declare function registerDeviceProbe(connectorId: string, probe: DeviceProbe): void;
/** Refresh an access token through the connector's token endpoint. */
export declare function refreshOAuthToken(def: ConnectorDef, credential: ConnectorCredential, options?: {
    tokenUrlOverride?: string;
}): Promise<Partial<ConnectorCredential> | null>;
export interface AuthProbe {
    /** Optional: obtain the user code to display. */
    issueUserCode?: () => Promise<string>;
    /** Resolve true once the user finished authorizing. */
    isConnected: () => Promise<boolean>;
}
/** Run the auth flow for a connector; returns the credential patch to persist. */
export declare function runAuth(def: ConnectorDef, options: AuthRunOptions): Promise<Partial<ConnectorCredential>>;
export type { TokenField };
