import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './contracts.ts'
import type { DesktopClientPlatform } from './environment.ts'
import {
  computeDesktopColumns, DesktopLayoutState, MACOS_SIDEBAR_COLLAPSED,
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_COLLAPSED,
} from './layout-state.ts'

/** Private values assembled by the advanced-shell registration. */
interface AdvancedFrameInjected {
  /** Desktop-owned panel state exposed through the standard layout service. */
  layout: DesktopLayoutState
  /** Host platform controlling native title-bar spacing. */
  platform: DesktopClientPlatform
}

/** Full advanced root slot props. */
export type AdvancedFrameProps = PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'main' | 'rightbar' | 'shell.overlay'>
  & AdvancedFrameInjected

/**
 * Desktop-owned transparent frame around the unchanged product surfaces.
 *
 * Mirrors the rc.2 `ui-layout` AppFrame solve: the left column holds the
 * upstream sidebar, `main` renders the selected panel (the Conversation under
 * the reserved `conversation` key), and the right column is a track the right
 * Sidebar's occupant asks for through `ctx.layout.openRightbar`.
 */
export function AdvancedFrame({ layout, platform, renderSlot }: AdvancedFrameProps) {
  const subscribeLayout = useCallback((listener: () => void) => layout.subscribe(listener), [layout])
  const readLayout = useCallback(() => layout.getSnapshot(), [layout])
  const state = useSyncExternalStore(subscribeLayout, readLayout)
  const { layoutInfo, panelInfo } = state
  const frameRef = useRef<HTMLDivElement>(null)

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useLayoutEffect(() => {
    const element = frameRef.current
    if (element === null) return
    let raf: number | null = null
    let disposed = false
    const measure = (): void => {
      const width = element.getBoundingClientRect().width
      if (width > 0) layout.setViewportWidth(width)
    }
    measure()
    const observer = new ResizeObserver(() => {
      if (disposed) return
      raf ??= requestAnimationFrame(() => {
        raf = null
        measure()
      })
    })
    observer.observe(element)
    return () => {
      disposed = true
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [layout])

  const collapsedWidth = platform === 'darwin' ? MACOS_SIDEBAR_COLLAPSED : SIDEBAR_COLLAPSED
  const viewport = layoutInfo.viewportWidth
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const sidebarCollapsed = layout.sidebarCollapsed()
  const sidebarPreference = layout.sidebarPreference()
  const rightbarPreference = layout.rightbarPreference()
  // Opening on a narrow frame collapses the left sidebar. Eligibility must
  // include that space before the occupant's first shown report arrives.
  const normal = computeDesktopColumns(
    viewport,
    !layoutInfo.rightbarShown && narrow ? 0 : sidebarPreference,
    rightbarPreference,
    collapsedWidth,
  )
  const cols = computeDesktopColumns(
    viewport,
    sidebarPreference,
    layoutInfo.rightbarTrack ? rightbarPreference : 0,
    collapsedWidth,
  )

  return (
    <div
      ref={frameRef}
      className="dshDesktopFrame"
      data-desktop-platform={platform}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-rightbar-collapsed={cols.rightbar === 0 || undefined}
      data-rightbar-fullscreen={layoutInfo.rightbarFullscreen || undefined}
      data-rightbar-instant={layoutInfo.rightbarInstant || undefined}
      style={{ gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.rightbar}px` }}
    >
      {platform === 'darwin' && <div className="dshDesktopMacCaptionRow" aria-hidden="true" />}
      {platform === 'win32' && <div className="dshDesktopWindowsCaptionRow" aria-hidden="true" />}
      <aside className="dshDesktopSidebarSurface">
        <div className="dshDesktopUpstreamSidebar">
          {renderSlot('sidebar', { collapsed: sidebarCollapsed, width: cols.sidebar })}
        </div>
      </aside>
      <main className="dshDesktopConversationSurface">
        {renderSlot('main', {}, { entryKey: panelInfo.activePanelId ?? 'conversation' })}
      </main>
      {/* The right column is root-scoped in rc.2: its occupant owns the Session
          binding (the right Sidebar renders `rightbar.session` itself), so the
          frame passes geometry only — no SessionProvider wrapper. */}
      <aside className="dshDesktopRightbarSurface">
        {renderSlot('rightbar', {
          width: normal.rightbar,
          viewportWidth: viewport,
          canShow: normal.rightbar > 0,
        })}
      </aside>
      <div className="dshDesktopOverlay" data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {!sidebarCollapsed && (
        <ResizeHandle
          side="sidebar"
          left={cols.sidebar}
          size={cols.sidebar}
          onResize={(width) => { layout.setSidebar(width) }}
        />
      )}
      {layoutInfo.rightbarShown && !layoutInfo.rightbarFullscreen && normal.rightbar > 0 && (
        <ResizeHandle
          side="rightbar"
          left={viewport - normal.rightbar}
          size={normal.rightbar}
          onResize={(width) => { layout.setRightbar(width) }}
        />
      )}
    </div>
  )
}

function ResizeHandle(props: { side: 'sidebar' | 'rightbar'; left: number; size: number; onResize: (width: number) => void }) {
  const origin = useRef(0)
  const base = useRef(0)
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    origin.current = event.clientX
    base.current = props.size
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [props.size])
  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const delta = event.clientX - origin.current
    props.onResize(base.current + (props.side === 'sidebar' ? delta : -delta))
  }, [props])
  const [dragging, setDragging] = useState(false)
  return (
    <div
      className="dshDesktopResizeHandle"
      data-side={props.side}
      data-dragging={dragging || undefined}
      style={{ left: props.left }}
      onPointerDown={(event) => { setDragging(true); onPointerDown(event) }}
      onPointerMove={onPointerMove}
      onPointerUp={() => { setDragging(false) }}
      onPointerCancel={() => { setDragging(false) }}
    />
  )
}
