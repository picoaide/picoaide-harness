/**
 * Main-area mounting for the scheduled-job center.
 *
 * The `conversation` slot is single-occupant (ui-conversation) and external
 * plugins cannot declare slots, so the center takes over the center column
 * at the DOM level — the same pattern as the former dsh-task board: a
 * container is appended inside the center column as a trailing child React
 * never manages, and a global stylesheet rule scoped to the html activation
 * attribute hides the conversation content while the center is active. The
 * conversation subtree underneath stays mounted and stateful.
 */
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { CronController } from './controller.ts'
import { CronJobTab } from './CronJobTab.tsx'
import { CRON_ACTIVE_ATTR } from './CronTrigger.tsx'
import { t } from './locales.ts'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"], [class*="ConversationSurface"], [class*="dshDesktopConversationSurface"]'
/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'cron'
const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

/** Close the cron center (used by sibling panels and navigation). */
export function closeCronPanel(): void {
  document.documentElement.removeAttribute(CRON_ACTIVE_ATTR)
}

/** The injected panel container (kept in the DOM, hidden when inactive). */
export const CRON_VIEW_SELECTOR = '[data-dsh-cron-view]'

/** Global visibility rules (injected once per plugin activation). */
function visibilityStyle(): HTMLStyleElement {
  const style = document.createElement('style')
  style.dataset.dshCronVisibility = ''
  // Base: the container starts hidden via a stylesheet rule (NOT an inline
  // style — an inline display:none would out-prioritize every non-important
  // rule below and the panel could never show). While the center is active,
  // show the container and hide the conversation subtree. !important on the
  // hide side beats the shell's inline display:contents.
  style.textContent = [
    `[data-dsh-cron-view] {`,
    `  display: none;`,
    `  height: 100%;`,
    `  width: 100%;`,
    `}`,
    `html[${CRON_ACTIVE_ATTR}] [data-pane='conversation'] > :not([data-dsh-cron-view]),`,
    `html[${CRON_ACTIVE_ATTR}] [class*='centerCol'] > :not([data-dsh-cron-view]) {`,
    `  display: none !important;`,
    `}`,
    `html[${CRON_ACTIVE_ATTR}] [data-dsh-cron-view] {`,
    `  display: block;`,
    `}`,
  ].join('\n')
  return style
}

/**
 * Mount the cron center React tree into the center column and bind its
 * visibility to the html activation attribute.
 * @returns disposer unmounting the tree and restoring the column.
 */
export function mountCronPanel(controller: CronController, workspaces?: IWorkspaces, api?: ConnectionHandle['api']): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const style = visibilityStyle()
  document.head.appendChild(style)

  const ensure = (): void => {
    if (container !== undefined) return
    const column = document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR)
    if (column === null) return
    container = document.createElement('div')
    container.dataset.dshCronView = ''
    container.dataset.dshPlugin = 'cron'
    // No inline display here: visibility is owned by the injected
    // stylesheet rule (an inline style would defeat the show rule).
    column.appendChild(container)
    root = createRoot(container)
    root.render(createElement(CronCenterView, { controller, ...(workspaces === undefined ? {} : { workspaces }), ...(api === undefined ? {} : { api }) }))
  }

  // The frame mounts after boot settlement; watch for the column's arrival.
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const onOtherActivate = (event: Event): void => {
    if ((event as CustomEvent).detail !== PANEL_NAME) closeCronPanel()
  }
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!document.documentElement.hasAttribute(CRON_ACTIVE_ATTR)) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) closeCronPanel()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)

  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    closeCronPanel()
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
    style.remove()
  }
}

/** Center view: a back-to-chat header plus the job center body. */
function CronCenterView({ controller, workspaces, api }: { controller: CronController; workspaces?: IWorkspaces; api?: ConnectionHandle['api'] }): JSX.Element {
  const back = (): void => { closeCronPanel() }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 420 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px' }}>
        <button type="button" onClick={back} style={backButtonStyle} aria-label={t('board.close')}>
          <span aria-hidden="true">‹</span>
          <span>{t('board.close')}</span>
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <CronJobTab controller={controller} {...(workspaces === undefined ? {} : { workspaces })} {...(api === undefined ? {} : { api })} />
      </div>
    </div>
  )
}

const backButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: '1px solid var(--dsw-border, rgba(128,128,128,.3))',
  borderRadius: 8,
  background: 'transparent',
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: 13,
  padding: '4px 10px',
  cursor: 'pointer',
}
