import type { Context } from '@deepseek-ai/cordis'

/** Electron platforms supported by the DSH Desktop renderer marker. */
export type DesktopPlatform = 'darwin' | 'win32' | 'linux'

/** Window values resolved from the desktop-shell Cordis row. */
export interface DesktopWindowConfig {
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
  /** Loopback URL served by the active DSH profile. */
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
   * Own one shell generation after the Host Loader settles.
   * @param ready - Host Loader settlement for the current profile generation.
   * @param resolveSpec - reads native shell inputs after settlement, when
   *   ephemeral services such as the Web server port are authoritative.
   * @returns an asynchronous disposer for the shell generation.
   */
  mountAfter(ready: Promise<void>, resolveSpec: () => DesktopShellSpec): () => Promise<void>

  /**
   * Wait for the scheduled shell generation to load its renderer.
   * @returns a promise that rejects when native shell setup fails.
   */
  whenMounted(): Promise<void>

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
