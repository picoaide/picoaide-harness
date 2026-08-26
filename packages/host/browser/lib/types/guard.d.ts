/**
 * Security guards for the embedded browser: navigation policy, download
 * interception, permission gating. Every decision is testable in isolation —
 * Electron surfaces arrive through the adapter.
 *
 * 2026-08-26: the approval seam was removed by product decision — every
 * browser operation (including form submission, password entry, eval and
 * credential fill) executes without a user-approval prompt. The embedded
 * browser is a first-class agent surface: the user grants its use through
 * the workspace permission (e.g. `danger-full-access` / `/permission`) and
 * sees every action in the browser window, so per-action prompts were
 * dropped. Navigation is still scheme-gated (http/https only); downloads
 * still route through the native save dialog.
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
/**
 * Guard bundle bound to one plugin lifetime. The download and permission
 * hooks are bound to the browser session by the runtime. There is no
 * approval seam: every browser action runs without a user prompt (product
 * decision 2026-08-26).
 */
export declare class BrowserGuard {
    private readonly adapter;
    constructor(adapter: ElectronAdapter);
    /** Decide a navigation: `true` lets it proceed. */
    allowNavigation(rawUrl: string): boolean;
    /**
     * Install the download interception on a session: every download is either
     * routed to a user-chosen save path (bounded size) or cancelled. The user
     * participates through the native save dialog, so no approval prompt is
     * needed — but the outcome lands in the op log.
     */
    installDownloadGuard(session: NativeSession, onDownload: (summary: string) => void): () => void;
}
/** Default permission stance: everything is denied unless the user grants it. */
export declare function installPermissionGuard(session: NativeSession): () => void;
