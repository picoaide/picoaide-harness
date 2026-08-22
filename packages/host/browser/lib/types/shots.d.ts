/**
 * Screenshot capture for the embedded browser: `capturePage` → downscale to a
 * bounded width → JPEG base64. Screenshots are returned to the model and
 * never persisted (audit keeps op log text only).
 * @module @picoaide/dsh-browser
 */
import type { NativeWebContents } from './electron-adapter.ts';
/** Default screenshot max width (CSS pixels). */
export declare const SCREENSHOT_MAX_WIDTH = 1280;
/** Default JPEG quality (0-100). */
export declare const SCREENSHOT_QUALITY = 70;
/**
 * Capture the visible page and return a JPEG data URL. The image is downscaled
 * when wider than `maxWidth`; `quality` trades bytes against fidelity (both
 * owned by the deployment, not the model).
 */
export declare function captureScreenshot(webContents: NativeWebContents, maxWidth?: number, quality?: number): Promise<string>;
