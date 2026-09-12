import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { applyAdvancedShell } from '../src/client/advanced-shell.ts'
import { DesktopLayoutState } from '../src/client/layout-state.ts'
import { parseDesktopClientEnvironment } from '../src/client/environment.ts'
import { SIDEBAR_DEFAULT } from '../src/client/layout-state.ts'

describe('desktop advanced shell', () => {
  it('fails loud when wired with a non-advanced mode', () => {
    const ctx = { effect: vi.fn() } as unknown as ClientContext
    const env = { mode: 'compatibility', platform: 'darwin' } as const
    expect(() => applyAdvancedShell(ctx, env)).toThrow('advanced shell received mode')
    expect(ctx.effect).not.toHaveBeenCalled()
  })

  it('only projects a valid mode/platform pair (malformed markers throw)', () => {
    expect(() => parseDesktopClientEnvironment('?dsh-desktop-mode=glass&dsh-desktop-platform=darwin'))
      .toThrow('dsh-desktop-mode')
    expect(parseDesktopClientEnvironment('?'))
      .toBeUndefined()
  })

  it('owns a default-width layout before any resize interaction', () => {
    const layout = new DesktopLayoutState(1440)
    const { layoutInfo, panelInfo } = layout.getSnapshot()
    expect(layoutInfo.sidebar).toBe(SIDEBAR_DEFAULT)
    // rc.2 right column: nothing is reserved and nothing is shown until the
    // occupant reports through ctx.layout.openRightbar.
    expect(layoutInfo.rightbar).toBeNull()
    expect(layoutInfo.rightbarShown).toBe(false)
    expect(layoutInfo.rightbarTrack).toBe(false)
    expect(panelInfo.activePanelId).toBeNull()
  })
})

/**
 * P2-13 subscription granularity.
 *
 * Upstream refuses to let a drag re-render the conversation column. Two
 * mechanisms carry that here, and only the first is reachable from a unit test
 * (the frame itself needs a DOM: vitest runs Node-only in this package and
 * jsdom is deliberately not installed):
 *
 *  1. the selected main key arrives from the root `panelInfo` standard source,
 *     whose channel publishes selection ONLY — measured below;
 *  2. the frame renders `main` under `useMemo` keyed on that key
 *     (`AdvancedFrame.tsx`), so an equal key keeps the element identity and the
 *     conversation subtree is not re-rendered. Mechanism 2 is asserted by the
 *     rc.2 slot/panel E2E (`yarn workspace dsh-plugin-desktop e2e:client`) plus
 *     the frame's own typecheck; it is deliberately not asserted here rather
 *     than pretending a Node test can count React renders.
 */
describe('advanced desktop layout subscription granularity', () => {
  it('publishes panel selection on its own channel, not on geometry changes', () => {
    const layout = new DesktopLayoutState(1440)
    const geometryKeys = Object.keys(layout.getSnapshot().layoutInfo)
    let panelEvents = 0
    const stop = layout.panelInfo.subscribe(() => { panelEvents += 1 })

    layout.retainMainPanels(['conversation', 'pico-cron'])
    layout.selectPanel('pico-cron' as MainPanelId)
    expect(panelEvents).toBe(1)

    // Every geometry mutation the frame's drag handles and ResizeObserver can
    // issue while the selection is untouched.
    layout.setSidebar(320)
    layout.setRightbar(420)
    layout.setViewportWidth(900)
    layout.toggleSidebar()
    layout.openRightbar(true, false)
    layout.closeRightbar()
    expect(panelEvents).toBe(1)

    layout.selectPanel(null)
    expect(panelEvents).toBe(2)
    stop()

    // The channel is a projection of the published snapshot, so it can never
    // report a selection the frame's own snapshot does not have.
    expect(layout.panelInfo.getSnapshot()).toBe(layout.getSnapshot().panelInfo)
    // ...and the frame-facing snapshot keeps the geometry the frame solves from,
    // which is what its full-snapshot subscription is still for.
    expect(geometryKeys).toContain('viewportWidth')
    expect(layout.getSnapshot().layoutInfo.viewportWidth).toBe(900)
  })
})
