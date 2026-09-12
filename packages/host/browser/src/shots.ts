/**
 * Screenshot capture for the embedded browser: `capturePage` → downscale to a
 * bounded width → JPEG base64. Screenshots are returned to the model and
 * never persisted (audit keeps op log text only).
 * @module @picoaide/dsh-browser
 */

import type { NativeWebContents } from './electron-adapter.ts'

/** Default screenshot max width (CSS pixels). */
const SCREENSHOT_MAX_WIDTH = 1280
/** Default JPEG quality (0-100). */
const SCREENSHOT_QUALITY = 70
/** Smallest clip scale accepted by CDP (below this the image is useless). */
const SCREENSHOT_MIN_SCALE = 0.05

/** Clamp a requested quality into the 1..100 range Electron/CDP accept. */
export function clampQuality(quality: number): number {
  return Math.max(1, Math.min(100, quality))
}

/** The CDP `send` shape this module needs (the runtime's tab session). */
export type CdpSend = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>

/**
 * Capture the visible page and return a JPEG data URL. The image is downscaled
 * when wider than `maxWidth`; `quality` trades bytes against fidelity (both
 * owned by the deployment, not the model).
 */
export async function captureScreenshot(
  webContents: NativeWebContents,
  maxWidth = SCREENSHOT_MAX_WIDTH,
  quality = SCREENSHOT_QUALITY,
): Promise<string> {
  if (webContents.isDestroyed()) throw new Error('browser: tab was destroyed')
  const image = await webContents.capturePage()
  // An empty capture (hidden window / background tab / zero-sized view) must
  // fail loudly instead of returning a 0-byte data URL the model reads as a
  // blank page (P2-31).
  if (image === undefined || image === null) {
    throw new Error('browser: screenshot failed — the page produced no image (is the tab visible?)')
  }
  const { width, height } = image.getSize()
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`browser: screenshot failed — empty image (${width}x${height})`)
  }
  const clampedQuality = clampQuality(quality)
  let out = image
  if (width > maxWidth) {
    out = image.resize({ width: Math.max(1, maxWidth), quality: 'good' })
  }
  const buffer = out.toJPEG(clampedQuality)
  if (buffer.length === 0) {
    throw new Error('browser: screenshot failed — encoder returned an empty image')
  }
  return `data:image/jpeg;base64,${buffer.toString('base64')}`
}

/** `Page.getLayoutMetrics` subset this module reads. */
interface LayoutMetrics {
  cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }
}

/**
 * Capture through CDP's **renderer-side** path (`fromSurface: false`).
 *
 * Why this exists (2026-09-12, real-device report): the browser window is
 * created hidden on purpose (2026-09-08 product decision — agent paths must
 * never pop it to the front), and a hidden window has **no viz surface**, so
 * `webContents.capturePage()` fails with `Current display surface not available
 * for capture / UnknownVizError`. `Page.captureScreenshot` with
 * `fromSurface: false` composites the frame in the renderer instead of reading
 * the browser-side surface, which is how headless capture works.
 *
 * Downscaling is preserved without Electron: the clip `scale` is derived from
 * the CSS layout viewport, so the payload stays at `maxWidth` like the
 * `capturePage` path does.
 *
 * @param send - the tab's CDP sender.
 * @param maxWidth - the same bound `captureScreenshot` enforces.
 * @param quality - JPEG quality (clamped to 1..100).
 * @returns a JPEG data URL.
 * @throws when the renderer returns no image.
 */
export async function captureScreenshotViaCdp(
  send: CdpSend,
  maxWidth = SCREENSHOT_MAX_WIDTH,
  quality = SCREENSHOT_QUALITY,
): Promise<string> {
  const metrics = await send<LayoutMetrics>('Page.getLayoutMetrics')
  const viewport = metrics?.cssLayoutViewport
  const width = typeof viewport?.clientWidth === 'number' ? viewport.clientWidth : 0
  const height = typeof viewport?.clientHeight === 'number' ? viewport.clientHeight : 0
  const boundedWidth = Math.max(1, maxWidth)
  const params: Record<string, unknown> = {
    format: 'jpeg',
    quality: clampQuality(quality),
    fromSurface: false,
  }
  if (width > boundedWidth && height > 0) {
    params.clip = { x: 0, y: 0, width, height, scale: Math.max(SCREENSHOT_MIN_SCALE, boundedWidth / width) }
  }
  const result = await send<{ data?: string }>('Page.captureScreenshot', params)
  const data = result?.data
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('browser: screenshot failed — the renderer returned no image')
  }
  return `data:image/jpeg;base64,${data}`
}
