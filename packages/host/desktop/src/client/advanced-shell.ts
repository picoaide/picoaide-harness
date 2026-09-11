import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from './contracts.ts'
import type { DesktopClientEnvironment } from './environment.ts'
import { AdvancedFrame } from './AdvancedFrame.tsx'
import { DesktopLayoutState } from './layout-state.ts'
import { provideDesktopLayout } from './layout-service.ts'
import { installAdvancedStyles } from './styles.ts'
import { DesktopThemePresenter } from './theme-presenter.ts'

/**
 * Provide the advanced layout service and own the desktop root slot.
 * @param ctx - active browser Cordis context.
 * @param environment - validated mode and platform marker.
 */
export function applyAdvancedShell(ctx: ClientContext, environment: DesktopClientEnvironment): void {
  if (environment.mode !== 'advanced') {
    throw new Error(`dsh-plugin-desktop: advanced shell received mode ${JSON.stringify(environment.mode)}`)
  }

  const desktopLayout = new DesktopLayoutState(window.innerWidth)
  // ui-layout is disabled in the advanced desktop profile (profile.ts), so
  // this shell is the single `layout` service provider and the single root
  // registrant; the child-slot declarations (sidebar/conversation/details/
  // shell.overlay) ride this registration — a second declaration would be
  // fatal, which is exactly why the official frame row cannot stay enabled.
  ctx.effect(
    () => provideDesktopLayout(ctx, desktopLayout),
    'desktop: layout service',
  )

  ctx.effect(() => {
    document.body.dataset.dshDesktopMode = 'advanced'
    document.body.dataset.dshDesktopPlatform = environment.platform
    const removeStyles = installAdvancedStyles()
    return () => {
      removeStyles()
      delete document.body.dataset.dshDesktopMode
      delete document.body.dataset.dshDesktopPlatform
    }
  }, 'desktop: advanced shell styles')

  ctx.effect(() => {
    const presenter = new DesktopThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', snapshot => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'desktop: theme presenter')

  // The sidebar surfaces read their selection through the root standard source
  // (`usePanelInfo`); ui-layout owns that source upstream, and its row is
  // disabled here, so this shell publishes it instead.
  ctx.effect(
    () => ctx.slots.provideRoot({ hooks: { panelInfo: desktopLayout.panelInfo } }),
    'desktop: panel info root source',
  )

  // `selectPanel` must reject a key that is not registered, and a panel that
  // disappears must not stay selected: mirror ui-layout's retention of the live
  // `main` key set.
  ctx.effect(() => {
    const retain = (): void => {
      desktopLayout.retainMainPanels(ctx.slots.entries('main').flatMap(entry =>
        entry.options.key === undefined ? [] : [entry.options.key]))
    }
    const dispose = ctx.slots.subscribe('main', retain)
    retain()
    return dispose
  }, 'desktop: main panel retention')

  // rc.2 vocabulary: `sidebar` (root column), `main` (keyed root panel set —
  // the Conversation lives under the reserved `conversation` key), `rightbar`
  // (root right column, occupied by the official right Sidebar) and the
  // frame-wide `shell.overlay` list.
  ctx.effect(() => ctx.slots.register({
    name: 'root',
    children: {
      'sidebar': { kind: 'single', scope: 'root' },
      'main': { kind: 'keyed', scope: 'root' },
      'rightbar': { kind: 'single', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
    inject: () => ({ layout: desktopLayout, platform: environment.platform }),
  }, AdvancedFrame), 'desktop: advanced root slot')
}
