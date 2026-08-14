import type { Context } from '@deepseek-ai/cordis'

/** Electron platforms supported by the DSH Desktop native adapter. */
export type DesktopPlatform = 'darwin' | 'win32' | 'linux'

/** Native presentation modes selected by the desktop-shell Cordis row. */
export type DesktopShellMode = 'compatibility' | 'advanced'

/** Window values resolved from the desktop-shell Cordis row. */
export interface DesktopWindowConfig {
  /** Native presentation mode selected before BrowserWindow construction. */
  mode: DesktopShellMode
  /** Initial window width in CSS pixels. */
  width: number
  /** Initial window height in CSS pixels. */
  height: number
  /** Minimum window width in CSS pixels. */
  minWidth: number
  /** Minimum window height in CSS pixels. */
  minHeight: number
}

/** Values the desktop-shell plugin hands to the Electron adapter. */
export interface DesktopShellSpec extends DesktopWindowConfig {
  /** Unmodified Web root served by the active DSH profile. */
  url: string
  /** Native application and tray label. */
  productName: string
  /** Original application icon shipped with the package. */
  iconPath: string
  /** Request Cordis teardown followed by native application exit. */
  requestQuit(code: number): void
}

/** Electron bootstrap capability supplied before the profile tree mounts. */
export interface DesktopRuntime {
  /** Current Electron platform. */
  readonly platform: DesktopPlatform

  /**
   * Register one shell generation while the Cordis profile is activating.
   * @param spec - native shell inputs resolved from active Host services.
   * @returns an asynchronous disposer for the shell generation.
   */
  schedule(spec: DesktopShellSpec): () => Promise<void>

  /**
   * Mount the registered generation after the launcher has settled the profile.
   * @returns a promise that rejects when registration or native setup fails.
   */
  mountScheduled(): Promise<void>

  /** Reveal and focus the current window, if mounted. */
  show(): void

  /** Allow the final native quit after the Cordis tree has disposed. */
  prepareToQuit(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Electron adapter provided by the DSH Desktop launcher. */
    desktopRuntime: DesktopRuntime
  }
}

// This type-only use keeps declaration merging reachable from the emitted
// package root without creating a runtime dependency edge.
export type DesktopRuntimeContext = Context
