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
/* 模态打开期间左栏交回不透明底（issue #128：左侧毛玻璃像被扫描了）。
   整视口蒙版是 rgba(0,0,0,.24) + backdrop-filter: blur(2px)，而 backdrop-filter 只能
   采样页面自身的绘制结果；左栏平时刻意透明（上行 background: transparent，为的是透出
   macOS vibrancy / Windows mica 原生材质），于是蒙版在左栏根本没有可模糊的底：
   左侧 = 0.24 黑直接压在未模糊的原生材质上，右侧 = 0.24 黑 + 模糊后的页面，分界线正好
   落在 border-right 上（半糊重影就是用户说的扫描感）。
   这里在模态存在时把两个真源一起换掉 —— 表面自身的 background（darwin 上真正被绘制的
   那一层）与 --dsw-specific-sidebar-fill（上游 SidebarRoot.module.css 的 .root 底色来源）
   —— 都取对话列同款 bg-base，蒙版两侧的底就一致了；模态关闭立刻回到透明，原生材质照旧透出。
   选择器只用 html:has() 加我们自己的稳定类名，绝不写上游 CSS-module 的哈希类名；
   role=dialog 与 aria-modal 同时要求，与 @picoaide/dsh-panel-surface 的模态判据同形，
   面板内的内联 alertdialog 确认块不带整视口蒙版，因此不会误触发。 */
html:has([role="dialog"][aria-modal="true"]) .dshDesktopSidebarSurface { --dsw-specific-sidebar-fill: var(--dsw-alias-bg-base); background: var(--dsw-alias-bg-base); }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopUpstreamSidebar { padding-top: ${MACOS_TITLEBAR_HEIGHT}px; -webkit-app-region: no-drag; }
.dshDesktopFrame[data-desktop-platform="darwin"][data-sidebar-collapsed] .dshDesktopUpstreamSidebar { width: ${SIDEBAR_COLLAPSED}px; margin: 0 auto; }
.dshDesktopFrame[data-desktop-platform="darwin"] { grid-template-rows: ${MACOS_TITLEBAR_HEIGHT}px minmax(0, 1fr); }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopSidebarSurface { grid-row: 1 / -1; -webkit-app-region: no-drag; }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopConversationSurface,
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopRightbarSurface { grid-row: 2; }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopSidebarSurface::before { content: ""; position: absolute; top: 0; right: 0; left: ${MACOS_TRAFFIC_LIGHT_SAFE_WIDTH}px; height: ${MACOS_DRAG_REGION_HEIGHT}px; user-select: none; -webkit-app-region: drag; }
.dshDesktopMacCaptionRow { position: relative; grid-column: 2 / -1; grid-row: 1; min-width: 0; background: var(--dsw-alias-bg-base); }
.dshDesktopMacCaptionRow::before { content: ""; position: absolute; top: 0; right: 0; left: 0; height: ${MACOS_DRAG_REGION_HEIGHT}px; user-select: none; -webkit-app-region: drag; }
/* The right panel is positioned against the frame (push) or the viewport
   (fullscreen), never against its own column, so the caption band the grid
   reserves for the native title bar has to be applied to it explicitly: the
   panel's strip carries the surface's own controls, and without the band they
   land under the platform's window buttons. A fullscreen panel still covers
   the frame, so the band becomes its own top padding. */
.dshDesktopFrame[data-desktop-platform="darwin"] [data-sidebar-right-panel="push"] { top: ${MACOS_TITLEBAR_HEIGHT}px; }
.dshDesktopFrame[data-desktop-platform="darwin"] [data-sidebar-right-panel="fullscreen"] { padding-top: ${MACOS_TITLEBAR_HEIGHT}px; }
.dshDesktopConversationSurface { grid-column: 2; grid-row: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--dsw-alias-bg-base); }
/* The right column never clips (upstream ui-layout AppFrame.module.css
   .rightbarCol): its occupant anchors a fixed-width panel to the column's right
   edge and hangs over the centre from a zero-width track, so clipping here
   would cut a shown panel down to the track. The closed panel
   (translateX(100%)) stays off-screen through the frame's own overflow: the
   column is static, so the panel's containing block is .dshDesktopFrame, and
   every slot outlet wrapper is display: contents (no intermediate box). */
