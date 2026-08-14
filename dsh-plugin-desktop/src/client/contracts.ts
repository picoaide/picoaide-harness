import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { DesktopLayoutState } from './layout-state.ts'

/** Sidebar geometry passed by the desktop root slot. */
export interface DesktopSidebarOwnerProps {
  /** Whether the sidebar is showing its compact rail. */
  collapsed: boolean
  /** Current rendered sidebar width. */
  width: number
}

/** Workspace browser facts passed by the desktop sidebar slot. */
export interface DesktopWorkspaceOwnerProps {
  /** Whether the sidebar is expanded. */
  wide: boolean
  /** Expand the sidebar before focusing a rail affordance. */
  expandSidebar: () => void
}

/** Sidebar footer facts passed to settings and additive actions. */
export interface DesktopSidebarFooterOwnerProps {
  /** Whether the sidebar is expanded. */
  wide: boolean
}

/** Public panel transitions consumed by conversation and sidebar plugins. */
export interface DesktopLayoutService {
  /** Toggle the sidebar between wide and compact presentation. */
  toggleSidebar(): void
  /** Open the current session's details panel. */
  openDetails(): void
  /** Close the details panel. */
  closeDetails(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Desktop-owned layout service in advanced mode. */
    layout: DesktopLayoutService
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Desktop advanced shell sidebar. */
    'sidebar': { kind: 'single'; scope: 'root'; owner: DesktopSidebarOwnerProps }
    /** Unchanged upstream conversation surface. */
    'conversation': { kind: 'single'; scope: 'session-maybe'; owner: Record<never, never> }
    /** Unchanged upstream details surface. */
    'details': { kind: 'single'; scope: 'session'; owner: Record<never, never> }
    /** Frame-wide additive overlays. */
    'shell.overlay': { kind: 'list'; scope: 'root' }
    /** Unchanged upstream workspace/session browser. */
    'sidebar.workspaces': { kind: 'single'; scope: 'root'; owner: DesktopWorkspaceOwnerProps }
    /** Unchanged upstream settings trigger and modal. */
    'sidebar.settings': { kind: 'single'; scope: 'root'; owner: DesktopSidebarFooterOwnerProps }
    /** Additive sidebar footer actions. */
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: DesktopSidebarFooterOwnerProps }
  }
}

/** Registration-side callbacks supplied to the advanced sidebar. */
export interface DesktopSidebarActions {
  /** Start or focus a session with an optional workspace. */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Desktop panel controller. */
  layout: DesktopLayoutState
}
