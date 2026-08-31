/** Same-origin endpoint serving the live desktop update badge snapshot. */
export const DESKTOP_UPDATE_PATH = '/api/pico/desktop/update'

/** Same-origin endpoint triggering a renderer-initiated manual update check. */
export const DESKTOP_UPDATE_CHECK_PATH = '/api/pico/desktop/update/check'

/** Update badge state served to the renderer. */
export interface DesktopUpdateStateResponse {
  /** Version reported available by the last completed check, if newer and downloadable. */
  readonly availableVersion: string | undefined
  /** Version currently downloading (between confirm and installer handoff). */
  readonly downloadingVersion: string | undefined
  /** Whether the running executable came from an Electron package. */
  readonly isPackaged: boolean
  /** Whether this platform has a fixed installer download endpoint. */
  readonly canDownload: boolean
  /** Installed desktop product version. */
  readonly currentVersion: string
  /** Current download progress (bytes) while downloading; undefined otherwise. */
  readonly downloadProgress: UpdateDownloadProgressState | undefined
  /** Last user-visible check failure category; undefined when the last check succeeded. */
  readonly lastError: 'network' | 'release-missing' | 'unsupported' | undefined
}

/** Byte-level download progress served to the renderer badge. */
export interface UpdateDownloadProgressState {
  /** Bytes received so far. */
  readonly receivedBytes: number
  /** Total expected bytes (content-length), or undefined when unknown. */
  readonly totalBytes: number | undefined
}

/** Empty snapshot before the update coordinator has produced any state. */
export function emptyDesktopUpdateState(): DesktopUpdateStateResponse {
  return {
    availableVersion: undefined,
    downloadingVersion: undefined,
    isPackaged: false,
    canDownload: false,
    currentVersion: '',
    downloadProgress: undefined,
    lastError: undefined,
  }
}
