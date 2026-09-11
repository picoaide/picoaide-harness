/**
 * Advanced-shell panel selection and column geometry.
 *
 * rc.2 replaced the old details-panel pair (`openDetails`/`closeDetails`) with
 * `ctx.layout`'s panel-selection face (`selectPanel`/`beginNavigation`) plus the
 * right column's self-reported presentation (`openRightbar`/`closeRightbar`).
 * The advanced desktop profile keeps `ui-layout`'s row disabled and this shell
 * owns the frame instead, so this module re-implements that contract: the
 * three-column solve mirrors upstream `ui-layout/src/client/columns.ts`, and
 * `panelInfo` is the root standard source the sidebar surfaces subscribe
 * through (`usePanelInfo`).
 */
import type { ILayout, MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Compatibility-mode compact rail used by the upstream Windows sidebar. */
export const SIDEBAR_COLLAPSED = 56
/** Wider compact rail reserved for the desktop-owned macOS sidebar. */
export const MACOS_SIDEBAR_COLLAPSED = 90
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
const SIDEBAR_MIN = 264
const SIDEBAR_MAX = 420
/** Viewport width below which the sidebar auto-collapses to the rail. */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/** Right column drag clamp floor. */
export const RIGHTBAR_MIN = 300
/** Maximum normal right panel width as a fraction of the frame. */
export const RIGHTBAR_MAX_RATIO = 0.7
/** First-open right panel preference as a fraction of the frame. */
export const RIGHTBAR_DEFAULT_RATIO = 0.45
/** Center width protected while the normal right column is open. */
const CENTER_MIN = 400

/** Frame measurement, panel preferences, and the right column's reported presentation. */
export interface DesktopLayoutInfo {
  /** Preferred sidebar width; zero means the compact rail. */
  sidebar: number
  /** Last positive frame measurement. */
  viewportWidth: number
  /** Manual narrow-screen override that temporarily expands the rail. */
  narrowExpanded: boolean
  /** Saved right panel width in px, or null before its first opening. */
  rightbar: number | null
  /** Whether the right panel is drawn at all, in either presentation. */
  rightbarShown: boolean
  /** Whether the normal panel width reserves a grid track. */
  rightbarTrack: boolean
  /** Reported fullscreen presentation. */
  rightbarFullscreen: boolean
  /** Suppress transitions for a fullscreen exit until another geometry action. */
  rightbarInstant: boolean
}

/** One frame's published state: panel selection plus column geometry. */
export interface DesktopLayoutSnapshot {
  /** Session-content selection shared with `usePanelInfo` consumers. */
  panelInfo: PanelInfo
  /** Column measurements and preferences. */
  layoutInfo: DesktopLayoutInfo
}

/** Column geometry after preserving the center surface. */
export interface DesktopColumns {
  /** Rendered sidebar width. */
  sidebar: number
  /** Rendered center width. */
  center: number
  /** Rendered right column width; zero means no track. */
  rightbar: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Resolve the three desktop columns without letting the right column squeeze the
 * conversation below its floor (upstream `computeColumns` semantics).
 * @param viewport - available frame width.
 * @param sidebar - sidebar preference, where zero selects the compact rail.
 * @param rightbar - right panel width preference, where zero means no track.
 * @param collapsedWidth - rail width for this platform.
 * @returns rendered column widths.
 */
export function computeDesktopColumns(
  viewport: number,
  sidebar: number,
  rightbar: number,
  collapsedWidth: number = SIDEBAR_COLLAPSED,
): DesktopColumns {
  const sidebarWidth = sidebar === 0 ? collapsedWidth : clamp(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const available = viewport - sidebarWidth - CENTER_MIN
  const rightbarWidth = rightbar === 0 || available < RIGHTBAR_MIN
    ? 0
    : Math.min(available, clamp(rightbar, RIGHTBAR_MIN, viewport * RIGHTBAR_MAX_RATIO))
  return {
    sidebar: sidebarWidth,
    center: Math.max(0, viewport - sidebarWidth - rightbarWidth),
    rightbar: rightbarWidth,
  }
}

/**
 * Observable layout controller used by the advanced root registration.
 *
 * Implements the rc.2 `ILayout` face (`selectPanel`, `beginNavigation`,
 * `toggleSidebar`, `openRightbar`, `closeRightbar`) and publishes the snapshot
 * the frame renders from. Two subscriber sets keep the panel-selection identity
 * stable for `usePanelInfo` consumers while layout measurements churn.
 */
export class DesktopLayoutState implements ILayout {
  private layoutInfo: DesktopLayoutInfo
  private panel: PanelInfo
  private snapshot: DesktopLayoutSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly panelListeners = new Set<() => void>()
  private navigation = new AbortController()
  private mainPanels = new Set<string>()

  /** @param viewportWidth - initial frame measurement (window width bootstraps it). */
  constructor(viewportWidth: number = 0) {
    this.layoutInfo = Object.freeze({
      sidebar: SIDEBAR_DEFAULT,
      viewportWidth,
      narrowExpanded: false,
      rightbar: null,
      rightbarShown: false,
      rightbarTrack: false,
      rightbarFullscreen: false,
      rightbarInstant: false,
    })
    this.panel = Object.freeze({ activePanelId: null })
    this.snapshot = Object.freeze({ panelInfo: this.panel, layoutInfo: this.layoutInfo })
  }

  /** Root standard source consumed as the `usePanelInfo` prop. */
  readonly panelInfo: HostObservable<PanelInfo> = {
    getSnapshot: () => this.panel,
    subscribe: (listener: () => void) => {
      this.panelListeners.add(listener)
      return () => { this.panelListeners.delete(listener) }
    },
  }

  /** @returns the immutable current frame state. */
  getSnapshot(): DesktopLayoutSnapshot {
    return this.snapshot
  }

  /** @param listener - notified after every published state replacement. @returns its disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Select a global central panel without changing the current session.
   * @param panelId - registered main key, or null to show the Conversation.
   * @throws if the selected main key is not registered; the selection is preserved.
   */
  selectPanel(panelId: MainPanelId | null): void {
    if (panelId !== null && !this.mainPanels.has(panelId)) {
      throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
    }
    this.navigation.abort()
    if (this.panel.activePanelId === panelId) return
    this.panel = Object.freeze({ activePanelId: panelId })
    this.publish()
    for (const listener of this.panelListeners) listener()
  }

  /**
   * Start an asynchronous navigation, superseding any earlier pending one.
   * @returns a signal aborted by the next navigation or by disposal.
   */
  beginNavigation(): AbortSignal {
    this.navigation.abort()
    this.navigation = new AbortController()
    return this.navigation.signal
  }

  /** @returns whether the sidebar renders its compact rail at the current measurement. */
  sidebarCollapsed(): boolean {
    return this.layoutInfo.viewportWidth < SIDEBAR_AUTO_COLLAPSE
      ? !this.layoutInfo.narrowExpanded
      : this.layoutInfo.sidebar === 0
  }

  /** @returns the sidebar width preference the frame solves its columns with. */
  sidebarPreference(): number {
    if (this.sidebarCollapsed()) return 0
    return this.layoutInfo.sidebar === 0 ? SIDEBAR_DEFAULT : this.layoutInfo.sidebar
  }

  /** @returns the right column's width preference (its first-open default included). */
  rightbarPreference(): number {
    return this.layoutInfo.rightbar ?? this.layoutInfo.viewportWidth * RIGHTBAR_DEFAULT_RATIO
  }

  /** Toggle the wide sidebar and the platform-selected compact rail. */
  toggleSidebar(): void {
    if (this.layoutInfo.viewportWidth < SIDEBAR_AUTO_COLLAPSE) {
      this.publishLayout({ narrowExpanded: !this.layoutInfo.narrowExpanded })
      return
    }
    this.publishLayout({ sidebar: this.layoutInfo.sidebar === 0 ? SIDEBAR_DEFAULT : 0 })
  }

  /**
   * Report the right panel's presentation without changing its expanded state.
   * @param track - whether the normal panel width reserves a grid track.
   * @param fullscreen - whether the panel covers the frame.
   */
  openRightbar(track: boolean, fullscreen: boolean): void {
    const width = this.layoutInfo.rightbar ?? Math.round(this.layoutInfo.viewportWidth * RIGHTBAR_DEFAULT_RATIO)
    this.publishLayout({
      rightbar: width,
      rightbarShown: true,
      rightbarTrack: track,
      rightbarFullscreen: fullscreen,
      rightbarInstant: false,
    })
  }

  /** Report the right panel as hidden: no track, no handle. */
  closeRightbar(): void {
    if (!this.layoutInfo.rightbarShown && !this.layoutInfo.rightbarTrack && !this.layoutInfo.rightbarFullscreen) return
    this.publishLayout({
      rightbarShown: false,
      rightbarTrack: false,
      rightbarFullscreen: false,
      // A fullscreen exit keeps transitions suppressed while the frame installs
      // its destination geometry; the next opening clears the flag.
      rightbarInstant: this.layoutInfo.rightbarFullscreen,
    })
  }

  /**
   * Keep the selectable panel set in step with the live `main` registrations.
   * @param panelIds - currently registered main keys.
   */
  retainMainPanels(panelIds: readonly string[]): void {
    this.mainPanels = new Set(panelIds)
    const active = this.panel.activePanelId
    if (active !== null && !this.mainPanels.has(active)) this.selectPanel(null)
  }

  /** @param width - current frame measurement. */
  setViewportWidth(width: number): void {
    if (width <= 0 || width === this.layoutInfo.viewportWidth) return
    this.publishLayout({ viewportWidth: width })
  }

  /** @param width - requested sidebar width from a resize gesture. */
  setSidebar(width: number): void {
    this.publishLayout({ sidebar: clamp(width, SIDEBAR_MIN, SIDEBAR_MAX) })
  }

  /** @param width - requested right panel width from a resize gesture. */
  setRightbar(width: number): void {
    const max = Math.max(RIGHTBAR_MIN, Math.round(this.layoutInfo.viewportWidth * RIGHTBAR_MAX_RATIO))
    this.publishLayout({ rightbar: clamp(width, RIGHTBAR_MIN, max) })
  }

  /** Invalidate pending navigations when the owning fiber unloads. */
  dispose(): void {
    this.navigation.abort()
  }

  private publishLayout(patch: Partial<DesktopLayoutInfo>): void {
    this.layoutInfo = Object.freeze({ ...this.layoutInfo, ...patch })
    this.publish()
  }

  private publish(): void {
    this.snapshot = Object.freeze({ panelInfo: this.panel, layoutInfo: this.layoutInfo })
    for (const listener of this.listeners) listener()
  }
}
