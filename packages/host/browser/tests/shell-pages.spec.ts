/**
 * Contract tests for the injected browser chrome pages (`shell-pages.ts`).
 *
 * These two pages are HTML/CSS/JS strings injected into Electron webContents,
 * so this package (no DOM environment) can only assert their SOURCE contract.
 * Real behaviour still needs the real-machine E2E over CDP — but the control
 * takeover rules below must never regress silently again (2026-09-11):
 *
 *   - the mask scrim is inert: only the pill's 我来操作 button grants control.
 *     A click anywhere else in the window must NOT steal the browser (the old
 *     whole-scrim click listener did exactly that, so a stray click on the
 *     toolbar or the page parked every queued AI action);
 *   - 我来操作 / 交给 AI is ONE always-visible toggle (never hover-revealed);
 *   - neither the activity panel nor Escape may hand control back to the AI.
 */
import { describe, expect, it } from 'vitest'
import { BROWSER_OVERLAY_HTML, BROWSER_SHELL_HTML } from '../src/shell-pages.ts'

describe('browser control contract: the pill button is the only entry', () => {
  it('never binds a click takeover on the whole-window scrim', () => {
    expect(BROWSER_OVERLAY_HTML).not.toContain("$('mask').addEventListener")
    expect(BROWSER_OVERLAY_HTML).toContain('id="pill-take"')
    expect(BROWSER_OVERLAY_HTML).toContain("$('pill-take').addEventListener('click'")
  })

  it('renders the scrim as a surface, not as a button', () => {
    expect(BROWSER_OVERLAY_HTML).not.toMatch(/\.s-mask \{[^}]*cursor: pointer/u)
  })

  it('keeps the toggle always visible and drops the sidebar duplicate', () => {
    expect(BROWSER_OVERLAY_HTML).not.toContain('.s-capsule:not(:hover) .take')
    expect(BROWSER_OVERLAY_HTML).not.toContain('.s-capsule:hover .take')
    expect(BROWSER_OVERLAY_HTML).not.toContain('take-btn')
  })

  it('releases control only from the toggle — never from Escape or the shell page', () => {
    expect(BROWSER_OVERLAY_HTML).not.toContain("if (state.controlled) post('takeover'")
    expect(BROWSER_SHELL_HTML).not.toContain("post('takeover'")
    // Escape still closes the floating surface in both pages.
    expect(BROWSER_OVERLAY_HTML).toContain("post('overlay', { mode: 'capsule' })")
    expect(BROWSER_SHELL_HTML).toContain("post('overlay', { mode: 'capsule' })")
  })

  it('keeps the takeover reachable from the keyboard while masked', () => {
    expect(BROWSER_OVERLAY_HTML).toContain("e.key === 'Enter' || e.key === ' '")
  })
})
