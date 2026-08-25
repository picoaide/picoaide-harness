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
}

/** Empty snapshot before the update coordinator has produced any state. */
export function emptyDesktopUpdateState(): DesktopUpdateStateResponse {
  return {
    availableVersion: undefined,
    downloadingVersion: undefined,
    isPackaged: false,
    canDownload: false,
    currentVersion: '',
  }
}
