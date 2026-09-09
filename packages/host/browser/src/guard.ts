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
import type { DownloadEntry, RecordActor } from './store.ts'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname, basename, extname } from 'node:path'

/** Maximum accepted download size in bytes (100 MB). */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

/** Default downloads directory (overridden by the runtime wiring). */
export const DEFAULT_DOWNLOAD_DIR = '.picoaide-downloads'

/** Resolve a conflict-free absolute path inside `dir` for `filename`. */
export function resolveDownloadPath(dir: string, filename: string): string {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // dir may be created by the save itself; best effort.
  }
  const safeName = basename(filename || 'download').replace(/[\\/:*?"<>|]/g, '_')
  const ext = extname(safeName)
  const stem = safeName.slice(0, safeName.length - ext.length)
  let candidate = join(dir, safeName)
  let n = 1
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}-${n}${ext}`)
    n++
    if (n > 999) return join(dir, `${stem}-${Date.now()}${ext}`)
  }
  void dirname
  return candidate
}

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

/** Store recorder contract for download auditing (create + update by id). */
export interface DownloadRecorder {
  add(entry: Omit<DownloadEntry, 'id' | 'createdAt'>): number
  update(id: number, patch: Partial<Pick<DownloadEntry, 'status' | 'path' | 'size'>>): void
}

/** Recorder context a download guard uses at fire time (latest tab wins). */
interface DownloadGuardContext {
  onDownload: (summary: string) => void
  record: DownloadRecorder | undefined
  groupKey: string | undefined
  actor: RecordActor | undefined
  downloadsDir: string
}

interface DownloadGuardEntry {
  refs: number
  context: DownloadGuardContext
  dispose: () => void
}

/**
 * Guard bundle bound to one plugin lifetime. The download and permission
 * hooks are bound to the browser session by the runtime. There is no
 * approval seam: every browser action runs without a user prompt (product
 * decision 2026-08-26).
 */
export class BrowserGuard {
  constructor(_adapter: ElectronAdapter) {}

  /** Sessions that already have the download guard installed, ref-counted per
   * tab. Tabs sharing one partition share one Session — installing a listener
   * per tab would duplicate every download record, but the listener must
   * survive until the LAST tab releases it: before 2026-09-08 closing the
   * first tab removed the shared listener and silently disabled download
   * interception for every remaining tab (audit P0-5). */
  private readonly guardedSessions = new WeakMap<object, DownloadGuardEntry>()

  /** Decide a navigation: `true` lets it proceed. */
  allowNavigation(rawUrl: string): boolean {
    return classifyNavigation(rawUrl) === 'allow'
  }

  /**
   * Install the programmatic download interception (v4 §11.6): every download
   * is saved into the configured downloads directory (auto-renamed on
   * conflict, bounded size, no native dialogs — an AI-driven flow must never
   * block on a dialog), recorded in the store for downloads_list.
   *
   * The returned disposer releases ONE tab's reference; the listener is
   * removed only when the last reference goes away.
   */
  installDownloadGuard(
    session: NativeSession,
    onDownload: (summary: string) => void,
    record?: DownloadRecorder,
    groupKey?: string,
    actor?: RecordActor,
    downloadsDir = DEFAULT_DOWNLOAD_DIR,
  ): () => void {
    const key = session as object
    const context: DownloadGuardContext = { onDownload, record, groupKey, actor, downloadsDir }
    const existing = this.guardedSessions.get(key)
    if (existing !== undefined) {
      existing.refs++
      // A download carries no tab identity (session-level event); attribute
      // it to the most recent registration rather than the first tab forever.
      existing.context = context
      return () => { this.releaseDownloadGuard(key) }
    }
    const entry: DownloadGuardEntry = { refs: 1, context, dispose: () => {} }
    const listener = (_event: unknown, item: NativeDownloadItem): void => {
      const { onDownload, record, groupKey, actor, downloadsDir } = entry.context
      const filename = item.getFilename() || 'download'
      let received = 0
      let rejected = false
      const recordId = record !== undefined
        ? record.add({ url: item.getURL(), fileName: filename, path: '', size: 0, status: 'in-progress', group: groupKey ?? 'unknown', actor: actor ?? 'ai' })
        : undefined
      const onUpdated = (): void => {
        received = item.getReceivedBytes()
        if (received > MAX_DOWNLOAD_BYTES && !rejected) {
          rejected = true
          item.cancel()
          onDownload(`download rejected (>100MB): ${filename}`)
          if (recordId !== undefined) {
            record?.update(recordId, { size: received, status: 'rejected' })
          }
        } else if (recordId !== undefined) {
          record?.update(recordId, { size: received, status: 'in-progress' })
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
        let target: string
        try {
          target = resolveDownloadPath(downloadsDir, filename)
        } catch (cause) {
          // Download dir unusable: never block the UI; reject loudly and
          // record the failure so downloads_list is not stuck at in-progress.
          rejected = true
          item.cancel()
          onDownload(`download failed (target dir unusable): ${filename}`)
          if (recordId !== undefined) record?.update(recordId, { status: 'rejected', size: received })
          void cause
          return
        }
        try {
          item.setSavePath(target)
        } catch (cause) {
          rejected = true
          item.cancel()
          onDownload(`download failed (save path rejected): ${filename}`)
          if (recordId !== undefined) record?.update(recordId, { status: 'rejected', size: received })
          void cause
          return
        }
        onDownload(`download saved to ${target}: ${filename}`)
        item.on?.('done', (event, state) => {
          // A size-rejected or failed download must keep 'rejected' — the
          // later 'cancelled' done-event must not overwrite the verdict.
          if (rejected) return
          const status = state === 'completed' ? 'done' : state === 'cancelled' ? 'cancelled' : 'rejected'
          if (record !== undefined && recordId !== undefined) {
            record.update(recordId, {
              status,
              path: status === 'done' ? target : '',
              size: item.getTotalBytes() > 0 ? item.getTotalBytes() : received,
            })
          }
          void event
        })
      })().catch(() => {
        item.cancel()
      })
    }
    session.on('will-download', listener)
    entry.dispose = () => { session.removeListener('will-download', listener) }
    this.guardedSessions.set(key, entry)
    return () => { this.releaseDownloadGuard(key) }
  }

  /** Drop one tab's reference; the shared listener goes away at zero. */
  private releaseDownloadGuard(key: object): void {
    const entry = this.guardedSessions.get(key)
    if (entry === undefined) return
    entry.refs--
    if (entry.refs > 0) return
    entry.dispose()
    this.guardedSessions.delete(key)
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
