/**
 * Security guards for the embedded browser: navigation policy, download
 * interception, permission gating, and the approval seam. Every decision is
 * testable in isolation — approval is an injected function, Electron
 * surfaces arrive through the adapter.
 * @module @picoaide/dsh-browser
 */
import type { BrowserNavigationVerdict } from './types.ts';
import type { ElectronAdapter, NativeSession } from './electron-adapter.ts';
/** Maximum accepted download size in bytes (100 MB). */
export declare const MAX_DOWNLOAD_BYTES: number;
/**
 * Classify a navigation target under the deployment policy:
 * - http(s) → `allow` (regular navigation does not prompt);
 * - about:blank / about:srcdoc → `allow`;
 * - everything else (`javascript:`, `data:`, `file:`, `chrome:`, …) → `deny`.
 * `approve` is reserved for sensitive actions decided at tool level (form
 * submission, password entry, eval).
 */
export declare function classifyNavigation(rawUrl: string): BrowserNavigationVerdict;
/** Human-readable classification reason (audit + model error text). */
export declare function navigationDenyReason(rawUrl: string): string;
/** Whether a click target looks like a form submission (approval-worthy). */
export declare function isSubmitTarget(kind: string, text: string, selector: string): boolean;
/** Whether a type target is a password field (approval-worthy). */
export declare function isPasswordTarget(selector: string): boolean;
/**
 * Guard bundle bound to one plugin lifetime. Approval is injected so unit
 * tests can decide without the Cordis approval service; the download and
 * permission hooks are bound to the browser session by the runtime.
 */
export declare class BrowserGuard {
    private readonly adapter;
    /** Ask the composed answerers about one sensitive action. */
    askApproval: (request: {
        agent: unknown;
        toolName: string;
        callId?: unknown;
        reason: string;
        signal?: AbortSignal;
    }) => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>;
    constructor(adapter: ElectronAdapter, askApproval?: BrowserGuard['askApproval']);
    /** Decide a navigation: `true` lets it proceed. */
    allowNavigation(rawUrl: string): boolean;
    /**
     * Install the download interception on a session: every download is either
     * routed to a user-chosen save path (bounded size) or cancelled. The user
     * participates through the native save dialog, so no approval prompt is
     * needed — but the outcome lands in the op log.
     */
    installDownloadGuard(session: NativeSession, onDownload: (summary: string) => void): () => void;
    /** Gate one sensitive action through the approval seam. */
    requireApproval(request: Parameters<BrowserGuard['askApproval']>[0]): Promise<boolean>;
}
/** Default permission stance: everything is denied unless the user grants it. */
export declare function installPermissionGuard(session: NativeSession): () => void;
