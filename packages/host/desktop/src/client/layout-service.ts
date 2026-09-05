import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from './contracts.ts'
import type { DesktopLayoutState } from './layout-state.ts'

/**
 * Provide the advanced layout service for one plugin-fiber lifetime.
 *
 * ui-layout is disabled in the advanced desktop profile (its AppFrame would
 * collide with the desktop's own root registration), so the desktop shell is
 * the `layout` service provider: ui-sidebar/ui-chat inject 'layout' and drive
 * panel transitions through this face. DesktopLayoutState implements the
 * upstream ILayout contract (toggleSidebar/openDetails/closeDetails).
 * @param ctx - active browser Cordis context.
 * @param layout - desktop-owned layout implementation.
 * @returns disposer for the service registration.
 */
export function provideDesktopLayout(ctx: ClientContext, layout: DesktopLayoutState): () => void {
  const dispose = ctx.reflect.provide('layout', layout)
  return () => { void dispose() }
}
