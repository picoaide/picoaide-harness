import {
  MACOS_DRAG_REGION_HEIGHT,
  MACOS_TITLEBAR_HEIGHT,
  MACOS_TRAFFIC_LIGHT_SAFE_WIDTH,
  WINDOWS_CAPTION_CONTROLS_WIDTH,
  WINDOWS_TITLEBAR_HEIGHT,
} from '../window-chrome.ts'
import { SIDEBAR_COLLAPSED } from './layout-state.ts'

/** Advanced-shell stylesheet kept as a plain string so the package client bundle stays self-contained. */
const ADVANCED_STYLES = `
html, body, #root { width: 100%; height: 100%; }
body[data-dsh-desktop-mode="advanced"] { margin: 0; background: transparent !important; }
.dshDesktopFrame { position: relative; display: grid; grid-template-rows: 100%; width: 100%; height: 100%; overflow: hidden; background: transparent; }
.dshDesktopSidebarSurface { --dsw-specific-sidebar-fill: transparent; position: relative; grid-column: 1; grid-row: 1; min-width: 0; overflow: hidden; background: transparent; border-right: 1px solid var(--dsw-alias-border-l1); }
.dshDesktopUpstreamSidebar { box-sizing: border-box; width: 100%; height: 100%; }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopUpstreamSidebar { padding-top: ${MACOS_TITLEBAR_HEIGHT}px; -webkit-app-region: no-drag; }
.dshDesktopFrame[data-desktop-platform="darwin"][data-sidebar-collapsed] .dshDesktopUpstreamSidebar { width: ${SIDEBAR_COLLAPSED}px; margin: 0 auto; }
.dshDesktopFrame[data-desktop-platform="darwin"] { grid-template-rows: ${MACOS_TITLEBAR_HEIGHT}px minmax(0, 1fr); }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopSidebarSurface { grid-row: 1 / -1; -webkit-app-region: no-drag; }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopConversationSurface,
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopDetailsSurface { grid-row: 2; }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopSidebarSurface::before { content: ""; position: absolute; top: 0; right: 0; left: ${MACOS_TRAFFIC_LIGHT_SAFE_WIDTH}px; height: ${MACOS_DRAG_REGION_HEIGHT}px; user-select: none; -webkit-app-region: drag; }
.dshDesktopMacCaptionRow { position: relative; grid-column: 2 / -1; grid-row: 1; min-width: 0; background: var(--dsw-alias-bg-base); }
.dshDesktopMacCaptionRow::before { content: ""; position: absolute; top: 0; right: 0; left: 0; height: ${MACOS_DRAG_REGION_HEIGHT}px; user-select: none; -webkit-app-region: drag; }
.dshDesktopConversationSurface { grid-column: 2; grid-row: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--dsw-alias-bg-base); }
.dshDesktopDetailsSurface { grid-column: 3; grid-row: 1; min-width: 0; min-height: 0; overflow: hidden; background: var(--dsw-alias-bg-base); border-left: 1px solid var(--dsw-alias-border-l2); }
.dshDesktopFrame[data-desktop-platform="win32"] { grid-template-rows: ${WINDOWS_TITLEBAR_HEIGHT}px minmax(0, 1fr); }
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopSidebarSurface { grid-row: 1 / -1; }
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopConversationSurface,
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopDetailsSurface { grid-row: 2; }
.dshDesktopWindowsCaptionRow { position: relative; grid-column: 2 / -1; grid-row: 1; min-width: 0; background: var(--dsw-alias-bg-base); }
.dshDesktopWindowsCaptionRow::before { content: ""; position: absolute; inset: 0 ${WINDOWS_CAPTION_CONTROLS_WIDTH}px 0 0; user-select: none; -webkit-app-region: drag; }
.dshDesktopFrame[data-sidebar-collapsed] { transition: grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out); }
.dshDesktopOverlay { position: absolute; z-index: 1000; inset: 0; pointer-events: none; }
.dshDesktopOverlay > * { pointer-events: auto; }
.dshDesktopResizeHandle { position: absolute; z-index: 50; top: 0; bottom: 0; width: 8px; margin-left: -4px; cursor: col-resize; touch-action: none; -webkit-app-region: no-drag; }
.dshDesktopNoDrag, button, input, textarea, select, a, [role="button"], [role="dialog"], [role="presentation"] { -webkit-app-region: no-drag; }
[role="dialog"], [aria-modal="true"] { -webkit-app-region: no-drag !important; }
html:has([aria-modal="true"]) .dshDesktopWindowsCaptionRow::before,
html:has([aria-modal="true"]) .dshDesktopMacCaptionRow::before,
html:has([aria-modal="true"]) .dshDesktopSidebarSurface,
html:has([aria-modal="true"]) .dshDesktopSidebarSurface::before { -webkit-app-region: no-drag !important; }
/* Windows Window-Controls-Overlay coexistence: the advanced window draws the
   native caption controls (minimize/maximize/close) at the top-right corner
   OVER the web content (titleBarOverlay, height WINDOWS_TITLEBAR_HEIGHT).
   Viewport-pinned third-party surfaces that claim the top-right corner (the
   better-sidebar toggle cluster, and its right panel's tab strip while open)
   would land under those controls, so in advanced Windows mode we drop them
   below the caption band. Selectors follow the better-sidebar skinning
   contract: scope to [data-dsh-better-sidebar] and match its CSS-module
   hashed classes by stable local-name substring; the :not() list excludes
   the panel body, drag handle, collapsed and bottom-panel surfaces. The
   strip height composes with the plugin's own --dsh-title-bar-strip
   variable (title-bar compat pref): the effective band is at least the
   native overlay height, more if the user reserved a taller strip. */
body[data-dsh-desktop-mode="advanced"][data-dsh-desktop-platform="win32"] [data-dsh-better-sidebar] [class*='toggleCluster'] {
  top: calc(max(var(--dsh-title-bar-strip, 0px), ${WINDOWS_TITLEBAR_HEIGHT}px) + 3px);
}
body[data-dsh-desktop-mode="advanced"][data-dsh-desktop-platform="win32"] [data-dsh-better-sidebar] [class*='panel']:not([class*='panelHidden']):not([class*='panelBody']):not([class*='panelResize']):not([class*='bottomPanel']) {
  padding-top: max(var(--dsh-title-bar-strip, 0px), ${WINDOWS_TITLEBAR_HEIGHT}px);
}
/* Session-header update badge (right-aligned utilities seat). */
.dshDesktopUpdateBadge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
  background: var(--dsw-alias-bg-elevated, #fff);
  color: var(--dsw-alias-fg-1, #333);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  font-family: inherit;
  cursor: pointer;
}
.dshDesktopUpdateBadge:hover { border-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.16)); }
.dshDesktopUpdateBadge:focus-visible { outline: 2px solid #2f6fed; outline-offset: 1px; }
.dshDesktopUpdateBadgeDot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #2f6fed;
  flex: 0 0 auto;
}
.dshDesktopUpdateBadge[data-state="downloading"] .dshDesktopUpdateBadgeDot {
  background: #e8871e;
  animation: dshDesktopUpdatePulse 1.2s ease-in-out infinite;
}
@keyframes dshDesktopUpdatePulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) { .dshDesktopFrame { transition: none !important; } }
`

/** Install and remove the advanced shell's global native-window styles. @returns the style disposer. */
export function installAdvancedStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = 'dsh-plugin-desktop/advanced-shell'
  style.textContent = ADVANCED_STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}
