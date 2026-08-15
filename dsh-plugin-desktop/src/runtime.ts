import type { Context } from '@deepseek-ai/cordis'
import type { UpdateRequest } from './update-checker.ts'

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

/** Generated images consumed by the platform tray adapter. */
export interface DesktopTrayIcons {
  /** Black macOS template image with its Retina representation beside it. */
  templatePath: string
  /** Brand-blue Windows/Linux image with DPI representations beside it. */
  bluePath: string
}

/** Stable placement groups for Host plugins that extend the native tray. */
export type DesktopTrayItemGroup = 'tools' | 'status'

/** One effect-scoped command contributed to the native tray menu. */
export interface DesktopTrayItem {
  /** Menu section used for deterministic ordering and separators. */
  group: DesktopTrayItemGroup
  /** Relative position inside the selected group. */
  order: number
  /** Resolve the current user-visible label when the menu is rebuilt. */
  label(): string
  /** Resolve whether the command can currently be invoked. */
  enabled?(): boolean
  /** Run the command without blocking the Electron menu callback. */
  invoke(): void | Promise<void>
}

/** Lifecycle handle returned for one tray contribution. */
export interface DesktopTrayItemRegistration {
  /** Rebuild the menu after the contribution's observable state changes. */
  refresh(): void
  /** Remove the contribution. Repeated disposal has no effect. */
  dispose(): void
}

/** Native notification shown by a desktop-owned Host plugin. */
export interface DesktopNotification {
  /** Notification heading. */
  title: string
  /** Concise user-facing status. */
  body: string
  /** Trusted URL opened when the notification is selected. */
  openUrl?: string
}

/** Electron capabilities used by the headless update plugin. */
export interface DesktopUpdateAdapter {
  /** Whether the running executable came from an Electron package. */
  readonly isPackaged: boolean
  /** Installed desktop product version. */
  readonly currentVersion: string
  /** Private file used for conditional request and notification state. */
  readonly statePath: string
  /** Request adapter backed by Electron's authenticated network session. */
  readonly request: UpdateRequest
  /** Open one validated release page in the default browser. */
  openRelease(url: string): Promise<void>
  /** Present a native status notification without blocking the Host tree. */
  notify(notification: DesktopNotification): void
}

/** Profile identity needed to open the packaged DSH command environment. */
export interface DesktopTerminalSpec {
  /** DSH profile selected by the desktop launcher. */
  profileName: string
  /** Absolute directory containing the profile manifest and dependencies. */
  profileDir: string
  /** Active DSH home shared with the desktop launcher. */
  homeDir: string
}

/** Values the desktop-shell plugin hands to the Electron adapter. */
export interface DesktopShellSpec extends DesktopWindowConfig {
  /** Unmodified Web root served by the active DSH profile. */
  url: string
  /** Native application and tray label. */
  productName: string
  /** Visible native caption on platforms that retain a title. */
  windowTitle: string
  /** Original application icon shipped with the package. */
  iconPath: string
  /** Generated tray assets derived from the repository-owned SVG. */
  trayIcons: DesktopTrayIcons
  /** Request Cordis teardown followed by native application exit. */
  requestQuit(code: number): void
  /** Persist another mode through the registered desktop settings scope. */
  requestModeChange(mode: DesktopShellMode): Promise<void>
}

/** Electron bootstrap capability supplied before the profile tree mounts. */
export interface DesktopRuntime {
  /** Current Electron platform. */
  readonly platform: DesktopPlatform

  /** Native network, notification, and release-page adapter. */
  readonly updates: DesktopUpdateAdapter

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

  /**
   * Contribute one command to the native tray for the current Cordis lifetime.
   * @param item - dynamic label, state, and invocation owned by the caller.
   * @returns a refreshable, idempotent registration handle.
   */
  registerTrayItem(item: DesktopTrayItem): DesktopTrayItemRegistration

  /** Open a native terminal containing packaged DSH command shims. */
  openTerminal(): void

  /** Request orderly Cordis teardown followed by an Electron relaunch. */
  requestRestart(): Promise<void>

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