.dshDesktopRightbarSurface { grid-column: 3; grid-row: 1; min-width: 0; min-height: 0; overflow: visible; background: var(--dsw-alias-bg-base); border-left: 1px solid var(--dsw-alias-border-l2); }
.dshDesktopFrame[data-desktop-platform="win32"] { grid-template-rows: ${WINDOWS_TITLEBAR_HEIGHT}px minmax(0, 1fr); }
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopSidebarSurface { grid-row: 1 / -1; }
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopConversationSurface,
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopRightbarSurface { grid-row: 2; }
.dshDesktopWindowsCaptionRow { position: relative; grid-column: 2 / -1; grid-row: 1; min-width: 0; background: var(--dsw-alias-bg-base); }
.dshDesktopWindowsCaptionRow::before { content: ""; position: absolute; inset: 0 ${WINDOWS_CAPTION_CONTROLS_WIDTH}px 0 0; user-select: none; -webkit-app-region: drag; }
.dshDesktopFrame[data-desktop-platform="win32"] [data-sidebar-right-panel="push"] { top: ${WINDOWS_TITLEBAR_HEIGHT}px; }
.dshDesktopFrame[data-desktop-platform="win32"] [data-sidebar-right-panel="fullscreen"] { padding-top: ${WINDOWS_TITLEBAR_HEIGHT}px; }
.dshDesktopFrame[data-sidebar-collapsed] { transition: grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out); }
.dshDesktopFrame[data-rightbar-instant] { transition: none !important; }
.dshDesktopOverlay { position: absolute; z-index: 1000; inset: 0; pointer-events: none; }
.dshDesktopOverlay > * { pointer-events: auto; }
.dshDesktopResizeHandle { position: absolute; z-index: 50; top: 0; bottom: 0; width: 8px; margin-left: -4px; cursor: col-resize; touch-action: none; -webkit-app-region: no-drag; }
.dshDesktopNoDrag, button, input, textarea, select, a, [role="button"], [role="dialog"], [role="presentation"] { -webkit-app-region: no-drag; }
[role="dialog"], [aria-modal="true"] { -webkit-app-region: no-drag !important; }
html:has([aria-modal="true"]) .dshDesktopWindowsCaptionRow::before,
html:has([aria-modal="true"]) .dshDesktopMacCaptionRow::before,
html:has([aria-modal="true"]) .dshDesktopSidebarSurface,
html:has([aria-modal="true"]) .dshDesktopSidebarSurface::before { -webkit-app-region: no-drag !important; }
/* Session-header update badge (right-aligned utilities seat). */
.dshDesktopUpdateBadge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
  /* 胶囊表面/文字用会翻转的 token：bg-elevated 与 fg-1 这两个名字上游都不存在
     （2026-09-16 审计）⇒ 暗色下依旧是白底深字。上游 Pill 用的是 bg-layer-2。 */
  background: var(--dsw-alias-bg-layer-2, #fff);
  color: var(--dsw-alias-label-primary, #333);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  font-family: inherit;
  cursor: pointer;
}
.dshDesktopUpdateBadge:hover { border-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.16)); }
/* 焦点环/圆点/成功态一律走会翻转的 token（2026-09-16 暗色审计）：
   硬编码的 #2f6fed / #e8871e / #16a34a / #15803d 在暗色下要么对比不足、
   要么与旁边已翻转的 bg-layer-2 底色打架（ready 深绿字在暗底只有 2.78:1）。
   例外是 ready 的文字：--dsw-alias-state-success-primary **不随主题翻转**
   （亮暗都解析成 green-500），当文字色用会让亮色主题掉到 2.28:1
   （2026-09-17 S06-01 审计），因此它只保留给圆点/边框。 */
.dshDesktopUpdateBadge:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2f6fed); outline-offset: 1px; }
.dshDesktopUpdateBadgeDot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-business-primary, #2f6fed);
  flex: 0 0 auto;
}
.dshDesktopUpdateBadge[data-state="downloading"] .dshDesktopUpdateBadgeDot {
  background: var(--dsw-alias-state-warn-primary, #e8871e);
  animation: dshDesktopUpdatePulse 1.2s ease-in-out infinite;
}
/* 已下载待安装:绿点 + 实心按钮,和"有新版本"明确区分(不再需要重新下载)。 */
.dshDesktopUpdateBadge[data-state="ready"] {
  border-color: var(--dsw-alias-state-success-primary, #16a34a);
  /* 文字显式给一对可读值（2026-09-17 S06-01 审计）：沿用状态色会同时丢掉
     亮色主题（白底 2.28:1）与暗色主题（深底上换成 green-500 也只有 6.12:1，
     但仍不如显式值的 7.13:1），而徽标底色 bg-layer-2 是翻转的。 */
  color: #15803d; /* 亮色 bg-layer-2(#fff) 上 5.02:1 */
}
body[data-ds-dark-theme] .dshDesktopUpdateBadge[data-state="ready"] {
  color: var(--dsw-static-green-400, #4ed17e); /* 暗色 bg-layer-2 上 7.13:1 */
}
.dshDesktopUpdateBadge[data-state="ready"] .dshDesktopUpdateBadgeDot {
  background: var(--dsw-alias-state-success-primary, #16a34a);
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
