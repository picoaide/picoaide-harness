/** Advanced-shell stylesheet kept as a plain string so the package client bundle stays self-contained. */
const ADVANCED_STYLES = `
html, body, #root { width: 100%; height: 100%; }
body[data-dsh-desktop-mode="advanced"] { margin: 0; background: transparent !important; }
.dshDesktopFrame { position: relative; display: grid; grid-template-rows: 100%; width: 100%; height: 100%; overflow: hidden; background: transparent; }
.dshDesktopSidebarSurface { min-width: 0; overflow: hidden; background: transparent; border-right: 1px solid var(--dsw-alias-border-l1); }
.dshDesktopConversationSurface { min-width: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--dsw-alias-bg-base); }
.dshDesktopDetailsSurface { min-width: 0; overflow: hidden; background: var(--dsw-alias-bg-base); border-left: 1px solid var(--dsw-alias-border-l2); }
.dshDesktopFrame[data-sidebar-collapsed] { transition: grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out); }
.dshDesktopOverlay { position: absolute; z-index: 1000; inset: 0; pointer-events: none; }
.dshDesktopOverlay > * { pointer-events: auto; }
.dshDesktopResizeHandle { position: absolute; z-index: 50; top: 0; bottom: 0; width: 8px; margin-left: -4px; cursor: col-resize; touch-action: none; -webkit-app-region: no-drag; }
.dshDesktopSidebar { --dsh-sidebar-inline-padding: 12px; display: flex; flex-direction: column; box-sizing: border-box; width: 100%; height: 100%; padding: 6px var(--dsh-sidebar-inline-padding); color: var(--dsw-alias-label-primary); background: transparent; font-size: 14px; }
.dshDesktopSidebar[data-desktop-platform="darwin"] { padding-top: 42px; }
.dshDesktopSidebar[data-desktop-platform="darwin"]:not([data-wide]) { padding-top: 50px; }
.dshDesktopSidebar:not([data-wide]) { align-items: center; padding-right: 27px; padding-left: 27px; }
.dshDesktopLogoRow { display: flex; flex: none; align-items: center; justify-content: flex-end; gap: 8px; box-sizing: border-box; width: 100%; height: 52px; margin-bottom: 8px; padding-left: 4px; user-select: none; -webkit-app-region: drag; }
.dshDesktopSidebar:not([data-wide]) .dshDesktopLogoRow { justify-content: center; height: 36px; margin-bottom: 12px; padding: 0; }
.dshDesktopBrand { display: inline-flex; flex: 1; align-items: center; min-width: 0; padding: 0; overflow: hidden; color: inherit; cursor: pointer; background: transparent; border: 0; }
.dshDesktopIconButton { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0; color: var(--dsw-alias-label-primary); cursor: pointer; background: transparent; border: 0; border-radius: 50%; }
.dshDesktopIconButton:hover, .dshDesktopNewSession:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshDesktopNewSession { display: flex; flex: none; align-items: center; justify-content: center; gap: 6px; box-sizing: border-box; width: calc(100% - 4px); height: 38px; margin: 0 2px 8px; padding: 8px 16px; color: var(--dsw-alias-label-primary); font: inherit; font-weight: 500; cursor: pointer; background: var(--dsw-alias-button-elevated-fill); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; }
.dshDesktopSidebar:not([data-wide]) .dshDesktopNewSession { width: 36px; height: 36px; margin: 0 0 12px; padding: 0; background: transparent; border-color: transparent; }
.dshDesktopWorkspaceRegion { --dsw-specific-sidebar-fill: transparent; display: flex; flex: 1; flex-direction: column; min-height: 0; margin-right: calc(-1 * var(--dsh-sidebar-inline-padding)); overflow: hidden; }
.dshDesktopSidebar:not([data-wide]) .dshDesktopWorkspaceRegion { width: 36px; margin-right: 0; }
.dshDesktopSidebarFooter { display: flex; flex: none; flex-direction: column; width: 100%; }
.dshDesktopSidebar:not([data-wide]) .dshDesktopSidebarFooter { align-items: center; width: 36px; }
.dshDesktopConversationSurface [data-phase] { position: relative; }
.dshDesktopConversationSurface [data-phase] > header { user-select: none; -webkit-app-region: drag; }
.dshDesktopConversationSurface [data-phase='hero']::before,
.dshDesktopConversationSurface [data-phase='settling']::before { content: ""; position: absolute; z-index: 1; top: 0; right: 0; left: 0; height: 38px; user-select: none; -webkit-app-region: drag; }
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopConversationSurface [data-phase] > header { padding-right: 138px; }
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopConversationSurface [data-phase='hero']::before,
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopConversationSurface [data-phase='settling']::before { right: 138px; }
.dshDesktopNoDrag, button, input, textarea, select, a, [role="button"], [role="dialog"], [role="presentation"] { -webkit-app-region: no-drag; }
.dshDesktopConversationSurface [data-phase] > header button,
.dshDesktopConversationSurface [data-phase] > header a,
.dshDesktopConversationSurface [data-phase] > header input,
[role="dialog"], [aria-modal="true"] { -webkit-app-region: no-drag !important; }
html:has([aria-modal="true"]) .dshDesktopLogoRow,
html:has([aria-modal="true"]) .dshDesktopConversationSurface [data-phase] > header,
html:has([aria-modal="true"]) .dshDesktopConversationSurface [data-phase]::before { -webkit-app-region: no-drag !important; }
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
