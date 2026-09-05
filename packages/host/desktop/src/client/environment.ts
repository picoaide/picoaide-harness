/** Desktop renderer modes accepted from the Electron-owned page URL. */
export type DesktopClientMode = 'compatibility' | 'advanced'

/** Host platforms whose native chrome has a desktop presentation. */
export type DesktopClientPlatform = 'darwin' | 'win32' | 'linux'

/** Validated renderer environment supplied by the Electron Host. */
export interface DesktopClientEnvironment {
  /** Active shell mode for this BrowserWindow lifetime. */
  mode: DesktopClientMode
  /** Electron Host platform used for native spacing and drag regions. */
  platform: DesktopClientPlatform
}

const MODES = new Set<DesktopClientMode>(['compatibility', 'advanced'])
const PLATFORMS = new Set<DesktopClientPlatform>(['darwin', 'win32', 'linux'])

/**
 * Validate the Electron-owned query marker before any desktop client effects run.
 * @param search - URL search string, including or omitting the leading question mark.
 * @returns the validated desktop renderer environment, or undefined outside the desktop shell.
 */
export const DESKTOP_ENV_STORAGE_KEY = 'dsh-desktop-env'

export function parseDesktopClientEnvironment(search: string): DesktopClientEnvironment | undefined {
  let source = search
  // The 0.1.2 index token exchange redirects to a clean `/` (query dropped),
  // so the desktop shell marker travels via the `dsh-desktop-env` cookie (or
  // the auth-gate login page's sessionStorage stash for the same lifetime).
  try {
    const stored = sessionStorage.getItem(DESKTOP_ENV_STORAGE_KEY)
    if (stored !== null && !/[?&]dsh-desktop-mode=/.test(source)) source = stored
  } catch { /* sessionStorage unavailable */ }
  if (typeof document !== 'undefined' && !/[?&]dsh-desktop-mode=/.test(source)) {
    const cookieEnv = document.cookie.split('; ')
      .find(part => part.startsWith('dsh-desktop-env='))
      ?.slice('dsh-desktop-env='.length)
    if (cookieEnv !== undefined) source = decodeURIComponent(cookieEnv)
  }
  const params = new URLSearchParams(source)
  const mode = params.get('dsh-desktop-mode')
  const platform = params.get('dsh-desktop-platform')
  if (mode === null && platform === null) return undefined
  if (!MODES.has(mode as DesktopClientMode)) {
    throw new Error(`dsh-plugin-desktop: invalid or missing dsh-desktop-mode ${JSON.stringify(mode)}`)
  }
  if (!PLATFORMS.has(platform as DesktopClientPlatform)) {
    throw new Error(`dsh-plugin-desktop: invalid or missing dsh-desktop-platform ${JSON.stringify(platform)}`)
  }
  return { mode: mode as DesktopClientMode, platform: platform as DesktopClientPlatform }
}
