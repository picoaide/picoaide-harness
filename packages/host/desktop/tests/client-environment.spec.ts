import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'
import { parseDesktopClientEnvironment } from '../src/client/environment.ts'
import {
  computeDesktopColumns, DesktopLayoutState, MACOS_SIDEBAR_COLLAPSED, SIDEBAR_COLLAPSED,
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
})
