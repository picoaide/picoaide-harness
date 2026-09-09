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
  const clampedQuality = Math.max(1, Math.min(100, quality))
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
