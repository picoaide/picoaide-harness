/**
 * Page-content extraction for the embedded browser: an interactable-element
 * snapshot the model uses to target clicks/types, and plain-text extraction.
 * Extraction runs through CDP `Runtime.evaluate` with a fixed, self-contained
 * probe script; results are data-only (never executed), and every output is
 * bounded so a hostile page cannot flood the model context.
 * @module @picoaide/dsh-browser
 */
import type { BrowserSnapshotElement } from './types.ts';
/** Cap on snapshot entries per call. */
export declare const SNAPSHOT_LIMIT = 200;
/** Cap on extracted text characters per call. */
export declare const TEXT_LIMIT: number;
/**
 * Extract the interactable-element snapshot of the current page through the
 * given CDP session. Bounded to `snapshotLimit` entries; each entry carries a
 * stable `index` (1-based) that click/type/select target.
 */
export declare function extractSnapshot(send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>, snapshotLimit?: number): Promise<BrowserSnapshotElement[]>;
/** Extract visible text of the page (or of `selector` when given), bounded. */
export declare function extractText(send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>, selector: string | undefined, textLimit?: number): Promise<string>;
