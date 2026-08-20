/**
 * Embedded agent-driven browser for DSH Desktop: owns the WebContentsView tab
 * pool, the CDP sessions, the `browser_*` tool suite, and the loopback panel
 * API consumed by the client browser panel.
 *
 * HTTP API (loopback, mirroring the connectors plugin):
 *   GET  /api/pico/browser/state          -> tabs + panel + control + ops
 *   POST /api/pico/browser/panel          -> { visible, bounds? }
 *   POST /api/pico/browser/open           -> { url? }
 *   POST /api/pico/browser/navigate       -> { tab, url }
 *   POST /api/pico/browser/reload|back|forward -> { tab? }
 *   POST /api/pico/browser/close-tab      -> { tab }
 *   POST /api/pico/browser/close-all
 *   POST /api/pico/browser/takeover       -> { active }
 *   POST /api/pico/browser/clear-data
 *   GET  /api/pico/browser/ops            -> recent op log
 * @module @picoaide/dsh-browser
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "pico-browser";
/** Services required by the embedded browser. */
export declare const inject: string[];
/** Plugin config: runtime caps and enablement. */
export interface Config {
    /** Maximum simultaneous tabs (default 8). */
    maxTabs?: number;
    /** Cooperative tool-call timeout budget ms (default 30000). */
    timeoutMs?: number;
    /** Cap on waiting for Electron's loadURL promise ms (default 20000). */
    loadTimeoutMs?: number;
    /** Whether `browser_eval` is enabled (default true). */
    evalEnabled?: boolean;
    /** Cap on snapshot entries per call (default 200). */
    snapshotLimit?: number;
    /** Cap on extracted text characters per call (default 32768). */
    textLimit?: number;
    /** Screenshot max width in CSS pixels (default 1280). */
    screenshotMaxWidth?: number;
    /** Screenshot JPEG quality 0-100 (default 70). */
    screenshotQuality?: number;
}
export declare const Config: z<Config>;
/**
 * Register the embedded browser plugin.
 * @param ctx - Cordis context carrying the webServer, tools, systemPrompt and
 *   attachments services.
 * @param config - runtime caps and enablement.
 */
export declare function apply(ctx: Context, config?: Config): void;
export type { BrowserRuntime } from './runtime.ts';
export type { BrowserOpLogEntry, BrowserPanelState, BrowserSnapshotElement, BrowserTabState, BrowserToolOptions } from './types.ts';
