/**
 * Shared vocabulary of the embedded agent-driven browser.
 * @module @picoaide/dsh-browser
 */

/** One tab of the embedded browser. */
export interface BrowserTabState {
  /** Stable per-runtime tab id (1-based). */
  readonly id: number
  /** Current page URL (empty before the first navigation). */
  readonly url: string
  /** Current page title (falls back to the URL host). */
  readonly title: string
  /** Whether the page is currently loading. */
  readonly loading: boolean
  /** Whether this tab is the visible one. */
  readonly visible: boolean
}

/** Screen-space placement of the native browser view over the main window. */
export interface BrowserViewBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Panel visibility + placement reported by the client browser panel. */
export interface BrowserPanelState {
  /** Whether the panel (and its native view) is shown. */
  readonly visible: boolean
  /** Placement when visible. */
  readonly bounds?: BrowserViewBounds
}

/** One recorded agent browser operation (audit log, screenshots never persisted). */
export interface BrowserOpLogEntry {
  /** Monotonic sequence number. */
  readonly seq: number
  /** Unix epoch ms. */
  readonly time: number
  /** The tool name that performed the operation. */
  readonly tool: string
  /** The tab id the operation targeted (0 = whole browser). */
  readonly tab: number
  /** Short human-readable summary (never contains credential values). */
  readonly summary: string
  /** `true` when the operation was rejected or failed. */
  readonly failed: boolean
}

/** Navigation verdict produced by the browser's navigation policy. */
export type BrowserNavigationVerdict = 'allow' | 'approve' | 'deny'

/** What a navigation should wait for before the tool call settles. */
export type BrowserWaitUntil = 'domcontentloaded' | 'load' | 'networkidle'

/** One snapshot entry: an interactable element the model may target by index. */
export interface BrowserSnapshotElement {
  /** Stable index used by click/type/select/scroll tools. */
  readonly index: number
  /** Element kind: link / button / input / select / textarea / other. */
  readonly kind: 'link' | 'button' | 'input' | 'select' | 'textarea' | 'other'
  /** Shortened visible text or input placeholder. */
  readonly text: string
  /** Stable CSS selector fallback (id/classes/tag:nth-of-type path). */
  readonly selector: string
  /** Whether the element is currently within the viewport. */
  readonly visible: boolean
  /** Whether the element is disabled. */
  readonly disabled: boolean
}

/** Runtime config surfaced to the model about the embedded browser. */
export interface BrowserToolOptions {
  /** Maximum tabs (default 8). */
  maxTabs?: number
  /** Cooperative tool-call timeout budget ms (default 30000). */
  timeoutMs?: number
  /**
   * Cap on how long one navigation waits for Electron's loadURL promise
   * (default 20000). loadURL settles on did-finish-load, which pages with
   * long-lived connections (polls, SSE, analytics) can delay well past the
   * page being interactive; racing it keeps the tool call from dying on the
   * cooperative timeout while the page is already usable.
   */
  loadTimeoutMs?: number
  /** Whether `browser_eval` is enabled (default true; enterprise can disable). */
  evalEnabled?: boolean
  /** Cap on snapshot entries per call (default 200). */
  snapshotLimit?: number
  /** Cap on extracted text characters per call (default 32768). */
  textLimit?: number
  /** Screenshot max width in CSS pixels (default 1280). */
  screenshotMaxWidth?: number
  /** Screenshot JPEG quality 0-100 (default 70). */
  screenshotQuality?: number
}

/** Credential lookup for the login-form injection (connectors store). */
export type CredentialResolver = (connectorId: string) => Promise<{ username?: string; password?: string } | null>
