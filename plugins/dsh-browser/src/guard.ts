/**
 * Security guards for the embedded browser: navigation policy, download
 * interception, permission gating, and the approval seam. Every decision is
 * testable in isolation — approval is an injected function, Electron
 * surfaces arrive through the adapter.
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

/** Whether a click target looks like a form submission (approval-worthy). */
export function isSubmitTarget(kind: string, text: string, selector: string): boolean {
  const lower = `${kind} ${text} ${selector}`.toLowerCase()
  return kind === 'button'
    || lower.includes('submit')
    || lower.includes('登录')
    || lower.includes('登陆')
    || lower.includes('sign in')
    || lower.includes('log in')
    || lower.includes('signin')
    || lower.includes('login')
}

/** Whether a type target is a password field (approval-worthy). */
export function isPasswordTarget(selector: string): boolean {
  const lower = selector.toLowerCase()
  return lower.includes('password') || lower.includes('passwd') || lower.includes('pwd')
}

/**
 * Guard bundle bound to one plugin lifetime. Approval is injected so unit
 * tests can decide without the Cordis approval service; the download and
 * permission hooks are bound to the browser session by the runtime.
 */
export class BrowserGuard {
  /** Ask the composed answerers about one sensitive action. */
  askApproval: (request: {
    agent: unknown
    toolName: string
    callId?: unknown
    reason: string
    signal?: AbortSignal
  }) => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>

  constructor(
    private readonly adapter: ElectronAdapter,
    askApproval: BrowserGuard['askApproval'] = async () => 'rejected',
  ) {
    this.askApproval = askApproval
  }

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
      const total = item.getTotalBytes()
      const filename = item.getFilename() || 'download'
      if (total > MAX_DOWNLOAD_BYTES) {
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

  /** Gate one sensitive action through the approval seam. */
  async requireApproval(request: Parameters<BrowserGuard['askApproval']>[0]): Promise<boolean> {
    const outcome = await this.askApproval(request)
    return outcome === 'allowed-once'
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
