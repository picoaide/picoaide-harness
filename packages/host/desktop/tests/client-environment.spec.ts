import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'
import { parseDesktopClientEnvironment } from '../src/client/environment.ts'
import {
  computeDesktopColumns, DesktopLayoutState, MACOS_SIDEBAR_COLLAPSED, RIGHTBAR_MIN, SIDEBAR_COLLAPSED,
} from '../src/client/layout-state.ts'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { installAdvancedStyles } from '../src/client/styles.ts'
import {
  MACOS_DRAG_REGION_HEIGHT,
  MACOS_TITLEBAR_HEIGHT,
  MACOS_TRAFFIC_LIGHT_SAFE_WIDTH,
  WINDOWS_CAPTION_CONTROLS_WIDTH,
  WINDOWS_TITLEBAR_HEIGHT,
} from '../src/window-chrome.ts'

describe('desktop client environment', () => {
  it('does not activate desktop effects for an ordinary browser URL', () => {
    vi.stubGlobal('window', { location: { search: '' } })
    const effect = vi.fn()

    try {
      expect(parseDesktopClientEnvironment('')).toBeUndefined()
      apply({ effect } as unknown as ClientContext)
      expect(effect).not.toHaveBeenCalled()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('accepts the Electron-owned kebab query markers', () => {
    expect(parseDesktopClientEnvironment('?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin'))
      .toEqual({ mode: 'advanced', platform: 'darwin' })
    expect(parseDesktopClientEnvironment('?dsh-desktop-platform=win32&dsh-desktop-mode=compatibility'))
      .toEqual({ mode: 'compatibility', platform: 'win32' })
  })

  it.each([
    ['?dsh-desktop-mode=glass&dsh-desktop-platform=darwin', 'dsh-desktop-mode'],
    ['?dsh-desktop-mode=advanced', 'dsh-desktop-platform'],
    ['?dsh-desktop-platform=darwin', 'dsh-desktop-mode'],
    ['?dsh-desktop-mode=advanced&dsh-desktop-platform=android', 'dsh-desktop-platform'],
  ])('fails loud for malformed marker %s', (search, field) => {
    expect(() => parseDesktopClientEnvironment(search)).toThrow(field)
  })
})

describe('advanced desktop layout', () => {
  it('owns native caption geometry without targeting feature headers', () => {
    expect(MACOS_TITLEBAR_HEIGHT).toBe(20)
    expect(MACOS_DRAG_REGION_HEIGHT).toBe(32)
    expect(MACOS_DRAG_REGION_HEIGHT).toBeGreaterThan(MACOS_TITLEBAR_HEIGHT)
    expect(WINDOWS_TITLEBAR_HEIGHT).toBe(32)
    let css = ''
    const remove = vi.fn()
    const style = {
      dataset: {},
      get textContent() { return css },
      set textContent(value: string) { css = value },
      remove,
    }
    const appendChild = vi.fn()
    vi.stubGlobal('document', {
      createElement: () => style,
      head: { appendChild },
    })

    try {
      const dispose = installAdvancedStyles()
      expect(css).toMatch(/\.dshDesktopSidebarSurface\s*\{[^}]*--dsw-specific-sidebar-fill:\s*transparent;/)
      // Column contract with upstream AppFrame's `.rightbarCol`: the right
      // column never clips, because a shown panel hangs over the centre from a
      // zero-width track; the frame is what clips the closed panel's
      // translateX(100%) slide.
      expect(css).toMatch(/\.dshDesktopRightbarSurface \{[^}]*overflow: visible;/)
      expect(css).toMatch(/\.dshDesktopFrame \{[^}]*overflow: hidden;/)
      expect(css).toMatch(/data-desktop-platform="darwin"\]\[data-sidebar-collapsed\][^{]*\.dshDesktopUpstreamSidebar \{[^}]*width:\s*56px;[^}]*margin:\s*0 auto;/)
      expect(css).toMatch(new RegExp(`data-desktop-platform="darwin"\\] \\.dshDesktopUpstreamSidebar \\{[^}]*padding-top: ${MACOS_TITLEBAR_HEIGHT}px;[^}]*-webkit-app-region: no-drag;`))
      expect(css).toContain(`grid-template-rows: ${MACOS_TITLEBAR_HEIGHT}px minmax(0, 1fr)`)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-platform="darwin"\] \.dshDesktopSidebarSurface \{[^}]*grid-row: 1 \/ -1;[^}]*-webkit-app-region: no-drag;/)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-platform="darwin"\] \.dshDesktopConversationSurface,\s*\.dshDesktopFrame\[data-desktop-platform="darwin"\] \.dshDesktopRightbarSurface \{ grid-row: 2; \}/)
      expect(css).toMatch(new RegExp(`data-desktop-platform="darwin"\\] \\.dshDesktopSidebarSurface::before \\{[^}]*left: ${MACOS_TRAFFIC_LIGHT_SAFE_WIDTH}px;[^}]*height: ${MACOS_DRAG_REGION_HEIGHT}px;[^}]*-webkit-app-region: drag;`))
      expect(css).not.toMatch(/data-desktop-platform="darwin"\] \.dshDesktopSidebarSurface::before \{[^}]*z-index:/)
      expect(css).toMatch(/\.dshDesktopMacCaptionRow \{[^}]*position: relative;[^}]*grid-column: 2 \/ -1;[^}]*grid-row: 1;/)
      expect(css).toMatch(new RegExp(`\\.dshDesktopMacCaptionRow::before \\{[^}]*height: ${MACOS_DRAG_REGION_HEIGHT}px;[^}]*-webkit-app-region: drag;`))
      expect(css).not.toMatch(/\.dshDesktopMacCaptionRow::before \{[^}]*z-index:/)
      expect(css).not.toMatch(/data-desktop-platform="darwin"\] \.dshDesktopSidebarSurface \{[^}]*-webkit-app-region:\s*drag;/)
      expect(css).not.toContain('[data-phase')
      expect(css).toMatch(/html:has\(\[aria-modal="true"\]\) \.dshDesktopMacCaptionRow::before,[\s\S]*html:has\(\[aria-modal="true"\]\) \.dshDesktopSidebarSurface::before \{ -webkit-app-region: no-drag !important; \}/)
      expect(css).toContain(`grid-template-rows: ${WINDOWS_TITLEBAR_HEIGHT}px minmax(0, 1fr)`)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-platform="win32"\] \.dshDesktopSidebarSurface \{ grid-row: 1 \/ -1; \}/)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-platform="win32"\] \.dshDesktopConversationSurface,\s*\.dshDesktopFrame\[data-desktop-platform="win32"\] \.dshDesktopRightbarSurface \{ grid-row: 2; \}/)
      expect(css).toMatch(/\.dshDesktopWindowsCaptionRow \{[^}]*grid-column: 2 \/ -1;[^}]*grid-row: 1;/)
      expect(css).toMatch(new RegExp(`\\.dshDesktopWindowsCaptionRow::before \\{[^}]*inset: 0 ${WINDOWS_CAPTION_CONTROLS_WIDTH}px 0 0;[^}]*-webkit-app-region: drag;`))
      expect(css).not.toMatch(/data-desktop-platform="win32"[^{}]*header[^{}]*\{[^}]*padding-right/)
      expect(appendChild).toHaveBeenCalledWith(style)
      dispose()
      expect(remove).toHaveBeenCalledOnce()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('uses the compatibility rail on Windows and the wider desktop rail on macOS', () => {
    expect(computeDesktopColumns(1440, 0, 0)).toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 1384, rightbar: 0 })
    expect(computeDesktopColumns(1440, 0, 0, MACOS_SIDEBAR_COLLAPSED))
      .toEqual({ sidebar: MACOS_SIDEBAR_COLLAPSED, center: 1350, rightbar: 0 })
    expect(SIDEBAR_COLLAPSED).toBe(56)
    expect(MACOS_SIDEBAR_COLLAPSED).toBe(90)
  })

  it('keeps the right column out until it fits beside the conversation floor', () => {
    // 400px center + 300px right column is the upstream eligibility rule; a
    // narrower frame drops the track instead of squeezing the conversation.
    expect(computeDesktopColumns(1440, 280, 400).rightbar).toBe(400)
    expect(computeDesktopColumns(700, 0, 400).rightbar).toBe(0)
  })

  it('publishes the rc.2 layout transitions', () => {
    const layout = new DesktopLayoutState(1440)
    const snapshots: Array<ReturnType<DesktopLayoutState['getSnapshot']>['layoutInfo']> = []
    layout.subscribe(() => { snapshots.push(layout.getSnapshot().layoutInfo) })
    layout.toggleSidebar()
    layout.openRightbar(true, false)
    layout.closeRightbar()
    expect(snapshots.map(info => ({
      sidebar: info.sidebar,
      rightbarShown: info.rightbarShown,
      rightbarTrack: info.rightbarTrack,
    }))).toEqual([
      { sidebar: 0, rightbarShown: false, rightbarTrack: false },
      { sidebar: 0, rightbarShown: true, rightbarTrack: true },
      { sidebar: 0, rightbarShown: false, rightbarTrack: false },
    ])
    // First opening saved a px preference (45% of the frame) that survives the close.
    expect(layout.getSnapshot().layoutInfo.rightbar).toBe(Math.round(1440 * 0.45))
  })

  it('selects a registered main panel and rejects an unknown key', () => {
    const layout = new DesktopLayoutState(1440)
    layout.retainMainPanels(['conversation', 'pico-cron'])
    layout.selectPanel('pico-cron' as MainPanelId)
    expect(layout.getSnapshot().panelInfo.activePanelId).toBe('pico-cron')
    expect(() => { layout.selectPanel('missing' as MainPanelId) }).toThrow('is not registered')
    // A panel that disappears must not stay selected.
    layout.retainMainPanels(['conversation'])
    expect(layout.getSnapshot().panelInfo.activePanelId).toBeNull()
  })

  it('lets the rail re-expand without losing its wide preference on narrow windows', () => {
    const layout = new DesktopLayoutState(1440)
    expect(layout.sidebarCollapsed()).toBe(false)
    layout.setViewportWidth(800)
    expect(layout.sidebarCollapsed()).toBe(true)
    layout.toggleSidebar()
    expect(layout.getSnapshot().layoutInfo.narrowExpanded).toBe(true)
    expect(layout.sidebarCollapsed()).toBe(false)
    layout.setViewportWidth(1440)
    expect(layout.sidebarCollapsed()).toBe(false)
    expect(layout.sidebarPreference()).toBe(280)
  })

  // P1-8: the five upstream `stores.ts` semantics `DesktopLayoutState` had
  // drifted from. Each case asserts the upstream action, not our old one.

  it('opens the right panel by dropping the narrow rail override (the left column concedes)', () => {
    // 756–979px dead zone: the frame can seat the right panel only if the left
    // column returns to its rail, which is what the occupant's `canShow`
    // requirement is computed from. Without the reset the occupant receives
    // canShow=false and collapses itself again — the open button goes inert.
    const layout = new DesktopLayoutState(900)
    layout.toggleSidebar()
    expect(layout.getSnapshot().layoutInfo.narrowExpanded).toBe(true)
    expect(layout.sidebarCollapsed()).toBe(false)

    layout.openRightbar(true, false)
    expect(layout.getSnapshot().layoutInfo.narrowExpanded).toBe(false)
    expect(layout.sidebarCollapsed()).toBe(true)

    // The wide-frame path must not touch the override at all.
    const wide = new DesktopLayoutState(1440)
    wide.openRightbar(true, false)
    expect(wide.getSnapshot().layoutInfo.narrowExpanded).toBe(false)
    expect(wide.sidebarCollapsed()).toBe(false)
  })

  it('makes the right panel eligible on a narrow frame by letting the rail yield', () => {
    // The frame's own solve (AdvancedFrame.tsx): eligibility is computed with
    // the collapsed rail. With the rail manually expanded, 900 - 280 - 400
    // leaves 220px, short of the 300px floor ⇒ ineligible; the same frame with
    // the rail (56px) resolves a positive track, which is the `canShow` the
    // official occupant requires before it stays expanded.
    const layout = new DesktopLayoutState(900)
    layout.toggleSidebar()
    expect(layout.sidebarCollapsed()).toBe(false)
    expect(layout.sidebarPreference()).toBe(280)
    expect(computeDesktopColumns(900, layout.sidebarPreference(), layout.rightbarPreference()).rightbar).toBe(0)

    layout.openRightbar(true, false)
    expect(layout.sidebarCollapsed()).toBe(true)
    const normal = computeDesktopColumns(900, 0, layout.rightbarPreference())
    // 45% of 900px = 405px, i.e. above the 300px floor here; what matters is
    // that the frame now resolves a positive track (canShow) instead of zero.
    expect(layout.getSnapshot().layoutInfo.rightbar).toBe(405)
    expect(normal.rightbar).toBe(405)
    expect(normal.rightbar >= RIGHTBAR_MIN).toBe(true)
  })

  it.each([800, 1440])('resets the narrow rail override when the frame crosses the 1024px breakpoint', (start) => {
    const other = start < 1024 ? 1440 : 800
    const layout = new DesktopLayoutState(start)
    layout.toggleSidebar()
    expect(layout.getSnapshot().layoutInfo.narrowExpanded).toBe(start < 1024)
    // Crossing in either direction drops the override: the narrow default is
    // the auto-collapsed rail, the wide state is the width preference.
    layout.setViewportWidth(other)
    expect(layout.getSnapshot().layoutInfo.narrowExpanded).toBe(false)
    // ...and it is live again on the far side of the breakpoint.
    layout.toggleSidebar()
    expect(layout.getSnapshot().layoutInfo.narrowExpanded).toBe(other < 1024)
  })

  it('keeps the narrow rail override while the frame stays inside its own side of the breakpoint', () => {
    const layout = new DesktopLayoutState(900)
    layout.toggleSidebar()
    expect(layout.getSnapshot().layoutInfo.narrowExpanded).toBe(true)
    layout.setViewportWidth(1000)
    expect(layout.getSnapshot().layoutInfo.narrowExpanded).toBe(true)
    layout.setViewportWidth(1440)
    layout.toggleSidebar()
    expect(layout.getSnapshot().layoutInfo.sidebar).toBe(0)
    layout.setViewportWidth(1600)
    expect(layout.getSnapshot().layoutInfo.sidebar).toBe(0)
  })

  it('keeps the fullscreen exit transition suppression until the next geometry action', () => {
    const layout = new DesktopLayoutState(1440)
    layout.openRightbar(true, true)
    expect(layout.getSnapshot().layoutInfo.rightbarInstant).toBe(false)
    // Entering normal presentation from fullscreen suppresses the slide once.
    layout.openRightbar(true, false)
    expect(layout.getSnapshot().layoutInfo.rightbarInstant).toBe(true)
    // Each frame-resize/drag/toggle action retires it and every later report
    // leaves a settled presentation alone.
    layout.setSidebar(320)
    expect(layout.getSnapshot().layoutInfo.rightbarInstant).toBe(false)
    layout.openRightbar(true, false)
    expect(layout.getSnapshot().layoutInfo.rightbarInstant).toBe(false)
  })

  it.each([
    ['setSidebar', (layout: DesktopLayoutState) => { layout.setSidebar(320) }],
    ['setRightbar', (layout: DesktopLayoutState) => { layout.setRightbar(420) }],
    ['setViewportWidth', (layout: DesktopLayoutState) => { layout.setViewportWidth(1280) }],
    ['toggleSidebar', (layout: DesktopLayoutState) => { layout.toggleSidebar() }],
  ])('clears the fullscreen exit suppression from %s', (_name, act) => {
    const layout = new DesktopLayoutState(1440)
    layout.openRightbar(true, true)
    layout.openRightbar(true, false)
    expect(layout.getSnapshot().layoutInfo.rightbarInstant).toBe(true)
    act(layout)
    expect(layout.getSnapshot().layoutInfo.rightbarInstant).toBe(false)
  })

  it('floors the first right panel preference at the contract minimum on a small frame', () => {
    // 45% of 600px is 270px — below the 300px clamp floor, so the saved
    // preference (and therefore `computeDesktopColumns`) must use the floor.
    const layout = new DesktopLayoutState(600)
    layout.openRightbar(true, false)
    expect(layout.getSnapshot().layoutInfo.rightbar).toBe(RIGHTBAR_MIN)
    expect(RIGHTBAR_MIN).toBe(300)
    // 45% of 1440px is above the floor and stays a plain ratio.
    const wide = new DesktopLayoutState(1440)
    wide.openRightbar(true, false)
    expect(wide.getSnapshot().layoutInfo.rightbar).toBe(Math.round(1440 * 0.45))
  })
})
