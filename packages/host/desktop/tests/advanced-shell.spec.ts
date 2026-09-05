import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
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
    const layout = new DesktopLayoutState()
    const snapshot = layout.getSnapshot()
    expect(snapshot.sidebar).toBe(SIDEBAR_DEFAULT)
    expect(snapshot.details).toBe(0)
    expect(snapshot.narrow).toBe(false)
  })
})
