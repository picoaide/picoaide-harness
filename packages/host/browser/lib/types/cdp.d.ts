/**
 * Minimal CDP client over Electron's per-webContents Debugger. The embedded
 * browser drives every tab through `webContents.debugger` (the built-in CDP
 * channel), so no extra runtime dependency is needed. This module owns the
 * wire protocol only: attach/detach, `sendCommand`, and event fan-out.
 * @module @picoaide/dsh-browser
 */
/**
 * The Electron Debugger surface this adapter needs. Type-only import keeps
 * the module loadable under plain Node (unit tests inject a mock).
 */
export interface CdpTransport {
    isAttached(): boolean;
    attach(protocolVersion: string): void;
    detach(): void;
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
    on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown;
    removeListener(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown;
}
/** One established CDP session over a transport. */
export declare class CdpSession {
    private readonly transport;
    private readonly listeners;
    private readonly messageListener;
    private closed;
    constructor(transport: CdpTransport);
    /** Attach with the stable protocol version, failing loudly on double attach. */
    attach(): Promise<void>;
    /** Send one CDP command; rejects when the session is closed or the command fails. */
    send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
    /** Subscribe to one CDP method; returns a disposer. */
    on(method: string, handler: (params: unknown) => void): () => void;
    /** Detach idempotently and clear all subscriptions. */
    detach(): void;
}
