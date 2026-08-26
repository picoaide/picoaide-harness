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

import type { BrowserNavigationVerdict } from './types.ts'
import type { ElectronAdapter, NativeDownloadItem, NativeSession } from './electron-adapter.ts'

/** Maximum accepted download size in bytes (100 MB). */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

/** Schemes the embedded browser may navigate to. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'about:'])

/** Maximum URL length accepted from the model (hostile-input bound). */
const MAX_URL_LENGTH = 8192

/**
 * Classify a navigation target under the deployment policy:
 * - http(s) → `allow` (regular navigation does not prompt);
 * - about:blank / about:srcdoc → `allow`;
 * - everything else (`javascript:`, `data:`, `file:`, `chrome:`, …) → `deny`.
 * `approve` is reserved for sensitive actions decided at tool level (form
 * submission, password entry, eval).
 */
export function classifyNavigation(rawUrl: string): BrowserNavigationVerdict {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) return 'deny'
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    // Relative URLs resolve against the page; the page cannot escalate beyond
    // its own origin through them, so allow (the webContents enforces origin).
    return 'allow'
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) return 'deny'
  return 'allow'
}

/** Human-readable classification reason (audit + model error text). */
export function navigationDenyReason(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
    return 'URL is empty or too long'
  }
  try {
    const protocol = new URL(rawUrl).protocol
    return `scheme ${JSON.stringify(protocol)} is not allowed (http/https only)`
  } catch {
    return 'malformed URL'
  }
}

/**
 * Guard bundle bound to one plugin lifetime. The download and permission
 * hooks are bound to the browser session by the runtime. There is no
 * approval seam: every browser action runs without a user prompt (product
 * decision 2026-08-26).
 */
export class BrowserGuard {
  constructor(private readonly adapter: ElectronAdapter) {}

  /** Decide a navigation: `true` lets it proceed. */
  allowNavigation(rawUrl: string): boolean {
    return classifyNavigation(rawUrl) === 'allow'
  }

  /**
   * Install the download interception on a session: every download is either
   * routed to a user-chosen save path (bounded size) or cancelled. The user
   * participates through the native save dialog, so no approval prompt is
   * needed — but the outcome lands in the op log.
   */
  installDownloadGuard(session: NativeSession, onDownload: (summary: string) => void): () => void {
    const listener = (_event: unknown, item: NativeDownloadItem): void => {
      const filename = item.getFilename() || 'download'
      // P3-8: getTotalBytes() is -1 for unknown-size downloads, which used to
      // bypass the cap. Count received bytes on 'updated' instead and cancel
      // once the limit is exceeded; a zero-sized file is allowed through.
      let received = 0
      let rejected = false
      const onUpdated = (): void => {
        received = item.getReceivedBytes()
        if (received > MAX_DOWNLOAD_BYTES && !rejected) {
          rejected = true
          item.cancel()
          onDownload(`download rejected (>100MB): ${filename}`)
        }
      }
      item.on?.('updated', onUpdated)
      if (item.getReceivedBytes() > MAX_DOWNLOAD_BYTES) {
        rejected = true
        item.cancel()
        onDownload(`download rejected (>100MB): ${filename}`)
        return
      }
      void (async () => {
        const result = await this.adapter.showSaveDialog({
          title: 'Save download',
          defaultPath: filename,
        })
        if (result.canceled || result.filePath === undefined || result.filePath === '') {
          item.cancel()
          onDownload(`download cancelled by user: ${filename}`)
          return
        }
        item.setSavePath(result.filePath)
        onDownload(`download saved to ${result.filePath}: ${filename}`)
      })().catch(() => {
        item.cancel()
      })
    }
    session.on('will-download', listener)
    return () => {
      session.removeListener('will-download', listener)
    }
  }
}

/** Default permission stance: everything is denied unless the user grants it. */
export function installPermissionGuard(session: NativeSession): () => void {
  session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
  // No removal API for the handler; returning a no-op disposer keeps the
  // interface uniform (a new handler overwrites on reinstall).
  return () => {}
}
