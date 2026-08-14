import { describe, expect, it } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { provideDesktopLayout } from '../src/client/layout-service.ts'
import { parseDesktopClientEnvironment } from '../src/client/environment.ts'
import { computeDesktopColumns, DesktopLayoutState, SIDEBAR_COLLAPSED } from '../src/client/layout-state.ts'

describe('desktop client environment', () => {
  it('accepts the Electron-owned kebab query markers', () => {
    expect(parseDesktopClientEnvironment('?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin'))
      .toEqual({ mode: 'advanced', platform: 'darwin' })
    expect(parseDesktopClientEnvironment('?dsh-desktop-platform=win32&dsh-desktop-mode=compatibility'))
      .toEqual({ mode: 'compatibility', platform: 'win32' })
  })

  it.each([
    ['', 'dsh-desktop-mode'],
    ['?dsh-desktop-mode=glass&dsh-desktop-platform=darwin', 'dsh-desktop-mode'],
    ['?dsh-desktop-mode=advanced', 'dsh-desktop-platform'],
    ['?dsh-desktop-mode=advanced&dsh-desktop-platform=android', 'dsh-desktop-platform'],
  ])('fails loud for malformed marker %s', (search, field) => {
    expect(() => parseDesktopClientEnvironment(search)).toThrow(field)
  })
})

describe('advanced desktop layout', () => {
  it('releases the Cordis layout service with its owning effect', () => {
    let disposed = false
    const ctx = {
      reflect: {
        provide: (name: string, value: unknown) => {
          expect(name).toBe('layout')
          expect(value).toBeInstanceOf(DesktopLayoutState)
          return () => { disposed = true }
        },
      },
    } as unknown as ClientContext

    const dispose = provideDesktopLayout(ctx, new DesktopLayoutState())
    expect(disposed).toBe(false)
    dispose()
    expect(disposed).toBe(true)
  })

  it('keeps the collapsed sidebar at the product 90 px rail width', () => {
    expect(computeDesktopColumns(1440, 0, 0)).toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 1350, details: 0 })
    expect(SIDEBAR_COLLAPSED).toBe(90)
  })

  it('publishes mirrored panel transitions', () => {
    const layout = new DesktopLayoutState()
    const snapshots: object[] = []
    layout.subscribe(() => { snapshots.push(layout.getSnapshot()) })
    layout.toggleSidebar()
    layout.openDetails()
    layout.closeDetails()
    expect(snapshots).toEqual([
      { sidebar: 0, details: 0, narrow: false, narrowExpanded: false },
      { sidebar: 0, details: 360, narrow: false, narrowExpanded: false },
      { sidebar: 0, details: 0, narrow: false, narrowExpanded: false },
    ])
  })

  it('lets the rail re-expand without losing its wide preference on narrow windows', () => {
    const layout = new DesktopLayoutState()
    layout.setNarrow(true)
    expect(layout.getSnapshot()).toMatchObject({ sidebar: 280, narrow: true, narrowExpanded: false })
    layout.toggleSidebar()
    expect(layout.getSnapshot()).toMatchObject({ sidebar: 280, narrow: true, narrowExpanded: true })
    layout.setNarrow(false)
    expect(layout.getSnapshot()).toMatchObject({ sidebar: 280, narrow: false, narrowExpanded: false })
  })
})
